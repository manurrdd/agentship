import { describe, expect, it } from 'vitest';
import {
  detectSdks,
  loadAndroidRequirements,
  loadSdkCatalog,
  requiredTargetSdk,
  sdkCatalogLastVerified,
} from '../src/index.js';

const CATEGORIES = new Set([
  'purchases',
  'ads',
  'analytics',
  'tracking',
  'push',
  'crash',
  'auth',
  'storage',
  'maps',
  'media',
  'support',
  'other',
]);

const DATA_TYPES = new Set([
  'contact_info',
  'identifiers',
  'usage_data',
  'diagnostics',
  'purchases',
  'location',
  'user_content',
  'contacts',
  'search_history',
  'browsing_history',
  'financial_info',
  'health',
  'sensitive_info',
  'other',
]);

describe('SDK catalog', () => {
  it('has unique ids and known categories and data types', () => {
    const catalog = loadSdkCatalog();
    expect(catalog.length).toBeGreaterThan(15);
    expect(new Set(catalog.map((e) => e.id)).size).toBe(catalog.length);
    for (const entry of catalog) {
      expect(entry.categories.length, entry.id).toBeGreaterThan(0);
      for (const category of entry.categories)
        expect(CATEGORIES.has(category), category).toBe(true);
      for (const dataType of entry.privacy) expect(DATA_TYPES.has(dataType), dataType).toBe(true);
    }
  });

  it('gives every entry at least one way to be matched', () => {
    for (const entry of loadSdkCatalog()) {
      const total = Object.values(entry.match).flat().length;
      expect(total, entry.id).toBeGreaterThan(0);
    }
  });

  it('records when it was last checked against the ecosystems', () => {
    expect(sdkCatalogLastVerified()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('detectSdks', () => {
  it('matches exact dependency names per ecosystem', () => {
    const found = detectSdks([
      { ecosystem: 'npm', names: ['react-native-purchases'], file: 'package.json' },
      { ecosystem: 'gradle', names: ['com.android.billingclient:billing'], file: 'build.gradle' },
    ]);
    expect(found.map((s) => s.id).sort()).toEqual(['play-billing', 'revenuecat']);
  });

  it('matches a pod declared with a subspec', () => {
    const found = detectSdks([
      { ecosystem: 'pod', names: ['Firebase/Analytics'], file: 'Podfile' },
    ]);
    expect(found.map((s) => s.id)).toContain('firebase-analytics');
  });

  it('does not match a name from another ecosystem', () => {
    expect(detectSdks([{ ecosystem: 'npm', names: ['RevenueCat'], file: 'package.json' }])).toEqual(
      [],
    );
  });

  it('accumulates evidence when the same SDK appears in several places', () => {
    const found = detectSdks([
      { ecosystem: 'pub', names: ['google_mobile_ads'], file: 'pubspec.yaml' },
      { ecosystem: 'pod', names: ['Google-Mobile-Ads-SDK'], file: 'Podfile' },
    ]);
    expect(found[0]?.evidence).toHaveLength(2);
  });

  it('ignores unknown dependencies rather than guessing', () => {
    expect(detectSdks([{ ecosystem: 'npm', names: ['lodash'], file: 'package.json' }])).toEqual([]);
  });
});

describe('Android platform requirements', () => {
  it('returns the highest requirement already in force', () => {
    expect(requiredTargetSdk(new Date('2026-01-01'))?.apiLevel).toBe(35);
    expect(requiredTargetSdk(new Date('2024-01-01'))?.apiLevel).toBe(33);
  });

  it('never extrapolates a requirement that has not started yet', () => {
    expect(requiredTargetSdk(new Date('2020-01-01'))).toBeUndefined();
  });

  it('keeps the requirement table sorted and dated', () => {
    const { targetSdkRequirements, lastVerified } = loadAndroidRequirements();
    expect(lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const entry of targetSdkRequirements) {
      expect(entry.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.apiLevel).toBeGreaterThan(20);
    }
  });
});
