import { describe, expect, it } from 'vitest';
import { manifestFor, only, runDiffer, stateOf } from '../../adapter-apple/test/differ-helpers.js';
import {
  editGroupDependencies,
  GOOGLE_EDIT_GROUP,
  GOOGLE_POST_COMMIT,
  googleImagesDiffer,
  googleListingDiffer,
  googlePromoteDiffer,
  googleReleaseDiffer,
  googleRolloutDiffer,
  googleTestersDiffer,
  groupsIntoOneBatch,
} from '../src/differs/index.js';

/**
 * The Google differs, and the two rules that shape all of them: everything that can share a
 * Play edit must, and nothing raises a staged rollout without being told to.
 */
describe('edit grouping', () => {
  it('proves the property on the drafts the real differs produce, not just on the table', async () => {
    // The dependency table above is the mechanism; this is the outcome. Every groupable
    // draft the release differs actually emit must be totally ordered by dependsOn, or the
    // executor would let an unrelated action split the run into several applyBatch calls.
    const manifest = manifestFor();
    const state = await stateOf('google');
    const runs = await Promise.all(
      [
        googleTestersDiffer(),
        googleListingDiffer(),
        googleImagesDiffer(),
        googleReleaseDiffer(),
      ].map((differ) => runDiffer(differ, manifest, state)),
    );
    try {
      const drafts = runs.flatMap((run) => run.drafts);
      expect(drafts.length).toBeGreaterThan(1);
      expect(groupsIntoOneBatch(drafts), drafts.map((d) => d.kind).join(', ')).toBe(true);
    } finally {
      await Promise.all(runs.map((run) => run.cleanup()));
    }
  });

  it('orders the shared edit so the executor emits one batch', () => {
    // Each member depends on every member before it, which is what makes the executable
    // actions consecutive in the topological order — and therefore one applyBatch.
    expect(editGroupDependencies('set_metadata').map((key) => key.kind)).toEqual([
      'manage_tester_groups',
    ]);
    expect(editGroupDependencies('submit_for_review', '42').map((key) => key.kind)).toEqual([
      'manage_tester_groups',
      'set_metadata',
      'sync_screenshots',
      'upload_build',
    ]);
  });

  it('puts every post-commit action after the whole edit', () => {
    for (const kind of GOOGLE_POST_COMMIT) {
      expect(editGroupDependencies(kind).map((key) => key.kind)).toEqual([...GOOGLE_EDIT_GROUP]);
    }
  });

  it('makes every cross-differ dependency optional', () => {
    // A differ cannot see what the others emitted, so "after X, if X is planned" is the
    // only honest ordering it can express.
    for (const key of editGroupDependencies('submit_for_review', '42')) {
      expect(key.optional).toBe(true);
    }
  });
});

describe('google/listing and google/images', () => {
  it('sends only what differs, and warns that the listing is live content', async () => {
    const run = await runDiffer(googleListingDiffer(), manifestFor(), await stateOf('google'));
    const draft = only(run.drafts);
    expect(draft.diff.map((entry) => entry.path)).toEqual(['listing.en-US.description']);
    expect(draft.riskNotes?.join(' ')).toContain('app-level');
    await run.cleanup();
  });

  it('emits nothing when the listing already matches', async () => {
    const state = await stateOf('google', {
      localizations: new Map([
        ['en-US', { name: 'Mock App', description: 'Fresh new description.' }],
      ]),
    });
    const run = await runDiffer(googleListingDiffer(), manifestFor(), state);
    expect(run.drafts).toEqual([]);
    await run.cleanup();
  });

  it('names Apple-only fields instead of silently dropping them', async () => {
    const manifest = manifestFor({
      metadata: {
        primaryLocale: 'en-US',
        locales: { 'en-US': { description: 'Fresh new description.', keywords: 'a,b' } },
      },
    });
    const run = await runDiffer(googleListingDiffer(), manifest, await stateOf('google'));
    const note = only(run.drafts).diff.find((entry) => entry.path === 'listing.en-US.keywords');
    expect(note?.note).toContain('no such field');
    await run.cleanup();
  });

  it('has no images to sync when the manifest lists none', async () => {
    const run = await runDiffer(googleImagesDiffer(), manifestFor(), await stateOf('google'));
    expect(run.drafts).toEqual([]);
    await run.cleanup();
  });
});

