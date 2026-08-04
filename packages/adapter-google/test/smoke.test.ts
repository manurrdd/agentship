import { createLogger } from '@agentship/core';
import { describe, expect, it } from 'vitest';
import { GoogleAdapter } from '../src/index.js';

/**
 * The one test that talks to Google.
 *
 * Gated behind `AGENTSHIP_E2E_GOOGLE=1` and limited to reads. Unlike Apple, Google has no
 * account-level endpoint, so the check needs a package name the service account can see —
 * `AGENTSHIP_E2E_GOOGLE_PACKAGE`. `listApps` is asserted to *fail*: Google publishes no
 * endpoint that enumerates a developer's apps, and this test is what would notice if that
 * ever changed.
 *
 *   AGENTSHIP_E2E_GOOGLE=1 AGENTSHIP_E2E_GOOGLE_PACKAGE=com.example.app \
 *   AGENTSHIP_GOOGLE_SA_JSON_PATH=… \
 *   pnpm test packages/adapter-google
 */
const packageName = process.env['AGENTSHIP_E2E_GOOGLE_PACKAGE'];
const enabled = process.env['AGENTSHIP_E2E_GOOGLE'] === '1' && packageName !== undefined;

describe.runIf(enabled)('Google Play smoke', () => {
  const adapter = new GoogleAdapter();
  const context = {
    profile: process.env['AGENTSHIP_E2E_PROFILE'] ?? 'default',
    logger: createLogger({ level: 'silent', sinks: [] }),
  };
  const ref = { store: 'google' as const, id: packageName as string, platform: 'android' as const };

  it('runs the pinned gpc binary', async () => {
    await expect(adapter.version(context)).resolves.toMatch(/^\d+\.\d+\.\d+/);
  }, 300_000);

  it('authenticates against the real API', async () => {
    const result = await adapter.checkAuth(context, ref);
    expect(result.ok, result.detail).toBe(true);
  }, 120_000);

  it("still cannot enumerate the account's apps", async () => {
    await expect(adapter.listApps(context)).rejects.toMatchObject({
      code: 'STORE_UNSUPPORTED_OPERATION',
    });
  });
});

describe.runIf(!enabled)('Google Play smoke', () => {
  it.skip('is gated behind AGENTSHIP_E2E_GOOGLE=1, a package name and real credentials', () => {
    // Recorded as skipped rather than silently absent.
  });
});
