import type { Store } from './types.js';

/**
 * Catalog of every error code Agentship can raise.
 *
 * Codes are grouped in families by prefix so that agents can react to a class of failure
 * without enumerating every member:
 *
 * - `AUTH_*`    — credentials: missing, invalid, unreachable keychain.
 * - `TOOL_*`    — internal binaries: platform support, download, integrity, execution.
 * - `BUILD_*`   — compiling and signing the user's app on this machine.
 * - `STORE_*`   — App Store Connect / Google Play responses.
 * - `ANALYZE_*` — static analysis of a user repository.
 * - `PLAN_*`    — kernel: plan, approvals, journal, resume.
 * - `CONFIG_*`  — Agentship configuration and project manifest.
 *
 * The catalog is a plain object (not an enum) so the compiled output stays erasable.
 */
export const ERROR_CODES = {
  // --- AUTH -------------------------------------------------------------------
  /** No credentials stored or exported for the requested store/profile. */
  AUTH_MISSING_CREDENTIALS: 'AUTH_MISSING_CREDENTIALS',
  /** Credentials are present but malformed (bad PEM, wrong JSON shape, bad id format). */
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  /** The OS keyring is not available (e.g. Linux without a secret service). */
  AUTH_KEYRING_UNAVAILABLE: 'AUTH_KEYRING_UNAVAILABLE',
  /** The OS keyring exists but the operation failed (locked, denied, backend error). */
  AUTH_KEYRING_ERROR: 'AUTH_KEYRING_ERROR',
  /** The named credential profile does not exist. */
  AUTH_PROFILE_NOT_FOUND: 'AUTH_PROFILE_NOT_FOUND',
  /** Environment fallback is partially configured (some variables set, others missing). */
  AUTH_ENV_INCOMPLETE: 'AUTH_ENV_INCOMPLETE',
  /** The store rejected the credentials' permissions (role too narrow). */
  AUTH_PERMISSION_DENIED: 'AUTH_PERMISSION_DENIED',

  // --- TOOL -------------------------------------------------------------------
  /** The current OS/architecture is not supported by Agentship (e.g. Windows in v1). */
  TOOL_PLATFORM_UNSUPPORTED: 'TOOL_PLATFORM_UNSUPPORTED',
  /** The tool name is not part of Agentship's managed toolchain. */
  TOOL_UNKNOWN: 'TOOL_UNKNOWN',
  /** The embedded lockfile has no entry for this tool on this platform. */
  TOOL_LOCK_ENTRY_MISSING: 'TOOL_LOCK_ENTRY_MISSING',
  /** The tool is not installed and installation was not requested. */
  TOOL_NOT_INSTALLED: 'TOOL_NOT_INSTALLED',
  /** Download failed after all retries (network, HTTP status, truncated stream). */
  TOOL_DOWNLOAD_FAILED: 'TOOL_DOWNLOAD_FAILED',
  /** The downloaded artifact's SHA-256 does not match the embedded lockfile. */
  TOOL_CHECKSUM_MISMATCH: 'TOOL_CHECKSUM_MISMATCH',
  /** The download exceeded the size declared in the lockfile (plus tolerance). */
  TOOL_SIZE_EXCEEDED: 'TOOL_SIZE_EXCEEDED',
  /** Another Agentship process holds the install lock for this tool for too long. */
  TOOL_LOCK_TIMEOUT: 'TOOL_LOCK_TIMEOUT',
  /** The freshly installed binary failed its `--version` health check. */
  TOOL_HEALTHCHECK_FAILED: 'TOOL_HEALTHCHECK_FAILED',
  /** An installed version is missing, truncated or has the wrong hash. */
  TOOL_INSTALL_CORRUPT: 'TOOL_INSTALL_CORRUPT',
  /** No previous version is kept, so a rollback is impossible. */
  TOOL_ROLLBACK_UNAVAILABLE: 'TOOL_ROLLBACK_UNAVAILABLE',
  /** A managed binary exited non-zero for a reason with no more specific mapping. */
  TOOL_EXEC_FAILED: 'TOOL_EXEC_FAILED',
  /** A managed binary exceeded its wall-clock timeout and was killed. */
  TOOL_TIMEOUT: 'TOOL_TIMEOUT',
  /** A managed binary produced more output than the configured limit. */
  TOOL_OUTPUT_TOO_LARGE: 'TOOL_OUTPUT_TOO_LARGE',
  /** A managed binary produced output that is not the expected JSON. */
  TOOL_INVALID_OUTPUT: 'TOOL_INVALID_OUTPUT',
  /** The installed binary reports a version other than the one pinned in the lockfile. */
  TOOL_VERSION_DRIFT: 'TOOL_VERSION_DRIFT',

  // --- BUILD ------------------------------------------------------------------
  /** The host OS cannot produce this artifact at all (an .ipa outside macOS). */
  BUILD_PLATFORM_UNSUPPORTED: 'BUILD_PLATFORM_UNSUPPORTED',
  /** A build tool the project needs is not installed (Xcode, a JDK, the Flutter SDK). */
  BUILD_TOOL_MISSING: 'BUILD_TOOL_MISSING',
  /** Agentship has no builder for this project shape (Expo managed without native folders). */
  BUILD_UNSUPPORTED_PROJECT: 'BUILD_UNSUPPORTED_PROJECT',
  /** A value the build needs is missing (scheme, module, keystore alias). */
  BUILD_INPUT_REQUIRED: 'BUILD_INPUT_REQUIRED',
  /** The build tool exited non-zero for a reason with no more specific mapping. */
  BUILD_FAILED: 'BUILD_FAILED',
  /** Code signing failed: no certificate, no profile, or the store refused to issue one. */
  BUILD_SIGNING_FAILED: 'BUILD_SIGNING_FAILED',
  /** The build produced no artifact, or one whose metadata contradicts the manifest. */
  BUILD_ARTIFACT_INVALID: 'BUILD_ARTIFACT_INVALID',

  // --- STORE ------------------------------------------------------------------
  /** The store rejected the request as unauthenticated. */
  STORE_UNAUTHORIZED: 'STORE_UNAUTHORIZED',
  /** The requested resource does not exist in the store. */
  STORE_NOT_FOUND: 'STORE_NOT_FOUND',
  /** The store throttled the request (HTTP 429). */
  STORE_RATE_LIMITED: 'STORE_RATE_LIMITED',
  /** The store is temporarily unavailable (5xx, maintenance). */
  STORE_UNAVAILABLE: 'STORE_UNAVAILABLE',
  /** The store rejected the payload as invalid. */
  STORE_VALIDATION_FAILED: 'STORE_VALIDATION_FAILED',
  /** The remote state changed under us (edit expired, version conflict). */
  STORE_CONFLICT: 'STORE_CONFLICT',
  /** The store has no API for the requested operation; a pending operation is emitted. */
  STORE_UNSUPPORTED_OPERATION: 'STORE_UNSUPPORTED_OPERATION',
  /** The store refused the operation for policy reasons. */
  STORE_REJECTED: 'STORE_REJECTED',

  // --- ANALYZE ----------------------------------------------------------------
  /** The path to analyze does not exist. */
  ANALYZE_PATH_NOT_FOUND: 'ANALYZE_PATH_NOT_FOUND',
  /** The path to analyze is not a directory. */
  ANALYZE_NOT_A_DIRECTORY: 'ANALYZE_NOT_A_DIRECTORY',
  /** No supported framework could be identified in the repository. */
  ANALYZE_FRAMEWORK_UNKNOWN: 'ANALYZE_FRAMEWORK_UNKNOWN',
  /** A traversal/size/depth limit was hit while scanning the repository. */
  ANALYZE_LIMIT_EXCEEDED: 'ANALYZE_LIMIT_EXCEEDED',
  /** The repository could not be read (permissions, I/O). */
  ANALYZE_UNREADABLE: 'ANALYZE_UNREADABLE',

  // --- PLAN -------------------------------------------------------------------
  /** A step requires an approval that has not been granted. */
  PLAN_APPROVAL_REQUIRED: 'PLAN_APPROVAL_REQUIRED',
  /** The granted approval no longer matches the content hash it was bound to. */
  PLAN_APPROVAL_STALE: 'PLAN_APPROVAL_STALE',
  /** A step requires a value the user has not supplied. */
  PLAN_INPUT_REQUIRED: 'PLAN_INPUT_REQUIRED',
  /** The plan is inconsistent with the observed remote state. */
  PLAN_CONFLICT: 'PLAN_CONFLICT',
  /** The write-ahead journal is unreadable or inconsistent. */
  PLAN_JOURNAL_CORRUPT: 'PLAN_JOURNAL_CORRUPT',
  /** No plan with the given identifier exists. */
  PLAN_NOT_FOUND: 'PLAN_NOT_FOUND',
  /** A plan step failed during execution; the plan is resumable. */
  PLAN_STEP_FAILED: 'PLAN_STEP_FAILED',
  /** Another Agentship process holds this project's apply lock. */
  PLAN_LOCKED: 'PLAN_LOCKED',

  // --- CONFIG -----------------------------------------------------------------
  /** Agentship user configuration failed validation. */
  CONFIG_INVALID: 'CONFIG_INVALID',
  /** A required configuration file is missing. */
  CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
  /** `AGENTSHIP_HOME` could not be created or is not writable with safe permissions. */
  CONFIG_HOME_UNWRITABLE: 'CONFIG_HOME_UNWRITABLE',
  /** The project manifest (`.agentship/agentship.yaml`) failed validation. */
  CONFIG_MANIFEST_INVALID: 'CONFIG_MANIFEST_INVALID',
  /** The configuration/manifest schema version is not supported by this Agentship. */
  CONFIG_UNSUPPORTED_VERSION: 'CONFIG_UNSUPPORTED_VERSION',
} as const;

