import type {
  AnalysisWarning,
  AppAnalysis,
  AppIdentity,
  BuildHints,
  Entitlement,
  Platform,
  Provenanced,
  VersionInfo,
} from '@agentship/core';
import { APP_ANALYSIS_VERSION } from '@agentship/core';
import { collectAssets } from './assets.js';
import { requiredTargetSdk } from './catalog.js';
import { detectFramework } from './detect.js';
import { extractAndroid } from './extract-android.js';
import { extractIos } from './extract-ios.js';
import { extractProject } from './extract-project.js';
import { derivePrivacySignals } from './privacy.js';
import { DEFAULT_LIMITS, RepoFs, type ScanLimits } from './repo-fs.js';
import { type DependencySource, detectSdks } from './sdks.js';

/**
 * Static analysis of an app repository.
 *
 * The whole point of this module is to hand the kernel and the agent a
 * picture of the app that is *honest*: every store-visible value carries where it came from
 * and how much it can be trusted, and anything the analyzer could not determine is simply
 * absent. An agent can then ask the user precisely the questions that remain, instead of
 * publishing a guess.
 *
 * Nothing here executes repository code, opens a network connection, or writes to disk.
 */

export interface AnalyzeOptions {
  readonly limits?: ScanLimits;
  /** Reference date for time-dependent platform requirements. Injected by tests. */
  readonly now?: Date;
}

/**
 * Control characters and the Unicode replacement character.
 *
 * A value containing either did not survive decoding intact — a file in the wrong encoding,
 * or deliberately corrupt bytes. Such a value must never reach a store listing, so it is
 * dropped rather than passed along as if it were a real bundle id or version.
 */
function hasUnprintable(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const isAllowedWhitespace = code === 0x09 || code === 0x0a || code === 0x0d;
    if ((code < 0x20 && !isAllowedWhitespace) || code === 0x7f || code === 0xfffd) return true;
  }
  return false;
}

function isUsable(value: Provenanced<unknown>): boolean {
  if (typeof value.value !== 'string') return true;
  return value.value.trim() !== '' && !hasUnprintable(value.value);
}

/** Builds a "first usable value, by precedence" picker that reports what it discarded. */
function makePicker(warnings: AnalysisWarning[]) {
  return <T>(
    label: string,
    ...values: (Provenanced<T> | undefined)[]
  ): Provenanced<T> | undefined => {
    for (const value of values) {
      if (value === undefined) continue;
      if (isUsable(value)) return value;
      warnings.push({
        code: 'UNREADABLE_VALUE',
        severity: 'warning',
        message: `The ${label} read from the project contains characters that did not decode correctly, so it was discarded.`,
        ...(value.source === undefined ? {} : { file: value.source }),
        remediation: `Check the encoding of the file, or declare ${label} in the Agentship manifest.`,
      });
    }
    return undefined;
  };
}

