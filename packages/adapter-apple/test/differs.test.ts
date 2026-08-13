import { describe, expect, it } from 'vitest';
import {
  appleMetadataDiffer,
  applePhasedReleaseDiffer,
  applePricingDiffer,
  appleReleaseDiffer,
  appleReviewDiffer,
  appleTestFlightDiffer,
  appleVersionDiffer,
} from '../src/differs/index.js';
import { explainIllegal, versionActionLegality } from '../src/differs/version-state-rules.js';
import { manifestFor, only, runDiffer, stateOf } from './differ-helpers.js';

/**
 * The Apple differs, one decision at a time.
 *
 * Two things are being checked throughout: that a differ emits nothing when the store
 * already matches (convergence, which is what makes a resume safe), and that it refuses to
 * emit an action the App Store would reject rather than trying and failing.
 */
describe('version state rules', () => {
  it('freezes a version’s content once it is with App Review', () => {
    expect(versionActionLegality('set_metadata', 'in_review').legal).toBe(false);
    expect(versionActionLegality('set_metadata', 'waiting_review').legal).toBe(false);
    expect(versionActionLegality('set_metadata', 'draft').legal).toBe(true);
    // A rejection reopens the version: that is the iterate-and-resubmit loop.
    expect(versionActionLegality('set_metadata', 'rejected').legal).toBe(true);
  });

  it('allows only the release itself once a version is approved and held', () => {
    expect(versionActionLegality('release_version', 'pending_release').legal).toBe(true);
    expect(versionActionLegality('submit_for_review', 'pending_release').legal).toBe(false);
    expect(versionActionLegality('set_phased_release', 'live').legal).toBe(true);
  });

  it('names the way out instead of only the problem', () => {
    const version = { id: 'v1', version: '1.1.0', state: 'in_review' as const };
    const message = explainIllegal(
      'set_metadata',
      version,
      versionActionLegality('set_metadata', 'in_review'),
    );
    expect(message).toContain('App Review');
    expect(message).toContain('Wait for App Review');

    const frozen = explainIllegal(
      'set_metadata',
      { ...version, state: 'live' },
      versionActionLegality('set_metadata', 'live'),
    );
    expect(frozen).toContain('Bump release.version');
  });
});

describe('apple/version', () => {
  it('creates the version the release asks for', async () => {
    const run = await runDiffer(appleVersionDiffer(), manifestFor(), await stateOf('apple'));
    const draft = only(run.drafts);
    expect(draft.kind).toBe('ensure_version');
    expect(draft.op).toEqual({
      op: 'ensure_version',
      spec: { version: '1.1.0', platform: 'ios', releaseStrategy: 'manual' },
    });
    await run.cleanup();
  });

  it('emits nothing when the version already exists with the right release strategy', async () => {
    const state = await stateOf('apple', {
      versions: [
        {
          id: 'v-2',
          version: '1.1.0',
          state: 'draft',
          track: 'production',
          releaseStrategy: 'manual',
        },
      ],
    });
    const run = await runDiffer(appleVersionDiffer(), manifestFor(), state);
    expect(run.drafts).toEqual([]);
    await run.cleanup();
  });

  it('stops at a version that is in review instead of trying to edit it', async () => {
    const state = await stateOf('apple', {
      versions: [{ id: 'v-2', version: '1.1.0', state: 'in_review', track: 'production' }],
    });
    const run = await runDiffer(appleVersionDiffer(), manifestFor(), state);
    const draft = only(run.drafts);
    expect(draft.needsInput).toEqual(['release.version']);
    expect(draft.op).toBeUndefined();
    expect(draft.riskNotes?.join(' ')).toContain('will not withdraw a submission');
    await run.cleanup();
  });
});

