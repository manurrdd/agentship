import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CREDENTIAL_ENV_VARS } from '../src/index.js';

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

export async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const previous = process.env['AGENTSHIP_HOME'];
  const dir = await mkdtemp(join(tmpdir(), 'agentship-cred-'));
  process.env['AGENTSHIP_HOME'] = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env['AGENTSHIP_HOME'];
    else process.env['AGENTSHIP_HOME'] = previous;
    await rm(dir, { recursive: true, force: true });
  }
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
