import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execa } from 'execa';
import { AgentshipError, type AgentshipErrorCode, ERROR_CODES } from './errors.js';
import { getLogger, type Logger } from './logger.js';
import { looksSecret, redactString } from './redact.js';
import type { Store } from './types.js';

/** Default wall-clock budget for a single invocation of a managed binary. */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** Default cap on captured stdout/stderr; store payloads are small, dumps are not. */
export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * Environment variables forwarded from the parent process.
 *
 * The child environment is built explicitly instead of inherited: a managed binary must
 * never see unrelated credentials that happen to live in the operator's shell.
 */
const FORWARDED_ENV_KEYS: readonly string[] = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
];

export interface RetryPolicy {
  /** Total attempts, including the first one. */
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 500, maxDelayMs: 8_000 };

export interface RunResult {
  readonly stdout: string;
  /** Already redacted: safe to log, to embed in errors and to hand to an agent. */
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly attempts: number;
}

export interface RunOptions {
  readonly args: readonly string[];
  /** Extra environment for the child, merged on top of the forwarded allow-list. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Written to the child's stdin — the safe channel for anything sensitive. */
  readonly input?: string;
  readonly retry?: RetryPolicy | false;
  readonly store?: Store;
  readonly logger?: Logger;
  readonly cancelSignal?: AbortSignal;
  /** Human-readable name used in log records and error messages. */
  readonly toolName?: string;
  /** Maps a failed invocation to a specific error code (adapters know their tool). */
  readonly mapExitCode?: (result: RunResult) => AgentshipErrorCode | undefined;
  /** Decides whether a failed invocation is worth retrying. */
  readonly isRetryable?: (result: RunResult) => boolean;
}

/**
 * A single invocation of a managed binary, without the binary.
 *
 * This is the seam that lets a store backend be exercised offline: the adapter builds an
 * invocation, and whoever owns the process (production: {@link createToolRunner} in
 * `@agentship/toolchain`; tests: a fixture table) decides how it is answered.
 */
export type ToolInvocation = Omit<RunOptions, 'store' | 'logger' | 'toolName' | 'mapExitCode'>;

/**
 * Executes an invocation of one specific managed binary.
 *
 * Returns the result of a failed invocation instead of throwing, because classifying a
 * non-zero exit is the backend's job — it is the only layer that knows what exit code 3
 * means for its tool. Structural failures (timeout, output limit, binary missing) still
 * throw, since no backend can do anything useful with them.
 */
export type ToolRunner = (invocation: ToolInvocation) => Promise<RunResult>;

/** Transient failures every store backend reports one way or another. */
const RETRYABLE_OUTPUT =
  /\b(429|too many requests|rate.?limit|50[0234]\b|service unavailable|temporarily unavailable|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up)\b/i;

function defaultIsRetryable(result: RunResult): boolean {
  return RETRYABLE_OUTPUT.test(result.stderr) || RETRYABLE_OUTPUT.test(result.stdout);
}

function buildEnv(extra: Readonly<Record<string, string | undefined>> | undefined): {
  [key: string]: string;
} {
  const env: { [key: string]: string } = {};
  for (const key of FORWARDED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) env[key] = value;
    }
  }
  return env;
}

/**
 * Guards the invariant "no secrets in argv": arguments are visible to every process on the
 * machine through `ps`. Secrets travel via the environment or stdin instead.
 */
function assertNoSecretsInArgs(args: readonly string[], toolName: string): void {
  for (const [index, arg] of args.entries()) {
    if (looksSecret(arg)) {
      throw new AgentshipError(
        ERROR_CODES.TOOL_EXEC_FAILED,
        `Refusing to run ${toolName}: argument ${index} looks like a secret, and process arguments are world-readable.`,
        { details: { toolName, argIndex: index } },
      );
    }
  }
}

function backoffDelay(attempt: number, policy: RetryPolicy): number {
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  // Full jitter: spreads concurrent retries instead of synchronising them.
  return Math.round(Math.random() * capped);
}

/**
 * Runs a managed binary by absolute path and returns its output, whatever the exit code.
 *
 * Never resolves the binary from `PATH` — the caller passes the path produced by
 * `@agentship/toolchain`, which only hands out hash-verified installations.
 *
 * A non-zero exit is a normal return value here: the store backends map exit codes and
 * stderr onto their own error families, and doing that from a thrown error loses
 * information. Timeouts, output limits and a missing binary still throw.
 */
