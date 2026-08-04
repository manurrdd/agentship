import { fileURLToPath } from 'node:url';
import type { AppAnalysis } from '@agentship/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeApp } from '../src/index.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** Reference date pinned so time-dependent platform requirements stay deterministic. */
const NOW = new Date('2026-08-03T00:00:00.000Z');

const analyses = new Map<string, AppAnalysis>();
async function analyze(name: string): Promise<AppAnalysis> {
  const cached = analyses.get(name);
  if (cached !== undefined) return cached;
  const result = await analyzeApp(fixture(name), { now: NOW });
  analyses.set(name, result);
  return result;
}

beforeAll(async () => {
  await Promise.all(
    [
      'flutter-app',
      'react-native-app',
      'expo-app',
      'ios-native-app',
      'android-native-app',
      'malformed-app',
    ].map(analyze),
  );
});

describe('Flutter', () => {
  it('is detected from pubspec.yaml despite the native projects it contains', async () => {
    const analysis = await analyze('flutter-app');
    expect(analysis.framework.framework).toBe('flutter');
    expect(analysis.framework.confidence).toBe('certain');
    expect(analysis.framework.evidence[0]?.file).toBe('pubspec.yaml');
    expect(analysis.platforms).toEqual(['ios', 'android']);
  });

  it('resolves the bundle id through the Xcode build setting it references', async () => {
    const analysis = await analyze('flutter-app');
    expect(analysis.identity.bundleId?.value).toBe('com.example.receiptScanner');
    // Info.plist only holds $(PRODUCT_BUNDLE_IDENTIFIER); the value comes from the project.
    expect(analysis.identity.bundleId?.confidence).toBe('inferred');
    expect(analysis.identity.bundleId?.source).toContain('project.pbxproj');
  });

  it('takes versions from pubspec, which is what generates the native ones', async () => {
    const analysis = await analyze('flutter-app');
    expect(analysis.versions.marketingVersion?.value).toBe('1.4.2');
    expect(analysis.versions.buildNumber?.value).toBe('42');
    expect(analysis.versions.versionCode?.value).toBe(42);
    expect(analysis.versions.marketingVersion?.source).toBe('pubspec.yaml');
  });

  it('does not warn about a versionCode Flutter supplies at build time', async () => {
    const analysis = await analyze('flutter-app');
    expect(analysis.warnings.map((w) => w.code)).not.toContain('MISSING_VERSION_CODE');
  });

  it('detects SDKs across pub, pod and gradle declarations', async () => {
    const analysis = await analyze('flutter-app');
    const ids = analysis.sdks.map((s) => s.id);
    expect(ids).toContain('firebase-analytics');
    expect(ids).toContain('admob');
    expect(ids).toContain('play-billing');
    const admob = analysis.sdks.find((s) => s.id === 'admob');
    expect(admob?.evidence.some((e) => e.file === 'pubspec.yaml')).toBe(true);
    expect(admob?.implications?.join(' ')).toMatch(/App Tracking Transparency/);
  });

  it('flags a declared permission whose purpose string is empty', async () => {
    const analysis = await analyze('flutter-app');
    const warning = analysis.warnings.find((w) => w.code === 'MISSING_USAGE_DESCRIPTION');
    expect(warning?.severity).toBe('error');
    expect(warning?.message).toContain('NSPhotoLibraryUsageDescription');
    const camera = analysis.permissions.ios.find((p) => p.key === 'NSCameraUsageDescription');
    expect(camera?.usageDescription?.value).toContain('photograph your receipts');
  });

  it('collects entitlements and build hints', async () => {
    const analysis = await analyze('flutter-app');
    expect(analysis.entitlements.map((e) => e.key)).toContain('aps-environment');
    expect(analysis.buildHints.ios?.schemes).toEqual(['Runner']);
    expect(analysis.buildHints.ios?.configurations.sort()).toEqual(['Debug', 'Release']);
    expect(analysis.buildHints.ios?.hasPodfile).toBe(true);
    expect(analysis.buildHints.ios?.deploymentTarget).toBe('13.0');
    expect(analysis.buildHints.android?.targetSdk).toBe(35);
    expect(analysis.buildHints.android?.hasGradleWrapper).toBe(true);
  });

  it('proposes privacy signals with their evidence', async () => {
    const analysis = await analyze('flutter-app');
    const location = analysis.privacySignals.find((s) => s.dataType === 'location');
    // A declared permission is direct evidence; an SDK is only an inference.
    expect(location?.confidence).toBe('certain');
    const purchases = analysis.privacySignals.find((s) => s.dataType === 'purchases');
    expect(purchases?.sdkIds).toContain('play-billing');
    expect(purchases?.confidence).toBe('inferred');
  });
});

