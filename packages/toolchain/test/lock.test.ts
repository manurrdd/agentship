import { writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureDir, toolsDir } from '@agentship/core';
import { describe, expect, it } from 'vitest';
import { withToolLock } from '../src/index.js';
import { silentLogger, withTempHome } from './helpers.js';

async function writeLock(content: Record<string, unknown>): Promise<string> {
  const dir = join(toolsDir(), 'asc');
  await ensureDir(dir);
  const path = join(dir, '.lock');
  await writeFile(path, JSON.stringify(content));
  return path;
}

describe('withToolLock', () => {
  it('serialises concurrent holders', async () => {
    await withTempHome(async () => {
      const order: string[] = [];
      const critical = async (name: string): Promise<void> => {
        order.push(`${name}:enter`);
        await delay(30);
        order.push(`${name}:exit`);
      };
      await Promise.all([
        withToolLock('asc', () => critical('a'), { logger: silentLogger }),
        withToolLock('asc', () => critical('b'), { logger: silentLogger }),
      ]);
      // Whoever wins, the sections never interleave.
      expect(order[1]).toBe(order[0]?.replace(':enter', ':exit'));
      expect(order[3]).toBe(order[2]?.replace(':enter', ':exit'));
    });
  });

  it('releases the lock even when the critical section throws', async () => {
    await withTempHome(async () => {
      await expect(
        withToolLock('asc', () => Promise.reject(new Error('boom')), { logger: silentLogger }),
      ).rejects.toThrow('boom');
      await expect(withToolLock('asc', async () => 'ok', { logger: silentLogger })).resolves.toBe(
        'ok',
      );
    });
  });

  it('steals a lock whose owner process is gone', async () => {
    await withTempHome(async () => {
      await writeLock({ pid: 999_999, host: hostname(), createdAt: new Date().toISOString() });
      await expect(
        withToolLock('asc', async () => 'ok', { logger: silentLogger, timeoutMs: 1_000 }),
      ).resolves.toBe('ok');
    });
  });

  it('steals a lock older than its TTL even if the PID is alive', async () => {
    await withTempHome(async () => {
      await writeLock({
        pid: process.pid,
        host: hostname(),
        createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      });
      await expect(
        withToolLock('asc', async () => 'ok', { logger: silentLogger, timeoutMs: 1_000 }),
      ).resolves.toBe('ok');
    });
  });

  it('steals a corrupted lock instead of wedging', async () => {
    await withTempHome(async () => {
      const dir = join(toolsDir(), 'asc');
      await ensureDir(dir);
      await writeFile(join(dir, '.lock'), 'not json at all');
      await expect(
        withToolLock('asc', async () => 'ok', { logger: silentLogger, timeoutMs: 1_000 }),
      ).resolves.toBe('ok');
    });
  });

  it('times out while a live owner holds the lock', async () => {
    await withTempHome(async () => {
      await writeLock({ pid: process.pid, host: hostname(), createdAt: new Date().toISOString() });
      await expect(
        withToolLock('asc', async () => 'ok', { logger: silentLogger, timeoutMs: 300 }),
      ).rejects.toMatchObject({ code: 'TOOL_LOCK_TIMEOUT' });
    });
  });
});
