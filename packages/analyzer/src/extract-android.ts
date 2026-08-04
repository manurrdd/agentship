import type {
  AnalysisWarning,
  AndroidBuildHints,
  AndroidPermission,
  Entitlement,
  Provenanced,
} from '@agentship/core';
import { provenanced } from '@agentship/core';
import {
  blockChildNames,
  extractBlock,
  gradleDependencies,
  gradleNumber,
  gradleValue,
  stripComments,
  xmlElements,
} from './parsers.js';
import type { RepoFs } from './repo-fs.js';

/**
 * Extraction from the Android side of a project.
 *
 * Gradle build scripts are programs, and the analyzer never runs them. What it does is read
 * the literal assignments that the overwhelming majority of app modules actually use, and
 * report nothing when a value comes from a variable, a version catalog or a function call —
 * `unknown` is a usable answer for an agent, a wrong `applicationId` is not.
 */

export interface AndroidExtraction {
  readonly androidDir: string;
  readonly moduleDir: string;
  readonly buildGradlePath?: string;
  readonly manifestPath?: string;
  readonly packageName?: Provenanced<string>;
  readonly appName?: Provenanced<string>;
  readonly versionName?: Provenanced<string>;
  readonly versionCode?: Provenanced<number>;
  readonly permissions: readonly AndroidPermission[];
  readonly features: readonly Entitlement[];
  readonly buildHints: AndroidBuildHints;
  readonly dependencies: readonly string[];
  readonly warnings: readonly AnalysisWarning[];
}

function joinDir(dir: string, file: string): string {
  return dir === '.' ? file : `${dir}/${file}`;
}

async function findAndroidDir(fs: RepoFs, appDir: string): Promise<string | undefined> {
  const nested = joinDir(appDir, 'android');
  if (await fs.isDirectory(nested)) return nested;
  const settings = await fs.firstExisting([
    joinDir(appDir, 'settings.gradle'),
    joinDir(appDir, 'settings.gradle.kts'),
  ]);
  return settings === undefined ? undefined : appDir;
}

/** Finds the Gradle module that applies the application plugin. */
async function findAppModule(
  fs: RepoFs,
  androidDir: string,
): Promise<{ moduleDir: string; buildGradlePath: string } | undefined> {
  const candidates: string[] = ['app'];
  for (const name of await fs.list(androidDir)) {
    if (name !== 'app' && (await fs.isDirectory(joinDir(androidDir, name)))) candidates.push(name);
  }
  for (const module of candidates) {
    const moduleDir = joinDir(androidDir, module);
    const buildGradlePath = await fs.firstExisting([
      joinDir(moduleDir, 'build.gradle'),
      joinDir(moduleDir, 'build.gradle.kts'),
    ]);
    if (buildGradlePath === undefined) continue;
    const text = await fs.readText(buildGradlePath);
    if (text === undefined) continue;
    if (/com\.android\.application/.test(text)) return { moduleDir, buildGradlePath };
  }
  return undefined;
}

