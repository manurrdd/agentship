/**
 * Normalised snapshot of what a store currently holds for one app.
 *
 * Everything here is store-neutral by construction: no App Store Connect resource ids
 * leak as concepts, no Google Play *edit* appears, and no field is named after a flag of
 * `asc` or `gpc`. Where the two platforms genuinely model different things (a TestFlight
 * group versus a Play track), the union of both is expressed once, with a documented
 * mapping performed inside each backend.
 *
 * The rule that keeps this honest: a backend never invents a value. What it could not read
 * — because the platform has no API for it, or because the credentials lack the role — is
 * reported as a {@link StateGap}, so the kernel can tell "absent" from "unknown".
 */

import type { Confidence, PendingOperation, Store } from './types.js';

/** Platform an app binary targets. Both stores are covered by one enum. */
export type AppPlatform = 'ios' | 'macos' | 'tvos' | 'visionos' | 'android';

/**
 * Stable handle for an app inside a store.
 *
 * `id` is whatever that store uses as its primary key — an App Store Connect app id for
 * Apple, a package name for Google — and is opaque to everything above the adapter.
 */
export interface AppRef {
  readonly store: Store;
  readonly id: string;
  /** `CFBundleIdentifier` (Apple) or `applicationId` (Google), when known. */
  readonly bundleId?: string;
  /** Narrows multi-platform Apple apps; Google apps are always `android`. */
  readonly platform?: AppPlatform;
}

export interface AppSummary {
  readonly ref: AppRef;
  readonly name: string;
  readonly bundleId?: string;
  /** Apple SKU; Google has no equivalent. */
  readonly sku?: string;
  /** Default/primary locale of the store listing, e.g. `en-US`. */
  readonly primaryLocale?: string;
  readonly platforms: readonly AppPlatform[];
}

/**
 * Lifecycle of a store-visible version, unified across both platforms.
 *
 * Apple's `appStoreVersionState` and Google's release `status` are collapsed onto this
 * enum; the per-store translation tables live in each backend and are covered by tests.
 */
export type VersionState =
  | 'draft'
  | 'waiting_review'
  | 'in_review'
  | 'rejected'
  | 'pending_release'
  | 'phased_release'
  | 'live'
  | 'removed'
  | 'unknown';

export const VERSION_STATES: readonly VersionState[] = [
  'draft',
  'waiting_review',
  'in_review',
  'rejected',
  'pending_release',
  'phased_release',
  'live',
  'removed',
  'unknown',
];

/**
 * Distribution channel, unified across both platforms.
 *
 * Google maps directly (`internal`/`alpha`/`beta`/`production`). Apple has no track
 * resource, so the backend maps: internal TestFlight groups → `internal_testing`,
 * external TestFlight groups → `closed_testing`, a TestFlight public link →
 * `open_testing`, and the App Store itself → `production`.
 */
export type ReleaseTrack = 'internal_testing' | 'closed_testing' | 'open_testing' | 'production';

/** How a version reaches users once it is approved. */
export type ReleaseStrategy = 'manual' | 'automatic' | 'scheduled';

export interface RemoteVersion {
  /** Backend-scoped identifier, needed to address the version in later calls. */
  readonly id: string;
  /** Marketing version, e.g. `1.4.0`. */
  readonly version: string;
  readonly state: VersionState;
  readonly platform?: AppPlatform;
  readonly track?: ReleaseTrack;
  readonly releaseStrategy?: ReleaseStrategy;
  readonly createdAt?: string;
  /** Build currently attached to this version, when one is. */
  readonly buildId?: string;
  readonly copyright?: string;
  /** Verbatim platform state, kept for diagnostics only — never matched on by the kernel. */
  readonly rawState?: string;
}