describe('apple/metadata', () => {
  it('sends only the fields that differ', async () => {
    const run = await runDiffer(appleMetadataDiffer(), manifestFor(), await stateOf('apple'));
    const draft = only(run.drafts);
    expect(draft.diff.map((entry) => entry.path)).toEqual(['metadata.en-US.description']);
    expect(draft.op).toMatchObject({
      op: 'set_metadata',
      changes: {
        version: '1.1.0',
        locales: [{ locale: 'en-US', description: 'Fresh new description.' }],
      },
    });
    await run.cleanup();
  });

  it('emits nothing when the listing already matches', async () => {
    const state = await stateOf('apple', {
      localizations: new Map([
        ['en-US', { name: 'Mock App', description: 'Fresh new description.' }],
      ]),
    });
    const run = await runDiffer(appleMetadataDiffer(), manifestFor(), state);
    expect(run.drafts).toEqual([]);
    await run.cleanup();
  });

  it('ignores the final newline added by store tooling', async () => {
    const state = await stateOf('apple', {
      localizations: new Map([
        ['en-US', { name: 'Mock App\r\n', description: 'Fresh new description.\n' }],
      ]),
    });
    const run = await runDiffer(appleMetadataDiffer(), manifestFor(), state);
    expect(run.drafts).toEqual([]);
    await run.cleanup();
  });

  it('treats renaming a live app as destructive', async () => {
    const manifest = manifestFor({
      metadata: {
        primaryLocale: 'en-US',
        locales: { 'en-US': { name: 'Brand New Name', description: 'The original text.' } },
      },
    });
    const run = await runDiffer(appleMetadataDiffer(), manifest, await stateOf('apple'));
    const draft = only(run.drafts);
    expect(draft.destructive).toBe(true);
    expect(draft.riskNotes?.join(' ')).toContain('every existing user');
    await run.cleanup();
  });

  it('says which fields the App Store has no place for, rather than dropping them', async () => {
    const manifest = manifestFor({
      metadata: {
        primaryLocale: 'en-US',
        locales: {
          'en-US': { description: 'Fresh new description.', shortDescription: 'Google only' },
        },
      },
    });
    const run = await runDiffer(appleMetadataDiffer(), manifest, await stateOf('apple'));
    const note = only(run.drafts).diff.find(
      (entry) => entry.path === 'metadata.en-US.shortDescription',
    );
    expect(note?.note).toContain('no such field');
    await run.cleanup();
  });

  it('does not touch a version whose content the store has frozen', async () => {
    const state = await stateOf('apple', {
      versions: [{ id: 'v-2', version: '1.1.0', state: 'in_review', track: 'production' }],
    });
    const run = await runDiffer(appleMetadataDiffer(), manifestFor(), state);
    expect(run.drafts).toEqual([]);
    await run.cleanup();
  });
});

describe('apple/testflight', () => {
  const manifest = manifestFor({
    testers: {
      groups: [
        { name: 'Internal', track: 'internal_testing', members: ['a@example.com'] },
        { name: 'Ignored', track: 'production' },
      ],
    },
  });

  it('creates the group and then distributes the build to it', async () => {
    const state = await stateOf('apple', {
      builds: [{ id: 'b-1', buildNumber: '42', state: 'valid', ticksLeft: 0 }],
    });
    const run = await runDiffer(appleTestFlightDiffer(), manifest, state);
    expect(run.drafts.map((draft) => draft.kind)).toEqual([
      'manage_tester_groups',
      'distribute_to_testers',
    ]);
    const distribute = run.drafts[1];
    expect(distribute?.dependsOn?.map((key) => key.kind)).toContain('manage_tester_groups');
    expect(distribute?.riskNotes?.join(' ')).toContain('e-mail');
    await run.cleanup();
  });

  it('waits for a processing build instead of distributing it', async () => {
    const state = await stateOf('apple', {
      builds: [{ id: 'b-1', buildNumber: '42', state: 'processing', ticksLeft: 3 }],
      testerGroups: [
        { id: 'g-1', name: 'Internal', track: 'internal_testing', members: ['a@example.com'] },
      ],
    });
    const run = await runDiffer(appleTestFlightDiffer(), manifest, state);
    expect(run.drafts).toEqual([]);
    await run.cleanup();
  });

  it('adds missing members without removing anyone', async () => {
    const state = await stateOf('apple', {
      testerGroups: [
        { id: 'g-1', name: 'Internal', track: 'internal_testing', members: ['b@example.com'] },
      ],
      builds: [{ id: 'b-1', buildNumber: '42', state: 'valid', ticksLeft: 0 }],
    });
    const run = await runDiffer(appleTestFlightDiffer(), manifest, state);
    const groups = run.drafts[0];
    expect(groups?.op).toMatchObject({
      op: 'manage_tester_groups',
      changes: { groups: [{ name: 'Internal', members: ['a@example.com'] }] },
    });
    // No prune: b@example.com is not mentioned, so it stays.
    expect(JSON.stringify(groups?.op)).not.toContain('pruneMembers');
    await run.cleanup();
  });
});

