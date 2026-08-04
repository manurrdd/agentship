import { mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentshipError, ERROR_CODES, ensureDir, FILE_MODE, tmpDir } from '@agentship/core';
import type { CredentialOptions } from './store.js';
import { getCredentials } from './store.js';

/**
 * Materialising secrets for the store backends.
 *
 * `asc` and `gpc` both want a key *file*, so a secret has to touch the disk. It touches it
 * for as short as possible and as narrowly as possible: inside `AGENTSHIP_HOME` (0700, never
 * the shared system temp directory, where any local user can watch for new files), in a
 * per-call directory, with mode 0600, and removed in a `finally` so a failure inside the
 * callback cannot leave an orphan.
 *
 * The alternative — passing key material as a command-line argument — is not available:
 * arguments are world-readable through `ps`, and the shared runner refuses them.
 */

async function withSecretFile<T>(
  filename: string,
  contents: string,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const root = await ensureDir(join(tmpDir(), 'keys'));
  const dir = await mkdtemp(join(root, 'k-'));
  const path = join(dir, filename);
  try {
    // `wx` — refuse to write through a pre-existing path, including a planted symlink.
    const handle = await open(path, 'wx', FILE_MODE);
    try {
      await handle.writeFile(contents);
    } finally {
      await handle.close();
    }
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Writes the App Store Connect private key to a short-lived file and hands its path to
 * `fn`. The file is named `AuthKey_<KEYID>.p8`, the convention Apple's own tooling expects.
 */
export async function withAppleKeyFile<T>(
  options: CredentialOptions,
  fn: (path: string, credentials: { keyId: string; issuerId: string }) => Promise<T>,
): Promise<T> {
  const credentials = await getCredentials('apple', options);
  return withSecretFile(`AuthKey_${credentials.keyId}.p8`, credentials.privateKeyPem, (path) =>
    fn(path, { keyId: credentials.keyId, issuerId: credentials.issuerId }),
  );
}

/**
 * Writes the Google service-account JSON to a short-lived file and hands its path to `fn`.
 * The path is what `GOOGLE_APPLICATION_CREDENTIALS` expects.
 */
export async function withGoogleServiceAccountFile<T>(
  options: CredentialOptions,
  fn: (path: string, credentials: { clientEmail: string; projectId: string }) => Promise<T>,
): Promise<T> {
  const credentials = await getCredentials('google', options);
  return withSecretFile('service-account.json', credentials.serviceAccountJson, (path) =>
    fn(path, { clientEmail: credentials.clientEmail, projectId: credentials.projectId }),
  );
}

/**
 * Guards against a caller trying to route secret material through the environment.
 *
 * The store backends build their own environment (identifiers, behaviour switches and the
 * path of the temporary key file above); this is the assertion that keeps the key material
 * itself out of it, so that a subprocess dumping its environment on error cannot leak a
 * private key.
 */
export function assertNoSecretEnv(env: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value.includes('PRIVATE KEY') || value.includes('"private_key"')) {
      throw new AgentshipError(
        ERROR_CODES.AUTH_INVALID_CREDENTIALS,
        `Refusing to pass key material through the environment variable ${key}.`,
        { details: { key } },
      );
    }
  }
}