/** Store listing text for one locale. */
export interface RemoteLocalization {
  /** Backend-scoped identifier of the localization record, when the platform has one. */
  readonly id?: string;
  readonly locale: string;
  /** Version this text belongs to; absent for app-level text (Apple app info, Google listing). */
  readonly versionId?: string;
  readonly name?: string;
  /** Apple only. */
  readonly subtitle?: string;
  /** Google only. */
  readonly shortDescription?: string;
  readonly description?: string;
  /** Apple only: comma-separated search keywords. */
  readonly keywords?: string;
  readonly whatsNew?: string;
  /** Apple only. */
  readonly promotionalText?: string;
  readonly marketingUrl?: string;
  readonly supportUrl?: string;
  readonly privacyPolicyUrl?: string;
  /** Google only: promo video URL. */
  readonly videoUrl?: string;
}

/**
 * Where an image is displayed in a store listing.
 *
 * `screenshots` is the only slot both stores share; the rest exist on Google alone
 * (Apple takes the icon from the binary). Backends that cannot honour a slot say so in
 * {@link OpResult.warnings} rather than failing the whole sync.
 */
export type ImageSlot = 'screenshots' | 'app_icon' | 'feature_graphic' | 'tv_banner';

/**
 * Device family a screenshot set targets.
 *
 * Deliberately coarse: Apple exposes a long matrix of display sizes and Google four
 * buckets. Each backend maps these onto its own vocabulary (Apple: `phone` →
 * `IPHONE_65`, `tablet_10` → `IPAD_PRO_3GEN_129`, the pair Apple's own tooling treats as
 * sufficient for an iOS submission) and warns on combinations it cannot express.
 */
export type ScreenshotDevice =
  | 'phone'
  | 'tablet_7'
  | 'tablet_10'
  | 'tv'
  | 'watch'
  | 'desktop'
  | 'vision';

/** One image already published in the store. */
export interface RemoteImage {
  readonly id: string;
  /** SHA-256 of the published bytes when the platform reports it (Google does). */
  readonly sha256?: string;
  /** MD5 the platform computed at upload time, when that is what it reports (Apple). */
  readonly md5?: string;
  readonly fileName?: string;
  readonly width?: number;
  readonly height?: number;
  readonly url?: string;
}

/** Every image published for one locale/device/slot combination, in display order. */
export interface RemoteImageSet {
  readonly locale: string;
  readonly device: ScreenshotDevice;
  readonly slot: ImageSlot;
  /** Backend-scoped identifier of the set, when the platform models one. */
  readonly id?: string;
  readonly images: readonly RemoteImage[];
}

/** Processing state of an uploaded binary, unified across both platforms. */
export type BuildState = 'processing' | 'valid' | 'invalid' | 'expired' | 'unknown';

export interface RemoteBuild {
  readonly id: string;
  /** Apple `CFBundleVersion`; Google `versionCode` rendered as a string. */
  readonly buildNumber: string;
  /** Marketing version the build declares. */
  readonly version?: string;
  readonly state: BuildState;
  readonly platform?: AppPlatform;
  readonly uploadedAt?: string;
  readonly expired?: boolean;
}

/**
 * A group of testers.
 *
 * Apple models these as TestFlight beta groups holding individual testers; Google models
 * them as Google Groups attached to a track. The neutral shape keeps both: `members`
 * holds e-mail addresses either way, and `kind` says how the store interprets them.
 */
export interface RemoteTesterGroup {
  readonly id: string;
  readonly name: string;
  readonly track: ReleaseTrack;
  /** `individuals` on Apple, `google_groups` on Google. */
  readonly kind: 'individuals' | 'google_groups';
  readonly members: readonly string[];
  /** Number of members when the backend reports a count but not the list. */
  readonly memberCount?: number;
  readonly publicLink?: string;
}

/** What a track currently distributes. */
export interface RemoteTrackState {
  readonly track: ReleaseTrack;
  readonly state: VersionState;
  /** Build numbers currently served on this track. */
  readonly buildNumbers: readonly string[];
  /** Fraction of users receiving a staged/phased rollout, in `[0, 1]`. */
  readonly userFraction?: number;
  readonly halted?: boolean;
  readonly releaseName?: string;
  /** Release notes per locale, as the store holds them today. */
  readonly notes?: readonly { readonly locale: string; readonly text: string }[];
  /** Native track name, for diagnostics only. */
  readonly rawTrack?: string;
}

