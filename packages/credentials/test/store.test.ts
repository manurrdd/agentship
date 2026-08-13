import { readFile } from 'node:fs/promises';
import { createLogger, type LogRecord, userConfigPath } from '@agentship/core';
import { describe, expect, it } from 'vitest';
import {
  credentialSource,
  deleteCredentials,
  GOOGLE_ENV,
  getCredentials,
  listProfiles,
  setCredentials,
} from '../src/index.js';
import {
  APPLE_ISSUER_ID,
  APPLE_KEY_ID,
  applePrivateKeyPem,
  serviceAccountJson,
  withEnv,
  withTempHome,
} from './helpers.js';

/**
 * Round-trip tests against an isolated in-memory implementation of the OS-keyring contract.
 *
 * The native keyring is deliberately not involved: a test process must never read or write
 * a developer's real credentials, and a desktop keyring can require interactive approval.
 */
const PROFILE = `apptest-${process.pid}`;

describe('credential store round-trip', () => {
  it('stores and reads back an Apple credential', async () => {
    await withTempHome(async () => {
      const pem = applePrivateKeyPem();
      await setCredentials(
        {
          store: 'apple',
          keyId: APPLE_KEY_ID,
          issuerId: APPLE_ISSUER_ID,
          privateKeyPem: pem,
          keyName: 'Agentship',
        },
        { profile: PROFILE },
      );

      const loaded = await getCredentials('apple', { profile: PROFILE });
      expect(loaded).toMatchObject({
        store: 'apple',
        keyId: APPLE_KEY_ID,
        issuerId: APPLE_ISSUER_ID,
        keyName: 'Agentship',
      });
      expect(loaded.privateKeyPem).toBe(pem.trim());
      expect(await credentialSource('apple', { profile: PROFILE })).toBe('keyring');
    });
  });

  it('keeps the private key out of the configuration file', async () => {
    await withTempHome(async () => {
      const pem = applePrivateKeyPem();
      await setCredentials(
        { store: 'apple', keyId: APPLE_KEY_ID, issuerId: APPLE_ISSUER_ID, privateKeyPem: pem },
        { profile: PROFILE },
      );
      const raw = await readFile(userConfigPath(), 'utf8');
      expect(raw).toContain(APPLE_KEY_ID);
      expect(raw).not.toContain('PRIVATE KEY');
      expect(raw).not.toContain(pem.split('\n')[1] as string);
    });
  });

  it('stores and reads back a Google credential', async () => {
    await withTempHome(async () => {
      const json = serviceAccountJson();
      await setCredentials(
        {
          store: 'google',
          serviceAccountJson: json,
          clientEmail: 'agentship-publisher@agentship-test.iam.gserviceaccount.com',
          projectId: 'agentship-test',
        },
        { profile: PROFILE },
      );
      const loaded = await getCredentials('google', { profile: PROFILE });
      expect(loaded.serviceAccountJson).toBe(json);
      expect(loaded.projectId).toBe('agentship-test');
    });
  });

  it('lists profiles from metadata alone', async () => {
    await withTempHome(async () => {
      await setCredentials(
        {
          store: 'apple',
          keyId: APPLE_KEY_ID,
          issuerId: APPLE_ISSUER_ID,
          privateKeyPem: applePrivateKeyPem(),
        },
        { profile: PROFILE },
      );
      const profiles = await listProfiles();
      expect(profiles.map((p) => p.profile)).toContain(PROFILE);
      expect(profiles.find((p) => p.profile === PROFILE)?.apple?.keyId).toBe(APPLE_KEY_ID);
    });
  });

  it('deletes a credential and forgets its metadata', async () => {
    await withTempHome(async () => {
      await setCredentials(
        {
          store: 'apple',
          keyId: APPLE_KEY_ID,
          issuerId: APPLE_ISSUER_ID,
          privateKeyPem: applePrivateKeyPem(),
        },
        { profile: PROFILE },
      );
      expect(await deleteCredentials('apple', { profile: PROFILE })).toBe(true);
      expect(await credentialSource('apple', { profile: PROFILE })).toBe('none');
      expect(await listProfiles()).toEqual([]);
      // With its metadata gone the profile itself no longer exists, which is a more
      // precise answer than "no credentials".
      await expect(getCredentials('apple', { profile: PROFILE })).rejects.toMatchObject({
        code: 'AUTH_PROFILE_NOT_FOUND',
      });
    });
  });

  it('lets the environment override a stored credential, and says so', async () => {
    await withTempHome(async () => {
      await setCredentials(
        {
          store: 'google',
          serviceAccountJson: serviceAccountJson({ project_id: 'stored-project' }),
          clientEmail: 'agentship-publisher@agentship-test.iam.gserviceaccount.com',
          projectId: 'stored-project',
        },
        { profile: PROFILE },
      );

      const records: LogRecord[] = [];
      const logger = createLogger({ level: 'debug', sinks: [(r) => records.push(r)] });
      await withEnv(
        { [GOOGLE_ENV.saJson]: serviceAccountJson({ project_id: 'env-project' }) },
        async () => {
          const loaded = await getCredentials('google', { profile: PROFILE, logger });
          expect(loaded.projectId).toBe('env-project');
        },
      );
      expect(records.some((r) => r.msg.includes('take precedence'))).toBe(true);
    });
  });
});

describe('credential store without any credential', () => {
  it('reports missing credentials for the default profile', async () => {
    await withTempHome(async () => {
      await withEnv({}, async () => {
        await expect(getCredentials('apple')).rejects.toMatchObject({
          code: 'AUTH_MISSING_CREDENTIALS',
        });
      });
    });
  });

  it('reports an unknown profile distinctly', async () => {
    await withTempHome(async () => {
      await withEnv({}, async () => {
        await expect(getCredentials('apple', { profile: 'nonexistent' })).rejects.toMatchObject({
          code: 'AUTH_PROFILE_NOT_FOUND',
        });
      });
    });
  });

  it('rejects an unusable profile name before touching the keyring', async () => {
    await withTempHome(async () => {
      await expect(getCredentials('apple', { profile: '../../etc' })).rejects.toMatchObject({
        code: 'AUTH_INVALID_CREDENTIALS',
      });
    });
  });
});
