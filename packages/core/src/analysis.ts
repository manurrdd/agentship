import { z } from 'zod';
import type { Provenanced } from './types.js';

/**
 * Result contract of `@agentship/analyzer`.
 *
 * It lives in core because the kernel and the MCP layer consume it
 * without depending on the analyzer implementation. Two invariants shape every field:
 *
 * 1. Anything that could end up visible in a store carries {@link Provenanced} metadata,
 *    so an agent can tell "read from Info.plist" from "guessed from the folder name".
 * 2. What cannot be determined is absent. The analyzer never invents identifiers,
 *    versions or names.
 */
export const APP_ANALYSIS_VERSION = 1;

export type Framework =
  | 'flutter'
  | 'react-native'
  | 'expo'
  | 'ios-native'
  | 'android-native'
  | 'unknown';

/** Expo projects behave differently depending on whether native folders are checked in. */
export type ExpoWorkflow = 'managed' | 'prebuild';

export type Platform = 'ios' | 'android';

/** A concrete file-level fact that supports a conclusion. */
export interface Evidence {
  /** Repo-relative path. */
  readonly file: string;
  /** What was found there, e.g. "pubspec.yaml declares the flutter SDK dependency". */
  readonly note: string;
}

export interface FrameworkDetection {
  readonly framework: Framework;
  readonly confidence: Provenanced<Framework>['confidence'];
  readonly evidence: readonly Evidence[];
  /** Only for Expo projects. */
  readonly expoWorkflow?: ExpoWorkflow;
  /** Frameworks that also matched, with their score, so ambiguity stays visible. */
  readonly runnerUps?: readonly { readonly framework: Framework; readonly score: number }[];
}

export interface AppIdentity {
  /** Apple bundle identifier, e.g. `com.example.app`. */
  readonly bundleId?: Provenanced<string>;
  /** Android application id, e.g. `com.example.app`. */
  readonly packageName?: Provenanced<string>;
  /** Name shown under the icon. */
  readonly displayName?: Provenanced<string>;
  /** Project/product name, not necessarily the store name. */
  readonly appName?: Provenanced<string>;
}

export interface VersionInfo {
  /** iOS `CFBundleShortVersionString`, e.g. `1.4.0`. */
  readonly marketingVersion?: Provenanced<string>;
  /** iOS `CFBundleVersion`. */
  readonly buildNumber?: Provenanced<string>;
  /** Android `versionName`. */
  readonly versionName?: Provenanced<string>;
  /** Android `versionCode`. */
  readonly versionCode?: Provenanced<number>;
}

export type SdkCategory =
  | 'purchases'
  | 'ads'
  | 'analytics'
  | 'tracking'
  | 'push'
  | 'crash'
  | 'auth'
  | 'storage'
  | 'maps'
  | 'media'
  | 'support'
  | 'other';

export interface DetectedSdk {
  /** Stable catalog id, e.g. `revenuecat`. */
  readonly id: string;
  readonly name: string;
  readonly categories: readonly SdkCategory[];
  /** Version string when the dependency declaration exposes one. */
  readonly version?: string;
  readonly evidence: readonly Evidence[];
  /** Why it matters for publishing, e.g. "requires IAP products configured in the store". */
  readonly implications?: readonly string[];
}

export interface IosPermission {
  /** Info.plist key, e.g. `NSCameraUsageDescription`. */
  readonly key: string;
  /** The purpose string, when present. Both stores reject missing ones. */
  readonly usageDescription?: Provenanced<string>;
  readonly source: string;
}

export interface AndroidPermission {
  /** Fully qualified name, e.g. `android.permission.CAMERA`. */
  readonly name: string;
  readonly maxSdkVersion?: number;
  readonly source: string;
}

export interface Entitlement {
  /** Entitlement key or Android feature, e.g. `com.apple.developer.applesignin`. */
  readonly key: string;
  readonly value?: string;
  readonly platform: Platform;
  readonly source: string;
}

/**
 * Categories aligned with what both stores ask about (Apple App Privacy / Google Data
 * Safety). Agentship proposes; the user declares.
 */
export type PrivacyDataType =
  | 'contact_info'
  | 'identifiers'
  | 'usage_data'
  | 'diagnostics'
  | 'purchases'
  | 'location'
  | 'user_content'
  | 'contacts'
  | 'search_history'
  | 'browsing_history'
  | 'financial_info'
  | 'health'
  | 'sensitive_info'
  | 'other';

export interface PrivacySignal {
  readonly dataType: PrivacyDataType;
  /** Why the analyzer believes this data may be collected. */
  readonly reason: string;
  /** Catalog ids of the SDKs that triggered the signal. */
  readonly sdkIds: readonly string[];
  readonly confidence: Provenanced<unknown>['confidence'];
  readonly evidence: readonly Evidence[];
}

