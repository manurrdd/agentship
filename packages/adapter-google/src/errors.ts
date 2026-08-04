import {
  AgentshipError,
  type AgentshipErrorCode,
  ERROR_CODES,
  type RunResult,
} from '@agentship/core';

/**
 * Turning a `gpc` failure into an Agentship error.
 *
 * `gpc` is well behaved here, which is why this file is a table rather than a heuristic: it
 * writes `Error [CODE]: message` and an optional `Suggestion:` line to stderr, keeps stdout
 * clean, and carries the error family in the exit code. Both are used — the code names the
 * exact condition, the exit code classifies anything the table does not list yet.
 *
 * Verified on gpc 0.9.93.
 */

/** Exit codes `gpc` assigns per error class. */
export const GPC_EXIT = {
  ok: 0,
  /** `GpcError`: an operation-level failure with no more specific class. */
  generic: 1,
  /** Usage, validation and missing-argument errors. */
  validation: 2,
  /** `AuthError`. */
  auth: 3,
  /** `PlayApiError`: something the Google Play Developer API returned. */
  api: 4,
  /** `NetworkError`. */
  network: 5,
} as const;

/** Structured form of a `gpc` failure, as printed on stderr. */
export interface GpcFailure {
  readonly code: string | undefined;
  readonly message: string;
  readonly suggestion: string | undefined;
}

// Deliberately line-scoped: the code drives classification, and anchoring the message to
// one line keeps a multi-line failure (a character-limit report, say) from swallowing the
// `Suggestion:` that follows it — and keeps parsing working when there is no trailing
// newline at all.
const ERROR_LINE = /^Error\s*\[([A-Z0-9_]+)\]:[ \t]*(.*)$/m;
const SUGGESTION_LINE = /^Suggestion:[ \t]*(.*)$/m;

/** Reads the `Error [CODE]: …` / `Suggestion: …` pair `gpc` prints on failure. */
export function parseGpcFailure(stderr: string): GpcFailure {
  const error = ERROR_LINE.exec(stderr);
  const suggestion = SUGGESTION_LINE.exec(stderr);
  return {
    code: error?.[1],
    message: (error?.[2] ?? firstLine(stderr)).trim(),
    suggestion: suggestion?.[1]?.trim(),
  };
}

/**
 * `gpc` error code → Agentship error code.
 *
 * Extracted from the binary's own catalog, so a code that disappears upstream shows up as
 * an unmapped fallback rather than as a wrong classification.
 */
