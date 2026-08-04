import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolsDir } from '@agentship/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  binaryPath,
  ensureTool,
  pointerPath,
  readPointer,
  removeAll,
  toolRoot,
  verifyInstall,
  versionDir,
} from '../src/index.js';
import {
  type FixtureServer,
  fakeBinary,
  fixtureLockfile,
  silentLogger,
  startFixtureServer,
  withTempHome,
} from './helpers.js';

const CONTENT = fakeBinary('1.0.0');
let server: FixtureServer;
const base = { logger: silentLogger, lockTimeoutMs: 5_000 };

beforeAll(async () => {
  server = await startFixtureServer(CONTENT);
});

afterAll(async () => {
  await server.close();
});

/**
 * Overwrites an installed binary keeping its exact size, so only the digest can catch the
 * substitution. A same-size swap is the interesting case: a size change is caught earlier
 * and more cheaply.
 */
async function tamperBinary(version: string, size: number): Promise<void> {
  const path = binaryPath('asc', version);
  await chmod(path, 0o700);
  await writeFile(path, '#!/bin/sh\necho pwned\n'.padEnd(size, '#'));
}

const CONTENT_SIZE = Buffer.byteLength(fakeBinary('1.0.0'));

describe('verifyInstall', () => {
  it('reports a clean installation as ok', async () => {
    await withTempHome(async () => {
      const lockfile = fixtureLockfile(server, CONTENT);
      await ensureTool('asc', { ...base, lockfile });
      const [report] = await verifyInstall({ lockfile });
      expect(report).toMatchObject({ tool: 'asc', status: 'ok', version: '1.0.0' });
      expect(report?.issues).toEqual([]);
    });
  });

  it('reports a tool that was never installed as missing', async () => {
    await withTempHome(async () => {
      const [report] = await verifyInstall({ lockfile: fixtureLockfile(server, CONTENT) });
      expect(report).toMatchObject({ tool: 'asc', status: 'missing' });
    });
  });

  it('cleans up what a killed install left behind', async () => {
    await withTempHome(async () => {
      const lockfile = fixtureLockfile(server, CONTENT);
      await ensureTool('asc', { ...base, lockfile });

      // Exactly the debris a `kill -9` mid-download leaves: a staging directory holding a
      // partial, unverified binary, plus an interrupted atomic write.
      const staging = join(toolRoot('asc'), '.staging-abc123');
      await mkdir(staging, { recursive: true, mode: 0o700 });
      await writeFile(join(staging, 'asc'), 'half-a-binary');
      await writeFile(join(toolRoot('asc'), 'current.json.999.tmp'), '{}');

      const [report] = await verifyInstall({ lockfile });
      expect(report?.status).toBe('repaired');
      expect(report?.version).toBe('1.0.0');
      await expect(stat(staging)).rejects.toThrow();
      await expect(stat(join(toolRoot('asc'), 'current.json.999.tmp'))).rejects.toThrow();
    });
  });

  it('rebuilds a lost pointer from a verified installation', async () => {
    await withTempHome(async () => {
      const lockfile = fixtureLockfile(server, CONTENT);
      await ensureTool('asc', { ...base, lockfile });
      await rm(pointerPath('asc'));

      const [report] = await verifyInstall({ lockfile });
      expect(report?.status).toBe('repaired');
      expect(await readPointer('asc')).toMatchObject({ version: '1.0.0' });
    });
  });

  it('refuses to adopt an installation whose bytes were altered', async () => {
    await withTempHome(async () => {
      const lockfile = fixtureLockfile(server, CONTENT);
      await ensureTool('asc', { ...base, lockfile });
      await rm(pointerPath('asc'));
      await tamperBinary('1.0.0', CONTENT_SIZE);

      const [report] = await verifyInstall({ lockfile });
      expect(report?.status).toBe('missing');
      expect(await readPointer('asc')).toBeUndefined();
    });
  });

  it('removes an active binary that fails its integrity check', async () => {
    await withTempHome(async () => {
      const lockfile = fixtureLockfile(server, CONTENT);
      await ensureTool('asc', { ...base, lockfile });
      await tamperBinary('1.0.0', CONTENT_SIZE);

      const [report] = await verifyInstall({ lockfile });
      expect(report?.status).toBe('missing');
      expect(report?.issues.join(' ')).toContain('integrity check');
      await expect(stat(versionDir('asc', '1.0.0'))).rejects.toThrow();
      expect(await readPointer('asc')).toBeUndefined();
    });
  });

  it('falls back to the kept version when the active one is corrupt', async () => {
    await withTempHome(async () => {
      await ensureTool('asc', { ...base, lockfile: fixtureLockfile(server, CONTENT) });
      const contentV2 = fakeBinary('2.0.0');
      const server2 = await startFixtureServer(contentV2);
      try {
        const v2 = fixtureLockfile(server2, contentV2, { version: '2.0.0' });
        await ensureTool('asc', { ...base, lockfile: v2 });
        await tamperBinary('2.0.0', Buffer.byteLength(contentV2));

        const [report] = await verifyInstall({ lockfile: v2 });
        expect(report?.status).toBe('repaired');
        expect(report?.version).toBe('1.0.0');
        expect(await readPointer('asc')).toMatchObject({ version: '1.0.0' });
      } finally {
        await server2.close();
      }
    });
  });

  it('detects an installation that no longer matches the pinned digest', async () => {
    await withTempHome(async () => {
      const lockfile = fixtureLockfile(server, CONTENT);
      await ensureTool('asc', { ...base, lockfile });
      // The team re-pins the same version to different bytes: the old install must go.
      const repinned = fixtureLockfile(server, CONTENT, { sha256: 'a'.repeat(64) });
      const [report] = await verifyInstall({ lockfile: repinned });
      expect(report?.status).toBe('missing');
      expect(report?.issues.join(' ')).toContain('pinned in the lockfile');
    });
  });

  it('removes an abandoned install lock', async () => {
    await withTempHome(async () => {
      const lockfile = fixtureLockfile(server, CONTENT);
      await ensureTool('asc', { ...base, lockfile });
      const lock = join(toolRoot('asc'), '.lock');
      await writeFile(
        lock,
        JSON.stringify({ pid: 1, host: 'other', createdAt: '2020-01-01T00:00:00.000Z' }),
      );
      const old = new Date(Date.now() - 3_600_000);
      await utimes(lock, old, old);

      const [report] = await verifyInstall({ lockfile });
      expect(report?.repairs.join(' ')).toContain('abandoned install lock');
      await expect(stat(lock)).rejects.toThrow();
    });
  });

  it('restores owner-only permissions on the binary', async () => {
    await withTempHome(async () => {
      const lockfile = fixtureLockfile(server, CONTENT);
      const path = await ensureTool('asc', { ...base, lockfile });
      await chmod(path, 0o777);

      const [report] = await verifyInstall({ lockfile });
      expect(report?.status).toBe('repaired');
      expect((await stat(path)).mode & 0o777).toBe(0o500);
      // The repair must not have altered the bytes.
      expect(await readFile(path, 'utf8')).toBe(CONTENT);
    });
  });
});

describe('removeAll', () => {
  it('deletes the managed toolchain', async () => {
    await withTempHome(async () => {
      await ensureTool('asc', { ...base, lockfile: fixtureLockfile(server, CONTENT) });
      await removeAll();
      await expect(stat(toolsDir())).rejects.toThrow();
    });
  });

  it('is a no-op when nothing is installed', async () => {
    await withTempHome(async () => {
      await expect(removeAll()).resolves.toBeUndefined();
    });
  });

  it('refuses to follow a tools directory that points outside AGENTSHIP_HOME', async () => {
    await withTempHome(async (home) => {
      const outside = await mkdtemp(join(tmpdir(), 'agentship-victim-'));
      await writeFile(join(outside, 'precious.txt'), 'keep me');
      await symlink(outside, join(home, 'tools'));

      await expect(removeAll()).rejects.toMatchObject({ code: 'CONFIG_HOME_UNWRITABLE' });
      expect(await readFile(join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
      await rm(outside, { recursive: true, force: true });
    });
  });
});