export type AgentshipErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ErrorFamily = 'AUTH' | 'TOOL' | 'BUILD' | 'STORE' | 'ANALYZE' | 'PLAN' | 'CONFIG';

/** Returns the family prefix of an error code. */
export function errorFamily(code: AgentshipErrorCode): ErrorFamily {
  return code.slice(0, code.indexOf('_')) as ErrorFamily;
}

/**
 * Codes that are worth retrying with backoff without any operator action.
 * Everything else is treated as terminal unless the caller says otherwise.
 */
const RETRYABLE_CODES: ReadonlySet<string> = new Set<AgentshipErrorCode>([
  ERROR_CODES.STORE_RATE_LIMITED,
  ERROR_CODES.STORE_UNAVAILABLE,
  ERROR_CODES.TOOL_DOWNLOAD_FAILED,
  ERROR_CODES.TOOL_TIMEOUT,
  ERROR_CODES.TOOL_LOCK_TIMEOUT,
]);

/** Actionable guidance attached to an error, aimed at an agent talking to a human. */
export interface Remediation {
  /** One sentence describing what to do. */
  readonly summary: string;
  /** Ordered concrete steps, when the fix is not a one-liner. */
  readonly steps?: readonly string[];
  /** Official documentation backing the remediation. */
  readonly docsUrl?: string;
}