const CODE_MAP: Readonly<Record<string, AgentshipErrorCode>> = {
  // --- credentials ---
  AUTH_NO_CREDENTIALS: ERROR_CODES.AUTH_MISSING_CREDENTIALS,
  AUTH_FILE_NOT_FOUND: ERROR_CODES.AUTH_MISSING_CREDENTIALS,
  AUTH_INVALID_KEY: ERROR_CODES.AUTH_INVALID_CREDENTIALS,
  AUTH_TOKEN_FAILED: ERROR_CODES.AUTH_INVALID_CREDENTIALS,
  AUTH_CACHE_INVALID: ERROR_CODES.AUTH_INVALID_CREDENTIALS,
  API_UNAUTHORIZED: ERROR_CODES.STORE_UNAUTHORIZED,
  API_FORBIDDEN: ERROR_CODES.AUTH_PERMISSION_DENIED,
  API_INSUFFICIENT_PERMISSIONS: ERROR_CODES.AUTH_PERMISSION_DENIED,
  // --- the app or a resource ---
  API_APP_NOT_FOUND: ERROR_CODES.STORE_NOT_FOUND,
  API_NOT_FOUND: ERROR_CODES.STORE_NOT_FOUND,
  API_TRACK_NOT_FOUND: ERROR_CODES.STORE_NOT_FOUND,
  BUNDLE_NOT_FOUND: ERROR_CODES.STORE_NOT_FOUND,
  RELEASE_NOT_FOUND: ERROR_CODES.STORE_NOT_FOUND,
  ROLLOUT_NOT_FOUND: ERROR_CODES.STORE_NOT_FOUND,
  // --- the edit ---
  API_CHANGES_ALREADY_IN_REVIEW: ERROR_CODES.STORE_CONFLICT,
  API_CHANGES_NOT_SENT_FOR_REVIEW: ERROR_CODES.STORE_CONFLICT,
  API_EDIT_CONFLICT: ERROR_CODES.STORE_CONFLICT,
  API_EDIT_EXPIRED: ERROR_CODES.STORE_CONFLICT,
  EDIT_CREATE_FAILED: ERROR_CODES.STORE_CONFLICT,
  // --- what we sent ---
  API_INVALID_INPUT: ERROR_CODES.STORE_VALIDATION_FAILED,
  API_INVALID_BUNDLE: ERROR_CODES.STORE_VALIDATION_FAILED,
  API_INVALID_PATH: ERROR_CODES.STORE_VALIDATION_FAILED,
  API_BUNDLE_TOO_LARGE: ERROR_CODES.STORE_VALIDATION_FAILED,
  API_DUPLICATE_VERSION_CODE: ERROR_CODES.STORE_CONFLICT,
  API_VERSION_CODE_TOO_LOW: ERROR_CODES.STORE_VALIDATION_FAILED,
  API_RELEASE_NOTES_TOO_LONG: ERROR_CODES.STORE_VALIDATION_FAILED,
  API_PACKAGE_NAME_MISMATCH: ERROR_CODES.STORE_VALIDATION_FAILED,
  API_ROLLOUT_DECREASE_FORBIDDEN: ERROR_CODES.STORE_REJECTED,
  API_ROLLOUT_ALREADY_COMPLETED: ERROR_CODES.STORE_CONFLICT,
  API_PRICING_UNAVAILABLE: ERROR_CODES.STORE_UNSUPPORTED_OPERATION,
  IMAGE_INVALID: ERROR_CODES.STORE_VALIDATION_FAILED,
  LISTING_CHAR_LIMIT_EXCEEDED: ERROR_CODES.STORE_VALIDATION_FAILED,
  // --- transient ---
  API_RATE_LIMITED: ERROR_CODES.STORE_RATE_LIMITED,
  API_SERVER_ERROR: ERROR_CODES.STORE_UNAVAILABLE,
  API_TIMEOUT: ERROR_CODES.STORE_UNAVAILABLE,
  API_NETWORK_ERROR: ERROR_CODES.STORE_UNAVAILABLE,
  NETWORK_ERROR: ERROR_CODES.STORE_UNAVAILABLE,
  API_EMPTY_RESPONSE: ERROR_CODES.STORE_UNAVAILABLE,
  // --- local ---
  MISSING_PACKAGE: ERROR_CODES.CONFIG_INVALID,
  CONFIG_INVALID_JSON: ERROR_CODES.CONFIG_INVALID,
  CONFIG_INVALID_KEY: ERROR_CODES.CONFIG_INVALID,
  CONFIG_INVALID_VALUE: ERROR_CODES.CONFIG_INVALID,
  CONFIG_PROFILE_NOT_FOUND: ERROR_CODES.CONFIG_NOT_FOUND,
};

const EXIT_MAP: Readonly<Record<number, AgentshipErrorCode>> = {
  [GPC_EXIT.generic]: ERROR_CODES.TOOL_EXEC_FAILED,
  [GPC_EXIT.validation]: ERROR_CODES.STORE_VALIDATION_FAILED,
  [GPC_EXIT.auth]: ERROR_CODES.AUTH_INVALID_CREDENTIALS,
  [GPC_EXIT.api]: ERROR_CODES.STORE_VALIDATION_FAILED,
  [GPC_EXIT.network]: ERROR_CODES.STORE_UNAVAILABLE,
};

export function classifyGpcFailure(result: RunResult): AgentshipErrorCode {
  const failure = parseGpcFailure(result.stderr);
  const mapped = failure.code === undefined ? undefined : CODE_MAP[failure.code];
  return mapped ?? EXIT_MAP[result.exitCode] ?? ERROR_CODES.TOOL_EXEC_FAILED;
}

/**
 * Remediation for the failures a user can actually act on.
 *
 * `API_CHANGES_ALREADY_IN_REVIEW` deserves special care: Agentship asks for
 * `--error-if-in-review`, so reaching this error means Google is holding a review that
 * committing would have cancelled. The user has to choose, and the message says so.
 */
