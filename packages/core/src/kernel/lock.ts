import { readFile, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { AgentshipError, ERROR_CODES } from '../errors.js';
import { ensureDir, FILE_MODE, stateDir } from '../paths.js';

/**
 * One `apply` at a time per `.agentship/` directory.
 *
 * Two concurrent applies against the same journal would interleave intents and results
 * and could double-execute non-idempotent operations, so the executor takes this lock
 * for the whole run. The lock is a file created with `wx` (fails if it exists) holding
 * the owner's pid; a lock whose pid is no longer alive on this host is stale and is
 * silently replaced, so a killed apply never wedges the project.
 */
interface LockPayload {
  readonly pid: number;
  readonly host: string;
  readonly at: string;
}

export function lockPath(repoRoot: string): string {
  return join(stateDir(repoRoot), 'apply.lock');
}

export interface ProjectLock {
  release(): Promise<void>;
}

export async function acquireProjectLock(repoRoot: string): Promise<ProjectLock> {
  await ensureDir(stateDir(repoRoot));
  const path = lockPath(repoRoot);
  const payload: LockPayload = { pid: process.pid, host: hostname(), at: new Date().toISOString() };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(path, JSON.stringify(payload), { flag: 'wx', mode: FILE_MODE });
      return {
        async release(): Promise<void> {
          await unlink(path).catch(() => undefined);
        },
      };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw AgentshipError.from(
          ERROR_CODES.CONFIG_HOME_UNWRITABLE,
          `Could not create the apply lock at ${path}.`,
          cause,
        );
      }
      const holder = await readLock(path);
      if (holder !== undefined && isAlive(holder)) {
        throw new AgentshipError(
          ERROR_CODES.PLAN_LOCKED,
          `Another apply is running for this project (pid ${holder.pid} on ${holder.host}, since ${holder.at}).`,
          {
            details: { ...holder },
            remediation: { summary: 'Wait for the other apply to finish, then retry.' },
          },
        );
      }
      // Stale (dead pid, unreadable, or another host — unverifiable, treated as stale
      // because .agentship/state is local project state, not a shared filesystem).
      await unlink(path).catch(() => undefined);
    }
  }
  throw new AgentshipError(ERROR_CODES.PLAN_LOCKED, 'Could not acquire the apply lock.', {
    remediation: { summary: `Delete ${path} if no apply is running.` },
  });
}

async function readLock(path: string): Promise<LockPayload | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as LockPayload;
  } catch {
    return undefined;
  }
}

function isAlive(holder: LockPayload): boolean {
  if (holder.host !== hostname()) return false;
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch {
    return false;
  }
}
