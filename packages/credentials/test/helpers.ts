import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CREDENTIAL_ENV_VARS } from '../src/index.js';
import { type KeyringEntryCtor, setKeyringEntryCtorForTests } from '../src/keyring.js';

/** A real EC P-256 private key in PEM form — exactly the shape of an Apple `.p8`. */
export function applePrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

export function rsaPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

/** A structurally valid Google service-account key file. */
export function serviceAccountJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'agentship-test',
    private_key_id: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    private_key: applePrivateKeyPem(),
    client_email: 'agentship-publisher@agentship-test.iam.gserviceaccount.com',
    client_id: '123456789012345678901',
    token_uri: 'https://oauth2.googleapis.com/token',
    ...overrides,
  });
}

export const APPLE_KEY_ID = 'ABCD1234EF';
export const APPLE_ISSUER_ID = '69a6de70-03db-47e3-e053-5b8c7c11a4d1';

/**
 * An isolated Agentship home *and* an isolated keyring namespace.
 *
 * The keyring is not under `AGENTSHIP_HOME`, so a temporary home alone left the tests
 * reading the real OS keychain: on a machine that actually uses Agentship, "no credentials
 * are configured" was false, the suite failed, and the assertion diff printed the
 * developer's real Apple private key. The namespace has to be isolated with the home.
 */
export async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const previousHome = process.env['AGENTSHIP_HOME'];
  const previousService = process.env['AGENTSHIP_KEYRING_SERVICE'];
  const dir = await mkdtemp(join(tmpdir(), 'agentship-cred-'));
  process.env['AGENTSHIP_HOME'] = dir;
  process.env['AGENTSHIP_KEYRING_SERVICE'] = isolatedKeyringService();
  setKeyringEntryCtorForTests(memoryKeyringEntryCtor());
  try {
    return await fn(dir);
  } finally {
    if (previousHome === undefined) delete process.env['AGENTSHIP_HOME'];
    else process.env['AGENTSHIP_HOME'] = previousHome;
    if (previousService === undefined) delete process.env['AGENTSHIP_KEYRING_SERVICE'];
    else process.env['AGENTSHIP_KEYRING_SERVICE'] = previousService;
    setKeyringEntryCtorForTests(undefined);
    await rm(dir, { recursive: true, force: true });
  }
}

/** A process-local keyring implementing the same async contract as the native backend. */
export function memoryKeyringEntryCtor(): KeyringEntryCtor {
  const entries = new Map<string, string>();
  return class MemoryKeyringEntry {
    readonly #key: string;

    constructor(service: string, username: string) {
      this.#key = `${service}\0${username}`;
    }

    async setPassword(password: string): Promise<void> {
      entries.set(this.#key, password);
    }

    async getPassword(): Promise<string | undefined> {
      return entries.get(this.#key);
    }

    async deleteCredential(): Promise<boolean> {
      return entries.delete(this.#key);
    }
  };
}

/**
 * A keyring service name no real installation uses, unique per call.
 *
 * Unique rather than fixed so that parallel test files, and a run that leaves an entry
 * behind on a keyring that has no temporary directory to be cleaned up with, cannot see
 * each other's secrets.
 */
export function isolatedKeyringService(): string {
  return `agentship-test-${randomUUID()}`;
}

/** Runs `fn` with the given credential environment, restoring the previous one after. */
export async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const all = [...CREDENTIAL_ENV_VARS.apple, ...CREDENTIAL_ENV_VARS.google];
  const saved = new Map(all.map((name) => [name, process.env[name]]));
  for (const name of all) delete process.env[name];
  for (const [name, value] of Object.entries(vars)) {
    if (value !== undefined) process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const name of all) {
      const value = saved.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
