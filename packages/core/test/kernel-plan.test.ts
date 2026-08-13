import {
  type ActionDraft,
  AgentshipError,
  buildPlan,
  checkApprovals,
  classifyDraft,
  createMockState,
  DifferRegistry,
  ERROR_CODES,
  MockStoreAdapter,
  metadataDiffer,
  type PlannedAction,
  type ResourceDiffer,
  releaseDiffer,
} from '@agentship/core';
import { describe, expect, it } from 'vitest';
import { testContext, testManifest } from './kernel-helpers.js';

async function planWith(options: {
  registry?: DifferRegistry;
  description?: string;
  track?: 'internal_testing' | 'production';
  adapter?: MockStoreAdapter;
}) {
  const adapter = options.adapter ?? new MockStoreAdapter({ store: 'apple' });
  const state = await adapter.getAppState(testContext(), {
    store: 'apple',
    id: 'app-1',
  });
  const registry =
    options.registry ??
    new DifferRegistry().register(metadataDiffer('apple')).register(releaseDiffer('apple'));
  return buildPlan({
    repoRoot: '/tmp/unused',
    manifest: testManifest({
      description: options.description ?? 'Fresh new description.',
      track: options.track ?? 'internal_testing',
    }),
    registry,
    stores: [
      {
        store: 'apple',
        state,
        capabilities: adapter.capabilities(),
        knownPending: adapter.knownPendingOperations(),
      },
    ],
  });
}

describe('buildPlan', () => {
  it('produces identical ids and planId whatever order differs register in', async () => {
    const forward = new DifferRegistry()
      .register(metadataDiffer('apple'))
      .register(releaseDiffer('apple'));
    const backward = new DifferRegistry()
      .register(releaseDiffer('apple'))
      .register(metadataDiffer('apple'));

    const a = await planWith({ registry: forward });
    const b = await planWith({ registry: backward });
    expect(a.actions.map((action) => action.id)).toEqual(b.actions.map((action) => action.id));
    expect(a.planId).toBe(b.planId);
  });

  it('changes an action id when — and only when — its content changes', async () => {
    const a = await planWith({ description: 'One description.' });
    const b = await planWith({ description: 'One description.' });
    const c = await planWith({ description: 'Another description.' });

    const metadataId = (plan: { actions: readonly PlannedAction[] }) =>
      plan.actions.find((action) => action.kind === 'set_metadata')?.id;
    const uploadId = (plan: { actions: readonly PlannedAction[] }) =>
      plan.actions.find((action) => action.kind === 'upload_build')?.id;

    expect(metadataId(a)).toBe(metadataId(b));
    expect(metadataId(a)).not.toBe(metadataId(c));
    // Unrelated actions keep their ids.
    expect(uploadId(a)).toBe(uploadId(c));
  });

  it('orders dependencies before dependents and rejects cycles', async () => {
    const plan = await planWith({});
    const ids = plan.actions.map((action) => action.id);
    const upload = plan.actions.find((action) => action.kind === 'upload_build');
    const submit = plan.actions.find((action) => action.kind === 'submit_for_review');
    expect(upload).toBeDefined();
    expect(submit?.dependsOn).toEqual([upload?.id]);
    expect(ids.indexOf(upload?.id ?? '')).toBeLessThan(ids.indexOf(submit?.id ?? ''));

    const cyclic: ResourceDiffer = {
      store: 'apple',
      resource: 'cyclic',
      plan: () => [
        {
          kind: 'a',
          target: 't',
          operation: 'setMetadata',
          summary: 'a',
          diff: [],
          dependsOn: [{ kind: 'b', target: 't' }],
        },
        {
          kind: 'b',
          target: 't',
          operation: 'setMetadata',
          summary: 'b',
          diff: [],
          dependsOn: [{ kind: 'a', target: 't' }],
        },
      ],
    };
    await expect(
      planWith({ registry: new DifferRegistry().register(cyclic) }),
    ).rejects.toMatchObject({ code: 'PLAN_CONFLICT' });
  });

  it('upgrades classification for production and sensitive operations, never downgrades', async () => {
    const capabilities = new MockStoreAdapter({ store: 'apple' }).capabilities();
    const base: ActionDraft = {
      kind: 'upload_build',
      target: 'build/42',
      operation: 'uploadBuild',
      summary: 's',
      diff: [],
    };
    expect(classifyDraft(base, capabilities)).toBe('auto');
    expect(classifyDraft({ ...base, production: true }, capabilities)).toBe('needs_approval');
    expect(classifyDraft({ ...base, destructive: true }, capabilities)).toBe('needs_approval');
    expect(classifyDraft({ ...base, operation: 'setPricing' }, capabilities)).toBe(
      'needs_approval',
    );
    expect(classifyDraft({ ...base, needsInput: ['x'] }, capabilities)).toBe('needs_input');

    const google = new MockStoreAdapter({ store: 'google' }).capabilities();
    // Google pricing has no API: agent_browser must never be "upgraded" to executable.
    expect(classifyDraft({ ...base, operation: 'setPricing' }, google)).toBe('agent_browser');
    expect(() => classifyDraft({ ...base, operation: 'reviewStatus' }, google)).toThrow(
      /unsupported/,
    );
  });

  it('marks a production submission needs_approval with risk notes', async () => {
    const plan = await planWith({ track: 'production' });
    const submit = plan.actions.find((action) => action.kind === 'submit_for_review');
    expect(submit?.classification).toBe('needs_approval');
    expect(submit?.riskNotes.join(' ')).toMatch(/production/);
    expect(plan.approvalsRequired).toContain(submit?.id);
  });

  it('collects pending operations and records what they block', async () => {
    const adapter = new MockStoreAdapter({
      store: 'google',
      state: createMockState({ contentRatingDone: false }),
    });
    const state = await adapter.getAppState(testContext(), {
      store: 'google',
      id: 'com.example.mock',
    });
    const plan = await buildPlan({
      repoRoot: '/tmp/unused',
      manifest: testManifest({ stores: ['google'] }),
      registry: new DifferRegistry()
        .register(metadataDiffer('google'))
        .register(releaseDiffer('google')),
      stores: [
        {
          store: 'google',
          state,
          capabilities: adapter.capabilities(),
          knownPending: adapter.knownPendingOperations(),
        },
      ],
    });
    const submit = plan.actions.find((action) => action.kind === 'submit_for_review');
    const rating = plan.pending.find((pending) => pending.id === 'google:content-rating');
    expect(submit?.blockedBy).toEqual(['google:content-rating']);
    expect(rating?.blocking).toEqual([submit?.id]);
  });
});

