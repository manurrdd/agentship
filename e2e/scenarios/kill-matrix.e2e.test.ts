import type { MockStoreAdapter, Store } from '@agentship/core';
import { describe, expect, it } from 'vitest';
import { Journey, type PlanView } from '../src/journey.js';
import { releaseManifest } from '../src/manifests.js';

/**
 * The kill matrix: the same release, interrupted at every point that can interrupt it.
 *
 * Two kinds of interruption, and the difference between them is the whole reason this file
 * exists:
 *
 * - **The store refuses** (`before`): the operation never happened, so it must happen later.
 * - **The answer is lost** (`after`): the operation *did* happen and Agentship never heard
 *   about it. Re-running it would upload a second build or submit a second time.
 *
 * Every case is followed by a real process death — the server, the session and every cached
 * kernel are thrown away, and a new process picks the release up from the journal on disk
 * and a fresh look at the store. What is asserted is always the same pair: the release
 * converges, and every non-idempotent effect happened exactly once.
 *
 * The matrix is enumerated rather than randomised on purpose; `kernel-convergence.property`
 * covers the randomised version at the kernel level. This one runs the whole agent flow.
 */
type Phase = 'before' | 'after';

interface KillCase {
  readonly operation: 'setMetadata' | 'uploadBuild' | 'submitForReview' | 'commit';
  readonly phase: Phase;
}

const APPLE_CASES: readonly KillCase[] = [
  { operation: 'setMetadata', phase: 'before' },
  { operation: 'setMetadata', phase: 'after' },
  { operation: 'uploadBuild', phase: 'before' },
  { operation: 'uploadBuild', phase: 'after' },
  { operation: 'submitForReview', phase: 'before' },
  { operation: 'submitForReview', phase: 'after' },
];

// Play applies a batch: every per-op failure surfaces at validate, and the only `after`
// that exists is the commit itself, which either lands whole or not at all.
const GOOGLE_CASES: readonly KillCase[] = [
  { operation: 'setMetadata', phase: 'before' },
  { operation: 'uploadBuild', phase: 'before' },
  { operation: 'submitForReview', phase: 'before' },
  { operation: 'commit', phase: 'before' },
  { operation: 'commit', phase: 'after' },
];

/** Everything the store must end up with, whatever happened on the way. */
function expectConverged(journey: Journey, store: Store, remaining: PlanView): void {
  const adapter = journey.adapter(store);
  expect(adapter.effects.uploads, `${store} uploads\n${journey.render()}`).toBe(1);
  expect(adapter.effects.submits, `${store} submits\n${journey.render()}`).toBe(1);
  expect(adapter.effects.metadataWrites, `${store} metadata\n${journey.render()}`).toBe(1);
  expect(
    adapter.state.localizations.get('en-US')?.description,
    `${store} description\n${journey.render()}`,
  ).toBe('Fresh new description.');
  // Nothing executable is left: what may remain is work that has no API.
  for (const action of remaining.actions) {
    expect(['agent_browser', 'human_only'], `${action.kind}\n${journey.render()}`).toContain(
      action.classification,
    );
  }
}

async function runRelease(
  journey: Journey,
  arm: (adapter: MockStoreAdapter) => void,
  store: Store,
): Promise<PlanView> {
  arm(journey.adapter(store));

  const plan = await journey.plan();
  // The run that gets interrupted. It may fail loudly or partially: both are normal.
  await journey.apply(plan);

  // The process dies here, with whatever the journal happens to hold.
  await journey.kill();

  // The agent's recovery move, and then the ordinary loop until there is nothing left.
  await journey.resume();
  return (await journey.driveToConvergence()).remaining;
}

describe.each([
  { store: 'apple' as const, cases: APPLE_CASES },
  { store: 'google' as const, cases: GOOGLE_CASES },
])('kill matrix: $store', ({ store, cases }) => {
  for (const killCase of cases) {
    it(`converges after a kill at ${killCase.operation} (${killCase.phase})`, async () => {
      const journey = await Journey.start({
        stores: [store],
        manifest: releaseManifest({ stores: [store], track: 'production' }),
      });
      try {
        const remaining = await runRelease(
          journey,
          (adapter) =>
            adapter.injectFailure({ operation: killCase.operation, phase: killCase.phase }),
          store,
        );
        expectConverged(journey, store, remaining);
      } finally {
        await journey.cleanup();
      }
    });
  }

  it('converges when the process dies with a plan in hand and nothing applied', async () => {
    const journey = await Journey.start({
      stores: [store],
      manifest: releaseManifest({ stores: [store], track: 'production' }),
    });
    try {
      const plan = await journey.plan();
      expect(plan.actions.length).toBeGreaterThan(0);
      await journey.kill();
      // The plan the agent was holding belongs to a process that no longer exists; the
      // approvals travel with it, and the new process plans again from the store.
      const converged = await journey.driveToConvergence();
      expectConverged(journey, store, converged.remaining);
    } finally {
      await journey.cleanup();
    }
  });

  it('converges when the process dies between two applies', async () => {
    const journey = await Journey.start({
      stores: [store],
      manifest: releaseManifest({ stores: [store], track: 'production' }),
      // A build Apple is still processing forces at least two rounds.
      processingTicks: store === 'apple' ? 1 : 0,
    });
    try {
      const plan = await journey.plan();
      await journey.apply(plan);
      await journey.kill();
      await journey.kill();
      const converged = await journey.driveToConvergence();
      expectConverged(journey, store, converged.remaining);
      expect(journey.restarts).toBe(2);
    } finally {
      await journey.cleanup();
    }
  });

  it('never repeats an effect however many times the run is retried after a kill', async () => {
    const journey = await Journey.start({
      stores: [store],
      manifest: releaseManifest({ stores: [store], track: 'production' }),
    });
    try {
      await journey.driveToConvergence();
      for (let round = 0; round < 3; round += 1) {
        await journey.kill();
        await journey.resume();
        await journey.driveToConvergence();
      }
      expectConverged(journey, store, await journey.plan());
    } finally {
      await journey.cleanup();
    }
  });
});