export interface ImageAsset {
  readonly path: string;
  readonly width?: number;
  readonly height?: number;
  readonly bytes: number;
}

export interface AssetInventory {
  readonly appIcons: readonly ImageAsset[];
  /** Existing store screenshots found in conventional locations. */
  readonly screenshots: readonly (ImageAsset & { readonly platform?: Platform })[];
  /** Store listing text files found in conventional locations (fastlane, triple-t). */
  readonly listingFiles: readonly string[];
}

export interface IosBuildHints {
  readonly workspace?: string;
  readonly project?: string;
  readonly schemes: readonly string[];
  readonly configurations: readonly string[];
  readonly hasPodfile: boolean;
  readonly deploymentTarget?: string;
}

export interface AndroidBuildHints {
  /** Gradle module that produces the app, e.g. `app`. */
  readonly module?: string;
  readonly flavors: readonly string[];
  readonly buildTypes: readonly string[];
  readonly hasGradleWrapper: boolean;
  readonly compileSdk?: number;
  readonly targetSdk?: number;
  readonly minSdk?: number;
}

export interface BuildHints {
  readonly ios?: IosBuildHints;
  readonly android?: AndroidBuildHints;
  /** npm/yarn/pnpm/bun, when the project is JavaScript based. */
  readonly packageManager?: string;
  /** Repo-relative path of the app inside a monorepo, `.` when it is the repo root. */
  readonly appDir: string;
}

export type WarningSeverity = 'info' | 'warning' | 'error';

export interface AnalysisWarning {
  /** Stable code so agents can react programmatically, e.g. `MISSING_USAGE_DESCRIPTION`. */
  readonly code: string;
  readonly severity: WarningSeverity;
  readonly message: string;
  readonly file?: string;
  /** What to do about it, phrased for an agent to relay. */
  readonly remediation?: string;
}

/** Bookkeeping about the scan itself, so limits never look like absence of data. */
export interface ScanStats {
  readonly filesScanned: number;
  readonly directoriesScanned: number;
  /** True when a size/depth/count limit stopped the traversal early. */
  readonly truncated: boolean;
  readonly durationMs: number;
}

export interface AppAnalysis {
  readonly schemaVersion: typeof APP_ANALYSIS_VERSION;
  readonly analyzedAt: string;
  /** Absolute path that was analyzed. */
  readonly root: string;
  readonly framework: FrameworkDetection;
  readonly platforms: readonly Platform[];
  readonly identity: AppIdentity;
  readonly versions: VersionInfo;
  readonly sdks: readonly DetectedSdk[];
  readonly permissions: {
    readonly ios: readonly IosPermission[];
    readonly android: readonly AndroidPermission[];
  };
  readonly entitlements: readonly Entitlement[];
  readonly privacySignals: readonly PrivacySignal[];
  readonly assets: AssetInventory;
  readonly buildHints: BuildHints;
  readonly warnings: readonly AnalysisWarning[];
  readonly stats: ScanStats;
}

/**
 * Structural guard for a persisted analysis read back from `.agentship/state/analysis.json`.
 *
 * The kernel treats a stored analysis as optional and possibly stale, and the file is
 * project-local. This schema is what makes "corrupt analysis only ever adds warnings" true:
 * it enforces exactly the containers consumers iterate — the arrays and nested arrays whose
 * wrong type would throw during `plan` (`privacySignals[].sdkIds`, `sdks[].categories`,
 * `permissions.ios`, `platforms`) — while every object is loose so the many unmodelled fields
 * (evidence, provenance, names) survive validation untouched. A file that fails it is dropped
 * as "no analysis", never trusted and never fatal.
 */
export const AppAnalysisSchema = z.looseObject({
  schemaVersion: z.literal(APP_ANALYSIS_VERSION),
  platforms: z.array(z.string()),
  framework: z.looseObject({}),
  identity: z.looseObject({}),
  versions: z.looseObject({}),
  sdks: z.array(z.looseObject({ id: z.string(), categories: z.array(z.string()) })),
  permissions: z.looseObject({
    ios: z.array(z.looseObject({ key: z.string() })),
    android: z.array(z.unknown()),
  }),
  entitlements: z.array(z.unknown()),
  privacySignals: z.array(z.looseObject({ dataType: z.string(), sdkIds: z.array(z.string()) })),
  assets: z.looseObject({
    appIcons: z.array(z.unknown()),
    screenshots: z.array(z.unknown()),
    listingFiles: z.array(z.unknown()),
  }),
  buildHints: z.looseObject({ appDir: z.string() }),
  warnings: z.array(z.unknown()),
  stats: z.looseObject({}),
});
