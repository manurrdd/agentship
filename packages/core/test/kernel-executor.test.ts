import { readFile } from 'node:fs/promises';
import { journalPath, pathExists, saveManifest } from '@agentship/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, testManifest } from './kernel-helpers.js';

describe('executor and apply semantics', () => {
  let harness: Harness;
  afterEach(async () => {
    await harness?.cleanup();
  });

  it('local dry run touches neither the store nor the journal', async () => {
    harness = await createHarness({ stores: ['apple'] });
    const apple = harness.adapters.get('apple');
    if (apple === undefined) throw new Error('missing adapter');

    const plan = await harness.kernel.plan();
    const result = await harness.kernel.apply({
      planId: plan.planId,
      approvals: plan.approvalsRequired,
      dryRun: 'local',
    });
    expect(result.ok).toBe(true);
    expect(result.outcomes.filter((o) => o.status === 'done').length).toBeGreaterThan(0);
    expect(apple.effects.uploads + apple.effects.submits + apple.effects.metadataWrites).toBe(0);
    expect(await pathExists(journalPath(harness.repoRoot))).toBe(false);
  });

  it('server dry run validates against the store without effects or journal entries', async () => {
    harness = await createHarness({ stores: ['google'] });
    const google = harness.adapters.get('google');
    if (google === undefined) throw new Error('missing adapter');

    const plan = await harness.kernel.plan();
    const result = await harness.kernel.apply({
      planId: plan.planId,
      approvals: plan.approvalsRequired,
      dryRun: 'server',
    });
    expect(result.ok).toBe(true);
    expect(google.effects.edits).toBe(0);
    expect(google.effects.uploads).toBe(0);
    expect(await pathExists(journalPath(harness.repoRoot))).toBe(false);
  });

  it('rejects an apply for a plan id that is not current', async () => {
    harness = await createHarness({ stores: ['apple'] });
    await harness.kernel.plan();
    await expect(harness.kernel.apply({ planId: 'plan-bogus' })).rejects.toMatchObject({
      code: 'PLAN_NOT_FOUND',
    });
  });

  it('detects external drift, reports it, and invalidates affected approvals', async () => {
    harness = await createHarness({ stores: ['apple'] });
    const apple = harness.adapters.get('apple');
    if (apple === undefined) throw new Error('missing adapter');

    const plan = await harness.kernel.plan();
    const metadataApproval = plan.actions.find((a) => a.kind === 'set_metadata')?.id as string;

    // Someone edits the listing in the console between plan and apply.
    apple.state.localizations.set('en-US', {
      name: 'Mock App',
      description: 'Changed behind our back.',
    });

    const result = await harness.kernel.apply({
      planId: plan.planId,
      approvals: plan.approvalsRequired,
    });
    expect(result.driftDetected).toEqual(['apple']);
    expect(result.staleApprovals).toContain(metadataApproval);
    // The drifted metadata action was withheld — never executed with a stale approval.
    expect(apple.effects.metadataWrites).toBe(0);
    const freshMetadata = result.plan.actions.find((a) => a.kind === 'set_metadata');
    expect(result.outcomes.find((o) => o.actionId === freshMetadata?.id)?.status).toBe(
      'needs_approval',
    );
  });

  it('stops at the first failure by default but can continue independent work', async () => {
    harness = await createHarness({ stores: ['apple'] });
    const apple = harness.adapters.get('apple');
    if (apple === undefined) throw new Error('missing adapter');
    apple.injectFailure({ operation: 'setMetadata', phase: 'before', times: 2 });

    const plan = await harness.kernel.plan();
    const stopped = await harness.kernel.apply({
      planId: plan.planId,
      approvals: plan.approvalsRequired,
    });
    expect(stopped.ok).toBe(false);
    // Metadata comes first; with stopOnError everything after it is skipped.
    expect(stopped.outcomes.map((o) => o.status)).toEqual(['failed', 'skipped', 'skipped']);

    const continued = await harness.kernel.resume({
      approvals: stopped.plan.approvalsRequired,
      stopOnError: false,
    });
    expect(continued.ok).toBe(false);
    const byKind = new Map(
      continued.plan.actions.map((action) => [
        action.id,
        continued.outcomes.find((o) => o.actionId === action.id)?.status,
      ]),
    );
    const upload = continued.plan.actions.find((a) => a.kind === 'upload_build');
    expect(byKind.get(upload?.id ?? '')).toBe('done');
    expect(apple.effects.uploads).toBe(1);
  });

  it('an interrupted apply (orphan intents) resumes without duplicate effects', async () => {
    harness = await createHarness({ stores: ['apple'] });
    const apple = harness.adapters.get('apple');
    if (apple === undefined) throw new Error('missing adapter');

    const plan = await harness.kernel.plan();
    // Simulated kill after the store applied the batch but before results were journaled.
    await expect(
      harness.kernel.apply({
        planId: plan.planId,
        approvals: plan.approvalsRequired,
        chaos: (point) => {
          if (point === 'before_result') throw new Error('SIGKILL (simulated)');
        },
      }),
    ).rejects.toThrow('SIGKILL');
    expect(apple.effects.uploads).toBe(1);
    expect(apple.effects.submits).toBe(1);

    // The journal holds orphan intents; the raw file proves intents preceded results.
    const journal = await readFile(journalPath(harness.repoRoot), 'utf8');
    expect(journal).toContain('"type":"intent"');
    expect(journal).not.toContain('"type":"result"');

    const resumed = await harness.kernel.resume({ approvals: [] });
    expect(resumed.ok).toBe(true);
    expect(resumed.warnings.join(' ')).toContain('not re-executing');
    // Verification by query: nothing ran twice.
    expect(apple.effects.uploads).toBe(1);
    expect(apple.effects.submits).toBe(1);
    expect(apple.effects.metadataWrites).toBe(1);
    expect(resumed.plan.actions).toEqual([]);
  });

  it('a corrupt journal forces store verification instead of trusting completions', async () => {
    harness = await createHarness({ stores: ['apple'] });
    const plan = await harness.kernel.plan();
    await harness.kernel.apply({ planId: plan.planId, approvals: plan.approvalsRequired });

    // Corrupt a middle line.
    const path = journalPath(harness.repoRoot);
    const lines = (await readFile(path, 'utf8')).split('\n');
    lines[0] = '{"tampered":true';
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, lines.join('\n'));

    const resumed = await harness.kernel.resume({ approvals: [] });
    expect(resumed.ok).toBe(true);
    expect(resumed.warnings.join(' ')).toContain('malformed');
    // Convergence came from the fresh snapshot, not from journal claims.
    expect(resumed.plan.actions).toEqual([]);
  });

  it('re-planning after a manifest edit invalidates only the affected approvals', async () => {
    harness = await createHarness({ stores: ['apple'] });
    const plan = await harness.kernel.plan();
    const oldMetadata = plan.actions.find((a) => a.kind === 'set_metadata')?.id as string;
    const upload = plan.actions.find((a) => a.kind === 'upload_build')?.id as string;

    await saveManifest(harness.repoRoot, testManifest({ description: 'Edited afterwards.' }));
    const result = await harness.kernel.apply({
      planId: plan.planId,
      approvals: plan.approvalsRequired,
    });
    expect(result.staleApprovals).toContain(oldMetadata);
    // Content-unchanged actions keep their ids across the replan.
    expect(result.plan.actions.map((a) => a.id)).toContain(upload);
  });
});
