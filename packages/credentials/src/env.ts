import { readFile } from 'node:fs/promises';
import { AgentshipError, ERROR_CODES, registerSecret, type Store } from '@agentship/core';
import type { AppleCredentials, GoogleCredentials } from './types.js';
import {
  assertAppleIssuerId,
  assertAppleKeyId,
  assertApplePrivateKey,
  parseServiceAccountJson,
} from './validate.js';

/**
 * Read-only credential source for CI and containers.
 *
 * Environment variables always win over the keyring: a pipeline that exports credentials
 * must not silently pick up a developer's stored ones, and an operator overriding a profile
 * on purpose should not have to delete anything first. Callers surface the override as a
 * warning so the precedence is never a surprise.
 *
 * The environment fallback is deliberately profile-agnostic — a CI job runs one identity.
 */

export const APPLE_ENV = {
  keyId: 'AGENTSHIP_APPLE_KEY_ID',
  issuerId: 'AGENTSHIP_APPLE_ISSUER_ID',
  p8: 'AGENTSHIP_APPLE_P8',
  p8Path: 'AGENTSHIP_APPLE_P8_PATH',
} as const;

export const GOOGLE_ENV = {
  saJson: 'AGENTSHIP_GOOGLE_SA_JSON',
  saJsonPath: 'AGENTSHIP_GOOGLE_SA_JSON_PATH',
} as const;

/** Environment variable names Agentship reads, for `doctor` and documentation. */
export const CREDENTIAL_ENV_VARS: Readonly<Record<Store, readonly string[]>> = {
  apple: Object.values(APPLE_ENV),
  google: Object.values(GOOGLE_ENV),
};

function read(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value;
}

/** True when any variable of the store's group is set. */
export function envConfigured(store: Store): boolean {
  return CREDENTIAL_ENV_VARS[store].some((name) => read(name) !== undefined);
}

function incomplete(store: Store, missing: readonly string[]): AgentshipError {
  return new AgentshipError(
    ERROR_CODES.AUTH_ENV_INCOMPLETE,
    `${store === 'apple' ? 'Apple' : 'Google'} credentials are partially configured in the environment: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing.`,
    {
      store,
      remediation: {
        summary: `Set ${missing.join(' and ')}, or unset the whole group to fall back to the OS keyring.`,
      },
    },
  );
}

/**
 * Reads credential material from a file on this machine.
 *
 * Shared by the CI environment fallback and by `agentship_configure_auth` when the user
 * hands over a path instead of pasting the secret — the path route is preferred there,
 * because the secret then never travels through a conversation.
 */
export async function readCredentialFile(
  path: string,
  store: Store,
  what: string,
): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (cause) {
    throw AgentshipError.from(
      ERROR_CODES.AUTH_INVALID_CREDENTIALS,
      `Could not read the ${what} at ${path}.`,
      cause,
      { store, remediation: { summary: 'Check the path and that the file is readable.' } },
    );
  }
}

async function readMaterial(
  inline: string | undefined,
  path: string | undefined,
  store: Store,
  what: string,
): Promise<string | undefined> {
  if (inline !== undefined) return inline;
  if (path === undefined) return undefined;
  return readCredentialFile(path, store, what);
}

/** Builds Apple credentials from the environment, or `undefined` when none are set. */
export async function appleFromEnv(): Promise<AppleCredentials | undefined> {
  if (!envConfigured('apple')) return undefined;

  const keyId = read(APPLE_ENV.keyId);
  const issuerId = read(APPLE_ENV.issuerId);
  const pem = await readMaterial(
    read(APPLE_ENV.p8),
    read(APPLE_ENV.p8Path),
    'apple',
    'App Store Connect private key',
  );

  const missing: string[] = [];
  if (keyId === undefined) missing.push(APPLE_ENV.keyId);
  if (issuerId === undefined) missing.push(APPLE_ENV.issuerId);
  if (pem === undefined) missing.push(`${APPLE_ENV.p8} or ${APPLE_ENV.p8Path}`);
  if (missing.length > 0) throw incomplete('apple', missing);

  assertAppleKeyId(keyId as string);
  assertAppleIssuerId(issuerId as string);
  assertApplePrivateKey(pem as string);
  registerSecret(pem);

  return {
    store: 'apple',
    keyId: keyId as string,
    issuerId: issuerId as string,
    privateKeyPem: (pem as string).trim(),
  };
}

/** Builds Google credentials from the environment, or `undefined` when none are set. */
export async function googleFromEnv(): Promise<GoogleCredentials | undefined> {
  if (!envConfigured('google')) return undefined;

  const json = await readMaterial(
    read(GOOGLE_ENV.saJson),
    read(GOOGLE_ENV.saJsonPath),
    'google',
    'Google service-account key',
  );
  if (json === undefined) {
    throw incomplete('google', [`${GOOGLE_ENV.saJson} or ${GOOGLE_ENV.saJsonPath}`]);
  }
  const { clientEmail, projectId } = parseServiceAccountJson(json);
  registerSecret(json);

  return { store: 'google', serviceAccountJson: json, clientEmail, projectId };
}
