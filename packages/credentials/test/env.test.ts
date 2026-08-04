import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APPLE_ENV,
  appleFromEnv,
  credentialSource,
  envConfigured,
  GOOGLE_ENV,
  googleFromEnv,
} from '../src/index.js';
import {
  APPLE_ISSUER_ID,
  APPLE_KEY_ID,
  applePrivateKeyPem,
  serviceAccountJson,
  withEnv,
  withTempHome,
} from './helpers.js';

describe('Apple credentials from the environment', () => {
  it('reads inline key material', async () => {
    const pem = applePrivateKeyPem();
    await withEnv(
      {
        [APPLE_ENV.keyId]: APPLE_KEY_ID,
        [APPLE_ENV.issuerId]: APPLE_ISSUER_ID,
        [APPLE_ENV.p8]: pem,
      },
      async () => {
        expect(envConfigured('apple')).toBe(true);
        const credentials = await appleFromEnv();
        expect(credentials).toMatchObject({
          store: 'apple',
          keyId: APPLE_KEY_ID,
          issuerId: APPLE_ISSUER_ID,
        });
        expect(credentials?.privateKeyPem).toBe(pem.trim());
      },
    );
  });

  it('reads key material from a file path', async () => {
    await withTempHome(async (home) => {
      const path = join(home, 'AuthKey_ABCD1234EF.p8');
      const pem = applePrivateKeyPem();
      await writeFile(path, pem, { mode: 0o600 });
      await withEnv(
        {
          [APPLE_ENV.keyId]: APPLE_KEY_ID,
          [APPLE_ENV.issuerId]: APPLE_ISSUER_ID,
          [APPLE_ENV.p8Path]: path,
        },
        async () => {
          expect((await appleFromEnv())?.privateKeyPem).toBe(pem.trim());
        },
      );
    });
  });

  it('reports a partially configured environment instead of falling back silently', async () => {
    await withEnv({ [APPLE_ENV.keyId]: APPLE_KEY_ID }, async () => {
      await expect(appleFromEnv()).rejects.toMatchObject({ code: 'AUTH_ENV_INCOMPLETE' });
    });
  });

  it('validates what the environment provides', async () => {
    await withEnv(
      {
        [APPLE_ENV.keyId]: 'not-a-key-id',
        [APPLE_ENV.issuerId]: APPLE_ISSUER_ID,
        [APPLE_ENV.p8]: applePrivateKeyPem(),
      },
      async () => {
        await expect(appleFromEnv()).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
      },
    );
  });

  it('explains an unreadable key path', async () => {
    await withEnv(
      {
        [APPLE_ENV.keyId]: APPLE_KEY_ID,
        [APPLE_ENV.issuerId]: APPLE_ISSUER_ID,
        [APPLE_ENV.p8Path]: '/nonexistent/AuthKey.p8',
      },
      async () => {
        await expect(appleFromEnv()).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
      },
    );
  });

  it('returns nothing when no variable is set', async () => {
    await withEnv({}, async () => {
      expect(envConfigured('apple')).toBe(false);
      expect(await appleFromEnv()).toBeUndefined();
    });
  });
});

describe('Google credentials from the environment', () => {
  it('reads inline JSON and a JSON path', async () => {
    const json = serviceAccountJson();
    await withEnv({ [GOOGLE_ENV.saJson]: json }, async () => {
      expect(await googleFromEnv()).toMatchObject({
        store: 'google',
        clientEmail: 'agentship-publisher@agentship-test.iam.gserviceaccount.com',
        projectId: 'agentship-test',
      });
    });

    await withTempHome(async (home) => {
      const path = join(home, 'sa.json');
      await writeFile(path, json, { mode: 0o600 });
      await withEnv({ [GOOGLE_ENV.saJsonPath]: path }, async () => {
        expect((await googleFromEnv())?.serviceAccountJson).toBe(json);
      });
    });
  });

  it('rejects a credential of the wrong type', async () => {
    await withEnv(
      { [GOOGLE_ENV.saJson]: JSON.stringify({ type: 'authorized_user' }) },
      async () => {
        await expect(googleFromEnv()).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
      },
    );
  });
});

describe('credentialSource', () => {
  it('reports the environment as the source when it is configured', async () => {
    await withTempHome(async () => {
      await withEnv({ [GOOGLE_ENV.saJson]: serviceAccountJson() }, async () => {
        expect(await credentialSource('google')).toBe('env');
      });
    });
  });
});
