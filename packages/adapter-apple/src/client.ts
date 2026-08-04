import {
  type AdapterContext,
  AgentshipError,
  ERROR_CODES,
  type RunResult,
  type ToolRunner,
} from '@agentship/core';
import { withAppleKeyFile } from '@agentship/credentials';
import { loadLockfile } from '@agentship/toolchain';
import { ascCommands } from './commands.js';
import { appleEnv, appleStateDir } from './environment.js';
import { ascError, isRetryableAscFailure } from './errors.js';
import { parseResource, parseResourceList } from './jsonapi.js';

/** Wall-clock budget for a normal App Store Connect call. */
const DEFAULT_TIMEOUT_MS = 120_000;

export interface AppleClientOptions {
  /** Supplied by tests; production always uses the toolchain-backed runner. */
  readonly runner: ToolRunner;
  /** Skip the version drift check. Only the drift check itself sets this. */
  readonly pinnedVersion?: string;
}

export interface InvokeOptions {
  readonly timeoutMs?: number;
  /** Retry transient store failures. Off for writes, since a retry could double-apply. */
  readonly retryTransient?: boolean;
}

/**
 * Runs `asc` with Agentship's credentials and nothing else.
 *
 * Every invocation materialises the `.p8` for the duration of the call and removes it in a
 * `finally`, so a crash inside the callback cannot leave key material on disk. The key is
 * never an argument: `ASC_PRIVATE_KEY_PATH` carries the path, and the shared runner refuses
 * arguments that look like secrets.
 */
export class AppleClient {
  readonly #runner: ToolRunner;
  #version: string | undefined;

  constructor(options: AppleClientOptions) {
    this.#runner = options.runner;
    this.#version = options.pinnedVersion;
  }

  /** Runs a command and returns its stdout, throwing a classified error on failure. */
  async run(
    context: AdapterContext,
    args: readonly string[],
    options: InvokeOptions = {},
  ): Promise<string> {
    const result = await this.runRaw(context, args, options);
    if (result.exitCode !== 0) throw ascError(args, result);
    return result.stdout;
  }

  /** Runs a command and returns the raw result, letting the caller decide what a failure means. */
  async runRaw(
    context: AdapterContext,
    args: readonly string[],
    options: InvokeOptions = {},
  ): Promise<RunResult> {
    const stateDir = await appleStateDir();
    return withAppleKeyFile({ profile: context.profile }, async (privateKeyPath, credentials) =>
      this.#runner({
        args,
        cwd: stateDir,
        env: appleEnv({ ...credentials, privateKeyPath, stateDir }),
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        // Writes are never retried: App Store Connect has no idempotency key, so a retried
        // POST can create a second resource. Reads opt in explicitly.
        ...(options.retryTransient === true ? {} : { retry: false as const }),
        isRetryable: isRetryableAscFailure,
        ...(context.cancelSignal === undefined ? {} : { cancelSignal: context.cancelSignal }),
      }),
    );
  }

  /** Runs a read-only command and parses the App Store Connect resources it returned. */
  async list(
    context: AdapterContext,
    args: readonly string[],
    options?: InvokeOptions,
  ): Promise<ReturnType<typeof parseResourceList>> {
    return parseResourceList(await this.run(context, args, options), args.slice(0, 2).join(' '));
  }

  /** Runs a read-only command and parses the single resource it returned. */
  async one(
    context: AdapterContext,
    args: readonly string[],
    options?: InvokeOptions,
  ): Promise<ReturnType<typeof parseResource>> {
    return parseResource(await this.run(context, args, options), args.slice(0, 2).join(' '));
  }

  /**
   * Version `asc` reports, e.g. `3.4.1`.
   *
   * `--version` needs no credentials, but it goes through the same invocation path so that
   * the isolated environment is exercised on every run rather than only on store calls.
   */
  async version(context: AdapterContext): Promise<string> {
    if (this.#version !== undefined) return this.#version;
    const result = await this.runRaw(context, ascCommands.version(), { timeoutMs: 30_000 });
    if (result.exitCode !== 0) throw ascError(ascCommands.version(), result);
    // "3.4.1 (commit: a5cbf6e, date: 2026-08-01T17:04:55Z)"
    const reported = result.stdout.trim().split(/\s+/, 1)[0] ?? '';
    this.#version = reported;
    return reported;
  }

  /**
   * Fails when the installed `asc` is not the version the command table was verified
   * against.
   *
   * A silent version bump is the failure mode this whole design is built around: the
   * mappings in `commands.ts` are only true for one version, and a flag that quietly
   * changed meaning would corrupt a store rather than raise an error.
   */
  async assertNoDrift(context: AdapterContext): Promise<string> {
    const expected = loadLockfile().tools['asc']?.version;
    const reported = await this.version(context);
    if (expected !== undefined && reported !== expected) {
      throw new AgentshipError(
        ERROR_CODES.TOOL_VERSION_DRIFT,
        `asc reports version ${reported}, but Agentship's command mappings were verified against ${expected}.`,
        {
          store: 'apple',
          details: { reported, expected },
          remediation: {
            summary:
              'Run `agentship doctor` to reinstall the pinned version, or update Agentship if the lockfile moved.',
          },
        },
      );
    }
    return reported;
  }
}