describe('React Native (bare)', () => {
  it('is detected and reads identity from the native projects', async () => {
    const analysis = await analyze('react-native-app');
    expect(analysis.framework.framework).toBe('react-native');
    expect(analysis.identity.bundleId?.value).toBe('com.acme.chat');
    expect(analysis.identity.bundleId?.confidence).toBe('certain');
    expect(analysis.identity.packageName?.value).toBe('com.acme.chat');
    expect(analysis.versions.versionCode?.value).toBe(15);
    expect(analysis.buildHints.packageManager).toBe('yarn');
  });

  it('warns that the app targets an API level Google Play no longer accepts', async () => {
    const analysis = await analyze('react-native-app');
    const warning = analysis.warnings.find((w) => w.code === 'TARGET_SDK_BELOW_MINIMUM');
    expect(warning?.severity).toBe('error');
    expect(warning?.message).toContain('API 35');
  });

  it('records the maxSdkVersion of a legacy storage permission', async () => {
    const analysis = await analyze('react-native-app');
    const storage = analysis.permissions.android.find((p) =>
      p.name.endsWith('READ_EXTERNAL_STORAGE'),
    );
    expect(storage?.maxSdkVersion).toBe(32);
  });

  it('finds committed screenshots and icons', async () => {
    const analysis = await analyze('react-native-app');
    expect(analysis.assets.screenshots[0]?.platform).toBe('ios');
    expect(analysis.assets.appIcons.length).toBeGreaterThan(0);
    // Dimensions come from the PNG header itself.
    expect(analysis.assets.appIcons[0]?.width).toBe(1);
  });
});

describe('Expo (managed)', () => {
  it('is detected ahead of React Native and reads identity from app.json', async () => {
    const analysis = await analyze('expo-app');
    expect(analysis.framework.framework).toBe('expo');
    expect(analysis.framework.expoWorkflow).toBe('managed');
    // Expo and React Native score close together, so the answer comes from the rule.
    expect(analysis.framework.confidence).toBe('inferred');
    expect(analysis.framework.runnerUps?.map((r) => r.framework)).toContain('react-native');
    expect(analysis.identity.bundleId?.value).toBe('com.trailmap.app');
    expect(analysis.identity.packageName?.value).toBe('com.trailmap.app');
    expect(analysis.identity.displayName?.value).toBe('TrailMap');
    expect(analysis.versions.versionCode?.value).toBe(7);
  });

  it('reports both target platforms even without native directories', async () => {
    const analysis = await analyze('expo-app');
    expect(analysis.platforms).toEqual(['ios', 'android']);
    expect(analysis.buildHints.ios).toBeUndefined();
    expect(analysis.buildHints.packageManager).toBe('pnpm');
  });
});

describe('Native iOS', () => {
  it('reads identity and versions from the Xcode build settings', async () => {
    const analysis = await analyze('ios-native-app');
    expect(analysis.framework.framework).toBe('ios-native');
    expect(analysis.platforms).toEqual(['ios']);
    expect(analysis.identity.bundleId?.value).toBe('com.ledgerapp.ios');
    expect(analysis.versions.marketingVersion?.value).toBe('3.1.0');
    expect(analysis.versions.buildNumber?.value).toBe('31');
    expect(analysis.identity.packageName).toBeUndefined();
  });

  it('reports that a build setting differs across configurations', async () => {
    const analysis = await analyze('ios-native-app');
    const warning = analysis.warnings.find((w) => w.code === 'BUILD_SETTING_VARIES');
    expect(warning?.message).toContain('com.ledgerapp.ios.staging');
  });

  it('collects pods and entitlements', async () => {
    const analysis = await analyze('ios-native-app');
    expect(analysis.sdks.map((s) => s.id).sort()).toEqual(['revenuecat', 'sentry']);
    expect(analysis.entitlements.map((e) => e.key)).toContain('com.apple.developer.applesignin');
  });
});

