import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadManifest, manifestPath, saveManifest } from '@agentship/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Journey } from '../src/journey.js';

/**
 * The vertical slice: a directory on disk becomes a release.
 *
 * Nothing is pre-arranged. The repository is a real Flutter fixture, the manifest is the
 * one `agentship_analyze` writes from it, and the only thing the "user" does is answer the
 * gaps the analysis reported — which is the entire premise of the product: Agentship works
 * out everything it can, and asks about exactly what is left.
 */
describe('vertical slice: from a repository to a submitted release', () => {
  let journey: Journey | undefined;
  afterEach(async () => {
    await journey?.cleanup();
    journey = undefined;
  });

  it('analyses, fills the gaps, plans, gets approval and converges', async () => {
    journey = await Journey.start({ stores: ['apple'], fixture: 'flutter-app' });

    // 1. The agent's first call. It writes the manifest, and says what it could not know.
    const analyzed = await journey.analyze();
    const analysis = analyzed.payload['analysis'] as {
      framework: { framework: string; confidence: string };
      platforms: string[];
    };
    const manifestInfo = analyzed.payload['manifest'] as {
      path: string;
      created: boolean;
      gaps: string[];
    };
    expect(analysis.framework.framework).toBe('flutter');
    expect(analysis.platforms).toEqual(expect.arrayContaining(['ios']));
    expect(manifestInfo.created).toBe(true);
    expect(manifestInfo.path).toBe(manifestPath(journey.repoRoot));

    // The generated manifest is real YAML on disk, and it marks its gaps for the agent.
    const yaml = await readFile(join(journey.repoRoot, '.agentship/agentship.yaml'), 'utf8');
    expect(yaml).toContain('version: 1');
    const generated = await loadManifest(journey.repoRoot);
    expect(generated.app.name.length).toBeGreaterThan(0);

    // 2. The user answers. Only the gaps are touched, plus the artifact this test does not
    //    build: everything else stays exactly as the analysis left it.
    await saveManifest(journey.repoRoot, {
      ...generated,
      stores: { apple: { bundleId: 'com.example.mock', appId: 'app-1' } },
      release: {
        ...generated.release,
        version: '1.1.0',
        buildNumber: '42',
        track: 'production',
        artifacts: { apple: { path: 'artifacts/app.ipa', kind: 'ipa' } },
      },
      metadata: {
        primaryLocale: 'en-US',
        locales: {
          'en-US': {
            name: 'Mock App',
            description: 'Fresh new description.',
            shortDescription: 'Calm.',
            privacyPolicyUrl: 'https://acme.example/privacy',
          },
        },
      },
    });

    // 3. Credentials: the machine is checked before the store is touched.
    const status = await journey.call('agentship_setup_status', { projectDir: journey.repoRoot });
    expect(status.payload['credentials']).toBeDefined();
    expect(status.payload['tools']).toBeDefined();

    // 4. The plan. Every prerequisite of the submission comes before it, and the
    //    submission itself is never automatic.
    const plan = await journey.plan();
    const kinds = plan.actions.map((action) => action.kind);
    expect(kinds).toContain('ensure_version');
    expect(kinds).toContain('set_metadata');
    expect(kinds).toContain('upload_build');
    expect(kinds).toContain('submit_for_review');
    const submit = plan.actions.find((action) => action.kind === 'submit_for_review');
    expect(submit?.classification).toBe('needs_approval');

    // 5. Applying with no approvals at all still makes progress, and touches nothing gated.
    const withheld = await journey.apply(plan, []);
    expect(journey.adapter('apple').effects.submits).toBe(0);
    expect(withheld.outcomes.some((outcome) => outcome.status === 'needs_approval')).toBe(true);

    // 6. The user approves, and the release lands.
    await journey.driveToConvergence();

    const apple = journey.adapter('apple');
    expect(apple.state.versions.find((version) => version.version === '1.1.0')?.state).toBe(
      'waiting_review',
    );
    expect(apple.effects.uploads).toBe(1);
    expect(apple.effects.submits).toBe(1);
    expect(apple.effects.metadataWrites).toBe(1);

    // 7. What is left is exactly what a machine may not decide: the analysis proposed a
    //    privacy declaration from the SDKs it found, and only the user can confirm it.
    const remaining = await journey.plan();
    expect(
      remaining.actions.map((action) => action.kind),
      journey.render(),
    ).toEqual(['confirm_privacy']);
    expect(remaining.actions[0]?.classification).toBe('needs_input');

    // 8. The user reads the proposal and confirms it in the manifest.
    const reviewed = await loadManifest(journey.repoRoot);
    await saveManifest(journey.repoRoot, {
      ...reviewed,
      privacy: { ...reviewed.privacy, declarationStatus: 'confirmed' },
    });
    const afterConfirming = await journey.plan();
    expect(afterConfirming.actions.some((action) => action.kind === 'confirm_privacy')).toBe(false);

    // Apple exposes no API for App Privacy, so the declaration becomes console work with
    // the proposal already filled in — not an action Agentship can perform.
    const pending = await journey.pending('list');
    const ids = (pending.payload['pending'] as { id: string }[]).map((entry) => entry.id);
    expect(ids).toContain('apple:app-privacy');
  });

  it('analyses a React Native repository without a manifest and asks before inventing', async () => {
    journey = await Journey.start({ stores: ['apple'], fixture: 'react-native-app' });
    const analyzed = await journey.analyze();
    const manifestInfo = analyzed.payload['manifest'] as { created: boolean; gaps: string[] };
    expect(manifestInfo.created).toBe(true);

    // Whatever the analysis could not determine is reported as a gap and left as a
    // sentinel in the manifest, never guessed into a store.
    const manifest = await loadManifest(journey.repoRoot);
    const rendered = JSON.stringify(manifest);
    for (const gap of manifestInfo.gaps) expect(gap.length).toBeGreaterThan(0);
    if (manifestInfo.gaps.length > 0) expect(rendered).toContain('<needs_input>');

    // A plan over an unanswered manifest asks, and executes nothing gated.
    const plan = await journey.plan();
    await journey.apply(plan, []);
    const apple = journey.adapter('apple');
    expect(apple.effects.submits).toBe(0);
    expect(apple.effects.metadataWrites).toBe(0);
  });
});
