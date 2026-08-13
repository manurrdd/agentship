import { join } from 'node:path';
import type { AgentshipManifest } from '@agentship/core';
import { isNeedsInput, pathExists } from '@agentship/core';
import { findHostTool } from './host.js';
import type { BuilderId, BuildPlatform, BuildSupport } from './types.js';

/**
 * Which projects Agentship builds, and which it refuses to.
 *
 * The matrix is honest rather than generous. Every "supported" entry means Agentship runs the
 * project's own build system with the project's own configuration — `xcodebuild` on the
 * workspace that is checked in, the Gradle *wrapper* the repository ships, `flutter build`
 * from the Flutter SDK on the machine. It never rewrites the user's build files, never
 * installs a toolchain behind their back, and never substitutes a global `gradle` for a
 * missing wrapper: those would all produce an artifact the user cannot reproduce.
 *
 * | Project                    | iOS                  | Android              |
 * |----------------------------|----------------------|----------------------|
 * | iOS native                 | `xcodebuild`         | —                    |
 * | Android native             | —                    | `./gradlew`          |
 * | React Native               | `xcodebuild`         | `./gradlew`          |
 * | Flutter                    | `flutter build ipa`  | `flutter build appbundle` |
 * | Expo, native folders in    | `xcodebuild`         | `./gradlew`          |
 * | Expo managed, no native    | not built            | not built            |
 *
 * The last row is the one that matters. `expo prebuild` generates `ios/` and `android/`
 * from configuration, overwriting whatever is there; running it unattended can silently
 * discard work a user did in those folders. Agentship never runs it. An Expo managed project
 * gets two honest exits instead: run the prebuild yourself, or hand Agentship an artifact
 * built elsewhere (EAS, CI) through `release.artifacts`.
 */
export type ProjectFramework =
  | 'ios-native'
  | 'android-native'
  | 'react-native'
  | 'expo'
  | 'flutter';

export interface ProjectShape {
  readonly framework: ProjectFramework;
  /** Absolute directory of the app inside the repository. */
  readonly appDir: string;
  readonly hasIosProject: boolean;
  readonly hasAndroidProject: boolean;
  readonly hasGradleWrapper: boolean;
  /** Expo without `ios/` or `android/`: the one shape Agentship will not build. */
  readonly expoManaged: boolean;
}

/** Reads the repository to decide what kind of project this is. */
export async function detectProject(
  repoRoot: string,
  manifest: AgentshipManifest,
): Promise<ProjectShape> {
  const appDir = join(repoRoot, manifest.build?.appDir ?? '.');
  const [hasIos, hasAndroid, hasWrapper, hasPubspec, hasAppJson, hasReactNative] =
    await Promise.all([
      pathExists(join(appDir, 'ios')),
      pathExists(join(appDir, 'android')),
      pathExists(join(appDir, 'android', 'gradlew')),
      pathExists(join(appDir, 'pubspec.yaml')),
      pathExists(join(appDir, 'app.json')),
      pathExists(join(appDir, 'node_modules', 'react-native')),
    ]);

  const declared = manifest.build?.framework;
  // An iOS-only or Android-only repository has its project at the root, not under ios/.
  const rootIsXcode = !hasIos && (await pathExists(join(appDir, 'Podfile')));
  const framework: ProjectFramework =
    declared ??
    (hasPubspec
      ? 'flutter'
      : hasAppJson && !hasIos && !hasAndroid
        ? 'expo'
        : hasReactNative
          ? 'react-native'
          : hasIos || rootIsXcode
            ? 'ios-native'
            : 'android-native');

  return {
    framework,
    appDir,
    hasIosProject: hasIos || rootIsXcode,
    hasAndroidProject: hasAndroid || (framework === 'android-native' && !hasIos),
    hasGradleWrapper: hasWrapper || (await pathExists(join(appDir, 'gradlew'))),
    expoManaged: framework === 'expo' && !hasIos && !hasAndroid,
  };
}

/** The builder that would produce a platform's artifact for this project. */
export function builderFor(shape: ProjectShape, platform: BuildPlatform): BuilderId | undefined {
  if (shape.framework === 'flutter') {
    return platform === 'ios' ? 'flutter-ios' : 'flutter-android';
  }
  if (platform === 'ios')
    return shape.framework === 'android-native' ? undefined : 'ios-xcodebuild';
  return shape.framework === 'ios-native' ? undefined : 'android-gradle';
}

const EXPO_MANAGED_REMEDIATION =
  'Either run "npx expo prebuild" yourself and commit the native folders, or build with EAS/CI and point release.artifacts at the resulting file. Agentship never runs prebuild for you: it regenerates ios/ and android/ and can overwrite native changes.';

/**
 * Answers "could this build run right now, and if not, why", without running anything.
 *
 * This is what `agentship_doctor` reports and what the build differ consults before drafting
 * an action, so a user learns about a missing JDK while planning rather than ten minutes
 * into a release.
 */
