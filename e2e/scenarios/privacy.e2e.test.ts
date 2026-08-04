import { validateDataSafetyCsv } from '@agentship/catalog';
import { loadManifest, saveManifest } from '@agentship/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Journey, kindsOf } from '../src/journey.js';
import { privacyManifest, releaseManifest } from '../src/manifests.js';

/**
 * Privacy, from what the code shows to what the store is told.
 *
 * The journey exists because the two ends are owned by different parties: Agentship reads
 * the repository and proposes, and only the user can say what the app really does. So the
 * scenario walks the whole path — signals, proposal, confirmation, declaration — and
 * checks at every step that a machine cannot skip the user's part of it.
 */
describe('privacy: from the repository to the store', () => {
  let journey: Journey | undefined;
  afterEach(async () => {
    await journey?.cleanup();
    journey = undefined;
  });

  it('proposes from the code, warns about what the manifest omits, and executes nothing', async () => {
    journey = await Journey.start({ stores: ['google'], fixture: 'privacy-app' });
    await journey.analyze();

    // The analysis wrote a draft: every practice inferred, every one with its evidence.
    const proposed = await loadManifest(journey.repoRoot);
    expect(proposed.privacy?.declarationStatus).toBe('draft');
    const types = (proposed.privacy?.dataPractices ?? []).map((practice) => practice.dataType);
    expect(types).toEqual(expect.arrayContaining(['identifiers', 'location']));
    for (const practice of proposed.privacy?.dataPractices ?? []) {
      expect(practice.source).toBe('inferred');
      expect(practice.evidence).toBeDefined();
    }

    // A release manifest that ignores the proposal still gets a warning, not a silent pass.
    await saveManifest(journey.repoRoot, releaseManifest({ stores: ['google'] }));
    const plan = await journey.plan();
    expect(plan.warnings.join('\n')).toContain('UNDECLARED_DATA_TYPE');
    expect(kindsOf(plan)).not.toContain('set_data_safety');
    expect(journey.adapter('google').effects.dataSafetyWrites).toBe(0);
  });

  it('needs both gates: the user confirms the content, then approves the action', async () => {
    journey = await Journey.start({
      stores: ['google'],
      manifest: privacyManifest({
        stores: ['google'],
        track: 'internal_testing',
        declarationStatus: 'draft',
      }),
    });
    const google = journey.adapter('google');

    // Gate one. A draft produces a request for confirmation, never an executable action.
    const draft = await journey.plan();
    expect(draft.actions.find((action) => action.kind === 'confirm_privacy')?.classification).toBe(
      'needs_input',
    );
    expect(kindsOf(draft)).not.toContain('set_data_safety');
    await journey.apply(draft);
    expect(google.effects.dataSafetyWrites).toBe(0);

    // The user reads it and confirms the content.
    await saveManifest(
      journey.repoRoot,
      privacyManifest({ stores: ['google'], track: 'internal_testing' }),
    );

    // Gate two. Confirmed content is still not permission to send it.
    const confirmed = await journey.plan();
    const send = confirmed.actions.find((action) => action.kind === 'set_data_safety');
    expect(send?.classification).toBe('needs_approval');
    await journey.apply(confirmed, []);
    expect(google.effects.dataSafetyWrites).toBe(0);

    // Both gates satisfied: the declaration goes, as a CSV Play accepts.
    await journey.apply(confirmed, [send?.id as string]);
    expect(google.effects.dataSafetyWrites, journey.render()).toBe(1);
    const csv = google.state.dataSafety?.csv ?? '';
    const validated = validateDataSafetyCsv(csv);
    expect(validated.errors).toEqual([]);
    expect(validated.rows.map((row) => row['data_type'])).toEqual(
      expect.arrayContaining(['Device or other IDs']),
    );

    // And it is not sent again, not even after the process dies.
    await journey.kill();
    expect(kindsOf(await journey.plan())).not.toContain('set_data_safety');
    expect(google.effects.dataSafetyWrites).toBe(1);
  });

  it('turns the Apple half into console work with the proposal already filled in', async () => {
    journey = await Journey.start({
      stores: ['apple'],
      manifest: privacyManifest({ stores: ['apple'] }),
    });

    await journey.plan();
    const got = await journey.pending('get', { id: 'apple:app-privacy' });
    const pending = got.payload['pending'] as {
      fields: { label: string; proposedValue?: string; rationale?: string }[];
      steps: string[];
      verification: { summary: string; check?: string };
      console: { url: string; lastVerified: string };
    };
    const identifiers = pending.fields.find((field) => field.label.startsWith('Identifiers'));
    expect(identifiers?.proposedValue).toContain('Third-Party Advertising');
    expect(identifiers?.rationale).toContain('AdMob');
    expect(pending.console.url).toContain('appstoreconnect.apple.com');
    expect(pending.console.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Apple has no API for these answers, so nothing here claims automatic verification.
    expect(pending.verification.check).toBeUndefined();
  });

  it('blocks the submission while App Store Connect still reports App Privacy as missing', async () => {
    journey = await Journey.start({
      stores: ['apple'],
      manifest: privacyManifest({ stores: ['apple'] }),
      state: () => ({ appPrivacyDone: false, versions: [] }),
    });
    const apple = journey.adapter('apple');

    const plan = await journey.plan();
    const submit = plan.actions.find((action) => action.kind === 'submit_for_review');
    const applied = await journey.apply(plan);
    expect(
      applied.outcomes.find((outcome) => outcome.actionId === submit?.id)?.status,
      journey.render(),
    ).toBe('blocked');
    expect(apple.effects.submits).toBe(0);

    // The user declares it in the console and records that they did. Apple exposes no API
    // for the answers themselves, so the record stands on the user's word — what unblocks
    // the submission is App Store Connect no longer reporting the declaration as missing.
    apple.state.appPrivacyDone = true;
    const completed = await journey.pending('complete', {
      id: 'apple:app-privacy',
      notes: 'Declared in App Store Connect.',
    });
    expect((completed.payload['pending'] as { status: string }).status).toBe('done');

    const resumed = await journey.resume();
    expect(resumed.outcomes.some((outcome) => outcome.status === 'blocked')).toBe(false);
    await journey.driveToConvergence();
    expect(apple.effects.submits).toBe(1);
  });
});
