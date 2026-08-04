import { afterEach, describe, expect, it } from 'vitest';
import { Journey, kindsOf } from '../src/journey.js';
import { privacyManifest, releaseManifest } from '../src/manifests.js';

/**
 * The Google Play journey.
 *
 * Play's model is an *edit*: a batch of changes that either commits whole or does not
 * happen at all. So the properties worth an end-to-end test are different from Apple's —
 * the edit must be atomic under interruption, a rollout to a track is live the moment it
 * commits, and Data Safety is a declaration that has to survive the fact that Play will
 * not read it back.
 */
describe('Google: a complete release journey', () => {
  let journey: Journey | undefined;
  afterEach(async () => {
    await journey?.cleanup();
    journey = undefined;
  });

  it('writes the listing, uploads the bundle and rolls it out to the track', async () => {
    journey = await Journey.start({
      stores: ['google'],
      manifest: releaseManifest({ stores: ['google'], track: 'internal_testing' }),
    });
    const google = journey.adapter('google');

    const plan = await journey.plan();
    expect(kindsOf(plan)).toEqual(
      expect.arrayContaining(['set_metadata', 'upload_build', 'submit_for_review']),
    );

    const converged = await journey.driveToConvergence();
    expect(converged.converged, journey.render()).toBe(true);
    expect(google.effects.uploads).toBe(1);
    expect(google.effects.submits).toBe(1);
    expect(google.effects.edits).toBeGreaterThanOrEqual(1);
    // A commit to a testing track is live at once — no review to wait for.
    expect(google.state.versions.find((version) => version.version === '1.1.0')?.state).toBe(
      'live',
    );
  });

  it('leaves no half-applied edit when the commit dies, and converges after a restart', async () => {
    journey = await Journey.start({
      stores: ['google'],
      manifest: releaseManifest({ stores: ['google'], track: 'internal_testing' }),
    });
    const google = journey.adapter('google');
    // The edit commits and the answer never arrives.
    google.injectFailure({ operation: 'commit', phase: 'after' });

    const plan = await journey.plan();
    const failed = await journey.apply(plan);
    expect(failed.ok).toBe(false);

    await journey.kill();
    const converged = await journey.driveToConvergence();
    expect(converged.converged, journey.render()).toBe(true);
    // Whatever the commit did, it did once: nothing was uploaded or rolled out twice.
    expect(google.effects.uploads).toBe(1);
    expect(google.effects.submits).toBe(1);
  });

  it('sends Data Safety only when the user confirmed it and approved the action', async () => {
    journey = await Journey.start({
      stores: ['google'],
      manifest: privacyManifest({ stores: ['google'], track: 'internal_testing' }),
    });
    const google = journey.adapter('google');

    const plan = await journey.plan();
    const dataSafety = plan.actions.find((action) => action.kind === 'set_data_safety');
    expect(dataSafety?.classification).toBe('needs_approval');

    // Approving everything except the declaration leaves the declaration unsent.
    await journey.apply(
      plan,
      plan.approvalsRequired.filter((id) => id !== dataSafety?.id),
    );
    expect(google.effects.dataSafetyWrites).toBe(0);

    const converged = await journey.driveToConvergence();
    expect(google.effects.dataSafetyWrites, journey.render()).toBe(1);
    // What is left over is console work Play has no API for, never an executable action.
    for (const action of converged.remaining.actions) {
      expect(['agent_browser', 'human_only'], action.kind).toContain(action.classification);
    }

    // Play cannot be read back, so convergence rests on the archive Agentship keeps: a second
    // pass must not re-send it.
    await journey.kill();
    const after = await journey.plan();
    expect(kindsOf(after)).not.toContain('set_data_safety');
    expect(google.effects.dataSafetyWrites).toBe(1);
  });

  it('never touches production without an approval bound to that exact diff', async () => {
    journey = await Journey.start({
      stores: ['google'],
      manifest: releaseManifest({ stores: ['google'], track: 'production' }),
    });
    const google = journey.adapter('google');

    const plan = await journey.plan();
    const rollout = plan.actions.find((action) => action.kind === 'submit_for_review');
    expect(rollout?.classification).toBe('needs_approval');

    // An id from a stale plan: the content hash no longer matches anything current.
    const applied = await journey.apply(plan, ['submit_for_review:google:0000000000000000']);
    expect(google.effects.submits).toBe(0);
    expect(
      applied.outcomes.some((outcome) => outcome.status === 'needs_approval'),
      journey.render(),
    ).toBe(true);
  });
});

describe('Google and Apple in one release', () => {
  let journey: Journey | undefined;
  afterEach(async () => {
    await journey?.cleanup();
    journey = undefined;
  });

  it('plans both stores together and converges both', async () => {
    journey = await Journey.start({
      stores: ['apple', 'google'],
      manifest: releaseManifest({ stores: ['apple', 'google'], track: 'internal_testing' }),
    });

    const plan = await journey.plan();
    expect(new Set(plan.actions.map((action) => action.store))).toEqual(
      new Set(['apple', 'google']),
    );

    const converged = await journey.driveToConvergence();
    expect(converged.converged, journey.render()).toBe(true);
    for (const store of ['apple', 'google'] as const) {
      const adapter = journey.adapter(store);
      expect(adapter.effects.uploads, `${store} uploads`).toBe(1);
      expect(adapter.effects.metadataWrites, `${store} metadata`).toBe(1);
    }
    // Each store ends where its own model says it should: the build is in TestFlight and
    // the bundle is live on Play's internal track. There is no review in either case.
    expect(journey.adapter('apple').effects.submits).toBe(0);
    const rollout = journey
      .adapter('google')
      .state.versions.find((version) => version.version === '1.1.0');
    expect(rollout?.state).toBe('live');
    expect(rollout?.track).toBe('internal_testing');
  });

  it('keeps one store working when the other is failing', async () => {
    journey = await Journey.start({
      stores: ['apple', 'google'],
      manifest: releaseManifest({ stores: ['apple', 'google'], track: 'internal_testing' }),
    });
    // Google is down for this whole run; Apple is fine.
    journey
      .adapter('google')
      .injectFailure({ operation: 'uploadBuild', phase: 'before', times: 20 });

    const plan = await journey.plan();
    await journey.call('agentship_apply', {
      planId: plan.planId,
      approvals: [...plan.approvalsRequired],
      // One store failing must not stop the independent work of the other.
      stopOnError: false,
    });

    expect(journey.adapter('apple').effects.uploads, journey.render()).toBe(1);
    expect(journey.adapter('apple').effects.metadataWrites).toBe(1);
    expect(journey.adapter('google').effects.uploads).toBe(0);
  });
});
