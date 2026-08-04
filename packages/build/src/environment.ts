import { findHostTool, runHostTool } from './host.js';

/**
 * What `doctor` reports about the build environment.
 *
 * These tools belong to the user, not to Agentship: it neither installs nor pins Xcode, a JDK
 * or the Flutter SDK. So the checks are informational by design — a machine with no Flutter
 * SDK is perfectly healthy for someone shipping a native iOS app — and each one says what
 * it enables rather than demanding it be fixed.
 *
 * The one hard statement is platform: an `.ipa` cannot be produced outside macOS by any
 * arrangement of tools, and pretending otherwise would waste a user's afternoon.
 */
export type BuildCheckStatus = 'ok' | 'warn' | 'unavailable';

export interface BuildEnvironmentCheck {
  readonly id: string;
  readonly title: string;
  readonly status: BuildCheckStatus;
  readonly detail: string;
  /** Version string the tool reported, when it ran. */
  readonly version?: string;
  readonly remediation?: string;
}

async function probe(
  name: string,
  args: readonly string[],
): Promise<{ path: string; version: string } | undefined> {
  const path = await findHostTool(name);
  if (path === undefined) return undefined;
  const result = await runHostTool(path, {
    args,
    cwd: process.cwd(),
    timeoutMs: 60_000,
    toolName: name,
  }).catch(() => undefined);
  if (result === undefined || result.exitCode !== 0) return { path, version: 'unknown' };
  return {
    path,
    version: (result.stdout.split('\n').find((line) => line.trim() !== '') ?? 'unknown').trim(),
  };
}

export async function buildEnvironmentChecks(): Promise<readonly BuildEnvironmentCheck[]> {
  const checks: BuildEnvironmentCheck[] = [];

  if (process.platform === 'darwin') {
    const xcode = await probe('xcodebuild', ['-version']);
    checks.push(
      xcode === undefined
        ? {
            id: 'build:xcode',
            title: 'Xcode (iOS builds)',
            status: 'unavailable',
            detail: 'xcodebuild is not on PATH, so Agentship cannot build an .ipa here.',
            remediation:
              'Install Xcode from the App Store, then run "sudo xcode-select -s /Applications/Xcode.app".',
          }
        : {
            id: 'build:xcode',
            title: 'Xcode (iOS builds)',
            status: 'ok',
            detail: `iOS builds are available (${xcode.version}).`,
            version: xcode.version,
          },
    );
    // An Xcode without an installed iOS platform archives nothing, and says so late.
    if (xcode !== undefined) {
      const platforms = await runHostTool(xcode.path, {
        args: ['-showsdks'],
        cwd: process.cwd(),
        timeoutMs: 60_000,
        toolName: 'xcodebuild',
      }).catch(() => undefined);
      const hasIos = platforms !== undefined && /iphoneos\d/i.test(platforms.stdout);
      if (!hasIos) {
        checks.push({
          id: 'build:ios-platform',
          title: 'iOS platform SDK',
          status: 'unavailable',
          detail: 'Xcode is installed but reports no iOS SDK.',
          remediation:
            'Install the iOS platform: "xcodebuild -downloadPlatform iOS", or open Xcode once and let it finish installing components.',
        });
      }
    }
  } else {
    checks.push({
      id: 'build:xcode',
      title: 'Xcode (iOS builds)',
      status: 'unavailable',
      detail: `iOS applications can only be built on macOS; this machine runs ${process.platform}.`,
      remediation:
        'Build the .ipa elsewhere and point release.artifacts.apple at it. Everything else Agentship does works from here.',
    });
  }

  const java = await probe('java', ['-version']);
  checks.push(
    java === undefined
      ? {
          id: 'build:jdk',
          title: 'JDK (Android builds)',
          status: 'unavailable',
          detail: 'No JDK is on PATH, so Gradle cannot run.',
          remediation:
            'Install a JDK (17 for Android Gradle Plugin 8.x) and point JAVA_HOME at it.',
        }
      : {
          id: 'build:jdk',
          title: 'JDK (Android builds)',
          status: 'ok',
          // `java -version` prints to stderr on older JDKs, so "unknown" is common and fine.
          detail: `Android builds can run (${java.version}).`,
          version: java.version,
        },
  );

  const flutter = await probe('flutter', ['--version']);
  checks.push(
    flutter === undefined
      ? {
          id: 'build:flutter',
          title: 'Flutter SDK',
          status: 'warn',
          detail: 'The Flutter SDK is not installed; only needed for Flutter projects.',
          remediation: 'Install Flutter if this repository is a Flutter app.',
        }
      : {
          id: 'build:flutter',
          title: 'Flutter SDK',
          status: 'ok',
          detail: `Flutter builds are available (${flutter.version}).`,
          version: flutter.version,
        },
  );

  return checks;
}
