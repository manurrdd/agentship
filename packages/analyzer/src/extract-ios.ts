import type {
  AnalysisWarning,
  Entitlement,
  IosBuildHints,
  IosPermission,
  Provenanced,
} from '@agentship/core';
import { provenanced } from '@agentship/core';
import {
  entitlementKeys,
  parsePlist,
  pbxprojApplicationSettings,
  pbxprojConfigurations,
  pbxprojSettings,
} from './parsers.js';
import type { RepoFs } from './repo-fs.js';

/**
 * Extraction from the iOS side of a project.
 *
 * `Info.plist` is the source of truth for identity and purpose strings, but in any modern
 * project its interesting values are `$(BUILD_SETTING)` references resolved by Xcode at
 * build time. The analyzer resolves them from `project.pbxproj` and downgrades the result's
 * confidence to `inferred`, because a setting can differ per configuration and only a real
 * build knows which one applies. A reference that cannot be resolved is reported as a
 * warning, never guessed.
 */

export interface IosExtraction {
  readonly iosDir: string;
  readonly infoPlistPath?: string;
  readonly bundleId?: Provenanced<string>;
  readonly displayName?: Provenanced<string>;
  readonly appName?: Provenanced<string>;
  readonly marketingVersion?: Provenanced<string>;
  readonly buildNumber?: Provenanced<string>;
  readonly permissions: readonly IosPermission[];
  readonly entitlements: readonly Entitlement[];
  readonly buildHints: IosBuildHints;
  readonly pods: readonly string[];
  readonly warnings: readonly AnalysisWarning[];
}

const BUILD_SETTING_REFERENCE = /^\$[({]([A-Za-z0-9_]+)[)}]$/;

function joinDir(dir: string, file: string): string {
  return dir === '.' ? file : `${dir}/${file}`;
}

/** Locates the iOS project directory: `ios/` in cross-platform projects, the root in native ones. */
async function findIosDir(fs: RepoFs, appDir: string): Promise<string | undefined> {
  const nested = joinDir(appDir, 'ios');
  if (await fs.isDirectory(nested)) return nested;
  for (const name of await fs.list(appDir)) {
    if (name.endsWith('.xcodeproj') || name.endsWith('.xcworkspace')) return appDir;
  }
  return undefined;
}

/**
 * Picks the app's Info.plist.
 *
 * Preference order matters: `Runner/Info.plist` is Flutter's fixed layout, and the generic
 * fallback must exclude test targets and CocoaPods, whose plists would yield a test bundle's
 * identifier instead of the app's.
 */
async function findInfoPlist(fs: RepoFs, iosDir: string): Promise<string | undefined> {
  const preferred = await fs.firstExisting([
    joinDir(iosDir, 'Runner/Info.plist'),
    joinDir(iosDir, 'App/Info.plist'),
  ]);
  if (preferred !== undefined) return preferred;

  const all = (await fs.find(/(^|\/)Info\.plist$/)).filter(
    (path) =>
      path.startsWith(iosDir === '.' ? '' : `${iosDir}/`) &&
      !/(^|\/)(Pods|Tests|.*Tests|.*UITests|Frameworks)(\/|$)/.test(path),
  );
  // Shallower paths belong to the app target; deeper ones to nested resources.
  return all.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0];
}

type Resolver = (raw: string, key: string) => Provenanced<string> | undefined;