export async function analyzeApp(root: string, options: AnalyzeOptions = {}): Promise<AppAnalysis> {
  const startedAt = Date.now();
  const fs = await RepoFs.open(root, options.limits ?? DEFAULT_LIMITS);
  const warnings: AnalysisWarning[] = [];

  const detection = await detectFramework(fs);
  warnings.push(...detection.warnings);
  const { appDir, framework } = detection;

  const project = await extractProject(fs, appDir, framework);
  warnings.push(...project.warnings);

  const ios = await extractIos(fs, appDir);
  if (ios !== undefined) warnings.push(...ios.warnings);
  const android = await extractAndroid(fs, appDir);
  if (android !== undefined) warnings.push(...android.warnings);

  // Precedence: the framework manifest wins wherever it is what generates the native files
  // (Flutter's pubspec, Expo's app.json). For bare React Native and native projects the
  // native files are the source of truth.
  const manifestWins = framework === 'flutter' || framework === 'expo';

  const pickFirst = makePicker(warnings);
  const identity: AppIdentity = {
    ...pick(
      'bundleId',
      pickFirst(
        'bundle identifier',
        manifestWins ? project.bundleId : undefined,
        ios?.bundleId,
        project.bundleId,
      ),
    ),
    ...pick(
      'packageName',
      pickFirst(
        'application id',
        manifestWins ? project.packageName : undefined,
        android?.packageName,
        project.packageName,
      ),
    ),
    ...pick(
      'displayName',
      pickFirst('display name', project.displayName, ios?.displayName, android?.appName),
    ),
    ...pick('appName', pickFirst('app name', project.appName, ios?.appName, android?.appName)),
  };

  const versions: VersionInfo = {
    ...pick(
      'marketingVersion',
      pickFirst(
        'marketing version',
        manifestWins ? project.marketingVersion : undefined,
        ios?.marketingVersion,
        project.marketingVersion,
      ),
    ),
    ...pick(
      'buildNumber',
      pickFirst(
        'build number',
        manifestWins ? project.buildNumber : undefined,
        ios?.buildNumber,
        project.buildNumber,
      ),
    ),
    ...pick(
      'versionName',
      pickFirst(
        'version name',
        manifestWins ? project.versionName : undefined,
        android?.versionName,
        project.versionName,
      ),
    ),
    ...pick(
      'versionCode',
      pickFirst(
        'version code',
        manifestWins ? project.versionCode : undefined,
        android?.versionCode,
        project.versionCode,
      ),
    ),
  };

  const platforms = await resolvePlatforms(
    fs,
    appDir,
    framework,
    ios !== undefined,
    android !== undefined,
  );

  const dependencySources: DependencySource[] = [
    { ecosystem: 'npm', names: project.npmDependencies, file: join(appDir, 'package.json') },
    { ecosystem: 'pub', names: project.pubDependencies, file: join(appDir, 'pubspec.yaml') },
    ...(ios === undefined || ios.pods.length === 0
      ? []
      : [{ ecosystem: 'pod' as const, names: ios.pods, file: join(ios.iosDir, 'Podfile') }]),
    ...(android === undefined || android.dependencies.length === 0
      ? []
      : [
          {
            ecosystem: 'gradle' as const,
            names: android.dependencies,
            file: android.buildGradlePath ?? join(android.moduleDir, 'build.gradle'),
          },
        ]),
  ];
  const sdks = detectSdks(dependencySources.filter((source) => source.names.length > 0));

  const iosPermissions = ios?.permissions ?? [];
  const androidPermissions = android?.permissions ?? [];
  const entitlements: Entitlement[] = [...(ios?.entitlements ?? []), ...(android?.features ?? [])];
  const privacySignals = derivePrivacySignals(sdks, iosPermissions, androidPermissions);

  const buildHints: BuildHints = {
    ...(ios === undefined ? {} : { ios: ios.buildHints }),
    ...(android === undefined ? {} : { android: android.buildHints }),
    ...(detection.packageManager === undefined ? {} : { packageManager: detection.packageManager }),
    appDir,
  };

  const assets = await collectAssets(fs);
  warnings.push(...platformWarnings(android?.buildHints.targetSdk, options.now));
  if (assets.appIcons.length === 0 && framework !== 'unknown') {
    warnings.push({
      code: 'NO_APP_ICON_FOUND',
      severity: 'warning',
      message:
        'No app icon was found in the usual locations. Both stores reject a build without one.',
      remediation: 'Add the icon to the iOS asset catalogue and the Android mipmap resources.',
    });
  }
  if (fs.truncated) {
    warnings.push({
      code: 'SCAN_TRUNCATED',
      severity: 'info',
      message:
        'The repository is larger than the analyzer scans; some files were not inspected, so the result may be incomplete.',
      remediation: 'Point the analyzer at the app directory instead of the repository root.',
    });
  }
  const skippedSymlinks = fs.skipped.filter((entry) => entry.reason === 'symlink');
  if (skippedSymlinks.length > 0) {
    warnings.push({
      code: 'SYMLINKS_SKIPPED',
      severity: 'info',
      message: `${skippedSymlinks.length} symbolic link(s) were not followed; the analyzer only reads regular files inside the repository.`,
    });
  }

  return {
    schemaVersion: APP_ANALYSIS_VERSION,
    analyzedAt: new Date().toISOString(),
    root: fs.root,
    framework: {
      framework,
      confidence: detection.confidence,
      evidence: detection.evidence,
      ...(detection.expoWorkflow === undefined ? {} : { expoWorkflow: detection.expoWorkflow }),
      ...(detection.runnerUps.length === 0 ? {} : { runnerUps: detection.runnerUps }),
    },
    platforms,
    identity,
    versions,
    sdks,
    permissions: { ios: iosPermissions, android: androidPermissions },
    entitlements,
    privacySignals,
    assets,
    buildHints,
    warnings: dedupeWarnings(dropResolved(warnings, identity, versions)),
    stats: {
      filesScanned: fs.filesScanned,
      directoriesScanned: fs.directoriesScanned,
      truncated: fs.truncated,
      durationMs: Date.now() - startedAt,
    },
  };
}

