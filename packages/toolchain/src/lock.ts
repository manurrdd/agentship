import { open, readFile, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentshipError, ERROR_CODES, ensureDir, FILE_MODE, type Logger } from '@agentship/core';
import { lockPath } from './layout.js';
import type { ToolName } from './lockfile.js';

/**
 * Cross-process install lock.
 *
 * Two Agentship processes (an MCP server and a `doctor` run, say) may try to install the same
 * tool at the same time. The lock is a file created with `O_EXCL`, holding the owner's PID
 * and host. A stale lock — owner gone, or older than {@link LOCK_TTL_MS} — is stolen rather
 * than waited on forever, because the alternative is a permanently wedged installation
 * after a `kill -9`.
 */

/** A lock older than this is considered abandoned. */
export const LOCK_TTL_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 100;

interface LockContent {
  readonly pid: number;
  readonly host: string;
  readonly createdAt: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readLock(path: string): Promise<LockContent | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<LockContent>;
    if (typeof parsed.pid !== 'number' || typeof parsed.createdAt !== 'string') return undefined;
    return { pid: parsed.pid, host: parsed.host ?? '', createdAt: parsed.createdAt };
  } catch {
    // Unreadable or malformed: treat as stale so a corrupted lock cannot wedge Agentship.
    return undefined;
  }
}

function isStale(lock: LockContent | undefined): boolean {
  if (lock === undefined) return true;
  const age = Date.now() - Date.parse(lock.createdAt);
  if (Number.isNaN(age) || age > LOCK_TTL_MS) return true;
  // A PID check is only meaningful on the machine that created the lock.
  return lock.host === hostname() && !isProcessAlive(lock.pid);
}

async function tryAcquire(path: string): Promise<boolean> {
  try {
    const handle = await open(path, 'wx', FILE_MODE);
    try {
      const content: LockContent = {
        pid: process.pid,
        host: hostname(),
        createdAt: new Date().toISOString(),
      };
      await handle.writeFile(JSON.stringify(content));
    } finally {
      await handle.close();
    }
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw AgentshipError.from(
      ERROR_CODES.TOOL_LOCK_TIMEOUT,
      `Could not create the install lock at ${path}.`,
      cause,
    );
  }
}

export interface WithToolLockOptions {
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

/**
 * Runs `fn` while holding the install lock for `tool`.
 *
 * The lock is always released, including on failure; the release is best-effort because a
 * leftover lock is recoverable (it expires) while a thrown release error would mask the
 * real failure.
 */
export async function withToolLock<T>(
  tool: ToolName,
  fn: () => Promise<T>,
  options: WithToolLockOptions = {},
): Promise<T> {
  const path = lockPath(tool);
  await ensureDir(dirname(path));
  const timeoutMs = options.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;

  while (!(await tryAcquire(path))) {
    const existing = await readLock(path);
    if (isStale(existing)) {
      options.logger?.warn('stealing a stale toolchain install lock', {
        tool,
        ownerPid: existing?.pid,
      });
      await rm(path, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new AgentshipError(
        ERROR_CODES.TOOL_LOCK_TIMEOUT,
        `Another Agentship process (pid ${existing?.pid ?? 'unknown'}) has been installing ${tool} for more than ${Math.round(timeoutMs / 1000)}s.`,
        {
          details: { tool, ownerPid: existing?.pid },
          remediation: {
            summary: `Wait for it to finish, or delete ${path} if that process is gone.`,
          },
        },
      );
    }
    await delay(POLL_INTERVAL_MS);
  }

  try {
    return await fn();
  } finally {
    await rm(path, { force: true }).catch(() => undefined);
  }
}