/** Current price and availability, as far as the platform exposes it. */
export interface RemotePricing {
  readonly free?: boolean;
  readonly amount?: string;
  readonly currency?: string;
  readonly baseTerritory?: string;
  readonly territories?: readonly string[];
  readonly availableInNewTerritories?: boolean;
  /** Backend-scoped identifier of the active schedule, when the platform has one. */
  readonly scheduleId?: string;
}

/** Kind of monetisation product, unified across both platforms. */
export type ProductKind =
  | 'consumable'
  | 'non_consumable'
  | 'non_renewing_subscription'
  | 'auto_renewable_subscription'
  | 'unknown';

export interface ProductSummary {
  readonly id: string;
  /** Store-facing product identifier, e.g. `com.example.pro.monthly`. */
  readonly productId: string;
  readonly kind: ProductKind;
  readonly referenceName?: string;
  /** Subscription group / base plan the product belongs to, when it belongs to one. */
  readonly groupId?: string;
  readonly state?: string;
}

/** One territory's price for a product. */
export interface RemoteProductPrice {
  /** ISO country code or the store's own territory identifier. */
  readonly territory: string;
  readonly price: string;
  readonly currency?: string;
  /** Backend-scoped identifier of the price point, when the platform models one. */
  readonly pricePointId?: string;
}

/** One introductory or promotional offer as the store currently holds it. */
export interface RemoteProductOffer {
  readonly id: string;
  readonly kind: 'introductory' | 'promotional' | 'offer_code' | 'win_back' | 'unknown';
  readonly mode?: 'free_trial' | 'pay_as_you_go' | 'pay_up_front';
  readonly duration?: string;
  readonly periods?: number;
  readonly price?: string;
  readonly state?: string;
  /** Territory the offer applies in, when the store scopes offers per territory (Apple). */
  readonly territory?: string;
}

/**
 * A monetisation product with everything a differ needs to decide whether it converged.
 *
 * Deliberately richer than {@link ProductSummary}: a summary answers "does this product
 * exist", and a differ that stopped there would recreate a product whose price drifted, or
 * miss a price that was never applied. The extra fields are all optional, because a backend
 * reports what it could read and nothing more — an empty `prices` means "not read", which is
 * why {@link RemoteAppState.gaps} exists.
 */
export interface RemoteProduct extends ProductSummary {
  readonly displayName?: string;
  readonly description?: string;
  /** Subscriptions only: the billing period in the neutral spelling. */
  readonly period?: string;
  readonly prices?: readonly RemoteProductPrice[];
  readonly offers?: readonly RemoteProductOffer[];
  /** Territories the product is available in, when the backend reports them. */
  readonly territories?: readonly string[];
  readonly familySharable?: boolean;
}

/** Apple's age rating declaration, as the store currently holds it. */
export interface RemoteAgeRating {
  /** Backend-scoped identifier of the declaration, needed to edit it. */
  readonly id?: string;
  /** Answers keyed by Apple's own field names. */
  readonly answers: Readonly<Record<string, string | boolean>>;
}

/** Google's Data Safety declaration, as the store currently holds it. */
export interface RemoteDataSafety {
  /** The declaration in Play Console's CSV export format, when the API returned one. */
  readonly csv?: string;
  /** SHA-256 of the CSV Agentship last applied, read from the project's archive. */
  readonly appliedSha256?: string;
  readonly updatedAt?: string;
}

/** State of a gradual rollout, unified across Apple phased release and Google staged rollout. */
export interface RemotePhasedRelease {
  readonly track: ReleaseTrack;
  readonly state: 'inactive' | 'active' | 'paused' | 'complete';
  readonly userFraction?: number;
  /** Apple exposes a day counter; Google does not. */
  readonly dayNumber?: number;
  /** Backend-scoped identifier, needed to address the rollout in later calls. */
  readonly id?: string;
}