function join(dir: string, file: string): string {
  return dir === '.' ? file : `${dir}/${file}`;
}

function pick<K extends string, T>(
  key: K,
  value: Provenanced<T> | undefined,
): Partial<Record<K, Provenanced<T>>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, Provenanced<T>>);
}

/**
 * Which stores the project can target.
 *
 * A managed Expo project has no native directories at all, so presence on disk cannot be
 * the only signal: the Expo config declares the targets instead.
 */
async function resolvePlatforms(
  fs: RepoFs,
  appDir: string,
  framework: string,
  hasIos: boolean,
  hasAndroid: boolean,
): Promise<Platform[]> {
  if (hasIos || hasAndroid) {
    return [...(hasIos ? (['ios'] as const) : []), ...(hasAndroid ? (['android'] as const) : [])];
  }
  if (framework === 'expo') {
    const appJson = await fs.readJson<{ expo?: { platforms?: string[] } }>(
      join(appDir, 'app.json'),
    );
    const declared = appJson?.expo?.platforms;
    if (declared !== undefined) {
      return declared.filter((p): p is Platform => p === 'ios' || p === 'android');
    }
    // Expo targets both stores unless the config says otherwise.
    return ['ios', 'android'];
  }
  return [];
}

function platformWarnings(targetSdk: number | undefined, now: Date | undefined): AnalysisWarning[] {
  if (targetSdk === undefined) return [];
  const requirement = requiredTargetSdk(now);
  if (requirement === undefined || targetSdk >= requirement.apiLevel) return [];
  return [
    {
      code: 'TARGET_SDK_BELOW_MINIMUM',
      severity: 'error',
      message: `The app targets API level ${targetSdk}, but since ${requirement.effectiveFrom} Google Play requires at least API ${requirement.apiLevel} (Android ${requirement.androidVersion}) for ${requirement.appliesTo}.`,
      remediation: `Raise targetSdk to ${requirement.apiLevel} or higher and re-test before uploading.`,
    },
  ];
}

/**
 * Drops "value missing" warnings for values another source supplied.
 *
 * A Flutter project computes `versionCode` from `pubspec.yaml` at build time, so the
 * Android extractor legitimately finds no literal — reporting that as a problem would be a
 * false alarm, and false alarms are what make an agent stop trusting warnings.
 */
function dropResolved(
  warnings: readonly AnalysisWarning[],
  identity: AppIdentity,
  versions: VersionInfo,
): AnalysisWarning[] {
  const resolved = new Set<string>();
  if (identity.bundleId !== undefined) resolved.add('MISSING_BUNDLE_ID');
  if (identity.packageName !== undefined) resolved.add('MISSING_APPLICATION_ID');
  if (versions.versionCode !== undefined) resolved.add('MISSING_VERSION_CODE');
  return warnings.filter((warning) => !resolved.has(warning.code));
}

/** Collapses warnings that repeat verbatim across extractors. */
function dedupeWarnings(warnings: readonly AnalysisWarning[]): AnalysisWarning[] {
  const seen = new Set<string>();
  const result: AnalysisWarning[] = [];
  for (const warning of warnings) {
    const key = `${warning.code}|${warning.file ?? ''}|${warning.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(warning);
  }
  const order = { error: 0, warning: 1, info: 2 };
  return result.sort((a, b) => order[a.severity] - order[b.severity]);
}