describe('apple/review-submission', () => {
  const production = manifestFor({
    release: { version: '1.1.0', buildNumber: '42', track: 'production', strategy: 'manual' },
  });

  it('is always production and always needs the build', async () => {
    const state = await stateOf('apple', {
      versions: [{ id: 'v-2', version: '1.1.0', state: 'draft', track: 'production' }],
      builds: [{ id: 'b-1', buildNumber: '42', state: 'valid', ticksLeft: 0 }],
    });
    const run = await runDiffer(appleReviewDiffer(), production, state);
    const draft = only(run.drafts);
    expect(draft.production).toBe(true);
    expect(draft.dependsOn?.map((key) => key.kind)).toContain('upload_build');
    expect(draft.op).toMatchObject({
      op: 'submit_for_review',
      submission: { holdForDeveloperRelease: true },
    });
    await run.cleanup();
  });

  it('never submits for a TestFlight track', async () => {
    const run = await runDiffer(appleReviewDiffer(), manifestFor(), await stateOf('apple'));
    expect(run.drafts).toEqual([]);
    await run.cleanup();
  });

  it('does not resubmit a version that is already with App Review', async () => {
    const state = await stateOf('apple', {
      versions: [{ id: 'v-2', version: '1.1.0', state: 'in_review', track: 'production' }],
    });
    const run = await runDiffer(appleReviewDiffer(), production, state);
    expect(run.drafts).toEqual([]);
    await run.cleanup();
  });

  it('makes a rejected version wait for a human to read the reviewer', async () => {
    const state = await stateOf('apple', {
      versions: [{ id: 'v-2', version: '1.1.0', state: 'rejected', track: 'production' }],
      builds: [{ id: 'b-1', buildNumber: '42', state: 'valid', ticksLeft: 0 }],
    });
    const run = await runDiffer(appleReviewDiffer(), production, state);
    const draft = only(run.drafts);
    expect(draft.blockedBy).toContain('apple:resolution-center');
    expect(draft.pending?.actionClass).toBe('agent_browser');
    await run.cleanup();
  });

  it('asks for the demo account the manifest promised but did not supply', async () => {
    const manifest = manifestFor({
      release: { version: '1.1.0', buildNumber: '42', track: 'production' },
      review: { demoAccountRequired: true },
    });
    const state = await stateOf('apple', {
      versions: [{ id: 'v-2', version: '1.1.0', state: 'draft', track: 'production' }],
    });
    const run = await runDiffer(appleReviewDiffer(), manifest, state);
    expect(only(run.drafts).needsInput).toContain('review.demoAccountName');
    await run.cleanup();
  });
});

