import { cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateDataSafetyCsv } from '@agentship/catalog';
import { loadManifest, ManifestSchema, saveManifest } from '@agentship/core';
import { afterEach, describe, expect, it } from 'vitest';
import { actionsOf, createMcpHarness, type McpHarness, outcomesOf } from './helpers.js';

/**
 * The privacy flow end to end: from what the repository shows, to a declaration the user
 * confirmed, to a store.
 *
 * Two gates are what this proves, and they are deliberately independent. Confirming the
 * *content* is the user saying "this is what my app does"; approving the *action* is the
 * user saying "send it". A declaration that has one without the other never reaches a store,
 * and neither gate can be satisfied by Agentship on the user's behalf.
 */
const FIXTURE = fileURLToPath(new URL('../../analyzer/test/fixtures/privacy-app', import.meta.url));

function manifestWith(privacy: Record<string, unknown> | undefined, stores: 'apple' | 'google') {
  return ManifestSchema.parse({
    version: 1,
    app: { name: 'Lumo' },
    stores:
      stores === 'apple'
        ? { apple: { bundleId: 'com.example.mock', appId: 'app-1' } }
        : { google: { packageName: 'com.example.mock' } },
    release: {
      version: '1.1.0',
      buildNumber: '42',
      track: 'internal_testing',
      artifacts: { google: { path: 'artifacts/app.aab', kind: 'aab' } },
    },
    metadata: {
      primaryLocale: 'en-US',
      locales: {
        'en-US': {
          name: 'Mock App',
          description: 'The original text.',
          shortDescription: 'Calm.',
          privacyPolicyUrl: 'https://acme.example/privacy',
        },
      },
    },
    ...(privacy === undefined ? {} : { privacy }),
  });
}

async function withFixtureAnalysis(harness: McpHarness): Promise<void> {
  await cp(FIXTURE, harness.repoRoot, { recursive: true, force: true });
  // Analysing writes both the analysis the kernel reads and, on a fresh project, a manifest;
  // the harness already wrote one, so only the analysis lands.
  await harness.call('agentship_analyze', { projectDir: harness.repoRoot });
}

describe('from signals to a proposal', () => {
  let harness: McpHarness | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('proposes a draft declaration in the manifest of a project with none', async () => {
    harness = await createMcpHarness({ stores: ['apple'], withoutManifest: true });
    await cp(FIXTURE, harness.repoRoot, { recursive: true, force: true });
    await harness.call('agentship_analyze', { projectDir: harness.repoRoot });

    const manifest = await loadManifest(harness.repoRoot);
    expect(manifest.privacy?.declarationStatus).toBe('draft');
    const types = (manifest.privacy?.dataPractices ?? []).map((practice) => practice.dataType);
    expect(types).toEqual(expect.arrayContaining(['identifiers', 'location']));
    for (const practice of manifest.privacy?.dataPractices ?? []) {
      expect(practice.source).toBe('inferred');
      expect(practice.evidence).toBeDefined();
    }
  });

  it('warns about an ads SDK contradicting the store age rating, even while the declaration is a draft', async () => {
    harness = await createMcpHarness({
      stores: ['apple'],
      manifest: manifestWith({ declarationStatus: 'draft', dataPractices: [] }, 'apple'),
      // The store declares "no advertising" while the repository contains AdMob.
      state: () => ({ ageRating: { id: 'ar-1', answers: { advertising: false } } }),
    });
    await withFixtureAnalysis(harness);

    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const warnings = (planned.payload['plan'] as { warnings: string[] }).warnings.join('\n');
    expect(warnings).toContain('ADS_SDK_VS_AGE_RATING');
    expect(warnings).toContain('advertising: false');
    // The warning is decoupled from the gate; the ACTION is not. A draft declaration still
    // produces no set_age_rating.
    expect(actionsOf(planned.payload).some((action) => action.kind === 'set_age_rating')).toBe(
      false,
    );
  });

  it('warns on the plan about what the code shows and the declaration omits', async () => {
    harness = await createMcpHarness({
      stores: ['apple'],
      manifest: manifestWith(undefined, 'apple'),
    });
    await withFixtureAnalysis(harness);

    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const warnings = (planned.payload['plan'] as { warnings: string[] }).warnings.join('\n');
    expect(warnings).toContain('UNDECLARED_DATA_TYPE');
    expect(warnings).toContain('ADS_WITHOUT_DECLARATION');
  });
});

