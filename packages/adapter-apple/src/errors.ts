import {
  AgentshipError,
  type AgentshipErrorCode,
  ERROR_CODES,
  type RunResult,
} from '@agentship/core';

/**
 * Turning an `asc` failure into an Agentship error.
 *
 * `asc` writes failures to stderr as prose (`Error: <what>` plus an optional `Hint:` line)
 * and exits non-zero. Its exit codes are coarse — verified on 3.4.1: `2` for a usage or
 * flag error, `3` for anything that came back from App Store Connect, including
 * authentication — so the exit code alone cannot distinguish a 401 from a 404.
 *
 * Classification therefore reads the message, with the exit code as the fallback. That is
 * deliberate rather than fragile: the alternative is to report every store failure as one
 * opaque code, which would make remediation impossible and would push the guesswork up
 * into the agent, where it belongs even less.
 */

/** Exit codes observed on asc 3.4.1. */
export const ASC_EXIT = {
  ok: 0,
  usage: 2,
  /** Anything that reached (or failed to reach) App Store Connect. */
  api: 3,
} as const;

interface Signature {
  readonly pattern: RegExp;
  readonly code: AgentshipErrorCode;
  readonly remediation?: { summary: string; steps?: string[]; docsUrl?: string };
}

/**
 * Ordered most specific first. Every pattern matches text `asc` actually emits, either
 * verbatim from Apple's API error payload (`asc` forwards Apple's `title: detail`) or from
 * its own wrapper.
 */
const SIGNATURES: readonly Signature[] = [
  {
    // Apple's own 401 body. It must be matched before the "no credentials configured" rule
    // below, whose wording it overlaps — the two need opposite remediations, and telling
    // someone to configure a key they already configured is worse than saying nothing.
    pattern:
      /Authentication credentials are missing or invalid|NOT_AUTHORIZED|invalid.{0,20}bearer token|token.{0,20}expired/i,
    code: ERROR_CODES.STORE_UNAUTHORIZED,
    remediation: {
      summary: 'The stored App Store Connect key was rejected. Re-create and re-configure it.',
      steps: [
        'Check that the key has not been revoked in App Store Connect → Users and Access → Integrations.',
        'If it was revoked, create a new team API key and store it with `agentship_configure_auth`.',
      ],
      docsUrl: 'https://developer.apple.com/documentation/appstoreconnectapi',
    },
  },
  {
    // `asc`'s own wrapper when nothing supplied a key at all.
    pattern: /missing authentication|no credentials found/i,
    code: ERROR_CODES.AUTH_MISSING_CREDENTIALS,
    remediation: {
      summary: 'Configure App Store Connect credentials for this profile.',
      steps: [
        'Create a team API key in App Store Connect → Users and Access → Integrations → App Store Connect API.',
        'Store it with the `agentship_configure_auth` tool (key id, issuer id and the .p8 file).',
      ],
      docsUrl: 'https://appstoreconnect.apple.com/access/integrations/api',
    },
  },
  {
    pattern:
      /FORBIDDEN|not permitted|insufficient (?:permissions|privileges)|requires the .* role/i,
    code: ERROR_CODES.AUTH_PERMISSION_DENIED,
    remediation: {
      summary: 'The API key role is too narrow for this operation.',
      steps: ['Re-create the key with at least the App Manager role, then reconfigure Agentship.'],
    },
  },
  {
    pattern: /agreement|contract.{0,30}(?:not|missing|pending)|Paid Applications/i,
    code: ERROR_CODES.STORE_REJECTED,
    remediation: {
      summary:
        'A required Apple agreement is not in place. Only an Account Holder can accept it, in the App Store Connect console.',
      docsUrl: 'https://appstoreconnect.apple.com/agreements',
    },
  },
  {
    pattern: /\b429\b|rate ?limit|too many requests/i,
    code: ERROR_CODES.STORE_RATE_LIMITED,
  },
  {
    pattern: /\b(?:500|502|503|504)\b|service unavailable|temporarily unavailable|try again later/i,
    code: ERROR_CODES.STORE_UNAVAILABLE,
  },
  {
    pattern: /\b409\b|STATE_ERROR|conflict|cannot be modified in its current state/i,
    code: ERROR_CODES.STORE_CONFLICT,
  },
  {
    pattern: /\b404\b|not found|does not exist|NOT_FOUND/i,
    code: ERROR_CODES.STORE_NOT_FOUND,
  },
  {
    pattern: /ENTITY_ERROR|validation|invalid (?:value|attribute|parameter)|\b400\b/i,
    code: ERROR_CODES.STORE_VALIDATION_FAILED,
  },
  {
    pattern: /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|no such host|dial tcp|network is/i,
    code: ERROR_CODES.STORE_UNAVAILABLE,
  },
];

/** Maps an `asc` failure onto an Agentship error code. */
export function classifyAscFailure(result: RunResult): AgentshipErrorCode {
  const text = `${result.stderr}\n${result.stdout}`;
  for (const signature of SIGNATURES) {
    if (signature.pattern.test(text)) return signature.code;
  }
  if (result.exitCode === ASC_EXIT.usage) return ERROR_CODES.TOOL_EXEC_FAILED;
  if (result.exitCode === ASC_EXIT.api) return ERROR_CODES.STORE_VALIDATION_FAILED;
  return ERROR_CODES.TOOL_EXEC_FAILED;
}

/** Builds the error a failed `asc` invocation raises. */
export function ascError(args: readonly string[], result: RunResult): AgentshipError {
  const code = classifyAscFailure(result);
  const remediation = SIGNATURES.find(
    (s) => s.code === code && s.pattern.test(result.stderr),
  )?.remediation;
  return new AgentshipError(code, `asc ${describe(args)} failed: ${summarise(result)}`, {
    store: 'apple',
    ...(remediation === undefined ? {} : { remediation }),
    details: {
      command: args,
      exitCode: result.exitCode,
      // `RunResult.stderr` is redacted by the shared runner before it reaches here.
      stderr: result.stderr.slice(0, 4_000),
    },
  });
}

/** True when the failure is worth retrying without any operator action. */
export function isRetryableAscFailure(result: RunResult): boolean {
  const code = classifyAscFailure(result);
  return code === ERROR_CODES.STORE_RATE_LIMITED || code === ERROR_CODES.STORE_UNAVAILABLE;
}

/** The subcommand path, for error messages: `versions phased-release update`. */
function describe(args: readonly string[]): string {
  const words: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('-')) break;
    words.push(arg);
  }
  return words.join(' ') || '(no subcommand)';
}

function summarise(result: RunResult): string {
  const line = result.stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('Error:') || l !== '');
  const cleaned = (line ?? `exit code ${result.exitCode}`).replace(/^Error:\s*/, '');
  return cleaned.length > 400 ? `${cleaned.slice(0, 400)}…` : cleaned;
}
