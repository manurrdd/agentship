import { loadManifest, ManifestSchema } from '@agentship/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpHarness, type McpHarness } from './helpers.js';

/**
 * The two presentation layers a plan response carries besides the plan itself:
 *
 * - `adoptable` — manifest gaps whose value the store already holds, offered for explicit
 *   adoption and never written automatically.
 * - `readiness` — what stands between the project and a review submission, per store,
 *   blockers first.
 */
function manifestWithGap() {
  return ManifestSchema.parse({
    version: 1,
    app: { name: 'Mock App' },
    stores: { apple: { bundleId: 'com.example.mock', appId: 'app-1' } },
    release: {
      version: '1.1.0',
      buildNumber: '42',
      track: 'internal_testing',
      artifacts: { apple: { path: 'artifacts/app.ipa', kind: 'ipa' } },
    },
    metadata: {
      primaryLocale: 'en-US',
      locales: { 'en-US': { name: 'Mock App', description: '<needs_input>' } },
    },
  });
}

describe('adoptable values and readiness', () => {
  let harness: McpHarness | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('offers the store value for a manifest gap without writing it', async () => {
    harness = await createMcpHarness({ stores: ['apple'], manifest: manifestWithGap() });
    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });

    const adoptable = planned.payload['adoptable'] as {
      path: string;
      store: string;
      remoteValue: string;
    }[];
    const entry = adoptable.find((e) => e.path === 'metadata.locales.en-US.description');
    expect(entry?.store).toBe('apple');
    expect(entry?.remoteValue).toBe('The original text.');
    expect(String(planned.payload['adoptableNote'])).toContain('adopted from');
    // Not backfilled: the manifest still carries the sentinel until the agent, with the
    // user's agreement, writes it.
    const manifest = await loadManifest(harness.repoRoot);
    expect(manifest.metadata.locales['en-US']?.description).toBe('<needs_input>');
  });

  it('reports readiness per store on plan and store_status, blockers first', async () => {
    harness = await createMcpHarness({ stores: ['apple'], manifest: manifestWithGap() });
    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });

    const readiness = planned.payload['readiness'] as {
      apple: { severity: string; source: string; summary: string; remediation: string }[];
    };
    // The sentinel description makes the metadata action needs_input: a blocker.
    const blocker = readiness.apple.find((item) => item.source === 'manifest');
    expect(blocker?.severity).toBe('blocking');
    expect(blocker?.remediation).toContain('agentship.yaml');
    const severities = readiness.apple.map((item) => item.severity);
    expect([...severities].sort((a, b) => (a === b ? 0 : a === 'blocking' ? -1 : 1))).toEqual(
      severities,
    );

    // store_status derives readiness from the stored plan and says so.
    const status = await harness.call('agentship_store_status', {
      projectDir: harness.repoRoot,
    });
    const statusReadiness = status.payload['readiness'] as {
      perStore: Record<string, unknown[]>;
      note: string;
    };
    expect(statusReadiness.perStore['apple']?.length).toBeGreaterThan(0);
    expect(statusReadiness.note).toContain('agentship_plan');
    // And store_status offers the same adoptable values.
    const adoptable = status.payload['adoptable'] as { path: string }[];
    expect(adoptable.some((e) => e.path === 'metadata.locales.en-US.description')).toBe(true);
  });

  it('carries what the store itself refuses, which no manifest diff could predict', async () => {
    harness = await createMcpHarness({ stores: ['apple'], manifest: manifestWithGap() });
    const apple = harness.adapters.get('apple');
    // Nothing in the manifest or the snapshot implies either of these: the screenshot is
    // present and the right shape as far as Agentship knows, and the phone number is not a
    // field any differ compares. Only Apple knows.
    if (apple !== undefined) {
      apple.state.submissionBlockers = [
        {
          code: 'screenshots.size.unsupported',
          severity: 'error',
          blocking: true,
          message:
            'The 6.5" screenshots are 1320x2868, which this display family no longer accepts.',
        },
        {
          code: 'review_details.phone.missing',
          severity: 'warning',
          blocking: false,
          message: 'App Store review details have no contact phone number.',
          remediation: 'Add review.contactPhone to the manifest.',
        },
      ];
    }

    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const readiness = planned.payload['readiness'] as {
      apple: { severity: string; source: string; summary: string; remediation: string }[];
    };
    const fromStore = readiness.apple.filter((item) => item.source === 'store');
    expect(fromStore.map((item) => item.summary)).toEqual([
      '[screenshots.size.unsupported] The 6.5" screenshots are 1320x2868, which this display family no longer accepts.',
      '[review_details.phone.missing] App Store review details have no contact phone number.',
    ]);
    expect(fromStore[0]?.severity).toBe('blocking');
    expect(fromStore[1]?.severity).toBe('warning');
    expect(fromStore[1]?.remediation).toBe('Add review.contactPhone to the manifest.');
  });

  it('reports text the store already disagrees with, instead of quietly reverting it', async () => {
    // The manifest was written once and the listing was edited in the console afterwards —
    // the shape of every "two sources of truth" accident. Applying the manifest would put
    // the older text back, and today the only warning is a diff nobody reads as a revert.
    harness = await createMcpHarness({
      stores: ['apple'],
      manifest: ManifestSchema.parse({
        version: 1,
        app: { name: 'Mock App' },
        stores: { apple: { bundleId: 'com.example.mock', appId: 'app-1' } },
        release: { version: '1.1.0', buildNumber: '42', track: 'internal_testing' },
        metadata: {
          primaryLocale: 'en-US',
          locales: { 'en-US': { name: 'Mock App', description: 'The original text.' } },
        },
      }),
    });
    const apple = harness.adapters.get('apple');
    apple?.state.localizations.set('en-US', {
      name: 'Mock App',
      description: 'The text somebody rewrote in App Store Connect, with the renewal wording.',
    });
    apple?.state.localizations.set('es-ES', { name: 'Mock App', description: 'Texto publicado.' });

    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const drift = planned.payload['drift'] as {
      kind: string;
      locale: string;
      path?: string;
      detail: string;
    }[];

    const differs = drift.find((entry) => entry.kind === 'differs');
    expect(differs?.path).toBe('metadata.locales.en-US.description');
    expect(differs?.detail).toContain('replaces the published text');

    // The locale nothing in the manifest mentions is the half a diff can never surface.
    const undeclared = drift.find((entry) => entry.kind === 'undeclared_locale');
    expect(undeclared?.locale).toBe('es-ES');
    expect(undeclared?.detail).toContain('does not declare that locale');
    expect(String(planned.payload['driftNote'])).toContain('may not have been Agentship');
  });

  it('says which store could not be asked instead of implying it had nothing to say', async () => {
    harness = await createMcpHarness({ stores: ['google'] });
    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });

    const notAsked = planned.payload['readinessNotAsked'] as { store: string; reason: string }[];
    expect(notAsked).toHaveLength(1);
    expect(notAsked[0]?.store).toBe('google');
    expect(notAsked[0]?.reason).toContain('no pre-submission readiness check');
  });
});
