import { readFile, stat, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROFILE,
  readUserConfig,
  USER_CONFIG_VERSION,
  updateUserConfig,
  writeUserConfig,
} from '../src/config.js';
import { ensureAgentshipHome, userConfigPath } from '../src/paths.js';
import { withTempHome } from './helpers.js';

describe('user config', () => {
  it('returns defaults when the file does not exist', async () => {
    await withTempHome(async () => {
      const config = await readUserConfig();
      expect(config.schemaVersion).toBe(USER_CONFIG_VERSION);
      expect(config.defaultProfile).toBe(DEFAULT_PROFILE);
      expect(config.profiles).toEqual({});
    });
  });

  it('round-trips profile metadata with owner-only permissions', async () => {
    await withTempHome(async () => {
      await updateUserConfig((config) => ({
        ...config,
        profiles: {
          ...config.profiles,
          default: {
            apple: {
              keyId: 'ABCD123456',
              issuerId: '69a6de70-1111-2222-3333-444455556666',
              updatedAt: new Date(0).toISOString(),
            },
          },
        },
      }));
      const config = await readUserConfig();
      expect(config.profiles['default']?.apple?.keyId).toBe('ABCD123456');
      const info = await stat(userConfigPath());
      expect(info.mode & 0o777).toBe(0o600);
    });
  });

  it('never stores secret material', async () => {
    await withTempHome(async () => {
      await updateUserConfig((config) => ({
        ...config,
        profiles: {
          default: {
            google: {
              clientEmail: 'agentship@p.iam.gserviceaccount.com',
              projectId: 'p',
              updatedAt: new Date(0).toISOString(),
            },
          },
        },
      }));
      const raw = await readFile(userConfigPath(), 'utf8');
      expect(raw).not.toContain('PRIVATE KEY');
      expect(raw).not.toContain('private_key');
    });
  });

  it('rejects malformed JSON instead of silently overwriting it', async () => {
    await withTempHome(async () => {
      await ensureAgentshipHome();
      await writeFile(userConfigPath(), '{ not json');
      await expect(readUserConfig()).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    });
  });

  it('rejects an unsupported schema version', async () => {
    await withTempHome(async () => {
      await ensureAgentshipHome();
      await writeFile(userConfigPath(), JSON.stringify({ schemaVersion: 99 }));
      await expect(readUserConfig()).rejects.toMatchObject({
        code: 'CONFIG_UNSUPPORTED_VERSION',
      });
    });
  });

  it('rejects a structurally invalid config', async () => {
    await withTempHome(async () => {
      await ensureAgentshipHome();
      await writeFile(
        userConfigPath(),
        JSON.stringify({ schemaVersion: 1, profiles: { default: { apple: { keyId: 1 } } } }),
      );
      await expect(readUserConfig()).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    });
  });

  it('validates on write', async () => {
    await withTempHome(async () => {
      // biome-ignore lint/suspicious/noExplicitAny: deliberately writing an invalid value.
      await expect(writeUserConfig({ defaultProfile: '' } as any)).rejects.toThrow();
    });
  });
});
