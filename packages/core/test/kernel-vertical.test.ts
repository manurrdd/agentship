import { readFile } from 'node:fs/promises';
import {
  clearRegisteredSecrets,
  journalPath,
  planPath,
  registerSecret,
  snapshotPath,
} from '@agentship/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './kernel-helpers.js';

/**
 * The canonical vertical slice: manifest → snapshot → plan → approve → apply → failure →
 * resume → convergence, against the mock store. This test is the executable contract the
 * later plans build on.
 */
describe('vertical slice', () => {
  let harness: Harness;
  afterEach(async () => {
    await harness?.cleanup();
    clearRegisteredSecrets();
  });

  it('runs the full happy path to convergence on Apple', async () => {
    harness = await createHarness({ stores: ['apple'] });
    const apple = harness.adapters.get('apple');
    if (apple === undefined) throw new Error('missing adapter');

    const plan = await harness.kernel.plan();
    expect(plan.actions.map((action) => action.kind).sort()).toEqual([
      'set_metadata',
      'submit_for_review',
      'upload_build',
    ]);

    // Nothing sensitive without approval: withheld, not failed — and nothing executed.
    const withoutApprovals = await harness.kernel.apply({ planId: plan.planId });
    const statuses = new Map(
      withoutApprovals.outcomes.map((outcome) => [outcome.actionId, outcome.status]),
    );
    const metadata = plan.actions.find((action) => action.kind === 'set_metadata');
    const upload = plan.actions.find((action) => action.kind === 'upload_build');
    const submit = plan.actions.find((action) => action.kind === 'submit_for_review');
    expect(statuses.get(metadata?.id ?? '')).toBe('needs_approval');
    expect(statuses.get(upload?.id ?? '')).toBe('done'); // auto: uploads need no approval
    expect(statuses.get(submit?.id ?? '')).toBe('needs_approval');
    expect(apple.effects.submits).toBe(0);
    expect(apple.effects.metadataWrites).toBe(0);

    // Approve and apply the rest. The upload already happened; replanning must not redo it.
    const second = await harness.kernel.resume({
      approvals: withoutApprovals.plan.approvalsRequired,
    });
    expect(second.ok).toBe(true);
    expect(apple.effects.uploads).toBe(1);
    expect(apple.effects.submits).toBe(1);
    expect(apple.effects.metadataWrites).toBe(1);

    // Converged: a fresh plan is empty.
    const final = await harness.kernel.plan();
    expect(final.actions).toEqual([]);
    expect(apple.state.versions.find((v) => v.version === '1.1.0')?.state).toBe('waiting_review');
    expect(apple.state.localizations.get('en-US')?.description).toBe('Fresh new description.');
  });

  it('recovers from a mid-apply failure without duplicating the upload', async () => {
    harness = await createHarness({ stores: ['apple'] });
    const apple = harness.adapters.get('apple');
    if (apple === undefined) throw new Error('missing adapter');
    // The store submits the version and *then* the connection dies: the worst case.
    apple.injectFailure({ operation: 'submitForReview', phase: 'after' });

    const plan = await harness.kernel.plan();
    const first = await harness.kernel.apply({
      planId: plan.planId,
      approvals: plan.approvalsRequired,
    });
    expect(first.ok).toBe(false);
    expect(apple.effects.submits).toBe(1); // the effect landed before the failure

    const resumed = await harness.kernel.resume({ approvals: first.plan.approvalsRequired });
    expect(resumed.ok).toBe(true);
    // The fresh snapshot proved the submission landed; it was not re-executed.
    expect(apple.effects.submits).toBe(1);
    expect(apple.effects.uploads).toBe(1);
    expect((await harness.kernel.plan()).actions).toEqual([]);
  });

  it('waits out build processing across resumes', async () => {
    harness = await createHarness({ stores: ['apple'], processingTicks: 2 });
    const apple = harness.adapters.get('apple');
    if (apple === undefined) throw new Error('missing adapter');

    const plan = await harness.kernel.plan();
    const first = await harness.kernel.apply({
      planId: plan.planId,
      approvals: plan.approvalsRequired,
    });
    // Upload succeeded; the submit failed because the build is still processing.
    expect(first.ok).toBe(false);
    expect(apple.effects.uploads).toBe(1);

    // Resuming replans each time; approvals are refreshed from the returned fresh plan
    // (content changed remotely — the draft version now exists — so ids legitimately
    // rotate and the old submit approval goes stale instead of silently carrying over).
    let result = first;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      result = await harness.kernel.resume({ approvals: result.plan.approvalsRequired });
      if (result.ok && result.plan.actions.length === 0) break;
    }
    expect(result.plan.actions).toEqual([]);
    expect(apple.effects.uploads).toBe(1);
    expect(apple.effects.submits).toBe(1);
  });

  it('groups a Google apply into one atomic edit and honours pending gating', async () => {
    harness = await createHarness({
      stores: ['google'],
      state: () => ({ contentRatingDone: false }),
    });
    const google = harness.adapters.get('google');
    if (google === undefined) throw new Error('missing adapter');

    const plan = await harness.kernel.plan();
    const submit = plan.actions.find((action) => action.kind === 'submit_for_review');
    expect(submit?.blockedBy).toEqual(['google:content-rating']);

    const first = await harness.kernel.apply({
      planId: plan.planId,
      approvals: plan.approvalsRequired,
    });
    expect(first.ok).toBe(true);
    const byId = new Map(first.outcomes.map((outcome) => [outcome.actionId, outcome]));
    expect(byId.get(submit?.id ?? '')?.status).toBe('blocked');
    // Metadata + upload travelled in exactly one committed edit, and it was atomic.
    expect(google.effects.edits).toBe(1);
    expect(
      first.outcomes.filter((outcome) => outcome.status === 'done').every((o) => o.atomic),
    ).toBe(true);

    // The console work happens (simulated), the pending is completed and verified…
    google.state.contentRatingDone = true;
    await harness.kernel.completePending('google:content-rating', 'Questionnaire submitted.');
    const verification = await harness.kernel.verifyPending('google:content-rating');
    expect(verification.verified).toBe(true);
    expect(verification.operation.status).toBe('verified');

    // …and the release converges after a fresh plan/approve/apply round (the submit's
    // content changed — the draft version now exists — so the old approval is stale).
    const fresh = await harness.kernel.plan();
    expect(fresh.actions.map((action) => action.kind)).toEqual(['submit_for_review']);
    const second = await harness.kernel.apply({
      planId: fresh.planId,
      approvals: fresh.approvalsRequired,
    });
    expect(second.ok).toBe(true);
    expect(google.effects.submits).toBe(1);
    expect((await harness.kernel.plan()).actions).toEqual([]);
  });

  it('treats Google pricing proposals as results, not failures', async () => {
    harness = await createHarness({ stores: ['google'] });
    const google = harness.adapters.get('google');
    if (google === undefined) throw new Error('missing adapter');

    const result = await google.setPricing(
      harness.context,
      { store: 'google', id: 'com.example.mock' },
      { free: false, amount: '3.99' },
    );
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.pending?.[0]?.id).toBe('google:pricing-and-countries');
    expect(google.effects.pricingWrites).toBe(0);
  });

  it('keeps secrets out of every persisted kernel file', async () => {
    const canary = 'kernel-canary-9f8e7d6c5b4a';
    registerSecret(canary);
    harness = await createHarness({
      stores: ['apple'],
      state: () => ({
        localizations: new Map([
          ['en-US', { name: 'Mock App', description: `The original text. token=${canary}` }],
        ]),
      }),
    });

    const plan = await harness.kernel.plan();
    await harness.kernel.apply({ planId: plan.planId, approvals: plan.approvalsRequired });

    for (const file of [
      snapshotPath(harness.repoRoot, 'apple'),
      planPath(harness.repoRoot),
      journalPath(harness.repoRoot),
    ]) {
      const content = await readFile(file, 'utf8');
      expect(content, file).not.toContain(canary);
    }
  });
});
