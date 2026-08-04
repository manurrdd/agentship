import type { PendingOperation } from '@agentship/core';
import {
  AgentshipError,
  type AgentshipErrorCode,
  ERROR_CODES,
  type Remediation,
} from '@agentship/core';

/**
 * Turning thousands of lines of build output into one sentence and one instruction.
 *
 * A failed `xcodebuild` prints a wall of text in which the actual cause appears once. An
 * agent handed that wall will summarise it badly; an agent handed "no signing certificate,
 * and here is why" will relay it correctly. So the log goes to a file and only a
 * classification reaches the agent.
 *
 * Each rule states what the tool prints, what it means, and what the user does about it.
 * A pattern that does not match anything falls through to a generic failure with the last
 * meaningful lines of output — never to a guess.
 */
export interface DiagnosticRule {
  /** Stable id, so a rule can be asserted on in tests and cited in a report. */
  readonly id: string;
  readonly pattern: RegExp;
  readonly code: AgentshipErrorCode;
  /** Written for the user, not for the log. */
  readonly message: string;
  readonly remediation: Remediation;
  /**
   * Console work the user must do before this build can ever succeed. Emitted as a pending
   * operation, because "accept the agreements" is not something a retry fixes.
   */
  readonly pending?: Omit<PendingOperation, 'status'>;
}

const APPLE_AGREEMENTS_PENDING: Omit<PendingOperation, 'status'> = {
  id: 'apple:agreements-tax-banking',
  store: 'apple',
  category: 'agreements',
  title: 'Accept the Apple Developer Program agreements',
  reason:
    'Apple refuses to issue signing certificates and provisioning profiles until the Account Holder has accepted the current agreements. There is no API for accepting them.',
  actionClass: 'human_only',
  console: {
    url: 'https://developer.apple.com/account',
    path: ['Membership', 'Agreements'],
    lastVerified: '2026-08-03',
  },
  verification: { summary: 'The developer account shows no outstanding agreement.' },
};

/**
 * The failures that actually happen, in the order they should be tested.
 *
 * Order matters: a missing certificate also prints a generic "Command CodeSign failed", so
 * the specific rule has to win.
 */
