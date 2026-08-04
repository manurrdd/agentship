import { fileURLToPath } from 'node:url';
import {
  type AppAnalysis,
  ManifestSchema,
  privacyLint,
  privacySignalFingerprint,
  proposePrivacy,
} from '@agentship/core';
import { describe, expect, it } from 'vitest';
import { analyzeApp } from '../src/index.js';

/**
 * The privacy proposal, against a real repository rather than a hand-written signal list.
 *
 * The fixture is the combination the plan calls out — Firebase Analytics and Crashlytics,
 * AdMob, and a location permission — because it exercises every interesting case at once:
 * a certain signal (a declared permission), an inferred one (an SDK that usually collects),
 * a tracking question only the user can answer, and a data type that is sensitive enough
 * that Agentship must ask rather than assume.
 */
const FIXTURE = fileURLToPath(new URL('./fixtures/privacy-app', import.meta.url));

let cached: AppAnalysis | undefined;
async function analysis(): Promise<AppAnalysis> {
  cached ??= await analyzeApp(FIXTURE);
  return cached;
}

function manifestWith(privacy: Record<string, unknown> | undefined) {
  return ManifestSchema.parse({
    version: 1,
    app: { name: 'Lumo' },
    stores: { apple: { bundleId: 'com.acme.lumo', appId: 'app-1' } },
    release: { version: '1.0.0' },
    metadata: {
      primaryLocale: 'en-US',
      locales: {
        'en-US': {
          name: 'Lumo',
          description: 'A calm app.',
          privacyPolicyUrl: 'https://acme.example/privacy',
        },
      },
    },
    ...(privacy === undefined ? {} : { privacy }),
  });
}

describe('proposePrivacy', () => {
  it('proposes a data practice for every signal, with its evidence', async () => {
    const proposal = proposePrivacy(await analysis());
    const byType = new Map(
      proposal.declaration.dataPractices.map((practice) => [practice.dataType, practice]),
    );
    // AdMob and Firebase Analytics both imply identifiers; the location permission is read
    // from the project, so it is a fact rather than a guess.
    expect([...byType.keys()]).toEqual(expect.arrayContaining(['identifiers', 'location']));
    expect(byType.get('location')?.evidence).toContain('location');
    expect(byType.get('identifiers')?.purposes).toContain('advertising');
    for (const practice of proposal.declaration.dataPractices) {
      expect(practice.source).toBe('inferred');
      expect(practice.evidence).toBeDefined();
    }
  });

  it('produces a draft, never an answer', async () => {
    const proposal = proposePrivacy(await analysis());
    expect(proposal.declaration.declarationStatus).toBe('draft');
  });

  it('asks about tracking and about sensitive data instead of deciding', async () => {
    const proposal = proposePrivacy(await analysis());
    const questions = proposal.questions.join('\n');
    expect(questions).toContain('track users across other companies');
    expect(questions).toContain('location');
  });

  it('is deterministic and fingerprints the signals it was derived from', async () => {
    const first = proposePrivacy(await analysis());
    const second = proposePrivacy(await analysis());
    expect(first).toEqual(second);
    expect(first.fingerprint).toBe(privacySignalFingerprint(await analysis()));
    expect(first.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('privacyLint', () => {
  it('accepts a declaration that matches the repository', async () => {
    const proposal = proposePrivacy(await analysis());
    const manifest = manifestWith({
      declarationStatus: 'confirmed',
      dataPractices: proposal.declaration.dataPractices,
      confirmedFrom: proposal.fingerprint,
    });
    const codes = privacyLint(manifest, await analysis()).map((finding) => finding.code);
    expect(codes).not.toContain('UNDECLARED_DATA_TYPE');
    expect(codes).not.toContain('ADS_WITHOUT_DECLARATION');
    expect(codes).not.toContain('PRIVACY_DECLARATION_DRIFT');
  });

  it('reports a data type the repository shows and the manifest omits', async () => {
    const codes = privacyLint(manifestWith({ dataPractices: [] }), await analysis()).map(
      (finding) => finding.code,
    );
    expect(codes).toContain('UNDECLARED_DATA_TYPE');
    expect(codes).toContain('ADS_WITHOUT_DECLARATION');
  });

  it('reports drift when the code moved after the declaration was confirmed', async () => {
    const proposal = proposePrivacy(await analysis());
    const manifest = manifestWith({
      declarationStatus: 'confirmed',
      dataPractices: proposal.declaration.dataPractices,
      confirmedFrom: 'deadbeef',
    });
    const codes = privacyLint(manifest, await analysis()).map((finding) => finding.code);
    expect(codes).toContain('PRIVACY_DECLARATION_DRIFT');
  });

  it('treats a missing usage description as an error, because App Review rejects it', async () => {
    const withoutDescription: AppAnalysis = {
      ...(await analysis()),
      permissions: {
        ios: [{ key: 'NSCameraUsageDescription', source: 'ios/Lumo/Info.plist' }],
        android: [],
      },
    };
    const findings = privacyLint(manifestWith(undefined), withoutDescription);
    const missing = findings.find((finding) => finding.code === 'MISSING_USAGE_DESCRIPTION');
    expect(missing?.severity).toBe('error');
  });

  it('flags a purpose string that says nothing', async () => {
    const vague: AppAnalysis = {
      ...(await analysis()),
      permissions: {
        ios: [
          {
            key: 'NSCameraUsageDescription',
            usageDescription: { value: 'We need this', confidence: 'certain' },
            source: 'ios/Lumo/Info.plist',
          },
        ],
        android: [],
      },
    };
    const codes = privacyLint(manifestWith(undefined), vague).map((finding) => finding.code);
    expect(codes).toContain('GENERIC_USAGE_DESCRIPTION');
  });

  it('requires App Tracking Transparency before a declaration may claim tracking', async () => {
    const withoutAtt: AppAnalysis = {
      ...(await analysis()),
      permissions: {
        ios: (await analysis()).permissions.ios.filter(
          (permission) => permission.key !== 'NSUserTrackingUsageDescription',
        ),
        android: [],
      },
    };
    const manifest = manifestWith({
      declarationStatus: 'confirmed',
      dataPractices: [
        {
          dataType: 'identifiers',
          collected: true,
          purposes: ['advertising'],
          linkedToUser: false,
          tracking: true,
          shared: true,
          source: 'declared',
        },
      ],
    });
    const finding = privacyLint(manifest, withoutAtt).find(
      (candidate) => candidate.code === 'TRACKING_WITHOUT_ATT',
    );
    expect(finding?.severity).toBe('error');
  });

  it('asks for a privacy policy URL once anything is declared', async () => {
    const manifest = ManifestSchema.parse({
      version: 1,
      app: { name: 'Lumo' },
      stores: { google: { packageName: 'com.acme.lumo' } },
      release: { version: '1.0.0' },
      metadata: { primaryLocale: 'en-US', locales: { 'en-US': { name: 'Lumo' } } },
      privacy: {
        declarationStatus: 'confirmed',
        dataPractices: [
          {
            dataType: 'diagnostics',
            collected: true,
            purposes: ['app_functionality'],
            source: 'declared',
          },
        ],
      },
    });
    const codes = privacyLint(manifest, undefined).map((finding) => finding.code);
    expect(codes).toContain('MISSING_PRIVACY_POLICY_URL');
  });
});
