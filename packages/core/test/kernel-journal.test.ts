import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalJson,
  contentHash,
  journalPath,
  openJournal,
  readJournal,
  summarizeJournal,
} from '@agentship/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('canonical hashing', () => {
  it('is insensitive to object key order, sensitive to content', () => {
    expect(contentHash({ a: 1, b: [{ x: 1, y: 2 }] })).toBe(
      contentHash({ b: [{ y: 2, x: 1 }], a: 1 }),
    );
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
    expect(canonicalJson({ b: 1, a: undefined })).toBe('{"b":1}');
  });

  it('preserves array order as content', () => {
    expect(contentHash([1, 2])).not.toBe(contentHash([2, 1]));
  });
});

describe('journal', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'agentship-journal-'));
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  const intentFields = (actionId: string, attempt = 1) => ({
    planId: 'plan-x',
    actionId,
    idempotencyKey: actionId,
    store: 'apple' as const,
    kind: 'upload_build',
    attempt,
  });

  it('round-trips intents and results and detects orphans', async () => {
    const journal = await openJournal(repoRoot);
    journal.intent(intentFields('a:1:h'));
    journal.result({
      planId: 'plan-x',
      actionId: 'a:1:h',
      idempotencyKey: 'a:1:h',
      attempt: 1,
      status: 'done',
      changed: true,
    });
    journal.intent(intentFields('b:2:h'));

    const read = await readJournal(repoRoot);
    expect(read.corrupt).toBe(false);
    expect(read.warnings).toEqual([]);
    expect(read.entries).toHaveLength(3);

    const summary = summarizeJournal(read.entries);
    expect(summary.get('a:1:h')?.orphanIntent).toBe(false);
    expect(summary.get('b:2:h')?.orphanIntent).toBe(true);
  });

  it('a new attempt supersedes the previous result', async () => {
    const journal = await openJournal(repoRoot);
    journal.intent(intentFields('a:1:h', 1));
    journal.result({
      planId: 'plan-x',
      actionId: 'a:1:h',
      idempotencyKey: 'a:1:h',
      attempt: 1,
      status: 'failed',
    });
    journal.intent(intentFields('a:1:h', 2));
    const summary = summarizeJournal((await readJournal(repoRoot)).entries);
    expect(summary.get('a:1:h')?.orphanIntent).toBe(true);
  });

  it('discards a truncated final line with a warning, without marking corruption', async () => {
    const journal = await openJournal(repoRoot);
    journal.intent(intentFields('a:1:h'));
    await appendFile(journalPath(repoRoot), '{"type":"result","v":1,"agentship":"0');

    const read = await readJournal(repoRoot);
    expect(read.corrupt).toBe(false);
    expect(read.entries).toHaveLength(1);
    expect(read.warnings.join(' ')).toContain('truncated');
  });

  it('marks the journal corrupt when a middle line is malformed', async () => {
    const journal = await openJournal(repoRoot);
    journal.intent(intentFields('a:1:h'));
    await appendFile(journalPath(repoRoot), 'garbage-not-json\n');
    journal.intent(intentFields('b:2:h'));

    const read = await readJournal(repoRoot);
    expect(read.corrupt).toBe(true);
    expect(read.entries).toHaveLength(2);
  });

  it('treats schema-invalid entries as corruption, not as data', async () => {
    await openJournal(repoRoot); // ensures the state directory exists
    await appendFile(
      journalPath(repoRoot),
      `${JSON.stringify({ type: 'intent', v: 1 })}\n{"type":"unknown"}\n`,
    );
    const read = await readJournal(repoRoot);
    expect(read.corrupt).toBe(true);
    expect(read.entries).toHaveLength(0);
  });

  it('returns empty for a missing journal', async () => {
    const read = await readJournal(repoRoot);
    expect(read).toEqual({ entries: [], warnings: [], corrupt: false });
  });
});