describe('the two gates', () => {
  let harness: McpHarness | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  const practices = [
    {
      dataType: 'identifiers',
      collected: true,
      purposes: ['advertising', 'analytics'],
      linkedToUser: false,
      tracking: false,
      shared: true,
      source: 'inferred',
      evidence: 'Google AdMob typically collects this data',
    },
    {
      dataType: 'diagnostics',
      collected: true,
      purposes: ['app_functionality'],
      source: 'inferred',
      evidence: 'Firebase Crashlytics typically collects this data',
    },
  ];

  it('gate one: a draft declaration produces no executable action at all', async () => {
    harness = await createMcpHarness({
      stores: ['google'],
      manifest: manifestWith({ declarationStatus: 'draft', dataPractices: practices }, 'google'),
    });
    const google = harness.adapters.get('google');

    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const confirm = actionsOf(planned.payload).find((action) => action.kind === 'confirm_privacy');
    expect(confirm?.classification).toBe('needs_input');
    expect(actionsOf(planned.payload).some((action) => action.kind === 'set_data_safety')).toBe(
      false,
    );

    // Even approving everything the plan offers changes nothing about privacy.
    const plan = planned.payload['plan'] as { planId: string; approvalsRequired: string[] };
    await harness.call('agentship_apply', {
      planId: plan.planId,
      approvals: plan.approvalsRequired,
    });
    expect(google?.effects.dataSafetyWrites).toBe(0);
  });

  it('gate two: a confirmed declaration still needs the action approved', async () => {
    harness = await createMcpHarness({
      stores: ['google'],
      manifest: manifestWith(
        { declarationStatus: 'confirmed', dataPractices: practices },
        'google',
      ),
    });
    const google = harness.adapters.get('google');

    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const apply = actionsOf(planned.payload).find((action) => action.kind === 'set_data_safety');
    expect(apply?.classification).toBe('needs_approval');

    const plan = planned.payload['plan'] as { planId: string };
    const withoutApproval = await harness.call('agentship_apply', {
      planId: plan.planId,
      approvals: [],
    });
    expect(google?.effects.dataSafetyWrites).toBe(0);
    expect(
      outcomesOf(withoutApproval.payload).some((outcome) => outcome.status === 'needs_approval'),
    ).toBe(true);
  });

  it('applies a valid CSV once both gates are satisfied, and stops re-applying it', async () => {
    harness = await createMcpHarness({
      stores: ['google'],
      manifest: manifestWith(
        { declarationStatus: 'confirmed', dataPractices: practices },
        'google',
      ),
    });
    const google = harness.adapters.get('google');

    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const apply = actionsOf(planned.payload).find((action) => action.kind === 'set_data_safety');
    const plan = planned.payload['plan'] as { planId: string };
    const applied = await harness.call('agentship_apply', {
      planId: plan.planId,
      approvals: [apply?.id as string],
    });
    expect(applied.payload['ok']).toBe(true);
    expect(google?.effects.dataSafetyWrites).toBe(1);

    const csv = google?.state.dataSafety?.csv ?? '';
    expect(validateDataSafetyCsv(csv).errors).toEqual([]);
    const rows = validateDataSafetyCsv(csv).rows;
    expect(rows.map((row) => row['data_type'])).toEqual(
      expect.arrayContaining(['Device or other IDs', 'Crash logs', 'Diagnostics']),
    );
    const adId = rows.find((row) => row['data_type'] === 'Device or other IDs');
    expect(adId?.['purposes']).toBe('Advertising or marketing; Analytics');
    expect(adId?.['shared']).toBe('true');

    // Play cannot be read back, so convergence comes from the archive Agentship keeps.
    const after = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    expect(actionsOf(after.payload).some((action) => action.kind === 'set_data_safety')).toBe(
      false,
    );
    expect(google?.effects.dataSafetyWrites).toBe(1);
  });
});

describe('the Apple half', () => {
  let harness: McpHarness | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('fills the App Privacy console entry with the projection and the evidence', async () => {
    harness = await createMcpHarness({
      stores: ['apple'],
      manifest: manifestWith(
        {
          declarationStatus: 'confirmed',
          dataPractices: [
            {
              dataType: 'identifiers',
              collected: true,
              purposes: ['advertising'],
              linkedToUser: true,
              tracking: true,
              shared: true,
              source: 'declared',
              evidence: 'Google AdMob typically collects this data',
            },
          ],
        },
        'apple',
      ),
    });

    await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const got = await harness.call('agentship_pending', {
      projectDir: harness.repoRoot,
      action: 'get',
      id: 'apple:app-privacy',
    });
    const pending = got.payload['pending'] as {
      fields: { label: string; proposedValue?: string; rationale?: string }[];
      steps: string[];
      verification: { summary: string; check?: string };
    };
    const row = pending.fields.find((field) => field.label.startsWith('Identifiers'));
    expect(row?.proposedValue).toContain('Third-Party Advertising');
    expect(row?.proposedValue).toContain('Used for tracking: yes');
    expect(row?.rationale).toContain('AdMob');
    // Apple exposes no API for these answers, so nothing here claims automatic verification.
    expect(pending.verification.check).toBeUndefined();
    expect(pending.steps.join('\n')).toContain('Agentship cannot check this from any API');
  });

  it('proposes an age rating that starts from Apple’s safe defaults', async () => {
    harness = await createMcpHarness({
      stores: ['apple'],
      manifest: manifestWith(
        {
          declarationStatus: 'confirmed',
          dataPractices: [{ dataType: 'identifiers', collected: true, purposes: ['advertising'] }],
        },
        'apple',
      ),
    });
    await withFixtureAnalysis(harness);
    await saveManifest(
      harness.repoRoot,
      manifestWith(
        {
          declarationStatus: 'confirmed',
          dataPractices: [{ dataType: 'identifiers', collected: true, purposes: ['advertising'] }],
        },
        'apple',
      ),
    );

    const planned = await harness.call('agentship_plan', {
      projectDir: harness.repoRoot,
      detail: 'full',
    });
    const rating = actionsOf(planned.payload).find((action) => action.kind === 'set_age_rating') as
      | { classification: string; riskNotes?: string[]; diff?: { path: string; after?: unknown }[] }
      | undefined;
    expect(rating?.classification).toBe('needs_approval');
    // AdMob is in the fixture, so advertising is proposed as true — and everything Agentship
    // cannot see is named as a safe default rather than an answer.
    expect(rating?.diff?.find((entry) => entry.path === 'ageRating.advertising')?.after).toBe(true);
    expect(rating?.riskNotes?.join(' ')).toContain('safe default');
  });
});