function makeResolver(
  plistPath: string,
  settings: Map<string, string[]>,
  pbxprojPath: string | undefined,
  warnings: AnalysisWarning[],
): Resolver {
  return (raw, key) => {
    const reference = BUILD_SETTING_REFERENCE.exec(raw.trim());
    if (reference === null) return provenanced(raw, 'certain', plistPath, `${key} in Info.plist`);

    const settingName = reference[1] as string;
    const values = settings.get(settingName);
    if (values === undefined || values[0] === undefined) {
      // `FLUTTER_*` settings live in Generated.xcconfig, which `flutter build` writes from
      // pubspec.yaml and which is deliberately not committed. Their absence is expected,
      // and pubspec supplies the same values, so it is not worth an alarm.
      if (settingName.startsWith('FLUTTER_')) return undefined;
      warnings.push({
        code: 'UNRESOLVED_BUILD_SETTING',
        severity: 'warning',
        message: `${key} is set to $(${settingName}) in Info.plist and that build setting could not be found.`,
        file: plistPath,
        remediation: `Provide the value explicitly in the Agentship manifest, or check that ${settingName} is defined in the Xcode project.`,
      });
      return undefined;
    }
    if (values.length > 1) {
      warnings.push({
        code: 'BUILD_SETTING_VARIES',
        severity: 'info',
        message: `${settingName} has different values across build configurations (${values.join(', ')}); using ${values[0]}.`,
        file: pbxprojPath ?? plistPath,
      });
    }
    return provenanced(
      values[0],
      'inferred',
      pbxprojPath ?? plistPath,
      `${key} resolves to the ${settingName} build setting`,
    );
  };
}

