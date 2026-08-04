import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

/**
 * The published package, installed the way a user gets it.
 *
 * Gated behind `AGENTSHIP_PACK_TEST=1` because it builds, packs and runs `npm install`
 * against the registry. It answers the questions no unit test can: does the tarball carry
 * the skills and the runtime data, does the bundle run with only its declared third-party
 * dependencies present, and does the installed binary set up and diagnose itself.
 *
 * With `AGENTSHIP_E2E_NETWORK=1` it also downloads the managed binaries, which is the only
 * way `doctor` can come back completely green.
 */
const enabled = process.env['AGENTSHIP_PACK_TEST'] === '1';
const withTools = process.env['AGENTSHIP_E2E_NETWORK'] === '1';
const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(CLI_DIR, '../..');

describe.skipIf(!enabled)('npm pack', () => {
  it('installs cleanly and works with nothing but its dependencies', {
    timeout: withTools ? 20 * 60_000 : 5 * 60_000,
  }, async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agentship-pack-'));
    const home = await mkdtemp(join(tmpdir(), 'agentship-pack-home-'));
    const agentshipHome = await mkdtemp(join(tmpdir(), 'agentship-pack-state-'));
    try {
      await execa('pnpm', ['--filter', 'agentship', 'build'], { cwd: REPO_ROOT });
      const packed = await execa('npm', ['pack', '--pack-destination', workspace], {
        cwd: CLI_DIR,
      });
      const tarball = join(
        workspace,
        (await readdir(workspace)).find((name) => name.endsWith('.tgz')) as string,
      );
      expect(packed.exitCode).toBe(0);

      const listing = await execa('tar', ['-tzf', tarball]);
      const files = listing.stdout.split('\n');
      for (const required of [
        'package/dist/bin.js',
        'package/skills/agentship-publish/SKILL.md',
        'package/skills/agentship-first-release/SKILL.md',
        'package/skills/agentship-troubleshoot/SKILL.md',
        'package/tools.lock.json',
        'package/data/sdk-catalog.json',
        // The console catalog and the privacy taxonomies are runtime data too: without them
        // a published build would fail the moment an agent asked for console instructions.
        'package/data/apple/app-record.yaml',
        'package/data/google/app-record.yaml',
        'package/data/privacy/mapping-apple.yaml',
        'package/data/privacy/data-safety-csv.yaml',
      ]) {
        expect(files, `${required} is missing from the tarball`).toContain(required);
      }
      // Sources are not shipped: the bundle is the product.
      expect(files.some((file) => file.startsWith('package/src/'))).toBe(false);

      await execa('npm', ['install', '--no-audit', '--no-fund', tarball], { cwd: workspace });
      const bin = join(workspace, 'node_modules', '.bin', 'agentship');
      const env = {
        ...process.env,
        HOME: home,
        AGENTSHIP_HOME: agentshipHome,
        ...(withTools ? {} : { AGENTSHIP_SKIP_TOOL_INSTALL: '1' }),
      };

      const version = await execa(bin, ['--version'], { env });
      expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);

      const setup = await execa(bin, ['setup', '--yes', '--agents', 'none'], {
        env,
        reject: false,
      });
      expect(setup.stdout).toContain('agentship');

      const doctor = await execa(bin, ['doctor', '--json'], { env, reject: false });
      const report = JSON.parse(doctor.stdout) as {
        ok: boolean;
        checks: { id: string; status: string }[];
      };
      const toolChecks = report.checks.filter((check) => check.id.startsWith('tool:'));
      expect(toolChecks).toHaveLength(2);
      if (withTools) {
        expect(report.checks.filter((check) => check.status === 'fail')).toEqual([]);
        expect(report.ok).toBe(true);
      }

      const uninstall = await execa(bin, ['uninstall', '--yes'], { env, reject: false });
      expect(uninstall.exitCode).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
      await rm(agentshipHome, { recursive: true, force: true });
    }
  });
});
