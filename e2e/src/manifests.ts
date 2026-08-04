import { type AgentshipManifest, ManifestSchema, type Store } from '@agentship/core';

/**
 * The desired states the scenarios publish.
 *
 * They are deliberately few and shared: a journey is meant to read as "this app, this
 * release", and a per-test manifest would turn every scenario into an exercise in reading
 * YAML. Each builder takes overrides for the one thing its scenario is about.
 */
export const APPLE_REF = { bundleId: 'com.example.mock', appId: 'app-1' } as const;
export const GOOGLE_REF = { packageName: 'com.example.mock' } as const;

function storesFor(stores: readonly Store[]): Record<string, unknown> {
  return {
    ...(stores.includes('apple') ? { apple: APPLE_REF } : {}),
    ...(stores.includes('google') ? { google: GOOGLE_REF } : {}),
  };
}

function artifactsFor(stores: readonly Store[]): Record<string, unknown> {
  return {
    ...(stores.includes('apple') ? { apple: { path: 'artifacts/app.ipa', kind: 'ipa' } } : {}),
    ...(stores.includes('google') ? { google: { path: 'artifacts/app.aab', kind: 'aab' } } : {}),
  };
}

export interface ReleaseManifestOptions {
  readonly stores?: readonly Store[];
  readonly track?: 'internal_testing' | 'closed_testing' | 'open_testing' | 'production';
  readonly version?: string;
  readonly buildNumber?: string;
  readonly description?: string;
  readonly phased?: boolean;
  readonly testers?: boolean;
  readonly extra?: Record<string, unknown>;
}

/** An ordinary release: listing text, an artifact and a track. */
export function releaseManifest(options: ReleaseManifestOptions = {}): AgentshipManifest {
  const stores = options.stores ?? ['apple'];
  return ManifestSchema.parse({
    version: 1,
    app: { name: 'Mock App' },
    stores: storesFor(stores),
    release: {
      version: options.version ?? '1.1.0',
      buildNumber: options.buildNumber ?? '42',
      track: options.track ?? 'production',
      strategy: 'manual',
      ...(options.phased === true ? { phased: true } : {}),
      artifacts: artifactsFor(stores),
    },
    metadata: {
      primaryLocale: 'en-US',
      locales: {
        'en-US': {
          name: 'Mock App',
          shortDescription: 'Calm.',
          description: options.description ?? 'Fresh new description.',
          whatsNew: 'Faster and calmer.',
          privacyPolicyUrl: 'https://acme.example/privacy',
        },
      },
    },
    ...(options.testers === true
      ? {
          testers: {
            groups: [
              { name: 'Internal', track: 'internal_testing', members: ['tester@example.com'] },
            ],
          },
        }
      : {}),
    ...(options.extra ?? {}),
  });
}

/** A release plus a subscription and a consumable, priced in one territory. */
export function monetizedManifest(options: ReleaseManifestOptions = {}): AgentshipManifest {
  return releaseManifest({
    ...options,
    extra: {
      monetization: {
        products: [
          {
            id: 'pro_monthly',
            type: 'subscription',
            period: 'one_month',
            apple: { productId: 'com.example.mock.pro.monthly', group: 'Pro', level: 1 },
            google: { productId: 'com.example.mock.pro.monthly', basePlan: 'monthly' },
            names: { 'en-US': { displayName: 'Mock Pro', description: 'Everything, monthly.' } },
            price: { base: '4.99', baseTerritory: 'US', strategy: 'manual' },
          },
          {
            id: 'coins',
            type: 'consumable',
            apple: { productId: 'com.example.mock.coins' },
            google: { productId: 'com.example.mock.coins' },
            names: { 'en-US': { displayName: 'Coins' } },
            price: { base: '0.99', baseTerritory: 'US', strategy: 'manual' },
          },
        ],
      },
      ...(options.extra ?? {}),
    },
  });
}

/**
 * The practices a user has read and stands behind.
 *
 * `source: 'declared'` is the user's own statement — as opposed to `inferred`, which is
 * what the analyzer proposes. The status of the declaration as a whole is separate:
 * `declarationStatus` is the gate that lets any of it reach a store.
 */
export const DECLARED_PRACTICES = [
  {
    dataType: 'identifiers',
    collected: true,
    purposes: ['advertising', 'analytics'],
    linkedToUser: false,
    tracking: false,
    shared: true,
    source: 'declared',
    evidence: 'Google AdMob typically collects this data',
  },
  {
    dataType: 'diagnostics',
    collected: true,
    purposes: ['app_functionality'],
    source: 'declared',
    evidence: 'Firebase Crashlytics typically collects this data',
  },
] as const;

export interface PrivacyManifestOptions extends ReleaseManifestOptions {
  readonly declarationStatus?: 'draft' | 'confirmed';
}

export function privacyManifest(options: PrivacyManifestOptions = {}): AgentshipManifest {
  return releaseManifest({
    ...options,
    extra: {
      privacy: {
        declarationStatus: options.declarationStatus ?? 'confirmed',
        dataPractices: DECLARED_PRACTICES,
      },
      ...(options.extra ?? {}),
    },
  });
}

/** An app that does not exist in either store yet: everything is console work. */
export function newAppManifest(stores: readonly Store[] = ['apple', 'google']): AgentshipManifest {
  return ManifestSchema.parse({
    version: 1,
    app: { name: 'Lumo' },
    stores: storesFor(stores),
    release: {
      version: '1.0.0',
      buildNumber: '1',
      track: 'production',
      artifacts: artifactsFor(stores),
    },
    metadata: {
      primaryLocale: 'en-US',
      locales: {
        'en-US': {
          name: 'Lumo',
          shortDescription: 'Calm.',
          description: 'A calm app.',
          privacyPolicyUrl: 'https://acme.example/privacy',
        },
      },
    },
  });
}