/** Area of the snapshot that could not be filled, and why. */
export interface StateGap {
  /** Field of {@link RemoteAppState} that is incomplete, e.g. `pricing`. */
  readonly area: string;
  readonly reason: string;
  /** `no_api` — the platform has none; `forbidden` — the credentials' role is too narrow. */
  readonly kind: 'no_api' | 'forbidden' | 'not_found' | 'error';
  /** The pending operation that would close the gap, when one applies. */
  readonly pendingId?: string;
}

/**
 * Complete normalised snapshot of one app in one store.
 *
 * The kernel diffs a manifest against this and never talks to a backend to find
 * out what is already true.
 */
export interface RemoteAppState {
  readonly store: Store;
  readonly ref: AppRef;
  /** ISO timestamp of when the snapshot was taken. */
  readonly capturedAt: string;
  readonly app: AppSummary;
  readonly versions: readonly RemoteVersion[];
  readonly localizations: readonly RemoteLocalization[];
  readonly images: readonly RemoteImageSet[];
  readonly builds: readonly RemoteBuild[];
  readonly testerGroups: readonly RemoteTesterGroup[];
  readonly tracks: readonly RemoteTrackState[];
  readonly pricing?: RemotePricing;
  readonly products: readonly RemoteProduct[];
  readonly phasedRelease?: RemotePhasedRelease;
  /** Apple only: the age rating declaration. Google's IARC rating has no API. */
  readonly ageRating?: RemoteAgeRating;
  /** Google only: the Data Safety declaration. Apple's App Privacy has no API. */
  readonly dataSafety?: RemoteDataSafety;
  /** What the backend could not read. Empty means "everything above is complete". */
  readonly gaps: readonly StateGap[];
  /** Operations this app needs that no API can perform. */
  readonly pending: readonly PendingOperation[];
}

/** Outcome of a review submission, best-effort where the platform does not expose one. */
export type SubmissionState =
  | 'not_submitted'
  | 'waiting_review'
  | 'in_review'
  | 'approved'
  | 'rejected'
  | 'completed'
  | 'cancelled'
  | 'unknown';

export interface SubmissionStatus {
  readonly state: SubmissionState;
  /**
   * How much the backend trusts the value. Google has no review-status API, so its
   * answers are `inferred` at best — the contract makes that visible instead of hiding it.
   */
  readonly confidence: Confidence;
  readonly detail?: string;
  readonly updatedAt?: string;
  /** Reviewer-visible rejection reasons, when the platform exposes them. */
  readonly messages?: readonly string[];
}

/** Handle to a submission, so its status can be polled later. */
export interface SubmissionRef {
  readonly store: Store;
  readonly id: string;
  /**
   * True when the platform has no submission resource and the id was minted by Agentship.
   * Google commits an edit instead of creating a submission, so its refs are synthetic.
   */
  readonly synthetic: boolean;
  readonly submittedAt?: string;
}

/** One thing the store itself says is wrong or missing before a version can be submitted. */
export interface SubmissionBlocker {
  /** The store's own code, e.g. `review_details.missing`. Stable enough to match on. */
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  /** The store considers this reason enough to refuse the submission. */
  readonly blocking: boolean;
  readonly message: string;
  readonly remediation?: string;
}

/**
 * What the store says still stands between a version and review.
 *
 * Agentship's own readiness is derived from the plan: it knows what the manifest asks for
 * and what the snapshot shows, so it can only ever report the gaps it was told to look for.
 * The store knows the rest — a missing reviewer phone number, a screenshot in a size that
 * is no longer accepted, a build that has not finished processing — and answers in one
 * call. Where a platform has no such endpoint the answer is `supported: false` with the
 * reason, never an empty list, because "nothing to report" and "nobody asked" must not
 * look the same.
 */
export interface SubmissionReadiness {
  readonly store: Store;
  readonly supported: boolean;
  /** Why the store could not answer, when `supported` is false. */
  readonly reason?: string;
  readonly blockers: readonly SubmissionBlocker[];
}
