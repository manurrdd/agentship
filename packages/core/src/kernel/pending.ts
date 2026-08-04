import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AdapterContext, StoreAdapter } from '../adapter.js';
import { AgentshipError, ERROR_CODES } from '../errors.js';
import { optional } from '../optional.js';
import { ensureDir, FILE_MODE, pendingDir } from '../paths.js';
import { redactValue } from '../redact.js';
import type { AppRef, RemoteAppState } from '../store-state.js';
import type { PendingOperation, PendingStatus, Store } from '../types.js';
import type { AgentshipManifest } from './manifest.js';

/**
 * Persistence and lifecycle of pending operations: `.agentship/pending/<id>.json`.
 *
 * A pending operation is work Agentship cannot perform through an API. Its lifecycle is
 * `open → done → verified`: an agent or human marks it `done` after acting in the store
 * console, and — when the operation declares a verification with a registered check —
 * {@link verifyPending} confirms it against a fresh store snapshot before promoting it to
 * `verified`. Actions whose `blockedBy` names a pending operation stay blocked until it
 * reaches `done` or `verified`.
 *
 * Statuses only move forward here: re-planning merges freshly emitted pendings into the
 * files without ever resetting a `done`/`verified` back to `open`.
 */
const STATUS_RANK: Readonly<Record<PendingStatus, number>> = {
  open: 0,
  in_progress: 1,
  failed: 1,
  skipped: 2,
  done: 2,
  verified: 3,
};

/** `true` when a pending operation no longer blocks the actions that depend on it. */
export function pendingSatisfied(status: PendingStatus): boolean {
  return status === 'done' || status === 'verified' || status === 'skipped';
}