export const BUILD_DIAGNOSTICS: readonly DiagnosticRule[] = [
  {
    id: 'apple.agreements',
    pattern:
      /you (?:must|need to) (?:accept|agree to).{0,60}(?:license|agreement)|updated (?:program )?license agreement|Agreements, Tax, and Banking/i,
    code: ERROR_CODES.BUILD_SIGNING_FAILED,
    message:
      'Apple will not issue signing assets until the current developer agreements are accepted.',
    remediation: {
      summary:
        'The Account Holder must accept the outstanding agreements at developer.apple.com, then the build can run again.',
      docsUrl: 'https://developer.apple.com/account',
    },
    pending: APPLE_AGREEMENTS_PENDING,
  },
  {
    id: 'apple.no-signing-certificate',
    pattern:
      /No signing certificate ["']?(?:iOS Distribution|Apple Distribution)|no valid signing identities|doesn'?t have valid signing/i,
    code: ERROR_CODES.BUILD_SIGNING_FAILED,
    message:
      'Xcode found no Apple Distribution certificate it could use, and could not have one issued.',
    remediation: {
      summary:
        'Check that the App Store Connect key has the App Manager role, that the team id is right, and that the certificate limit for the team has not been reached.',
      steps: [
        'Confirm the credential profile points at the intended team (agentship_setup_status).',
        'If the team already has the maximum number of distribution certificates, revoke an unused one in the Apple Developer portal.',
      ],
    },
  },
  {
    id: 'apple.no-profile',
    pattern:
      /No profiles for ['"][^'"]+['"] were found|doesn'?t match any applicable devices|provisioning profile.{0,40}(?:not found|doesn'?t (?:exist|include))/i,
    code: ERROR_CODES.BUILD_SIGNING_FAILED,
    message:
      'No provisioning profile matches this bundle identifier, and automatic signing could not create one.',
    remediation: {
      summary:
        'Register the bundle identifier in the Apple Developer portal (Certificates, Identifiers & Profiles → Identifiers), then build again.',
      docsUrl: 'https://developer.apple.com/account/resources/identifiers/list',
    },
  },
  {
    id: 'apple.entitlement-not-enabled',
    pattern:
      /capability .{0,60} is not (?:enabled|available)|entitlement .{0,60} (?:is not|isn'?t) (?:allowed|supported)/i,
    code: ERROR_CODES.BUILD_SIGNING_FAILED,
    message:
      'The app requests a capability that is not enabled for its identifier in the Apple Developer portal.',
    remediation: {
      summary:
        'Enable the capability on the App ID in the Apple Developer portal, then build again. Agentship will not change an app identifier’s capabilities.',
    },
  },
  {
    id: 'apple.scheme-not-found',
    pattern: /The (?:project|workspace) .{0,120} does not contain a scheme named/i,
    code: ERROR_CODES.BUILD_INPUT_REQUIRED,
    message: 'The configured scheme does not exist in this project.',
    remediation: {
      summary:
        'Set build.ios.scheme in .agentship/agentship.yaml to a scheme the project actually defines (xcodebuild -list shows them).',
    },
  },
  {
    id: 'apple.xcode-missing',
    pattern: /xcode-select: error|unable to find utility|Xcode\.app.{0,40}(?:not|cannot be) found/i,
    code: ERROR_CODES.BUILD_TOOL_MISSING,
    message: 'The command line tools point at no usable Xcode installation.',
    remediation: {
      summary:
        'Install Xcode from the App Store and run "sudo xcode-select -s /Applications/Xcode.app", then build again.',
    },
  },
  {
    id: 'apple.pods-missing',
    pattern: /The sandbox is not in sync with the Podfile\.lock|Podfile\.lock.{0,40}out of date/i,
    code: ERROR_CODES.BUILD_FAILED,
    message: 'The CocoaPods sandbox is out of sync with Podfile.lock.',
    remediation: {
      summary:
        'Run "pod install" in the iOS project directory and commit the result. Agentship does not install dependencies for you.',
    },
  },
  {
    id: 'android.jdk-incompatible',
    pattern:
      /Unsupported class file major version|invalid source release|Unsupported Java\.|requires Java \d+|Android Gradle plugin requires Java/i,
    code: ERROR_CODES.BUILD_TOOL_MISSING,
    message: 'The JDK on this machine is not the version this Gradle build requires.',
    remediation: {
      summary:
        'Install the JDK the project expects (Android Gradle Plugin 8.x needs JDK 17) and point JAVA_HOME at it.',
    },
  },
  {
    id: 'android.sdk-missing',
    pattern: /SDK location not found|ANDROID_HOME|Failed to install the following Android SDK/i,
    code: ERROR_CODES.BUILD_TOOL_MISSING,
    message: 'Gradle could not find the Android SDK.',
    remediation: {
      summary:
        'Install the Android SDK and set ANDROID_HOME (or write sdk.dir into local.properties in the repository).',
    },
  },
  {
    id: 'android.keystore-password',
    pattern:
      /Keystore was tampered with, or password was incorrect|failed to read key .{0,60} from store|Cannot recover key/i,
    code: ERROR_CODES.BUILD_SIGNING_FAILED,
    message: 'The stored keystore password or key alias does not open this keystore.',
    remediation: {
      summary:
        'Re-store the keystore passwords with agentship_configure_auth, or correct build.android.keystore.alias in the manifest.',
    },
  },
  {
    id: 'android.task-not-found',
    pattern: /Task '.*' not found in (?:root )?project|Cannot locate tasks that match/i,
    code: ERROR_CODES.BUILD_INPUT_REQUIRED,
    message: 'The Gradle task derived from the manifest does not exist in this project.',
    remediation: {
      summary:
        'Check build.android.module, build.android.flavor and build.android.buildType against what the project defines ("./gradlew tasks" lists them).',
    },
  },
  {
    id: 'flutter.sdk-missing',
    pattern: /Flutter SDK not found|flutter: command not found/i,
    code: ERROR_CODES.BUILD_TOOL_MISSING,
    message: 'The Flutter SDK is not installed, or not on PATH.',
    remediation: { summary: 'Install Flutter and make sure "flutter --version" works.' },
  },
  {
    id: 'generic.disk-full',
    pattern: /No space left on device|ENOSPC/i,
    code: ERROR_CODES.BUILD_FAILED,
    message: 'The build ran out of disk space.',
    remediation: { summary: 'Free disk space and build again; an archive needs several GB.' },
  },
];

export interface Diagnosis {
  readonly rule?: DiagnosticRule;
  readonly code: AgentshipErrorCode;
  readonly message: string;
  readonly remediation?: Remediation;
  readonly pending?: Omit<PendingOperation, 'status'>;
  /** The lines that justify the diagnosis, bounded and safe to show. */
  readonly evidence: readonly string[];
}

const NOISE =
  /^(?:note:|warning:|\s*$|ld: warning|objc\[|\[CP\]|> Task |Download |Downloading |Configure project)/i;

/** The last lines that look like a cause, for a failure no rule recognised. */
export function meaningfulTail(output: string, limit = 12): readonly string[] {
  const lines = output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '' && !NOISE.test(line));
  return lines.slice(-limit);
}

/**
 * Classifies a failed build.
 *
 * Both streams are searched because the tools disagree about where they print: `xcodebuild`
 * puts signing failures on stdout, Gradle puts almost everything on stderr.
 */
export function diagnose(output: string): Diagnosis {
  for (const rule of BUILD_DIAGNOSTICS) {
    const match = rule.pattern.exec(output);
    if (match === null) continue;
    return {
      rule,
      code: rule.code,
      message: rule.message,
      remediation: rule.remediation,
      ...(rule.pending === undefined ? {} : { pending: rule.pending }),
      evidence: evidenceAround(output, match.index),
    };
  }
  return {
    code: ERROR_CODES.BUILD_FAILED,
    message: 'The build tool failed and Agentship does not recognise the reason.',
    remediation: {
      summary:
        'Read the last lines of the build log (its path is in the error details) and fix the cause in the project; Agentship will not guess.',
    },
    evidence: meaningfulTail(output),
  };
}

function evidenceAround(output: string, index: number, radius = 2): readonly string[] {
  const before = output.slice(0, index).split('\n');
  const lineNumber = before.length - 1;
  const lines = output.split('\n');
  return lines
    .slice(Math.max(0, lineNumber - radius), lineNumber + radius + 1)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '');
}

/**
 * Builds the error a failed build throws, with the log path an agent can point at.
 *
 * When the diagnosis identifies console work — accepting the developer agreements, say —
 * the pending operation travels in `details.pendingOperation`, where the local runner picks
 * it up and emits it. A failure that no retry can fix should leave behind the thing that
 * would fix it.
 */
export function buildFailure(
  diagnosis: Diagnosis,
  details: Readonly<Record<string, unknown>>,
): AgentshipError {
  return new AgentshipError(diagnosis.code, diagnosis.message, {
    retryable: false,
    ...(diagnosis.remediation === undefined ? {} : { remediation: diagnosis.remediation }),
    details: {
      ...details,
      ...(diagnosis.rule === undefined ? {} : { diagnostic: diagnosis.rule.id }),
      ...(diagnosis.pending === undefined
        ? {}
        : { pendingOperation: { ...diagnosis.pending, status: 'open' as const } }),
      evidence: diagnosis.evidence,
    },
  });
}