const REMEDIATIONS: Readonly<
  Record<string, { summary: string; steps?: string[]; docsUrl?: string }>
> = {
  API_CHANGES_ALREADY_IN_REVIEW: {
    summary:
      'A review is already in progress for this app. Agentship refused to commit because committing would have cancelled it.',
    steps: [
      'Wait for the current review to finish, then re-run.',
      'Or approve cancelling the running review, and Agentship will commit over it.',
      'Or stage the changes without submitting them for review.',
    ],
  },
  API_CHANGES_NOT_SENT_FOR_REVIEW: {
    summary:
      'Google requires this app to commit without sending changes for review, which happens after a rejection.',
    steps: ['Re-run asking Agentship to commit without review, then submit from Play Console.'],
  },
  API_FORBIDDEN: {
    summary: 'The service account lacks permission for this app.',
    steps: [
      'In Play Console → Users and permissions, invite the service account e-mail.',
      'Grant at least "Release to testing tracks" and "Edit store listing" for this app.',
    ],
    docsUrl: 'https://play.google.com/console/developers/users-and-permissions',
  },
  API_INSUFFICIENT_PERMISSIONS: {
    summary: 'The service account is invited but its permissions are too narrow.',
    docsUrl: 'https://play.google.com/console/developers/users-and-permissions',
  },
  AUTH_NO_CREDENTIALS: {
    summary: 'Configure a Google Play service account for this profile.',
    docsUrl: 'https://developers.google.com/android-publisher/getting_started',
  },
  API_APP_NOT_FOUND: {
    summary:
      'Google Play has no app with this package name, or the service account cannot see it. The app and its first release must be created in Play Console.',
    docsUrl: 'https://play.google.com/console',
  },
  API_VERSION_CODE_TOO_LOW: {
    summary:
      'Google Play requires a version code higher than every code already uploaded. Increase versionCode and rebuild.',
  },
  API_DUPLICATE_VERSION_CODE: {
    summary: 'This version code was already uploaded. Increase versionCode and rebuild.',
  },
};

export function gpcError(args: readonly string[], result: RunResult): AgentshipError {
  const failure = parseGpcFailure(result.stderr);
  const code = classifyGpcFailure(result);
  const remediation =
    failure.code === undefined
      ? undefined
      : (REMEDIATIONS[failure.code] ??
        (failure.suggestion === undefined ? undefined : { summary: failure.suggestion }));

  return new AgentshipError(code, `gpc ${describe(args)} failed: ${failure.message}`, {
    store: 'google',
    ...(remediation === undefined ? {} : { remediation }),
    details: {
      command: args,
      exitCode: result.exitCode,
      gpcCode: failure.code,
      // `RunResult.stderr` is redacted by the shared runner before it reaches here.
      stderr: result.stderr.slice(0, 4_000),
    },
  });
}

export function isRetryableGpcFailure(result: RunResult): boolean {
  const code = classifyGpcFailure(result);
  return code === ERROR_CODES.STORE_RATE_LIMITED || code === ERROR_CODES.STORE_UNAVAILABLE;
}

/** Program-level flags Agentship puts before the subcommand, and whether they take a value. */
const GLOBAL_FLAGS: Readonly<Record<string, boolean>> = {
  '--app': true,
  '--output': true,
  '--profile': true,
  '--no-interactive': false,
  '--no-color': false,
  '--yes': false,
  '--dry-run': false,
};

/**
 * The subcommand path, for error messages: `listings images sync`.
 *
 * Skips exactly the global prefix Agentship emits, so a package name is never mistaken for a
 * subcommand and a boolean flag never swallows the word after it.
 */
export function describe(args: readonly string[]): string {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === undefined || !(arg in GLOBAL_FLAGS)) break;
    index += GLOBAL_FLAGS[arg] === true ? 2 : 1;
  }
  const words: string[] = [];
  for (; index < args.length && words.length < 3; index++) {
    const arg = args[index] ?? '';
    if (arg.startsWith('-')) break;
    words.push(arg);
  }
  return words.join(' ') || '(no subcommand)';
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? ''
  );
}