export async function extractIos(fs: RepoFs, appDir: string): Promise<IosExtraction | undefined> {
  const iosDir = await findIosDir(fs, appDir);
  if (iosDir === undefined) return undefined;

  const warnings: AnalysisWarning[] = [];
  const prefix = iosDir === '.' ? '' : `${iosDir}/`;

  const pbxprojPath = (await fs.find(/\.xcodeproj\/project\.pbxproj$/)).find((p) =>
    p.startsWith(prefix),
  );
  const pbxproj = pbxprojPath === undefined ? undefined : await fs.readText(pbxprojPath);
  const applicationSettings =
    pbxproj === undefined ? new Map<string, string[]>() : pbxprojApplicationSettings(pbxproj);
  // Older or hand-written projects may not contain the target graph sections. Keep the
  // tolerant all-settings reader as a fallback, but never use it when the app target is known.
  const settings =
    applicationSettings.size > 0
      ? applicationSettings
      : pbxproj === undefined
        ? new Map<string, string[]>()
        : pbxprojSettings(pbxproj);
  const configurations = pbxproj === undefined ? [] : pbxprojConfigurations(pbxproj);

  const infoPlistPath = await findInfoPlist(fs, iosDir);
  const plistText = infoPlistPath === undefined ? undefined : await fs.readText(infoPlistPath);
  const plist = plistText === undefined ? undefined : parsePlist(plistText);

  if (infoPlistPath !== undefined && plistText !== undefined && plist === undefined) {
    warnings.push({
      code: 'INFO_PLIST_UNREADABLE',
      severity: 'warning',
      message: 'Info.plist could not be parsed; it may be malformed or in binary format.',
      file: infoPlistPath,
      remediation: 'Convert it to XML (`plutil -convert xml1`) or fix the malformed entry.',
    });
  }

  const resolve = makeResolver(infoPlistPath ?? '', settings, pbxprojPath, warnings);
  const stringValue = (key: string): Provenanced<string> | undefined => {
    const raw = plist?.[key];
    if (typeof raw !== 'string' || raw.trim() === '') return undefined;
    return resolve(raw, key);
  };

  // Xcode-only projects often keep identity solely in build settings.
  const fromSettings = (key: string, detail: string): Provenanced<string> | undefined => {
    const values = settings.get(key);
    return values?.[0] === undefined
      ? undefined
      : provenanced(values[0], 'inferred', pbxprojPath, detail);
  };

  const bundleId =
    stringValue('CFBundleIdentifier') ??
    fromSettings('PRODUCT_BUNDLE_IDENTIFIER', 'PRODUCT_BUNDLE_IDENTIFIER build setting');
  const marketingVersion =
    stringValue('CFBundleShortVersionString') ??
    fromSettings('MARKETING_VERSION', 'MARKETING_VERSION build setting');
  const buildNumber =
    stringValue('CFBundleVersion') ??
    fromSettings('CURRENT_PROJECT_VERSION', 'CURRENT_PROJECT_VERSION build setting');
  const displayName = stringValue('CFBundleDisplayName');
  const appName = stringValue('CFBundleName');

  const permissions: IosPermission[] = [];
  for (const [key, value] of Object.entries(plist ?? {})) {
    if (!/^NS.*UsageDescription$/.test(key)) continue;
    const description = typeof value === 'string' ? value.trim() : '';
    permissions.push({
      key,
      source: infoPlistPath as string,
      ...(description === ''
        ? {}
        : { usageDescription: provenanced(description, 'certain', infoPlistPath) }),
    });
    if (description === '') {
      warnings.push({
        code: 'MISSING_USAGE_DESCRIPTION',
        severity: 'error',
        message: `${key} is declared but its purpose string is empty. App Review rejects builds whose purpose strings are missing or generic.`,
        file: infoPlistPath as string,
        remediation: `Write a specific sentence in ${key} explaining why the app needs this access.`,
      });
    }
  }
  permissions.sort((a, b) => a.key.localeCompare(b.key));

  const entitlements: Entitlement[] = [];
  for (const path of await fs.find(/\.entitlements$/)) {
    if (!path.startsWith(prefix)) continue;
    const text = await fs.readText(path);
    if (text === undefined) continue;
    for (const entry of entitlementKeys(text)) {
      entitlements.push({
        key: entry.key,
        platform: 'ios',
        source: path,
        ...(entry.value === undefined ? {} : { value: entry.value }),
      });
    }
  }

  const schemes = (await fs.find(/xcshareddata\/xcschemes\/[^/]+\.xcscheme$/))
    .filter((path) => path.startsWith(prefix))
    .map((path) => (path.split('/').pop() as string).replace(/\.xcscheme$/, ''))
    .sort();

  const workspace = (await fs.list(iosDir)).find((name) => name.endsWith('.xcworkspace'));
  const project = (await fs.list(iosDir)).find((name) => name.endsWith('.xcodeproj'));
  const podfile = joinDir(iosDir, 'Podfile');
  const podfileText = await fs.readText(podfile);
  const pods = podfileText === undefined ? [] : extractPods(podfileText);

  const buildHints: IosBuildHints = {
    ...(workspace === undefined ? {} : { workspace: joinDir(iosDir, workspace) }),
    ...(project === undefined ? {} : { project: joinDir(iosDir, project) }),
    schemes,
    configurations,
    hasPodfile: podfileText !== undefined,
    ...(settings.get('IPHONEOS_DEPLOYMENT_TARGET')?.[0] === undefined
      ? {}
      : { deploymentTarget: settings.get('IPHONEOS_DEPLOYMENT_TARGET')?.[0] as string }),
  };

  if (bundleId === undefined) {
    warnings.push({
      code: 'MISSING_BUNDLE_ID',
      severity: 'error',
      message: 'No iOS bundle identifier could be determined from the project.',
      ...(infoPlistPath === undefined ? {} : { file: infoPlistPath }),
      remediation: 'Set the bundle identifier in Xcode, or declare it in the Agentship manifest.',
    });
  }

  return {
    iosDir,
    ...(infoPlistPath === undefined ? {} : { infoPlistPath }),
    ...(bundleId === undefined ? {} : { bundleId }),
    ...(displayName === undefined ? {} : { displayName }),
    ...(appName === undefined ? {} : { appName }),
    ...(marketingVersion === undefined ? {} : { marketingVersion }),
    ...(buildNumber === undefined ? {} : { buildNumber }),
    permissions,
    entitlements,
    buildHints,
    pods,
    warnings,
  };
}

/** Pod names declared in a Podfile, e.g. `pod 'FirebaseAnalytics', '~> 10.0'`. */
function extractPods(podfile: string): string[] {
  const names = new Set<string>();
  for (const match of podfile.matchAll(/^\s*pod\s+["']([^"']+)["']/gm)) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  return [...names].sort();
}