export async function extractAndroid(
  fs: RepoFs,
  appDir: string,
): Promise<AndroidExtraction | undefined> {
  const androidDir = await findAndroidDir(fs, appDir);
  if (androidDir === undefined) return undefined;

  const warnings: AnalysisWarning[] = [];
  const module = await findAppModule(fs, androidDir);
  const moduleDir = module?.moduleDir ?? joinDir(androidDir, 'app');
  const buildGradlePath = module?.buildGradlePath;
  const rawGradle = buildGradlePath === undefined ? undefined : await fs.readText(buildGradlePath);
  const gradle = rawGradle === undefined ? undefined : stripComments(rawGradle);

  const defaultConfig = gradle === undefined ? undefined : extractBlock(gradle, 'defaultConfig');
  const searchIn = defaultConfig ?? gradle ?? '';

  const applicationId =
    gradleValue(searchIn, 'applicationId') ?? gradleValue(gradle ?? '', 'namespace');
  const versionName = gradleValue(searchIn, 'versionName');
  const versionCode = gradleNumber(searchIn, 'versionCode');

  const packageName =
    applicationId === undefined
      ? undefined
      : provenanced(
          applicationId,
          'certain',
          buildGradlePath,
          gradleValue(searchIn, 'applicationId') === undefined
            ? 'namespace in the application module'
            : 'applicationId in defaultConfig',
        );

  if (packageName === undefined && buildGradlePath !== undefined) {
    warnings.push({
      code: 'MISSING_APPLICATION_ID',
      severity: 'error',
      message:
        'No literal applicationId was found in the application module. It may be computed at build time.',
      file: buildGradlePath,
      remediation:
        'Declare the application id in the Agentship manifest, or set it as a literal in defaultConfig.',
    });
  }
  if (versionCode === undefined && buildGradlePath !== undefined) {
    warnings.push({
      code: 'MISSING_VERSION_CODE',
      severity: 'warning',
      message:
        'No literal versionCode was found. Google Play rejects an upload whose version code is not higher than the last one.',
      file: buildGradlePath,
      remediation:
        'Let Agentship set the version code at build time, or declare it in the manifest.',
    });
  }

  const manifestPath = await fs.firstExisting([
    joinDir(moduleDir, 'src/main/AndroidManifest.xml'),
    joinDir(moduleDir, 'AndroidManifest.xml'),
    joinDir(androidDir, 'src/main/AndroidManifest.xml'),
  ]);
  const manifest = manifestPath === undefined ? undefined : await fs.readText(manifestPath);

  const permissions: AndroidPermission[] = [];
  const features: Entitlement[] = [];
  let appName: Provenanced<string> | undefined;

  if (manifest !== undefined && manifestPath !== undefined) {
    for (const element of xmlElements(manifest, 'uses-permission')) {
      const name = element.attributes['android:name'];
      if (name === undefined) continue;
      const maxSdk = element.attributes['android:maxSdkVersion'];
      permissions.push({
        name,
        source: manifestPath,
        ...(maxSdk === undefined ? {} : { maxSdkVersion: Number.parseInt(maxSdk, 10) }),
      });
    }
    for (const element of xmlElements(manifest, 'uses-feature')) {
      const name = element.attributes['android:name'];
      if (name !== undefined)
        features.push({ key: name, platform: 'android', source: manifestPath });
    }
    const label = xmlElements(manifest, 'application')[0]?.attributes['android:label'];
    if (label !== undefined && !label.startsWith('@')) {
      appName = provenanced(label, 'certain', manifestPath, 'android:label in AndroidManifest.xml');
    } else if (label !== undefined) {
      // `@string/app_name` — resolve it from the default strings resource.
      const resolved = await resolveStringResource(fs, moduleDir, label);
      if (resolved !== undefined) {
        appName = provenanced(
          resolved.value,
          'inferred',
          resolved.file,
          `android:label resolves to ${label}`,
        );
      }
    }
    const legacyPackage = xmlElements(manifest, 'manifest')[0]?.attributes['package'];
    if (legacyPackage !== undefined) {
      warnings.push({
        code: 'MANIFEST_PACKAGE_ATTRIBUTE',
        severity: 'info',
        message:
          'AndroidManifest.xml still declares a package attribute; the Android Gradle plugin expects namespace in build.gradle instead.',
        file: manifestPath,
        remediation: 'Move the value to `namespace` in the module build script.',
      });
    }
  }
  permissions.sort((a, b) => a.name.localeCompare(b.name));

  const flavors =
    gradle === undefined ? [] : blockChildNames(extractBlock(gradle, 'productFlavors') ?? '');
  const buildTypes =
    gradle === undefined ? [] : blockChildNames(extractBlock(gradle, 'buildTypes') ?? '');
  const dependencies =
    gradle === undefined
      ? []
      : [
          ...new Set(
            gradleDependencies(extractBlock(gradle, 'dependencies') ?? '').map((d) => d.coordinate),
          ),
        ];

  const buildHints: AndroidBuildHints = {
    ...(module === undefined ? {} : { module: moduleDir.split('/').pop() as string }),
    flavors,
    buildTypes: buildTypes.length > 0 ? buildTypes : ['debug', 'release'],
    hasGradleWrapper: await fs.exists(joinDir(androidDir, 'gradlew')),
    ...numberIf('compileSdk', sdkLevel(gradle ?? '', 'compileSdk')),
    ...numberIf('targetSdk', sdkLevel(searchIn, 'targetSdk')),
    ...numberIf('minSdk', sdkLevel(searchIn, 'minSdk')),
  };

  return {
    androidDir,
    moduleDir,
    ...(buildGradlePath === undefined ? {} : { buildGradlePath }),
    ...(manifestPath === undefined ? {} : { manifestPath }),
    ...(packageName === undefined ? {} : { packageName }),
    ...(appName === undefined ? {} : { appName }),
    ...(versionName === undefined
      ? {}
      : {
          versionName: provenanced(
            versionName,
            'certain',
            buildGradlePath,
            'versionName in defaultConfig',
          ),
        }),
    ...(versionCode === undefined
      ? {}
      : {
          versionCode: provenanced(
            versionCode,
            'certain',
            buildGradlePath,
            'versionCode in defaultConfig',
          ),
        }),
    permissions,
    features,
    buildHints,
    dependencies,
    warnings,
  };
}

/**
 * Reads an SDK level under either spelling: the Android Gradle plugin renamed
 * `targetSdkVersion` to `targetSdk` (and likewise for min and compile), and both spellings
 * are still in wide use.
 */
function sdkLevel(source: string, key: 'compileSdk' | 'targetSdk' | 'minSdk'): number | undefined {
  return gradleNumber(source, key) ?? gradleNumber(source, `${key}Version`);
}

function numberIf<K extends string>(key: K, value: number | undefined): Partial<Record<K, number>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, number>);
}

/** Resolves `@string/app_name` against the module's default strings resource. */
async function resolveStringResource(
  fs: RepoFs,
  moduleDir: string,
  reference: string,
): Promise<{ value: string; file: string } | undefined> {
  const name = reference.replace(/^@string\//, '');
  if (name === reference) return undefined;
  const file = joinDir(moduleDir, 'src/main/res/values/strings.xml');
  const text = await fs.readText(file);
  if (text === undefined) return undefined;
  // `name` comes from the repository's own `android:label`, so it must be escaped before it
  // is spliced into a pattern: an unescaped value (`@string/((((.*)*)*)*)!`) is both a regex
  // injection and a catastrophic-backtracking pattern run against the repo's `strings.xml`.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<string[^>]*name="${escaped}"[^>]*>([^<]*)</string>`).exec(text);
  return match?.[1] === undefined ? undefined : { value: match[1].trim(), file };
}
