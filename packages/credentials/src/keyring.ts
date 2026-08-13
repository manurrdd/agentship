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

const DEFAULT_SERVICE = 'agentship';

/**
 * The keyring service every entry is filed under.
 *
 * Overridable through `AGENTSHIP_KEYRING_SERVICE` for one reason: without it there is no way
 * to run Agentship's own test suite without reading the developer's real credentials. That
 * is not a hypothetical — the suite failed on any machine that used Agentship, and because a
 * failed assertion prints the value it received, the diff put a real `.p8` private key on
 * the console. A namespace is the only part of the keyring worth making configurable; the
 * absence of a file-based fallback above is not.
 *
 * Read on every call rather than captured at import, so a test can isolate itself without
 * having to control module load order.
 */
function service(): string {
  const override = process.env['AGENTSHIP_KEYRING_SERVICE'];
  return override === undefined || override === '' ? DEFAULT_SERVICE : override;
}

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

export type KeyringEntryCtor = new (
  service: string,
  username: string,
) => {
  setPassword(password: string): Promise<void>;
  getPassword(): Promise<string | undefined>;
  deleteCredential(): Promise<boolean>;
};

let entryCtor: KeyringEntryCtor | undefined;
let loadFailure: unknown;

/**
 * Replaces the native keyring only inside a test process.
 *
 * Tests must never probe or write a developer's real credentials. Dependency injection is
 * safer than a magic environment fallback: production code cannot accidentally select an
 * in-memory store and report credentials as persisted when they will disappear on exit.
 */
export function setKeyringEntryCtorForTests(ctor: KeyringEntryCtor | undefined): void {
  if (process.env['NODE_ENV'] !== 'test') {
    throw new Error('A keyring test double can only be installed while NODE_ENV=test.');
  }
  entryCtor = ctor;
  loadFailure = undefined;
}

async function getEntryCtor(): Promise<KeyringEntryCtor> {
  if (entryCtor !== undefined) return entryCtor;
  if (loadFailure !== undefined) throw unavailable(loadFailure);
  try {
    const mod = (await import('@napi-rs/keyring')) as unknown as {
      AsyncEntry: KeyringEntryCtor;
    };
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
    await new Entry(service(), accountName(store, profile)).setPassword(secret);
  } catch (cause) {
    throw mapKeyringError(cause, 'store', store);
  }
}

export async function keyringGet(store: SecretKind, profile: string): Promise<string | undefined> {
  const Entry = await getEntryCtor();
  try {
    const value = await new Entry(service(), accountName(store, profile)).getPassword();
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
    return await new Entry(service(), accountName(store, profile)).deleteCredential();
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