describe('google/release', () => {
  it('creates the release, gated on the console-only content rating', async () => {
    const state = await stateOf('google', { contentRatingDone: false });
    const run = await runDiffer(googleReleaseDiffer(), manifestFor(), state);
    const draft = only(run.drafts);
    expect(draft.blockedBy).toContain('google:content-rating');
    expect(draft.op).toMatchObject({
      op: 'submit_for_review',
      submission: { buildNumber: '42', track: 'internal_testing' },
    });
    await run.cleanup();
  });

  it('emits nothing when the track already serves this version code', async () => {
    const state = await stateOf('google', {
      tracks: [{ track: 'internal_testing', buildNumbers: ['42'], state: 'live' }],
    });
    const run = await runDiffer(googleReleaseDiffer(), manifestFor(), state);
    expect(run.drafts).toEqual([]);
    await run.cleanup();
  });

  it('stages the commit and emits the console step under managed publishing', async () => {
    const manifest = manifestFor({
      release: {
        version: '1.1.0',
        buildNumber: '42',
        track: 'production',
        managedPublishing: true,
      },
    });
    const run = await runDiffer(googleReleaseDiffer(), manifest, await stateOf('google'));
    const draft = only(run.drafts);
    expect(draft.op).toMatchObject({
      op: 'submit_for_review',
      submission: { withoutReview: true },
    });
    expect(draft.pending?.id).toBe('google:managed-publishing');
    expect(draft.production).toBe(true);
    await run.cleanup();
  });

  it('warns that a commit during a review would cancel it', async () => {
    const run = await runDiffer(googleReleaseDiffer(), manifestFor(), await stateOf('google'));
    expect(only(run.drafts).riskNotes?.join(' ')).toContain('CHANGES_ALREADY_IN_REVIEW');
    await run.cleanup();
  });
});

describe('google/rollout', () => {
  const manifest = manifestFor({
    release: { version: '1.1.0', buildNumber: '42', track: 'production', rollout: 0.5 },
  });

  it('raises the fraction only because the manifest says so', async () => {
    const state = await stateOf('google', {
      tracks: [{ track: 'production', buildNumbers: ['42'], state: 'live', userFraction: 0.1 }],
    });
    const run = await runDiffer(googleRolloutDiffer(), manifest, state);
    const draft = only(run.drafts);
    expect(draft.op).toMatchObject({
      op: 'set_phased_release',
      action: { action: 'resume', userFraction: 0.5 },
    });
    expect(draft.production).toBe(true);
    expect(draft.riskNotes?.join(' ')).toContain('never raises a rollout by itself');
    await run.cleanup();
  });

  it('completes the rollout when the manifest asks for everyone', async () => {
    const full = manifestFor({
      release: { version: '1.1.0', buildNumber: '42', track: 'production', rollout: 1 },
    });
    const state = await stateOf('google', {
      tracks: [{ track: 'production', buildNumbers: ['42'], state: 'live', userFraction: 0.5 }],
    });
    const run = await runDiffer(googleRolloutDiffer(), full, state);
    expect(only(run.drafts).op).toMatchObject({
      op: 'set_phased_release',
      action: { action: 'complete' },
    });
    await run.cleanup();
  });

  it('emits nothing when the rollout already serves the requested fraction', async () => {
    const state = await stateOf('google', {
      tracks: [{ track: 'production', buildNumbers: ['42'], state: 'live', userFraction: 0.5 }],
    });
    const run = await runDiffer(googleRolloutDiffer(), manifest, state);
    expect(run.drafts).toEqual([]);
    await run.cleanup();
  });

  it('explains that Play cannot go backwards instead of trying', async () => {
    const state = await stateOf('google', {
      tracks: [{ track: 'production', buildNumbers: ['42'], state: 'live', userFraction: 0.9 }],
    });
    const run = await runDiffer(googleRolloutDiffer(), manifest, state);
    const draft = only(run.drafts);
    expect(draft.op).toBeUndefined();
    expect(draft.needsInput).toEqual(['release.rollout']);
    expect(draft.diff[0]?.note).toContain('cannot reduce');
    await run.cleanup();
  });
});

