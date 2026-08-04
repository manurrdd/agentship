import { AgentshipError, DEFAULT_PROFILE, ERROR_CODES, registerSecret } from '@agentship/core';
import { keyringDelete, keyringGet, keyringSet } from './keyring.js';
import { assertProfileName } from './validate.js';

/**
 * The Android upload keystore's passwords.
 *
 * This is the third secret Agentship holds, and the only one that is not a store credential.
 * It matters more than it looks: with Play App Signing the upload key is replaceable — a
 * lost one is reset through a support request — but until the app is enrolled, the keystore
 * *is* the app's identity, and losing it means never being able to update that listing
 * again. Agentship therefore stores it in the OS keyring like any other secret, keeps the
 * keystore file itself out of the repository, and says all of this to the user when it
 * generates one.
 *
 * There is intentionally no environment-variable fallback here. Store credentials have one
 * because CI needs it; a keystore password in CI belongs in that CI's own secret store,
 * mounted as a file, not smuggled through Agentship.
 */
export interface KeystoreSecret {
  /** Password of the keystore file itself. */
  readonly storePassword: string;
  /** Password of the key inside it; usually the same, and defaulted to it when absent. */
  readonly keyPassword: string;
}

interface StoredKeystoreSecret {
  readonly storePassword: string;
  readonly keyPassword: string;
}

function resolveProfile(profile: string | undefined): string {
  const name = profile ?? DEFAULT_PROFILE;
  assertProfileName(name);
  return name;
}

/** Stores the keystore passwords for a profile, replacing anything already there. */
export async function setKeystoreSecret(
  secret: KeystoreSecret,
  options: { readonly profile?: string } = {},
): Promise<void> {
  const profile = resolveProfile(options.profile);
  if (secret.storePassword.length < 6) {
    throw new AgentshipError(
      ERROR_CODES.AUTH_INVALID_CREDENTIALS,
      'A keystore password must be at least six characters; keytool refuses anything shorter.',
    );
  }
  registerSecret(secret.storePassword);
  registerSecret(secret.keyPassword);
  const payload: StoredKeystoreSecret = {
    storePassword: secret.storePassword,
    keyPassword: secret.keyPassword,
  };
  await keyringSet('keystore', profile, JSON.stringify(payload));
}

/** Reads the keystore passwords, or `undefined` when the profile has none. */
export async function getKeystoreSecret(
  options: { readonly profile?: string } = {},
): Promise<KeystoreSecret | undefined> {
  const profile = resolveProfile(options.profile);
  const raw = await keyringGet('keystore', profile);
  if (raw === undefined) return undefined;
  let parsed: StoredKeystoreSecret;
  try {
    parsed = JSON.parse(raw) as StoredKeystoreSecret;
  } catch (cause) {
    throw AgentshipError.from(
      ERROR_CODES.AUTH_INVALID_CREDENTIALS,
      `The stored keystore secret for profile "${profile}" is not readable.`,
      cause,
      { remediation: { summary: 'Store the keystore passwords again.' } },
    );
  }
  if (typeof parsed.storePassword !== 'string' || parsed.storePassword === '') {
    throw new AgentshipError(
      ERROR_CODES.AUTH_INVALID_CREDENTIALS,
      `The stored keystore secret for profile "${profile}" has no store password.`,
    );
  }
  registerSecret(parsed.storePassword);
  registerSecret(parsed.keyPassword);
  return {
    storePassword: parsed.storePassword,
    keyPassword: parsed.keyPassword === '' ? parsed.storePassword : parsed.keyPassword,
  };
}

/** Reads the keystore passwords, or fails with an actionable error. */
export async function requireKeystoreSecret(
  options: { readonly profile?: string } = {},
): Promise<KeystoreSecret> {
  const secret = await getKeystoreSecret(options);
  if (secret === undefined) {
    throw new AgentshipError(
      ERROR_CODES.AUTH_MISSING_CREDENTIALS,
      `No Android keystore password is stored for profile "${options.profile ?? DEFAULT_PROFILE}".`,
      {
        store: 'google',
        remediation: {
          summary:
            'Store the upload keystore password with agentship_configure_auth (store: keystore), or let Agentship generate a keystore, which stores its password for you.',
        },
      },
    );
  }
  return secret;
}

export async function deleteKeystoreSecret(
  options: { readonly profile?: string } = {},
): Promise<boolean> {
  return keyringDelete('keystore', resolveProfile(options.profile));
}
