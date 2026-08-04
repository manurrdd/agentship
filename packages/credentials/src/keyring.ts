import { AgentshipError, ERROR_CODES, type Store } from '@agentship/core';

/**
 * Thin wrapper over the OS keyring.
 *
 * Agentship stores secrets only here — Keychain on macOS, the Secret Service on Linux, the
 * Credential Manager on Windows. There is deliberately no file-based fallback: a machine
 * without a keyring must use environment variables, which the operator controls, rather
 * than have Agentship silently invent a plaintext store.
 *
 * `@napi-rs/keyring` is loaded lazily so that a missing or unloadable native binding
 * degrades into "keyring unavailable, use the environment" instead of crashing at import
 * time — which would take down even the code paths that never touch a secret.
 */

const SERVICE = 'agentship';

/**
 * What a keyring entry can hold.
 *
 * Beyond the two store credentials there is one more secret Agentship custodies: the password
 * of an Android upload keystore. It is not a store credential — no API accepts it — but it
 * is exactly as sensitive, so it lives in the same place under its own kind rather than in
 * a file next to the keystore.
 */
export type SecretKind = Store | 'keystore';

/** One keyring entry per kind and profile. */
export function accountName(store: SecretKind, profile: string): string {
  return `${store}:${profile}`;
}

type EntryCtor = new (
  service: string,
  username: string,
) => {
  setPassword(password: string): Promise<void>;
  getPassword(): Promise<string | undefined>;
  deleteCredential(): Promise<boolean>;
};

let entryCtor: EntryCtor | undefined;
let loadFailure: unknown;

async function getEntryCtor(): Promise<EntryCtor> {
  if (entryCtor !== undefined) return entryCtor;
  if (loadFailure !== undefined) throw unavailable(loadFailure);
  try {
    const mod = (await import('@napi-rs/keyring')) as unknown as { AsyncEntry: EntryCtor };
    entryCtor = mod.AsyncEntry;
    return entryCtor;
  } catch (cause) {
    loadFailure = cause;
    throw unavailable(cause);
  }
}

function unavailable(cause: unknown): AgentshipError {
  return AgentshipError.from(
    ERROR_CODES.AUTH_KEYRING_UNAVAILABLE,
    'No OS keyring is available on this machine, so Agentship cannot store credentials securely.',
    cause,
    {
      remediation: {
        summary: 'Provide credentials through environment variables instead.',
        steps: [
          'Apple: set AGENTSHIP_APPLE_KEY_ID, AGENTSHIP_APPLE_ISSUER_ID and AGENTSHIP_APPLE_P8_PATH (or AGENTSHIP_APPLE_P8).',
          'Google: set AGENTSHIP_GOOGLE_SA_JSON_PATH (or AGENTSHIP_GOOGLE_SA_JSON).',
          'On a Linux desktop you can instead install and unlock a Secret Service provider such as gnome-keyring.',
        ],
      },
    },
  );
}

/** Errors that mean "there is no keyring here", as opposed to "this entry does not exist". */
const UNAVAILABLE_PATTERNS =
  /(no such interface|secret service|platform secure storage|not available|no keyring|dbus|org\.freedesktop\.secrets)/i;

/** Errors that mean "this entry does not exist". */
const NO_ENTRY_PATTERNS = /(no matching entry|no entry found|not found|nosuchentry)/i;

function mapKeyringError(cause: unknown, action: string, store: SecretKind): AgentshipError {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (UNAVAILABLE_PATTERNS.test(message)) return unavailable(cause);
  return AgentshipError.from(
    ERROR_CODES.AUTH_KEYRING_ERROR,
    `The OS keyring refused to ${action} the Agentship credential.`,
    cause,
    {
      ...(store === 'keystore' ? {} : { store }),
      remediation: {
        summary: 'Unlock the keyring and allow access for Agentship, then retry.',
      },
    },
  );
}

export async function keyringSet(
  store: SecretKind,
  profile: string,
  secret: string,
): Promise<void> {
  const Entry = await getEntryCtor();
  try {
    await new Entry(SERVICE, accountName(store, profile)).setPassword(secret);
  } catch (cause) {
    throw mapKeyringError(cause, 'store', store);
  }
}

export async function keyringGet(store: SecretKind, profile: string): Promise<string | undefined> {
  const Entry = await getEntryCtor();
  try {
    const value = await new Entry(SERVICE, accountName(store, profile)).getPassword();
    return value === null ? undefined : value;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (NO_ENTRY_PATTERNS.test(message)) return undefined;
    throw mapKeyringError(cause, 'read', store);
  }
}

/** Returns true when an entry existed and was removed. */
export async function keyringDelete(store: SecretKind, profile: string): Promise<boolean> {
  const Entry = await getEntryCtor();
  try {
    return await new Entry(SERVICE, accountName(store, profile)).deleteCredential();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (NO_ENTRY_PATTERNS.test(message)) return false;
    throw mapKeyringError(cause, 'delete', store);
  }
}

/** Cheap probe used by `doctor` to decide whether to suggest the environment fallback. */
export async function keyringAvailable(): Promise<boolean> {
  try {
    await keyringGet('apple', '__agentship_probe__');
    return true;
  } catch (error) {
    if (AgentshipError.is(error) && error.code === ERROR_CODES.AUTH_KEYRING_UNAVAILABLE)
      return false;
    // Any other failure means a keyring exists but is unhappy; that is a different problem.
    return true;
  }
}
