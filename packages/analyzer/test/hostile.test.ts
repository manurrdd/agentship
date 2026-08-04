import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeApp, RepoFs } from '../src/index.js';

/**
 * The hostile fixture models a repository written to attack the analyzer: symlinks pointing
 * outside the checkout, a symlink loop, a directory tree deeper than the limit, bytes that
 * are not valid UTF-8, an XML entity declaration, and a dynamic Expo config whose top level
 * would run a shell command if it were ever imported.
 *
 * None of it may crash the analyzer, execute anything, or leak a byte from outside the
 * repository into the result.
 */
const HOSTILE = fileURLToPath(new URL('./fixtures/hostile-app', import.meta.url));
const OUTSIDE = fileURLToPath(new URL('./fixtures/_outside-the-repo', import.meta.url));

let sentinel: string;
let sentinelDir: string;

beforeAll(async () => {
  sentinelDir = await mkdtemp(join(tmpdir(), 'agentship-sentinel-'));
  sentinel = join(sentinelDir, 'pwned');
  process.env['AGENTSHIP_PWNED_SENTINEL'] = sentinel;
});

afterAll(async () => {
  delete process.env['AGENTSHIP_PWNED_SENTINEL'];
  await rm(sentinelDir, { recursive: true, force: true });
});

describe('hostile repository', () => {
  it('completes without throwing and within a sane time budget', async () => {
    const started = Date.now();
    const analysis = await analyzeApp(HOSTILE);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(analysis.schemaVersion).toBe(1);
  });

  it('never executes repository code', async () => {
    await analyzeApp(HOSTILE);
    // app.config.js runs `execSync` at module scope. If it had been imported, this exists.
    await expect(stat(sentinel)).rejects.toThrow();
  });

  it('reports the dynamic config as unread rather than evaluating it', async () => {
    const analysis = await analyzeApp(HOSTILE);
    const warning = analysis.warnings.find((w) => w.code === 'DYNAMIC_EXPO_CONFIG');
    expect(warning?.message).toContain('never executes repository code');
  });

  it('does not read through symlinks that point outside the repository', async () => {
    const analysis = await analyzeApp(HOSTILE);
    const dumped = JSON.stringify(analysis);
    expect(dumped).not.toContain('CANARY_LEAKED');
    // ios/Runner/Info.plist is such a symlink, so no bundle id can be found.
    expect(analysis.identity.bundleId).toBeUndefined();
    expect(analysis.warnings.map((w) => w.code)).toContain('SYMLINKS_SKIPPED');
  });

  it('survives a symlink loop', async () => {
    const analysis = await analyzeApp(HOSTILE);
    expect(analysis.stats.filesScanned).toBeGreaterThan(0);
    expect(analysis.stats.filesScanned).toBeLessThan(100);
  });

  it('stops at the depth limit instead of descending forever', async () => {
    const analysis = await analyzeApp(HOSTILE);
    expect(analysis.stats.truncated).toBe(true);
    expect(analysis.warnings.map((w) => w.code)).toContain('SCAN_TRUNCATED');
  });

  it('discards values that did not decode as text', async () => {
    const analysis = await analyzeApp(HOSTILE);
    expect(analysis.versions.marketingVersion).toBeUndefined();
    expect(analysis.warnings.some((w) => w.code === 'UNREADABLE_VALUE')).toBe(true);
    expect(JSON.stringify(analysis)).not.toContain('�');
  });

  it('ignores values that only appear inside comments', async () => {
    const analysis = await analyzeApp(HOSTILE);
    expect(analysis.identity.packageName?.value).toBe('com.hostile.real');
    expect(JSON.stringify(analysis)).not.toContain('com.attacker.spoofed');
  });

  it('does not modify the repository it analyzes', async () => {
    const before = await snapshot(HOSTILE);
    await analyzeApp(HOSTILE);
    expect(await snapshot(HOSTILE)).toEqual(before);
  });
});

describe('RepoFs boundaries', () => {
  it('refuses absolute paths and traversal', async () => {
    const fs = await RepoFs.open(HOSTILE);
    expect(await fs.readText('/etc/passwd')).toBeUndefined();
    expect(await fs.readText('../_outside-the-repo/secret.txt')).toBeUndefined();
    expect(await fs.exists('../_outside-the-repo/secret.txt')).toBe(false);
  });

  it('refuses to read through a symlink even when it stays inside the repository', async () => {
    const fs = await RepoFs.open(HOSTILE);
    expect(await fs.readText('secret-link.txt')).toBeUndefined();
    expect(await fs.readText('passwd-link')).toBeUndefined();
  });

  it('honours the file-size limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentship-big-'));
    try {
      await writeFile(join(dir, 'big.json'), 'x'.repeat(4096));
      const fs = await RepoFs.open(dir, {
        maxFiles: 10,
        maxDepth: 3,
        maxFileBytes: 1024,
        maxTotalBytes: 1_000_000,
      });
      expect(await fs.readText('big.json')).toBeUndefined();
      expect(fs.truncated).toBe(true);
      expect(fs.skipped.some((s) => s.reason === 'too-large')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('honours the file-count limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentship-many-'));
    try {
      for (let index = 0; index < 20; index++) {
        await writeFile(join(dir, `file-${index}.txt`), 'x');
      }
      const fs = await RepoFs.open(dir, {
        maxFiles: 5,
        maxDepth: 3,
        maxFileBytes: 1024,
        maxTotalBytes: 1_000_000,
      });
      expect((await fs.files()).length).toBe(5);
      expect(fs.truncated).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a missing path and a non-directory clearly', async () => {
    await expect(RepoFs.open(join(OUTSIDE, 'does-not-exist'))).rejects.toMatchObject({
      code: 'ANALYZE_PATH_NOT_FOUND',
    });
    await expect(RepoFs.open(join(OUTSIDE, 'secret.txt'))).rejects.toMatchObject({
      code: 'ANALYZE_NOT_A_DIRECTORY',
    });
  });
});

/** Names and sizes of every regular file, used to prove the analyzer only reads. */
async function snapshot(root: string): Promise<Record<string, number>> {
  const fs = await RepoFs.open(root);
  const result: Record<string, number> = {};
  for (const file of await fs.files()) result[file] = (await fs.fileSize(file)) ?? -1;
  return result;
}