export async function buildSupport(
  manifest: AgentshipManifest,
  shape: ProjectShape,
  platform: BuildPlatform,
): Promise<BuildSupport> {
  const builder = builderFor(shape, platform);
  if (builder === undefined) {
    return {
      builder: platform === 'ios' ? 'ios-xcodebuild' : 'android-gradle',
      platform,
      status: 'unsupported',
      detail: `This repository has no ${platform === 'ios' ? 'iOS' : 'Android'} project.`,
      remediation: `Remove the ${platform === 'ios' ? 'apple' : 'google'} store from the manifest, or add the native project.`,
    };
  }
  if (shape.expoManaged) {
    return {
      builder,
      platform,
      status: 'unsupported',
      detail:
        'This is an Expo managed project: it has no ios/ or android/ folder, so there is nothing to build locally.',
      remediation: EXPO_MANAGED_REMEDIATION,
    };
  }
  if (platform === 'ios' && process.platform !== 'darwin') {
    // What the manifest is missing is a fact about the manifest, so it is reported here too.
    // This machine cannot archive an iPhone app, but the user can still be told that
    // `release.buildNumber` is absent — and told the value their own `pubspec.yaml` already
    // states. Withholding that until someone opens a Mac helps nobody.
    const missingHere = missingBuildInput(manifest, shape, platform);
    return {
      builder,
      platform,
      status: 'host_unsupported',
      detail: `iOS applications can only be archived and signed on macOS; this machine runs ${process.platform}.`,
      ...(missingHere.length === 0 ? {} : { needsInput: missingHere }),
      remediation:
        'Build the .ipa on a Mac (or a macOS CI runner) and point release.artifacts.apple at it; everything else Agentship does works from here.',
    };
  }

  const missingInput = missingBuildInput(manifest, shape, platform);
  if (missingInput.length > 0) {
    return {
      builder,
      platform,
      status: 'needs_input',
      detail: `The manifest does not say ${missingInput.join(' or ')}.`,
      needsInput: missingInput,
      remediation: `Fill in ${missingInput.join(' and ')} in .agentship/agentship.yaml.`,
    };
  }

  const tool = await missingTool(builder, shape);
  if (tool !== undefined) {
    return {
      builder,
      platform,
      status: 'tool_missing',
      detail: tool.detail,
      remediation: tool.remediation,
    };
  }

  return { builder, platform, status: 'supported', detail: `${builder} can build this project.` };
}

/** Manifest paths this builder needs and does not have. */
function missingBuildInput(
  manifest: AgentshipManifest,
  shape: ProjectShape,
  platform: BuildPlatform,
): readonly string[] {
  const missing: string[] = [];
  if (platform === 'ios' && shape.framework !== 'flutter') {
    const scheme = manifest.build?.ios?.scheme;
    if (scheme === undefined || isNeedsInput(scheme)) missing.push('build.ios.scheme');
  }
  if (isNeedsInput(manifest.release.version)) missing.push('release.version');
  if (manifest.release.buildNumber === undefined || isNeedsInput(manifest.release.buildNumber)) {
    missing.push('release.buildNumber');
  }
  return missing;
}

interface MissingTool {
  readonly detail: string;
  readonly remediation: string;
}

async function missingTool(
  builder: BuilderId,
  shape: ProjectShape,
): Promise<MissingTool | undefined> {
  if (builder === 'ios-xcodebuild') {
    return (await findHostTool('xcodebuild')) === undefined
      ? {
          detail: 'xcodebuild is not available on this machine.',
          remediation:
            'Install Xcode from the App Store, then run "sudo xcode-select -s /Applications/Xcode.app".',
        }
      : undefined;
  }
  if (builder === 'android-gradle') {
    if (!shape.hasGradleWrapper) {
      return {
        detail: 'The repository has no Gradle wrapper (android/gradlew).',
        remediation:
          'Commit the Gradle wrapper the project was created with. Agentship will not fall back to a globally installed gradle: it would build with a different version than the project expects.',
      };
    }
    return (await findHostTool('java')) === undefined
      ? {
          detail: 'No JDK was found on this machine.',
          remediation:
            'Install a JDK (17 for Android Gradle Plugin 8.x) and point JAVA_HOME at it.',
        }
      : undefined;
  }
  if ((await findHostTool('flutter')) === undefined) {
    return {
      detail: 'The Flutter SDK is not on PATH.',
      remediation: 'Install Flutter and make sure "flutter --version" works.',
    };
  }
  if (builder === 'flutter-ios' && (await findHostTool('xcodebuild')) === undefined) {
    return {
      detail: 'Flutter needs Xcode to produce an .ipa, and xcodebuild is not available.',
      remediation: 'Install Xcode from the App Store, then run "sudo xcode-select -s".',
    };
  }
  return undefined;
}
