import type { AnalysisWarning, Framework, Provenanced } from '@agentship/core';
import { provenanced } from '@agentship/core';
import { parseYaml } from './parsers.js';
import type { RepoFs } from './repo-fs.js';

/**
 * Extraction from the framework's own manifest — `pubspec.yaml`, `package.json`, `app.json`.
 *
 * For Flutter and Expo this is where identity and version really live: the native files are
 * generated from it. For bare React Native it only carries the package name and version,
 * while identity stays in the native projects.
 *
 * A dynamic Expo config (`app.config.js`/`.ts`) is deliberately *not* evaluated — running
 * repository code is outside the analyzer's trust model — and produces a warning instead.
 */

export interface ProjectExtraction {
  readonly appName?: Provenanced<string>;
  readonly displayName?: Provenanced<string>;
  readonly bundleId?: Provenanced<string>;
  readonly packageName?: Provenanced<string>;
  readonly marketingVersion?: Provenanced<string>;
  readonly buildNumber?: Provenanced<string>;
  readonly versionName?: Provenanced<string>;
  readonly versionCode?: Provenanced<number>;
  readonly npmDependencies: readonly string[];
  readonly pubDependencies: readonly string[];
  readonly warnings: readonly AnalysisWarning[];
}

interface PackageJson {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

interface ExpoConfig {
  readonly name?: string;
  readonly slug?: string;
  readonly version?: string;
  readonly ios?: { bundleIdentifier?: string; buildNumber?: string };
  readonly android?: { package?: string; versionCode?: number };
}

interface Pubspec {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Record<string, unknown>;
  readonly dev_dependencies?: Record<string, unknown>;
}

function joinDir(dir: string, file: string): string {
  return dir === '.' ? file : `${dir}/${file}`;
}

export async function extractProject(
  fs: RepoFs,
  appDir: string,
  framework: Framework,
): Promise<ProjectExtraction> {
  const warnings: AnalysisWarning[] = [];
  let result: ProjectExtraction = { npmDependencies: [], pubDependencies: [], warnings: [] };

  const pubspecPath = joinDir(appDir, 'pubspec.yaml');
  const pubspecText = await fs.readText(pubspecPath);
  if (pubspecText !== undefined) {
    const pubspec = parseYaml(pubspecText) as Pubspec | undefined;
    if (pubspec === undefined) {
      warnings.push({
        code: 'PUBSPEC_UNREADABLE',
        severity: 'warning',
        message: 'pubspec.yaml could not be parsed; Flutter identity and versions are unknown.',
        file: pubspecPath,
        remediation: 'Fix the YAML syntax error reported by `flutter pub get`.',
      });
    } else {
      const versions = splitFlutterVersion(pubspec.version);
      result = {
        ...result,
        ...(pubspec.name === undefined
          ? {}
          : { appName: provenanced(pubspec.name, 'certain', pubspecPath, 'name in pubspec.yaml') }),
        ...(versions.marketing === undefined
          ? {}
          : {
              marketingVersion: provenanced(
                versions.marketing,
                'certain',
                pubspecPath,
                'version in pubspec.yaml',
              ),
              versionName: provenanced(versions.marketing, 'certain', pubspecPath),
            }),
        ...(versions.build === undefined
          ? {}
          : {
              buildNumber: provenanced(
                versions.build,
                'certain',
                pubspecPath,
                'build number after + in the pubspec version',
              ),
              versionCode: provenanced(Number.parseInt(versions.build, 10), 'certain', pubspecPath),
            }),
        pubDependencies: [
          ...Object.keys(pubspec.dependencies ?? {}),
          ...Object.keys(pubspec.dev_dependencies ?? {}),
        ],
      };
    }
  }

  const packageJsonPath = joinDir(appDir, 'package.json');
  const packageJson = await fs.readJson<PackageJson>(packageJsonPath);
  if (packageJson !== undefined) {
    result = {
      ...result,
      ...(result.appName === undefined && packageJson.name !== undefined
        ? {
            appName: provenanced(
              packageJson.name,
              'inferred',
              packageJsonPath,
              'name in package.json, which is the project name rather than the store name',
            ),
          }
        : {}),
      npmDependencies: [
        ...Object.keys(packageJson.dependencies ?? {}),
        ...Object.keys(packageJson.devDependencies ?? {}),
      ],
    };
  }

  if (framework === 'expo') {
    const appJsonPath = joinDir(appDir, 'app.json');
    const appJson = await fs.readJson<{ expo?: ExpoConfig }>(appJsonPath);
    const expo = appJson?.expo;
    if (expo !== undefined) {
      result = {
        ...result,
        ...(expo.name === undefined
          ? {}
          : {
              displayName: provenanced(expo.name, 'certain', appJsonPath, 'expo.name in app.json'),
            }),
        ...(expo.version === undefined
          ? {}
          : {
              marketingVersion: provenanced(expo.version, 'certain', appJsonPath, 'expo.version'),
              versionName: provenanced(expo.version, 'certain', appJsonPath, 'expo.version'),
            }),
        ...(expo.ios?.bundleIdentifier === undefined
          ? {}
          : {
              bundleId: provenanced(
                expo.ios.bundleIdentifier,
                'certain',
                appJsonPath,
                'expo.ios.bundleIdentifier',
              ),
            }),
        ...(expo.android?.package === undefined
          ? {}
          : {
              packageName: provenanced(
                expo.android.package,
                'certain',
                appJsonPath,
                'expo.android.package',
              ),
            }),
        ...(expo.ios?.buildNumber === undefined
          ? {}
          : { buildNumber: provenanced(expo.ios.buildNumber, 'certain', appJsonPath) }),
        ...(expo.android?.versionCode === undefined
          ? {}
          : { versionCode: provenanced(expo.android.versionCode, 'certain', appJsonPath) }),
      };

      if (expo.ios?.bundleIdentifier === undefined || expo.android?.package === undefined) {
        warnings.push({
          code: 'EXPO_IDENTIFIERS_MISSING',
          severity: 'error',
          message:
            'The Expo config does not declare both expo.ios.bundleIdentifier and expo.android.package, which are required to build for the stores.',
          file: appJsonPath,
          remediation: 'Add both identifiers to app.json before the first build.',
        });
      }
    }

    const dynamicConfig = await fs.firstExisting([
      joinDir(appDir, 'app.config.ts'),
      joinDir(appDir, 'app.config.js'),
    ]);
    if (dynamicConfig !== undefined) {
      warnings.push({
        code: 'DYNAMIC_EXPO_CONFIG',
        severity: 'warning',
        message: `${dynamicConfig} is a dynamic Expo config. Agentship never executes repository code, so any value defined only there is not visible to this analysis.`,
        file: dynamicConfig,
        remediation:
          'Run `npx expo config --json` yourself and provide the resulting values, or move the static ones to app.json.',
      });
    }
  }

  return { ...result, warnings };
}

/** Flutter encodes both versions in one string: `1.2.3+45`. */
function splitFlutterVersion(version: string | undefined): {
  marketing?: string;
  build?: string;
} {
  if (version === undefined) return {};
  const [marketing, build] = version.split('+');
  return {
    ...(marketing === undefined || marketing === '' ? {} : { marketing }),
    ...(build === undefined || !/^\d+$/.test(build) ? {} : { build }),
  };
}