describe('google/promote', () => {
  const manifest = manifestFor({
    release: {
      version: '1.1.0',
      buildNumber: '42',
      track: 'production',
      promoteFrom: 'open_testing',
    },
  });

  it('serves the build that is already uploaded, without re-uploading it', async () => {
    const state = await stateOf('google', {
      tracks: [{ track: 'open_testing', buildNumbers: ['42'], state: 'live' }],
    });
    const run = await runDiffer(googlePromoteDiffer(), manifest, state);
    const draft = only(run.drafts);
    expect(draft.op).toMatchObject({
      op: 'distribute_to_testers',
      buildNumber: '42',
      track: 'production',
    });
    expect(draft.production).toBe(true);
    expect(draft.diff[0]?.note).toContain('nothing is rebuilt');
    await run.cleanup();
  });

  it('emits nothing once production serves it', async () => {
    const state = await stateOf('google', {
      tracks: [
        { track: 'open_testing', buildNumbers: ['42'], state: 'live' },
        { track: 'production', buildNumbers: ['42'], state: 'live' },
      ],
    });
    const run = await runDiffer(googlePromoteDiffer(), manifest, state);
    expect(run.drafts).toEqual([]);
    await run.cleanup();
  });

  it('refuses to promote a build the source track does not serve', async () => {
    const state = await stateOf('google', {
      tracks: [{ track: 'open_testing', buildNumbers: ['41'], state: 'live' }],
    });
    const run = await runDiffer(googlePromoteDiffer(), manifest, state);
    expect(only(run.drafts).needsInput).toEqual(['release.promoteFrom']);
    await run.cleanup();
  });

  it('leaves the release differ alone while a promotion is planned', async () => {
    const run = await runDiffer(googleReleaseDiffer(), manifest, await stateOf('google'));
    expect(run.drafts).toEqual([]);
    await run.cleanup();
  });
});

describe('google/testers', () => {
  it('attaches a Google Group through the API', async () => {
    const manifest = manifestFor({
      testers: { groups: [{ name: 'beta@googlegroups.com', track: 'closed_testing' }] },
    });
    const run = await runDiffer(googleTestersDiffer(), manifest, await stateOf('google'));
    const draft = only(run.drafts);
    expect(draft.kind).toBe('manage_tester_groups');
    expect(draft.op).toMatchObject({
      op: 'manage_tester_groups',
      changes: { groups: [{ members: ['beta@googlegroups.com'] }] },
    });
    await run.cleanup();
  });

  it('sends an individual e-mail list to the console, with the addresses laid out', async () => {
    const manifest = manifestFor({
      testers: {
        groups: [
          {
            name: 'Closed testers',
            track: 'closed_testing',
            members: ['a@example.com', 'b@example.com'],
          },
        ],
      },
    });
    const run = await runDiffer(googleTestersDiffer(), manifest, await stateOf('google'));
    const draft = only(run.drafts);
    expect(draft.kind).toBe('add_individual_testers');
    expect(draft.pending?.actionClass).toBe('agent_browser');
    expect(draft.pending?.fields?.map((field) => field.proposedValue)).toEqual([
      'a@example.com',
      'b@example.com',
    ]);
    await run.cleanup();
  });
});
