import { createLogger } from '@agentship/core';
import { describe, expect, it } from 'vitest';
import { AppleAdapter } from '../src/index.js';

/**
 * The one test that talks to Apple.
 *
 * Gated behind `AGENTSHIP_E2E_APPLE=1` and deliberately limited to reads: it proves that the
 * pinned binary, the isolated environment and the credential plumbing work together against
 * the real App Store Connect API, which no fixture can. Everything that writes is out of
 * scope here and belongs to the gated release flows.
 *
 * Run it with credentials in the environment:
 *
 *   AGENTSHIP_E2E_APPLE=1 \
 *   AGENTSHIP_APPLE_KEY_ID=… AGENTSHIP_APPLE_ISSUER_ID=… AGENTSHIP_APPLE_P8_PATH=… \
 *   pnpm test packages/adapter-apple
 */
const enabled = process.env['AGENTSHIP_E2E_APPLE'] === '1';

describe.runIf(enabled)('App Store Connect smoke', () => {
  const adapter = new AppleAdapter();
  const context = {
    profile: process.env['AGENTSHIP_E2E_PROFILE'] ?? 'default',
    logger: createLogger({ level: 'silent', sinks: [] }),
  };

  it('runs the pinned asc binary', async () => {
    // Installs the tool on first use, verifying its SHA-256 against the embedded lockfile.
    await expect(adapter.version(context)).resolves.toMatch(/^\d+\.\d+\.\d+/);
  }, 300_000);

  it('authenticates against the real API', async () => {
    const result = await adapter.checkAuth(context);
    expect(result.ok, result.detail).toBe(true);
  }, 120_000);

  it('lists the apps the key can see', async () => {
    const apps = await adapter.listApps(context);
    expect(Array.isArray(apps)).toBe(true);
    for (const app of apps) {
      expect(app.ref.store).toBe('apple');
      expect(app.name).not.toBe('');
    }
  }, 120_000);
});

describe.runIf(!enabled)('App Store Connect smoke', () => {
  it.skip('is gated behind AGENTSHIP_E2E_APPLE=1 and real credentials', () => {
    // Recorded as skipped rather than silently absent, so a green suite never reads as
    // "the real API was exercised".
  });
});