function fileNameFor(id: string): string {
  return `${id.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
}

async function write(repoRoot: string, operation: PendingOperation): Promise<void> {
  await ensureDir(pendingDir(repoRoot));
  const path = join(pendingDir(repoRoot), fileNameFor(operation.id));
  await writeFile(path, `${JSON.stringify(redactValue(operation), null, 2)}\n`, {
    mode: FILE_MODE,
  });
}

/** Lists every persisted pending operation, sorted by id. */
export async function listPending(repoRoot: string): Promise<readonly PendingOperation[]> {
  let files: string[];
  try {
    files = await readdir(pendingDir(repoRoot));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw AgentshipError.from(
      ERROR_CODES.CONFIG_HOME_UNWRITABLE,
      'Could not read the pending directory.',
      cause,
    );
  }
  const operations: PendingOperation[] = [];
  for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
    const raw = await readFile(join(pendingDir(repoRoot), file), 'utf8');
    operations.push(JSON.parse(raw) as PendingOperation);
  }
  return operations.sort((a, b) => a.id.localeCompare(b.id));
}

export async function getPending(repoRoot: string, id: string): Promise<PendingOperation> {
  const all = await listPending(repoRoot);
  const found = all.find((operation) => operation.id === id);
  if (found === undefined) {
    throw new AgentshipError(ERROR_CODES.PLAN_NOT_FOUND, `No pending operation with id "${id}".`, {
      details: { id, known: all.map((operation) => operation.id) },
    });
  }
  return found;
}

/**
 * Merges freshly planned pending operations into the persisted set.
 *
 * Content (title, fields, console, blocking) comes from the fresh emission; status and
 * notes come from whichever side is further along, so completing work in the console is
 * never undone by a replan.
 */
export async function mergePendingOperations(
  repoRoot: string,
  fresh: readonly PendingOperation[],
): Promise<readonly PendingOperation[]> {
  const persisted = new Map((await listPending(repoRoot)).map((op) => [op.id, op]));
  const merged: PendingOperation[] = [];
  for (const operation of fresh) {
    const existing = persisted.get(operation.id);
    const keepExistingStatus =
      existing !== undefined && STATUS_RANK[existing.status] > STATUS_RANK[operation.status];
    const next: PendingOperation = {
      ...operation,
      ...(keepExistingStatus
        ? {
            status: existing.status,
            ...optional('updatedAt', existing.updatedAt),
            ...optional('notes', existing.notes),
          }
        : {}),
    };
    await write(repoRoot, next);
    merged.push(next);
  }
  return merged;
}

async function transition(
  repoRoot: string,
  id: string,
  status: PendingStatus,
  notes?: string,
): Promise<PendingOperation> {
  const current = await getPending(repoRoot, id);
  const next: PendingOperation = {
    ...current,
    status,
    updatedAt: new Date().toISOString(),
    ...optional('notes', notes ?? current.notes),
  };
  await write(repoRoot, next);
  return next;
}

/** Marks a pending operation as completed by an agent or human. */
export async function completePending(
  repoRoot: string,
  id: string,
  notes?: string,
): Promise<PendingOperation> {
  return transition(repoRoot, id, 'done', notes);
}

/**
 * What a verifier knows besides the store snapshot.
 *
 * Most console work is confirmed by looking at the store, but not all of it: whether an
 * upload keystore exists is a fact about *this machine*, and no snapshot of App Store
 * Connect or Play will ever answer it. Passing the project alongside the snapshot is what
 * lets those checks be real instead of permanently returning `false`.
 */
export interface PendingVerifierContext {
  readonly repoRoot: string;
  readonly manifest: AgentshipManifest;
}

/**
 * A registered check that decides whether a pending operation's effect is now observable.
 *
 * Keyed by `PendingVerification.check`. The snapshot is fresh by construction — the kernel
 * re-captures before calling — so a verifier must never cache and must never trust that the
 * operation was marked done.
 */
export type PendingVerifier = (
  operation: PendingOperation,
  state: RemoteAppState,
  context: PendingVerifierContext,
) => boolean | Promise<boolean>;

export type PendingVerifierMap = ReadonlyMap<string, PendingVerifier>;

export interface VerifyPendingResult {
  readonly operation: PendingOperation;
  readonly verified: boolean;
  readonly detail: string;
}

/**
 * Verifies a completed pending operation against the store.
 *
 * Requires a fresh `getAppState` call — never a cached snapshot — because the whole point
 * is to observe what the console work actually produced. Operations without a registered
 * check stay `done`: honesty over optimism.
 */
export async function verifyPending(options: {
  readonly repoRoot: string;
  readonly id: string;
  readonly adapters: ReadonlyMap<Store, StoreAdapter>;
  readonly context: AdapterContext;
  readonly refs: ReadonlyMap<Store, AppRef>;
  readonly verifiers: PendingVerifierMap;
  readonly manifest: AgentshipManifest;
}): Promise<VerifyPendingResult> {
  const operation = await getPending(options.repoRoot, options.id);
  const checkId = operation.verification?.check;
  if (checkId === undefined) {
    return {
      operation,
      verified: false,
      detail: 'This operation declares no automatic verification; confirm it manually.',
    };
  }
  const verifier = options.verifiers.get(checkId);
  if (verifier === undefined) {
    return {
      operation,
      verified: false,
      detail: `No verifier is registered for check "${checkId}".`,
    };
  }
  const adapter = options.adapters.get(operation.store);
  const ref = options.refs.get(operation.store);
  if (adapter === undefined || ref === undefined) {
    return {
      operation,
      verified: false,
      detail: `No adapter or app reference is configured for the ${operation.store} store.`,
    };
  }
  const state = await adapter.getAppState(options.context, ref);
  const verified = await verifier(operation, state, {
    repoRoot: options.repoRoot,
    manifest: options.manifest,
  });
  if (!verified) {
    return {
      operation,
      verified: false,
      detail: 'The store does not yet reflect this operation.',
    };
  }
  const updated = await transition(options.repoRoot, options.id, 'verified');
  return { operation: updated, verified: true, detail: 'Verified against the store.' };
}
