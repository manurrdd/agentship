import { stat } from 'node:fs/promises';
import { runTool } from '@agentship/core';
import { describe, expect, it } from 'vitest';
import {
  currentPlatform,
  ensureTool,
  loadLockfile,
  TOOL_NAMES,
  verifyInstall,
} from '../src/index.js';
import { silentLogger, withTempHome } from './helpers.js';

/**
 * The only test that touches the network.
 *
 * Gated behind `AGENTSHIP_E2E_NETWORK=1` because it downloads ~250 MB from GitHub: it proves
 * that the digests embedded in `tools.lock.json` still match what upstream publishes, and
 * that both real binaries run on this machine. Everything else about the toolchain is
 * covered offline against a local fixture server.
 */
const enabled = process.env['AGENTSHIP_E2E_NETWORK'] === '1';

describe.skipIf(!enabled)('network smoke', () => {
  it('installs every pinned tool from the embedded lockfile and verifies clean', {
    timeout: 15 * 60_000,
  }, async () => {
    await withTempHome(async () => {
      const lockfile = loadLockfile();
      const platform = currentPlatform();

      for (const tool of TOOL_NAMES) {
        const entry = lockfile.tools[tool];
        expect(entry, `${tool} must be pinned in the lockfile`).toBeDefined();
        expect(entry?.platforms[platform], `${tool} must ship a ${platform} build`).toBeDefined();

        const path = await ensureTool(tool, { logger: silentLogger });
        const info = await stat(path);
        expect(info.size).toBe(entry?.platforms[platform]?.size);

        const version = await runTool(path, {
          args: ['--version'],
          retry: false,
          logger: silentLogger,
        });
        expect(version.exitCode).toBe(0);
        expect(version.stdout.trim().length).toBeGreaterThan(0);
      }

      const reports = await verifyInstall();
      for (const report of reports) {
        expect(report.status, `${report.tool}: ${report.issues.join('; ')}`).toBe('ok');
      }
    });
  });
});
