import { saveManifest } from '@agentship/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Journey, kindsOf } from '../src/journey.js';
import { releaseManifest } from '../src/manifests.js';

/**
 * The App Store journey, from an app with a live version to a version waiting for review.
 *
 * The three phases are the ones a real release has: get the build in (and wait for Apple to
 * process it), get the listing right, get a human to submit it — plus the two things that
 * go wrong most often, an interrupted run and a rejection.
 */
describe('Apple: a complete release journey', () => {
  let journey: Journey | undefined;
  afterEach(async () => {
    await journey?.cleanup();
    journey = undefined;
  });

  it('uploads, waits for processing, writes the listing and submits once approved', async () => {
    journey = await Journey.start({
      stores: ['apple'],
      manifest: releaseManifest({ testers: true }),
      // Apple does not make a build available the instant it is uploaded.
      processingTicks: 2,
      state: () => ({
        versions: [{ id: 'v-1', version: '1.0.0', state: 'live', track: 'production' }],
      }),
    });
    const apple = journey.adapter('apple');

    const plan = await journey.plan();
    expect(kindsOf(plan)).toEqual(
      expect.arrayContaining([
        'ensure_version',
        'set_metadata',
        'upload_build',
        'submit_for_review',
      ]),
    );

    const converged = await journey.driveToConvergence();
    expect(converged.converged, journey.render()).toBe(true);
    // The submission waited for the build to become valid rather than submitting a
    // binary Apple was still processing.
    expect(apple.state.builds.find((build) => build.buildNumber === '42')?.state).toBe('valid');
    expect(apple.state.versions.find((version) => version.version === '1.1.0')?.state).toBe(
      'waiting_review',
    );
    expect(apple.effects.uploads).toBe(1);
    expect(apple.effects.submits).toBe(1);
    expect(apple.effects.groupWrites).toBeGreaterThan(0);
    // The live version was never touched.
    expect(apple.state.versions.find((version) => version.version === '1.0.0')?.state).toBe('live');
  });

  it('survives the process dying mid-run and never uploads the build twice', async () => {
    journey = await Journey.start({ stores: ['apple'], manifest: releaseManifest() });
    const apple = journey.adapter('apple');
    // The upload lands and the connection dies before Agentship hears about it: the one
    // failure that would duplicate a non-idempotent effect if the journal were trusted.
    apple.injectFailure({ operation: 'uploadBuild', phase: 'after' });

    const plan = await journey.plan();
    const failed = await journey.apply(plan);
    expect(failed.ok).toBe(false);
    expect(apple.effects.uploads).toBe(1);

    // The process is gone. A new one picks the journey up from the journal and the store.
    await journey.kill();
    const resumed = await journey.resume();
    expect(kindsOf(resumed.plan)).not.toContain('upload_build');

    const converged = await journey.driveToConvergence();
    expect(converged.converged, journey.render()).toBe(true);
    expect(apple.effects.uploads).toBe(1);
    expect(apple.effects.submits).toBe(1);
  });

  it('holds the resubmission until a human has read the rejection, then ships it', async () => {
    journey = await Journey.start({
      stores: ['apple'],
      manifest: releaseManifest(),
      state: () => ({
        versions: [{ id: 'v-2', version: '1.1.0', state: 'rejected', track: 'production' }],
        builds: [{ id: 'b-1', buildNumber: '42', state: 'valid', ticksLeft: 0 }],
      }),
    });
    const apple = journey.adapter('apple');

    const plan = await journey.plan();
    const submit = plan.actions.find((action) => action.kind === 'submit_for_review');
    expect(submit).toBeDefined();
    const applied = await journey.apply(plan);
    expect(
      applied.outcomes.find((outcome) => outcome.actionId === submit?.id)?.status,
      journey.render(),
    ).toBe('blocked');
    expect(apple.effects.submits).toBe(0);

    // Resolution Center has no API: the human reads it and records what they did.
    const pending = await journey.pending('list');
    const resolution = (pending.payload['pending'] as { id: string }[]).find((entry) =>
      entry.id.includes('resolution-center'),
    );
    expect(resolution).toBeDefined();
    await journey.pending('complete', {
      id: resolution?.id as string,
      notes: 'Reviewer asked for a clearer purpose string; fixed and rebuilt.',
    });

    const converged = await journey.driveToConvergence();
    expect(converged.converged, journey.render()).toBe(true);
    expect(apple.effects.submits).toBe(1);
    expect(apple.state.versions.find((version) => version.version === '1.1.0')?.state).toBe(
      'waiting_review',
    );
  });

  it('rolls a held version out in phases and hands the release button to a human', async () => {
    journey = await Journey.start({
      stores: ['apple'],
      manifest: releaseManifest({ phased: true }),
      state: () => ({
        versions: [
          { id: 'v-1', version: '1.0.0', state: 'live', track: 'production' },
          { id: 'v-2', version: '1.1.0', state: 'pending_release', track: 'production' },
        ],
        builds: [{ id: 'b-1', buildNumber: '42', state: 'valid', ticksLeft: 0 }],
      }),
    });
    const apple = journey.adapter('apple');

    const plan = await journey.plan();
    expect(kindsOf(plan)).toContain('set_phased_release');
    expect(kindsOf(plan)).not.toContain('submit_for_review');
    const applied = await journey.apply(plan);
    expect(apple.effects.phasedWrites).toBe(1);

    // Releasing an approved version is console work through the pinned tool.
    const listed = await journey.pending('list');
    const ids = [
      ...(listed.payload['pending'] as { id: string }[]).map((entry) => entry.id),
      ...applied.emittedPending.map((entry) => entry.id),
    ];
    expect(ids).toContain('apple:release-version');
  });

  it('refuses to edit a version Apple is already reviewing', async () => {
    journey = await Journey.start({
      stores: ['apple'],
      manifest: releaseManifest({ description: 'A late change of mind.' }),
      state: () => ({
        versions: [{ id: 'v-2', version: '1.1.0', state: 'in_review', track: 'production' }],
        builds: [{ id: 'b-1', buildNumber: '42', state: 'valid', ticksLeft: 0 }],
      }),
    });
    const apple = journey.adapter('apple');

    const plan = await journey.plan();
    expect(kindsOf(plan)).not.toContain('set_metadata');
    expect(plan.actions.find((action) => action.kind === 'ensure_version')?.classification).toBe(
      'needs_input',
    );
    await journey.apply(plan);
    expect(apple.effects.metadataWrites).toBe(0);
    expect(apple.effects.submits).toBe(0);

    // The way forward is a new version number, and the user is the one who picks it.
    await saveManifest(journey.repoRoot, releaseManifest({ version: '1.2.0' }));
    const next = await journey.plan();
    expect(kindsOf(next)).toContain('ensure_version');
    const converged = await journey.driveToConvergence();
    expect(converged.converged, journey.render()).toBe(true);
    expect(apple.state.versions.find((version) => version.version === '1.2.0')?.state).toBe(
      'waiting_review',
    );
  });

  it('never runs an action whose dependency failed, even with stopOnError off', async () => {
    journey = await Journey.start({
      stores: ['apple'],
      manifest: releaseManifest({ stores: ['apple'] }),
    });
    const apple = journey.adapter('apple');
    // The editable version cannot be created; everything that writes into a version depends
    // on it, and `stopOnError: false` must not turn that dependency into a suggestion.
    apple.injectFailure({ operation: 'ensureVersion', phase: 'before', times: 20 });

    const plan = await journey.plan();
    const version = plan.actions.find((action) => action.kind === 'ensure_version');
    const metadata = plan.actions.find((action) => action.kind === 'set_metadata');
    expect(metadata?.dependsOn).toContain(version?.id);

    const result = await journey.apply(plan, [...plan.approvalsRequired], {
      stopOnError: false,
    });
    const status = (id?: string) =>
      result.outcomes.find((outcome) => outcome.actionId === id)?.status;
    expect(status(version?.id)).toBe('failed');
    expect(status(metadata?.id), journey.render()).toBe('skipped');
    // The proof that matters: nothing was written into a version that does not exist.
    expect(apple.effects.metadataWrites).toBe(0);
  });
});
