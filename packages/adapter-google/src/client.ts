import {
  type AdapterContext,
  AgentshipError,
  ERROR_CODES,
  parseToolJson,
  type RunResult,
  redactString,
  type ToolRunner,
} from '@agentship/core';
import { withGoogleServiceAccountFile } from '@agentship/credentials';
import { loadLockfile } from '@agentship/toolchain';
import { gpcCommands } from './commands.js';
import { googleEnv, googleStateDir } from './environment.js';
import { gpcError, isRetryableGpcFailure } from './errors.js';

/** Wall-clock budget for a normal Play Developer API call. */
const DEFAULT_TIMEOUT_MS = 120_000;

export interface GoogleClientOptions {
  /** Supplied by tests; production always uses the toolchain-backed runner. */
  readonly runner: ToolRunner;
  readonly pinnedVersion?: string;
}

export interface InvokeOptions {
  readonly timeoutMs?: number;
  readonly retryTransient?: boolean;
}

/**
 * Runs `gpc` with Agentship's credentials and nothing else.
 *
 * Invocations that touch an app are **serialised per package**. The Google Play Developer
 * API allows only one open edit per user and app: two `gpc` commands running at once for
 * the same package would each open an edit, and the second commit would fail with an edit
 * conflict — or, worse, succeed after invalidating the first. Since every mutating `gpc`
 * command opens and closes its own edit internally, the only place that constraint can be
 * honoured is here.
 */
export class GoogleClient {
  readonly #runner: ToolRunner;
  readonly #queues = new Map<string, Promise<unknown>>();
  #version: string | undefined;

  constructor(options: GoogleClientOptions) {
    this.#runner = options.runner;
    this.#version = options.pinnedVersion;
  }

  /**
   * Serialises `fn` against every other call for the same package.
   *
   * Exposed because `applyBatch` needs to hold the lane across several invocations that
   * form one logical unit, not just one at a time.
   */
  async withPackageLock<T>(packageName: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(packageName) ?? Promise.resolve();
    // The lane must survive a failure: a rejected predecessor has already released its
    // edit, so the next caller may proceed. `fn` runs on both settlement paths.
    const next = previous.then(fn, fn);
    // What is stored is the settled-either-way form, so a rejection never escapes as an
    // unhandled promise and never poisons the successor.
    const lane = next.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(packageName, lane);
    try {
      return await next;
    } finally {
      // Drop the lane once nobody is queued behind it, so the map cannot grow unbounded.
      if (this.#queues.get(packageName) === lane) this.#queues.delete(packageName);
    }
  }

  async runRaw(
    context: AdapterContext,
    args: readonly string[],
    options: InvokeOptions = {},
  ): Promise<RunResult> {
    const stateDir = await googleStateDir();
    return withGoogleServiceAccountFile({ profile: context.profile }, async (serviceAccountPath) =>
      this.#runner({
        args,
        cwd: stateDir,
        env: googleEnv({ serviceAccountPath, stateDir }),
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        // Writes are never retried: a retried commit could apply an edit twice.
        ...(options.retryTransient === true ? {} : { retry: false as const }),
        isRetryable: isRetryableGpcFailure,
        ...(context.cancelSignal === undefined ? {} : { cancelSignal: context.cancelSignal }),
      }),
    );
  }

  /** Runs a command and returns its stdout, throwing a classified error on failure. */
  async run(
    context: AdapterContext,
    args: readonly string[],
    options: InvokeOptions = {},
  ): Promise<string> {
    const result = await this.runRaw(context, args, options);
    if (result.exitCode !== 0) throw gpcError(args, result);
    return result.stdout;
  }

  /**
   * Runs a command and parses its JSON output.
   *
   * `gpc` prints the Play API resource verbatim under `--output json`, but a handful of
   * subcommands print prose instead (`auth whoami` is one). Parsing therefore fails loudly
   * rather than returning a guess: a caller that silently accepted unparsed output would
   * report an empty snapshot as a real one.
   */
  async json<T = unknown>(
    context: AdapterContext,
    args: readonly string[],
    options: InvokeOptions = {},
  ): Promise<T> {
    const stdout = await this.run(context, args, options);
    if (stdout.trim() === '') {
      throw new AgentshipError(
        ERROR_CODES.TOOL_INVALID_OUTPUT,
        'gpc produced no output where a JSON document was expected.',
        { store: 'google', details: { command: args } },
      );
    }
    try {
      return parseToolJson<T>(stdout, 'gpc');
    } catch (cause) {
      throw AgentshipError.from(
        ERROR_CODES.TOOL_INVALID_OUTPUT,
        'gpc did not produce the JSON document Agentship expected.',
        cause,
        {
          store: 'google',
          details: { command: args, sample: redactString(stdout.slice(0, 400)) },
        },
      );
    }
  }

  async version(context: AdapterContext): Promise<string> {
    if (this.#version !== undefined) return this.#version;
    const result = await this.runRaw(context, gpcCommands.version(), { timeoutMs: 30_000 });
    if (result.exitCode !== 0) throw gpcError(gpcCommands.version(), result);
    const reported = result.stdout.trim().split(/\s+/, 1)[0] ?? '';
    this.#version = reported;
    return reported;
  }

  /** Fails when the installed `gpc` is not the version `commands.ts` was verified against. */
  async assertNoDrift(context: AdapterContext): Promise<string> {
    const expected = loadLockfile().tools['gpc']?.version;
    const reported = await this.version(context);
    if (expected !== undefined && reported !== expected) {
      throw new AgentshipError(
        ERROR_CODES.TOOL_VERSION_DRIFT,
        `gpc reports version ${reported}, but Agentship's command mappings were verified against ${expected}.`,
        {
          store: 'google',
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