/**
 * One resource failing must cost exactly that resource.
 *
 * This is the shape of a real session: a manifest listing screenshots whose files had moved
 * made the screenshots differ throw, `buildPlan` propagated it, and a user who had asked to
 * compile and upload two binaries got no plan at all — the build and upload actions were
 * never even drafted. Nothing about a missing PNG says anything about a build.
 */
describe('a differ that fails', () => {
  const exploding = (resource: string, error: unknown): ResourceDiffer => ({
    store: 'apple',
    resource,
    plan: () => {
      throw error;
    },
  });

  it('blocks only its own resource and leaves the rest of the plan applicable', async () => {
    const plan = await planWith({
      registry: new DifferRegistry()
        .register(metadataDiffer('apple'))
        .register(releaseDiffer('apple'))
        .register(
          exploding(
            'screenshots',
            new AgentshipError(
              ERROR_CODES.CONFIG_MANIFEST_INVALID,
              'The manifest lists 5 screenshots that do not exist: a.png, b.png.',
              { remediation: { summary: 'Ask the user where these files are now.' } },
            ),
          ),
        ),
    });

    expect(plan.actions.length).toBeGreaterThan(0);
    expect(plan.actions.map((action) => action.kind)).toContain('set_metadata');
    expect(plan.blocked).toEqual([
      {
        store: 'apple',
        resource: 'screenshots',
        code: ERROR_CODES.CONFIG_MANIFEST_INVALID,
        reason: 'The manifest lists 5 screenshots that do not exist: a.png, b.png.',
        remediation: 'Ask the user where these files are now.',
      },
    ]);
    expect(plan.warnings.join('\n')).toContain('apple/screenshots');
  });

  it('does not hide an unexpected implementation error as a user resource problem', async () => {
    await expect(
      planWith({
        registry: new DifferRegistry()
          .register(metadataDiffer('apple'))
          .register(exploding('products', new Error('unexpected parser defect'))),
      }),
    ).rejects.toThrow('unexpected parser defect');
  });

  it('keeps the plan id determined by the actions, not by the failure text', async () => {
    const first = await planWith({
      registry: new DifferRegistry()
        .register(metadataDiffer('apple'))
        .register(
          exploding(
            'screenshots',
            new AgentshipError(ERROR_CODES.CONFIG_MANIFEST_INVALID, 'a.png is missing'),
          ),
        ),
    });
    const second = await planWith({
      registry: new DifferRegistry()
        .register(metadataDiffer('apple'))
        .register(
          exploding(
            'screenshots',
            new AgentshipError(ERROR_CODES.CONFIG_MANIFEST_INVALID, 'b.png is missing too'),
          ),
        ),
    });
    // Same actions, so the same approvals stay valid; only the reason differs.
    expect(first.planId).toBe(second.planId);
    expect(first.blocked[0]?.reason).not.toBe(second.blocked[0]?.reason);
  });
});

