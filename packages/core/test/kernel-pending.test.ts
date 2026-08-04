import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  completePending,
  getPending,
  listPending,
  mergePendingOperations,
  type PendingOperation,
} from '@agentship/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function pendingFixture(overrides: Partial<PendingOperation> = {}): PendingOperation {
  return {
    id: 'google:content-rating',
    store: 'google',
    category: 'content_rating',
    title: 'Complete the questionnaire',
    reason: 'No API.',
    actionClass: 'agent_browser',
    status: 'open',
    ...overrides,
  };
}

describe('pending operations', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'agentship-pending-'));
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('persists, lists and fetches operations', async () => {
    await mergePendingOperations(repoRoot, [pendingFixture()]);
    expect(await listPending(repoRoot)).toHaveLength(1);
    expect((await getPending(repoRoot, 'google:content-rating')).status).toBe('open');
    await expect(getPending(repoRoot, 'nope')).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
  });

  it('completing moves the status forward and a replan never moves it back', async () => {
    await mergePendingOperations(repoRoot, [pendingFixture()]);
    await completePending(repoRoot, 'google:content-rating', 'Done in console.');
    expect((await getPending(repoRoot, 'google:content-rating')).status).toBe('done');

    // A later plan emits the same operation as open again — content refreshes, status stays.
    const merged = await mergePendingOperations(repoRoot, [
      pendingFixture({ title: 'Refreshed title', blocking: ['submit_for_review:x:y'] }),
    ]);
    expect(merged[0]?.status).toBe('done');
    expect(merged[0]?.title).toBe('Refreshed title');
    expect(merged[0]?.notes).toBe('Done in console.');
  });
});
