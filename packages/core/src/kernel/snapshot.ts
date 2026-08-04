import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AdapterContext, StoreAdapter } from '../adapter.js';
import { AgentshipError, ERROR_CODES } from '../errors.js';
import { ensureDir, FILE_MODE, stateDir } from '../paths.js';
import { redactValue } from '../redact.js';
import type { AppRef, RemoteAppState } from '../store-state.js';
import type { Store } from '../types.js';
import { contentHash } from './hash.js';
import { AGENTSHIP_VERSION } from './version.js';

/**
 * Persisted snapshots of remote store state: `.agentship/state/snapshot-<store>.json`.
 *
 * The truth is always the store. A persisted snapshot exists so that a plan can be shown,
 * discussed and approved against a known capture — and so that `apply` can prove the store
 * moved underneath it (drift) by comparing fingerprints, instead of guessing. Every
 * `apply` re-captures before executing; nothing is ever executed against a stale file.
 *
 * Snapshots are written through {@link redactValue}: they must never contain secrets,
 * because they live on disk unencrypted and travel into logs and MCP responses.
 */
export const SNAPSHOT_VERSION = 1;

export interface StoredSnapshot {
  readonly schemaVersion: typeof SNAPSHOT_VERSION;
  readonly agentshipVersion: string;
  readonly capturedAt: string;
  readonly store: Store;
  /** Content fingerprint of `state` (excluding `capturedAt`), for drift detection. */
  readonly fingerprint: string;
  readonly state: RemoteAppState;
}

export function snapshotPath(repoRoot: string, store: Store): string {
  return join(stateDir(repoRoot), `snapshot-${store}.json`);
}

/**
 * Fingerprint of a snapshot's content.
 *
 * `capturedAt` is excluded so that two captures of an unchanged store compare equal; any
 * other difference — a build that finished processing, a version whose state moved, an
 * edit made in the console — counts as drift, because the kernel cannot know which
 * external changes are benign.
 */
export function stateFingerprint(state: RemoteAppState): string {
  const { capturedAt: _ignored, ...content } = state;
  return contentHash(content);
}

/** Captures a fresh snapshot from the store and persists it, redacted. */
export async function captureSnapshot(
  adapter: StoreAdapter,
  context: AdapterContext,
  ref: AppRef,
  repoRoot: string,
): Promise<StoredSnapshot> {
  const state = await adapter.getAppState(context, ref);
  const snapshot: StoredSnapshot = {
    schemaVersion: SNAPSHOT_VERSION,
    agentshipVersion: AGENTSHIP_VERSION,
    capturedAt: state.capturedAt,
    store: adapter.store,
    fingerprint: stateFingerprint(state),
    state,
  };
  await ensureDir(stateDir(repoRoot));
  const path = snapshotPath(repoRoot, adapter.store);
  const redacted = redactValue(snapshot);
  await writeFile(path, `${JSON.stringify(redacted, null, 2)}\n`, { mode: FILE_MODE });
  return snapshot;
}

/** Loads the last persisted snapshot, or `undefined` when none exists. */
export async function loadSnapshot(
  repoRoot: string,
  store: Store,
): Promise<StoredSnapshot | undefined> {
  const path = snapshotPath(repoRoot, store);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw AgentshipError.from(ERROR_CODES.PLAN_JOURNAL_CORRUPT, `Could not read ${path}.`, cause);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw AgentshipError.from(
      ERROR_CODES.PLAN_JOURNAL_CORRUPT,
      `${path} is not valid JSON. Delete it; snapshots are always re-capturable.`,
      cause,
    );
  }
  const snapshot = parsed as StoredSnapshot;
  if (snapshot.schemaVersion !== SNAPSHOT_VERSION) {
    // A snapshot is a cache of the store; an incompatible one is simply ignored.
    return undefined;
  }
  return snapshot;
}