/**
 * An approval has to survive the store moving underneath it.
 *
 * Applying part of a plan changes the store, which changes the "before" side of every other
 * action's diff. While the id hashed that too, approving "set the description to X" expired
 * because an unrelated upload had happened — and the user was asked to approve the same
 * wording again. Sixteen times, in the sessions this test comes from.
 */
describe('what an approval is bound to', () => {
  it('is the target state, not what the store happens to say now', async () => {
    const fromEmpty = await planWith({ description: 'The same description.' });
    const fromOther = await planWith({
      description: 'The same description.',
      adapter: new MockStoreAdapter({
        store: 'apple',
        state: createMockState({ description: 'Something else entirely.' }),
      }),
    });

    const idOf = (plan: Awaited<ReturnType<typeof planWith>>): string | undefined =>
      plan.actions.find((action) => action.kind === 'set_metadata')?.id;
    expect(idOf(fromEmpty)).toBe(idOf(fromOther));
  });

  it('still changes when the target itself changes', async () => {
    const before = await planWith({ description: 'One description.' });
    const after = await planWith({ description: 'Another description.' });
    const idOf = (plan: Awaited<ReturnType<typeof planWith>>): string | undefined =>
      plan.actions.find((action) => action.kind === 'set_metadata')?.id;
    expect(idOf(before)).not.toBe(idOf(after));
  });
});

describe('approving a whole plan', () => {
  it('covers every action in that exact plan with one id', async () => {
    const plan = await planWith({ track: 'production' });
    const check = checkApprovals(plan, [plan.planId]);
    const submits = plan.actions.filter((action) => action.operation === 'submitForReview');
    expect(submits.length).toBeGreaterThan(0);
    // Everything except the operations that reach real people irreversibly.
    for (const id of plan.approvalsRequired) {
      const action = plan.actions.find((candidate) => candidate.id === id);
      if (action?.operation === 'submitForReview') {
        expect(check.missing).toContain(id);
      } else {
        expect([...check.valid]).toContain(id);
      }
    }
  });

  it('is not a blanket yes: another plan’s id approves nothing', async () => {
    const plan = await planWith({ description: 'One description.' });
    const other = await planWith({ description: 'Another description.' });
    const check = checkApprovals(plan, [other.planId]);
    expect([...check.valid]).toEqual([]);
    expect(check.stale).toEqual([other.planId]);
    expect(check.missing).toEqual(plan.approvalsRequired);
  });
});

describe('checkApprovals', () => {
  it('separates valid, stale and unknown approvals and lists missing ones', async () => {
    const before = await planWith({ description: 'One description.' });
    const after = await planWith({ description: 'Another description.' });

    const staleApproval = before.actions.find((action) => action.kind === 'set_metadata')
      ?.id as string;
    const stillValid = after.actions.find((action) => action.kind === 'submit_for_review')
      ?.id as string;

    const check = checkApprovals(after, [staleApproval, stillValid, 'nonsense:x:y']);
    expect([...check.valid]).toEqual([stillValid]);
    expect(check.stale).toEqual([staleApproval]);
    expect(check.unknown).toEqual(['nonsense:x:y']);
    expect(check.missing).toContain(
      after.actions.find((action) => action.kind === 'set_metadata')?.id,
    );
  });
});
