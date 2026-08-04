import { AgentshipError, type ApplyResult, type ChaosPoint, type Store } from '@agentship/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createHarness } from './kernel-helpers.js';

/**
 * The kernel's two hard invariants, demonstrated under randomized fault sequences:
 *
 * 1. **No duplicated effects.** Whatever combination of failures and simulated kills is
 *    injected around each intent/result, no non-idempotent operation reaches the store
 *    twice (the mock throws on duplicate uploads/submissions, and effect counters are
 *    asserted to be exactly one).
 * 2. **Convergence.** A bounded number of resumes always reaches the desired state, with
 *    an empty plan at the end.
 *
 * Fault vocabulary:
 * - adapter faults, phase `before`: the store rejects the op without applying it;
 * - adapter faults, phase `after`: the store applies the op and *then* the connection
 *   dies (for Google, at the edit commit — atomically);
 * - chaos faults: the process is killed right after journaling intents, or right after
 *   the store call but before journaling results (orphan intents both ways).
 */
class SimulatedKill extends Error {
  constructor(point: ChaosPoint) {
    super(`simulated kill at ${point}`);
  }
}

type OperationTarget = 'setMetadata' | 'uploadBuild' | 'submitForReview';

interface Fault {
  readonly kind: 'adapter' | 'kill';
  readonly operation: OperationTarget | 'commit';
  readonly phase: 'before' | 'after';
  readonly point: ChaosPoint;
}

function faultArb(store: Store) {
  const operations: readonly (OperationTarget | 'commit')[] =
    store === 'google'
      ? ['setMetadata', 'uploadBuild', 'submitForReview', 'commit']
      : ['setMetadata', 'uploadBuild', 'submitForReview'];
  return fc.record({
    kind: fc.constantFrom<'adapter' | 'kill'>('adapter', 'kill'),
    operation: fc.constantFrom(...operations),
    phase: fc.constantFrom<'before' | 'after'>('before', 'after'),
    point: fc.constantFrom<ChaosPoint>('after_intent', 'before_result'),
  });
}

async function runScenario(store: Store, faults: readonly Fault[], processingTicks: number) {
  const harness = await createHarness({ stores: [store], processingTicks });
  const adapter = harness.adapters.get(store);
  if (adapter === undefined) throw new Error('missing adapter');

  const kills: ChaosPoint[] = [];
  for (const fault of faults) {
    if (fault.kind === 'adapter') {
      // Google per-op faults surface at validate; `after` only exists at the commit.
      const operation = store === 'google' && fault.phase === 'after' ? 'commit' : fault.operation;
      adapter.injectFailure({ operation, phase: fault.phase });
    } else {
      kills.push(fault.point);
    }
  }
  const chaos = (point: ChaosPoint): void => {
    const index = kills.indexOf(point);
    if (index !== -1) {
      kills.splice(index, 1);
      throw new SimulatedKill(point);
    }
  };

  const initial = await harness.kernel.plan();
  let approvals = initial.approvalsRequired;
  let planId = initial.planId;
  let converged = false;

  // Faults are finite, so a bounded number of plan→apply rounds must converge.
  for (let round = 0; round < 12 && !converged; round += 1) {
    let result: ApplyResult;
    try {
      result = await harness.kernel.apply({ planId, approvals, chaos });
    } catch (error) {
      if (error instanceof SimulatedKill || AgentshipError.is(error)) {
        // Crash or store-level refusal: replan, re-approve, resume — the agent flow.
        const fresh = await harness.kernel.plan();
        approvals = fresh.approvalsRequired;
        planId = fresh.planId;
        continue;
      }
      throw error;
    }
    converged = result.plan.actions.length === 0;
    approvals = result.plan.approvalsRequired;
    planId = result.planId;
  }

  const finalPlan = await harness.kernel.plan();
  const state = adapter.state;
  const effects = adapter.effects;
  await harness.cleanup();
  return { finalPlan, state, effects };
}

function assertConverged(
  outcome: Awaited<ReturnType<typeof runScenario>>,
  // Apple hands a submission to App Review; a Google commit to a testing track is live at
  // once. Same convergence, different end states, so the expectation says which.
  submittedState: 'waiting_review' | 'live' = 'waiting_review',
): void {
  expect(outcome.finalPlan.actions).toEqual([]);
  // Desired state reached…
  expect(outcome.state.localizations.get('en-US')?.description).toBe('Fresh new description.');
  const build = outcome.state.builds.filter((candidate) => candidate.buildNumber === '42');
  expect(build).toHaveLength(1);
  expect(outcome.state.versions.find((v) => v.version === '1.1.0')?.state).toBe(submittedState);
  // …and every non-idempotent effect happened exactly once.
  expect(outcome.effects.uploads).toBe(1);
  expect(outcome.effects.submits).toBe(1);
  expect(outcome.effects.metadataWrites).toBe(1);
}

describe('convergence under injected faults (property)', () => {
  it('Apple: any fault sequence converges without duplicate effects', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(faultArb('apple'), { maxLength: 4 }),
        fc.integer({ min: 0, max: 1 }),
        async (faults, processingTicks) => {
          assertConverged(await runScenario('apple', faults, processingTicks));
        },
      ),
      { numRuns: 750 },
    );
  }, 600_000);

  it('Google: any fault sequence converges without duplicate effects or partial edits', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(faultArb('google'), { maxLength: 4 }), async (faults) => {
        const outcome = await runScenario('google', faults, 0);
        assertConverged(outcome, 'live');
        // Atomicity: every committed edit applied all of its ops; a failed validate or a
        // pre-commit fault applied none (otherwise counters above could not all be 1).
        expect(outcome.effects.edits).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 300 },
    );
  }, 600_000);
});