export async function runToolRaw(binaryPath: string, options: RunOptions): Promise<RunResult> {
  const toolName = options.toolName ?? binaryPath.split('/').pop() ?? binaryPath;
  if (!isAbsolute(binaryPath)) {
    throw new AgentshipError(
      ERROR_CODES.TOOL_EXEC_FAILED,
      `Refusing to run ${toolName}: the binary path must be absolute, got "${binaryPath}".`,
      { details: { toolName } },
    );
  }
  assertNoSecretsInArgs(options.args, toolName);

  const log = (options.logger ?? getLogger()).child({ tool: toolName });
  const policy =
    options.retry === false ? { ...DEFAULT_RETRY, attempts: 1 } : (options.retry ?? DEFAULT_RETRY);
  const isRetryable = options.isRetryable ?? defaultIsRetryable;

  let lastResult: RunResult | undefined;
  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    const result = await runOnce(binaryPath, options, toolName, attempt);
    if (result.exitCode === 0) {
      log.debug('tool invocation succeeded', {
        args: options.args,
        attempt,
        durationMs: result.durationMs,
      });
      return result;
    }
    lastResult = result;
    const retryable = attempt < policy.attempts && isRetryable(result);
    log.warn('tool invocation failed', {
      args: options.args,
      attempt,
      exitCode: result.exitCode,
      stderr: result.stderr.slice(0, 2_000),
      willRetry: retryable,
    });
    if (!retryable) break;
    await delay(backoffDelay(attempt, policy));
  }

  return lastResult as RunResult;
}

/**
 * Runs a managed binary and throws an {@link AgentshipError} unless it exited cleanly.
 *
 * The convenient form for callers with nothing smarter to say about a failure, such as the
 * toolchain's health check.
 */
export async function runTool(binaryPath: string, options: RunOptions): Promise<RunResult> {
  const toolName = options.toolName ?? binaryPath.split('/').pop() ?? binaryPath;
  const failed = await runToolRaw(binaryPath, options);
  if (failed.exitCode === 0) return failed;

  const code = options.mapExitCode?.(failed) ?? ERROR_CODES.TOOL_EXEC_FAILED;
  throw new AgentshipError(
    code,
    `${toolName} exited with code ${failed.exitCode}.${failed.stderr === '' ? '' : ` ${firstLine(failed.stderr)}`}`,
    {
      ...(options.store === undefined ? {} : { store: options.store }),
      details: {
        toolName,
        exitCode: failed.exitCode,
        args: options.args,
        stderr: failed.stderr.slice(0, 4_000),
      },
    },
  );
}

interface ExecaFailure {
  readonly timedOut?: boolean;
  readonly isMaxBuffer?: boolean;
  readonly isCanceled?: boolean;
  readonly exitCode?: number;
  readonly code?: string;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
}

async function runOnce(
  binaryPath: string,
  options: RunOptions,
  toolName: string,
  attempt: number,
): Promise<RunResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  const result = (await execa(binaryPath, [...options.args], {
    cwd: options.cwd ?? process.cwd(),
    env: buildEnv(options.env),
    extendEnv: false,
    timeout: timeoutMs,
    maxBuffer: maxOutputBytes,
    reject: false,
    encoding: 'utf8',
    stripFinalNewline: true,
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.cancelSignal === undefined ? {} : { cancelSignal: options.cancelSignal }),
  })) as unknown as ExecaFailure;

  const durationMs = Date.now() - startedAt;
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = redactString(typeof result.stderr === 'string' ? result.stderr : '');

  if (result.timedOut === true) {
    throw new AgentshipError(
      ERROR_CODES.TOOL_TIMEOUT,
      `${toolName} did not finish within ${timeoutMs} ms and was terminated.`,
      {
        ...(options.store === undefined ? {} : { store: options.store }),
        details: { toolName, timeoutMs, args: options.args },
      },
    );
  }
  if (result.isMaxBuffer === true) {
    throw new AgentshipError(
      ERROR_CODES.TOOL_OUTPUT_TOO_LARGE,
      `${toolName} produced more than ${maxOutputBytes} bytes of output.`,
      { details: { toolName, maxOutputBytes, args: options.args } },
    );
  }
  if (result.code === 'ENOENT') {
    throw new AgentshipError(
      ERROR_CODES.TOOL_NOT_INSTALLED,
      `${toolName} is not installed at ${binaryPath}.`,
      { remediation: { summary: 'Run `agentship doctor` to repair the managed toolchain.' } },
    );
  }

  return {
    stdout,
    stderr,
    exitCode: result.exitCode ?? (result.isCanceled === true ? 130 : 1),
    durationMs,
    attempts: attempt,
  };
}

/** Runs a managed binary and parses its stdout as JSON. */
export async function runToolJson<T = unknown>(
  binaryPath: string,
  options: RunOptions,
): Promise<T> {
  const result = await runTool(binaryPath, options);
  return parseToolJson<T>(result.stdout, options.toolName ?? binaryPath);
}

/** Parses tool output as JSON, failing with a redacted, bounded sample on error. */
export function parseToolJson<T = unknown>(stdout: string, toolName: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (cause) {
    throw AgentshipError.from(
      ERROR_CODES.TOOL_INVALID_OUTPUT,
      `${toolName} did not produce valid JSON.`,
      cause,
      { details: { toolName, sample: redactString(stdout.slice(0, 500)) } },
    );
  }
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}