describe('apple/release and apple/phased-release', () => {
  it('offers the console release only once the store is holding an approved version', async () => {
    const manifest = manifestFor({
      release: { version: '1.1.0', buildNumber: '42', track: 'production' },
    });
    const waiting = await stateOf('apple', {
      versions: [{ id: 'v-2', version: '1.1.0', state: 'waiting_review', track: 'production' }],
    });
    expect((await runDiffer(appleReleaseDiffer(), manifest, waiting)).drafts).toEqual([]);

    const held = await stateOf('apple', {
      versions: [{ id: 'v-2', version: '1.1.0', state: 'pending_release', track: 'production' }],
    });
    const run = await runDiffer(appleReleaseDiffer(), manifest, held);
    const draft = only(run.drafts);
    expect(draft.operation).toBe('releaseVersion');
    expect(draft.pending?.console?.path).toContain('Release This Version');
    await run.cleanup();
  });

  it('starts a phased release once, and never advances it', async () => {
    const manifest = manifestFor({
      release: { version: '1.1.0', buildNumber: '42', track: 'production', phased: true },
    });
    const held = await stateOf('apple', {
      versions: [{ id: 'v-2', version: '1.1.0', state: 'pending_release', track: 'production' }],
    });
    const start = only((await runDiffer(applePhasedReleaseDiffer(), manifest, held)).drafts);
    expect(start.op).toMatchObject({ op: 'set_phased_release', action: { action: 'start' } });

    const running = await stateOf('apple', {
      versions: [{ id: 'v-2', version: '1.1.0', state: 'phased_release', track: 'production' }],
      phasedRelease: { track: 'production', state: 'active', userFraction: 0.02 },
    });
    // Already rolling out: Apple raises the percentage itself, so there is nothing to do.
    expect((await runDiffer(applePhasedReleaseDiffer(), manifest, running)).drafts).toEqual([]);
  });
});

describe('apple/pricing', () => {
  it('emits nothing when the manifest declares no pricing', async () => {
    const state = await stateOf('apple');
    expect((await runDiffer(applePricingDiffer(), manifestFor(), state)).drafts).toEqual([]);
  });

  it('proposes set_pricing when the declared price differs from the store', async () => {
    const manifest = manifestFor({ pricing: { amount: '3.99', baseTerritory: 'USA' } });
    const state = await stateOf('apple', { pricing: { free: true } });
    const draft = only((await runDiffer(applePricingDiffer(), manifest, state)).drafts);
    expect(draft.kind).toBe('set_pricing');
    expect(draft.operation).toBe('setPricing');
    expect(draft.op).toMatchObject({
      op: 'set_pricing',
      schedule: { amount: '3.99', baseTerritory: 'USA' },
    });
    expect(draft.diff).toEqual([
      { path: 'pricing.amount', after: '3.99', note: 'base territory USA' },
    ]);
  });

  it('shows before and after when the store already has a price', async () => {
    const manifest = manifestFor({ pricing: { amount: '4.99', baseTerritory: 'USA' } });
    const state = await stateOf('apple', { pricing: { free: false, amount: '3.99' } });
    const draft = only((await runDiffer(applePricingDiffer(), manifest, state)).drafts);
    expect(draft.diff[0]).toMatchObject({ path: 'pricing.amount', before: '3.99', after: '4.99' });
  });

  it('converges: an equal price produces no draft', async () => {
    const manifest = manifestFor({ pricing: { amount: '3.99' } });
    const state = await stateOf('apple', { pricing: { free: false, amount: '3.99' } });
    expect((await runDiffer(applePricingDiffer(), manifest, state)).drafts).toEqual([]);
    const free = manifestFor({ pricing: { free: true } });
    const freeState = await stateOf('apple', { pricing: { free: true } });
    expect((await runDiffer(applePricingDiffer(), free, freeState)).drafts).toEqual([]);
  });

  it('refuses to act on a pricing gap: unknown is not absent', async () => {
    const manifest = manifestFor({ pricing: { amount: '3.99' } });
    const base = await stateOf('apple');
    const state = {
      ...base,
      pricing: undefined,
      gaps: [
        ...base.gaps,
        { area: 'pricing', reason: 'the credentials cannot read pricing', kind: 'error' as const },
      ],
    };
    expect((await runDiffer(applePricingDiffer(), manifest, state)).drafts).toEqual([]);
  });

  it('reports a sentinel amount as needs_input instead of guessing', async () => {
    const manifest = manifestFor({ pricing: { amount: '<needs_input>' } });
    const state = await stateOf('apple', { pricing: { free: true } });
    const draft = only((await runDiffer(applePricingDiffer(), manifest, state)).drafts);
    expect(draft.op).toBeUndefined();
    expect(draft.needsInput).toContain('pricing.amount');
  });
});
