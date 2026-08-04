import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { agentshipHome, isInside, tmpDir } from '@agentship/core';
import { describe, expect, it } from 'vitest';
import {
  APPLE_ENV,
  assertNoSecretEnv,
  GOOGLE_ENV,
  withAppleKeyFile,
  withGoogleServiceAccountFile,
} from '../src/index.js';
import {
  APPLE_ISSUER_ID,
  APPLE_KEY_ID,
  applePrivateKeyPem,
  serviceAccountJson,
  withEnv,
  withTempHome,
} from './helpers.js';

/** Everything in this file uses the environment source, so no keyring is needed. */
async function withAppleEnv<T>(fn: () => Promise<T>): Promise<T> {
  return withEnv(
    {
      [APPLE_ENV.keyId]: APPLE_KEY_ID,
      [APPLE_ENV.issuerId]: APPLE_ISSUER_ID,
      [APPLE_ENV.p8]: applePrivateKeyPem(),
    },
    fn,
  );
}

async function keysDirEntries(): Promise<string[]> {
  return readdir(join(tmpDir(), 'keys')).catch(() => []);
}

describe('withAppleKeyFile', () => {
  it('exposes the key as a private file inside AGENTSHIP_HOME', async () => {
    await withTempHome(async () => {
      await withAppleEnv(async () => {
        await withAppleKeyFile({}, async (path, credentials) => {
          expect(isInside(agentshipHome(), path)).toBe(true);
          expect(path.endsWith(`AuthKey_${APPLE_KEY_ID}.p8`)).toBe(true);
          expect((await stat(path)).mode & 0o777).toBe(0o600);
          expect(await readFile(path, 'utf8')).toContain('BEGIN PRIVATE KEY');
          expect(credentials).toEqual({ keyId: APPLE_KEY_ID, issuerId: APPLE_ISSUER_ID });
        });
      });
    });
  });

  it('removes the file once the callback returns', async () => {
    await withTempHome(async () => {
      await withAppleEnv(async () => {
        let captured = '';
        await withAppleKeyFile({}, async (path) => {
          captured = path;
        });
        await expect(stat(captured)).rejects.toThrow();
        expect(await keysDirEntries()).toEqual([]);
      });
    });
  });

  it('leaves no orphan when the callback throws', async () => {
    await withTempHome(async () => {
      await withAppleEnv(async () => {
        await expect(
          withAppleKeyFile({}, async () => {
            throw new Error('store call failed');
          }),
        ).rejects.toThrow('store call failed');
        expect(await keysDirEntries()).toEqual([]);
      });
    });
  });

  it('isolates concurrent callers from each other', async () => {
    await withTempHome(async () => {
      await withAppleEnv(async () => {
        const paths = await Promise.all([
          withAppleKeyFile({}, async (p) => p),
          withAppleKeyFile({}, async (p) => p),
        ]);
        expect(paths[0]).not.toBe(paths[1]);
        expect(await keysDirEntries()).toEqual([]);
      });
    });
  });
});

describe('withGoogleServiceAccountFile', () => {
  it('writes the service account JSON privately and cleans it up', async () => {
    await withTempHome(async () => {
      const json = serviceAccountJson();
      await withEnv({ [GOOGLE_ENV.saJson]: json }, async () => {
        let captured = '';
        await withGoogleServiceAccountFile({}, async (path, credentials) => {
          captured = path;
          expect(isInside(agentshipHome(), path)).toBe(true);
          expect((await stat(path)).mode & 0o777).toBe(0o600);
          expect(await readFile(path, 'utf8')).toBe(json);
          expect(credentials.projectId).toBe('agentship-test');
        });
        await expect(stat(captured)).rejects.toThrow();
      });
    });
  });
});

describe('assertNoSecretEnv', () => {
  it('refuses an environment that carries a PEM private key', () => {
    expect(() =>
      assertNoSecretEnv({
        SOMETHING: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
      }),
    ).toThrowError(/Refusing to pass key material/);
  });

  it('refuses an environment that carries a service account JSON', () => {
    expect(() => assertNoSecretEnv({ GPC_SERVICE_ACCOUNT: serviceAccountJson() })).toThrowError(
      /Refusing to pass key material/,
    );
  });

  it('accepts identifiers and file paths', () => {
    expect(() =>
      assertNoSecretEnv({
        ASC_KEY_ID: APPLE_KEY_ID,
        ASC_ISSUER_ID: APPLE_ISSUER_ID,
        ASC_PRIVATE_KEY_PATH: '/tmp/agentship/keys/k-1/AuthKey_ABCD123456.p8',
      }),
    ).not.toThrow();
  });
});