export interface AgentshipErrorOptions {
  readonly store?: Store;
  /** Overrides the default derived from {@link RETRYABLE_CODES}. */
  readonly retryable?: boolean;
  readonly remediation?: Remediation;
  readonly cause?: unknown;
  /**
   * Extra machine-readable context. Must never contain secrets: this object is
   * serialised into logs and MCP responses.
   */
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * The only error type Agentship throws across package boundaries.
 *
 * Messages are written for an agent to relay to a human: what failed, and — through
 * {@link Remediation} — what to do next. Secrets must never reach `message` or `details`;
 * the logger redacts defensively, but the invariant belongs to the thrower.
 */
export class AgentshipError extends Error {
  override readonly name = 'AgentshipError';
  readonly code: AgentshipErrorCode;
  readonly store: Store | undefined;
  readonly retryable: boolean;
  readonly remediation: Remediation | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: AgentshipErrorCode, message: string, options: AgentshipErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.store = options.store;
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(code);
    this.remediation = options.remediation;
    this.details = options.details;
  }

  get family(): ErrorFamily {
    return errorFamily(this.code);
  }

  /** Structured form used by the logger and, later, by MCP tool responses. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.store === undefined ? {} : { store: this.store }),
      ...(this.remediation === undefined ? {} : { remediation: this.remediation }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }

  static is(value: unknown): value is AgentshipError {
    return value instanceof AgentshipError;
  }

  /** Wraps an unknown thrown value, preserving it as `cause`. */
  static from(
    code: AgentshipErrorCode,
    message: string,
    cause: unknown,
    options: Omit<AgentshipErrorOptions, 'cause'> = {},
  ): AgentshipError {
    if (cause instanceof AgentshipError) return cause;
    return new AgentshipError(code, message, { ...options, cause });
  }
}
