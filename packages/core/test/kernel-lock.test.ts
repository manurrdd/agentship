import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireProjectLock, ensureDir, lockPath, stateDir } from '@agentship/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('project lock', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'agentship-lock-'));
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('is exclusive while held and reusable after release', async () => {
    const lock = await acquireProjectLock(repoRoot);
    await expect(acquireProjectLock(repoRoot)).rejects.toMatchObject({ code: 'PLAN_LOCKED' });
    await lock.release();
    const again = await acquireProjectLock(repoRoot);
    await again.release();
  });

  it('replaces a stale lock left by a dead process', async () => {
    await ensureDir(stateDir(repoRoot));
    // A pid that cannot be alive: pid 1 is launchd/init but not ours; use an unlikely one.
    await writeFile(
      lockPath(repoRoot),
      JSON.stringify({ pid: 999999, host: hostname(), at: new Date().toISOString() }),
    );
    const lock = await acquireProjectLock(repoRoot);
    await lock.release();
  });

  it('treats an unreadable lock file as stale', async () => {
    await ensureDir(stateDir(repoRoot));
    await writeFile(lockPath(repoRoot), 'not-json');
    const lock = await acquireProjectLock(repoRoot);
    await lock.release();
  });
});