describe('Native Android', () => {
  it('reads the Kotlin DSL build script', async () => {
    const analysis = await analyze('android-native-app');
    expect(analysis.framework.framework).toBe('android-native');
    expect(analysis.platforms).toEqual(['android']);
    expect(analysis.identity.packageName?.value).toBe('com.habit.tracker');
    expect(analysis.versions.versionName?.value).toBe('3.1.0');
    expect(analysis.versions.versionCode?.value).toBe(7);
  });

  it('extracts flavours and build types from nested blocks', async () => {
    const analysis = await analyze('android-native-app');
    expect(analysis.buildHints.android?.flavors.sort()).toEqual(['free', 'pro']);
    expect(analysis.buildHints.android?.buildTypes.sort()).toEqual(['debug', 'release']);
    expect(analysis.buildHints.android?.minSdk).toBe(26);
  });

  it('resolves the app name through the string resource it references', async () => {
    const analysis = await analyze('android-native-app');
    expect(analysis.identity.displayName?.value).toBe('Habit Tracker');
    expect(analysis.identity.displayName?.confidence).toBe('inferred');
  });

  it('finds Play listing assets laid out in the fastlane convention', async () => {
    const analysis = await analyze('android-native-app');
    expect(analysis.assets.screenshots[0]?.platform).toBe('android');
    expect(analysis.assets.listingFiles.some((f) => f.endsWith('title.txt'))).toBe(true);
  });
});

describe('malformed project', () => {
  it('produces warnings instead of failing', async () => {
    const analysis = await analyze('malformed-app');
    const codes = analysis.warnings.map((w) => w.code);
    expect(codes).toContain('INFO_PLIST_UNREADABLE');
    expect(codes).toContain('MISSING_BUNDLE_ID');
    expect(codes).toContain('MISSING_APPLICATION_ID');
  });

  it('reports nothing rather than a wrong value', async () => {
    const analysis = await analyze('malformed-app');
    expect(analysis.identity.bundleId).toBeUndefined();
    expect(analysis.identity.packageName).toBeUndefined();
  });

  it('still extracts what is readable', async () => {
    const analysis = await analyze('malformed-app');
    expect(analysis.versions.marketingVersion?.value).toBe('0.1.0');
  });
});

describe('result contract', () => {
  it('is JSON-serialisable and bounded for every fixture', async () => {
    for (const [name, analysis] of analyses) {
      const json = JSON.stringify(analysis);
      expect(JSON.parse(json), name).toEqual(analysis);
      expect(json.length, name).toBeLessThan(200_000);
      expect(analysis.schemaVersion).toBe(1);
      expect(Date.parse(analysis.analyzedAt)).not.toBeNaN();
      expect(analysis.stats.filesScanned).toBeGreaterThan(0);
    }
  });

  it('gives every warning a code, a severity and a message', async () => {
    for (const analysis of analyses.values()) {
      for (const warning of analysis.warnings) {
        expect(warning.code).toMatch(/^[A-Z0-9_]+$/);
        expect(['info', 'warning', 'error']).toContain(warning.severity);
        expect(warning.message.length).toBeGreaterThan(10);
      }
    }
  });

  it('attaches provenance to every store-visible value', async () => {
    for (const analysis of analyses.values()) {
      const values = [
        ...Object.values(analysis.identity),
        ...Object.values(analysis.versions),
      ].filter((v) => v !== undefined);
      for (const value of values) {
        expect(['certain', 'inferred', 'guess']).toContain(value.confidence);
      }
    }
  });
});
