/**
 * Write-side vocabulary of the store contract: what the engine asks a backend to change,
 * and what it gets back.
 *
 * Every payload is declarative — it describes the desired end state, not a sequence of
 * calls — so that applying it twice is a no-op and the kernel can resume a half-executed
 * plan without bookkeeping inside the adapter.
 */

import type { AgentshipErrorCode } from './errors.js';
import type {
  AppPlatform,
  ImageSlot,
  ProductKind,
  ReleaseStrategy,
  ReleaseTrack,
  ScreenshotDevice,
  SubmissionRef,
} from './store-state.js';
import type { PendingOperation, Store } from './types.js';

/**
 * Desired store listing text for one locale.
 *
 * Fields both stores understand carry no marker. Fields only one store has are documented
 * as such: a backend that cannot honour a field reports it in {@link OpResult.warnings}
 * instead of failing, because a manifest written for both stores will always contain a few
 * fields only one of them accepts.
 */
export interface LocalizedMetadata {
  readonly locale: string;
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

export interface MetadataChanges {
  /**
   * Version the version-scoped fields belong to. When omitted the backend targets the
   * editable version it finds, and says which one it chose in {@link OpResult.details}.
   */
  readonly versionId?: string;
  /** Marketing version to target when `versionId` is not known to the caller. */
  readonly version?: string;
  readonly locales: readonly LocalizedMetadata[];
  /** Apple only. */
  readonly copyright?: string;
  /** Apple only: how the version reaches users once approved. */
  readonly releaseStrategy?: ReleaseStrategy;
  /** Apple only, and only with `releaseStrategy: 'scheduled'`. */
  readonly scheduledReleaseDate?: string;
}

/** One local image file destined for a store listing. */
export interface ImageUpload {
  /** Absolute path of the file on this machine. */
  readonly path: string;
  /**
   * SHA-256 of the file contents, hex-encoded lowercase.
   *
   * Supplied by the caller so that idempotence never depends on the adapter re-reading
   * the file, and so a plan hash covers the actual bytes that will be uploaded.
   */
  readonly sha256: string;
  /** Position within the set; ties are broken by `path` for determinism. */
  readonly order?: number;
}

export interface ImageSet {
  readonly locale: string;
  readonly device: ScreenshotDevice;
  /** Defaults to `screenshots`. */
  readonly slot?: ImageSlot;
  /** Desired contents of the set, in display order. */
  readonly assets: readonly ImageUpload[];
}

export interface ScreenshotPlan {
  readonly versionId?: string;
  readonly version?: string;
  readonly sets: readonly ImageSet[];
  /**
   * When true, images present in the store but absent from the plan are deleted, and the
   * store order is forced to match. When false (the default) the sync only adds what is
   * missing — the safe choice, since deletions are irreversible.
   */
  readonly prune?: boolean;
}

/** Binary to publish, produced by `@agentship/build`. */
export interface BuildArtifact {
  readonly path: string;
  readonly kind: 'ipa' | 'pkg' | 'aab' | 'apk';
  /** Marketing version; both backends can read it from the artifact when omitted. */
  readonly version?: string;
  /** `CFBundleVersion` / `versionCode`; read from the artifact when omitted. */
  readonly buildNumber?: string;
  /** ProGuard/R8 mapping file (Google only). */
  readonly mappingFile?: string;
  /** TestFlight "What to Test" notes (Apple only). */
  readonly whatToTest?: string;
  /**
   * How long to wait for the store to finish processing the upload. Defaults to 30
   * minutes; both platforms routinely take double-digit minutes.
   */
  readonly processingTimeoutMs?: number;
}

/** Handle to an uploaded build. */
export interface BuildRef {
  readonly store: Store;
  /** Backend-scoped identifier. Google has no build id, so it uses the version code. */
  readonly id: string;
  readonly buildNumber: string;
  readonly version?: string;
  readonly state: 'processing' | 'valid' | 'invalid' | 'expired' | 'unknown';
  readonly uploadedAt?: string;
}

/** Desired membership of tester groups. */
export interface TesterGroupChanges {
  readonly groups: readonly TesterGroupSpec[];
  /** Delete groups that exist in the store but not in `groups`. Off by default. */
  readonly prune?: boolean;
}

export interface TesterGroupSpec {
  readonly name: string;
  readonly track: ReleaseTrack;
  /**
   * Desired members. Apple takes individual e-mail addresses; Google takes Google Group
   * addresses. A backend given the wrong kind reports it as a warning.
   */
  readonly members?: readonly string[];
  /** Remove members not listed. Off by default. */
  readonly pruneMembers?: boolean;
  /** Apple only: expose the group through a public TestFlight link. */
  readonly publicLink?: boolean;
}

/** Desired price and availability. */
export interface PricingSchedule {
  readonly free?: boolean;
  /** Customer-facing price, e.g. `3.99`. Ignored when `free` is true. */
  readonly amount?: string;
  /** Territory the price is quoted in, as an ISO country code or English name. */
  readonly baseTerritory?: string;
  /** `YYYY-MM-DD`; the change applies immediately when omitted. */
  readonly startDate?: string;
  readonly availability?: {
    readonly territories?: readonly string[];
    readonly allTerritories?: boolean;
    readonly availableInNewTerritories?: boolean;
  };
}

/** What to submit for review. */
export interface SubmissionSpec {
  readonly versionId?: string;
  readonly version?: string;
  /** Build to attach before submitting. */
  readonly buildNumber?: string;
  /** Track the submission targets. Defaults to `production`. */
  readonly track?: ReleaseTrack;
  /**
   * Hold the approved version for a manual release instead of publishing on approval.
   * Apple honours it through the version's release strategy; on Google it selects a draft
   * release, and the backend says so in {@link OpResult.warnings}.
   */
  readonly holdForDeveloperRelease?: boolean;
  /**
   * Commit without sending anything to review. Google needs this for apps whose previous
   * submission was rejected; on Apple it is a no-op reported as a warning.
   */
  readonly withoutReview?: boolean;
}

/** Gradual rollout control, unified across Apple phased release and Google staged rollout. */
export interface PhasedReleaseAction {
  readonly action: 'start' | 'pause' | 'resume' | 'complete' | 'cancel';
  /** Target fraction in `[0, 1]`, for `start` and `resume` on platforms that accept one. */
  readonly userFraction?: number;
  /** Defaults to `production`. */
  readonly track?: ReleaseTrack;
  readonly versionId?: string;
}

/** Result of a single contract operation. */
export interface OpResult {
  readonly ok: boolean;
  readonly store: Store;
  readonly operation: OperationId;
  /**
   * Whether the store actually changed. `false` after a no-op re-run is what makes the
   * kernel's convergence checks meaningful.
   */
  readonly changed: boolean;
  readonly dryRun: boolean;
  /** Non-fatal divergences: fields the store ignores, sets it cannot express, and so on. */
  readonly warnings?: readonly string[];
  /** What this operation could not automate, ready to be surfaced to the user. */
  readonly pending?: readonly PendingOperation[];
  /** Machine-readable specifics; never contains secrets. */
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * The store-side version a release targets.
 *
 * Apple models a version as a resource that must exist before any version-scoped text,
 * screenshot or build can be attached to it; Google has no such resource — a release
 * carries its own name — so its backend reports the op as an unsupported no-op instead of
 * inventing something. Making "the version exists" an explicit, idempotent op is what lets
 * the kernel resume a half-built release without guessing which side created it.
 */
export interface VersionSpec {
  readonly version: string;
  readonly platform?: AppPlatform;
  /** How the version reaches users once approved. */
  readonly releaseStrategy?: ReleaseStrategy;
  /** `YYYY-MM-DD`, only with `releaseStrategy: 'scheduled'`. */
  readonly scheduledReleaseDate?: string;
  readonly copyright?: string;
}

/**
 * Desired state of one monetisation product, in the store's own vocabulary.
 *
 * The kernel's manifest keeps a store-neutral product; this is what one adapter is asked
 * for after the projection has been made, so a backend never has to guess whether
 * `level: 1` means an Apple subscription rank or a Play base plan.
 */
export interface ProductSpec {
  /** Store-facing product identifier, e.g. `com.example.pro.monthly`. */
  readonly productId: string;
  readonly kind: ProductKind;
  /** Internal name; both stores show it only to the developer. */
  readonly referenceName: string;
  /** Apple: subscription group reference name. Google: base plan id. */
  readonly group?: string;
  /** Apple only: rank inside the subscription group, 1 being the most valuable. */
  readonly level?: number;
  /** Subscriptions only, in the neutral spelling (`one_month`, `one_year`, …). */
  readonly period?: string;
  readonly familySharable?: boolean;
  /** Customer-visible name and description per locale. */
  readonly localizations?: readonly {
    readonly locale: string;
    readonly displayName: string;
    readonly description?: string;
  }[];
}

/** Desired price of one product. Every territory is stated; nothing is left to a default. */
export interface ProductPricingSpec {
  readonly productId: string;
  readonly kind: ProductKind;
  /** Customer price in `baseTerritory`, e.g. `4.99`. */
  readonly basePrice: string;
  readonly baseTerritory: string;
  /**
   * Per-territory prices the caller decided on, already approved. A backend applies exactly
   * these and never substitutes its own conversion for a missing one.
   */
  readonly territories?: Readonly<Record<string, string>>;
  /** `YYYY-MM-DD`; applies immediately when omitted. */
  readonly startDate?: string;
  /**
   * Keep the price existing subscribers pay. Raising a live subscription price without this
   * is a decision with customer-visible consequences, so callers set it deliberately.
   */
  readonly preserveExistingSubscribers?: boolean;
}

/** One introductory or promotional offer, in the store's vocabulary. */
export interface OfferSpec {
  readonly id: string;
  readonly kind: 'introductory' | 'promotional' | 'offer_code' | 'win_back';
  readonly mode: 'free_trial' | 'pay_as_you_go' | 'pay_up_front';
  readonly price?: string;
  readonly duration: string;
  readonly periods: number;
  readonly territories?: readonly string[];
}

export interface ProductOffersSpec {
  readonly productId: string;
  readonly kind: ProductKind;
  /** Apple: subscription group. Google: base plan the offers hang off. */
  readonly group?: string;
  readonly offers: readonly OfferSpec[];
}

/**
 * The regional prices a store proposes for a base price.
 *
 * Read-only and always shown in a diff before anything is set: a conversion table is the
 * store's opinion about what 4.99 USD is worth in Japan, not a decision Agentship may take.
 */
export interface PriceConversion {
  readonly baseTerritory: string;
  readonly basePrice: string;
  readonly prices: readonly {
    readonly territory: string;
    readonly price: string;
    readonly currency?: string;
  }[];
  /** True when the backend could not convert and the caller must price manually. */
  readonly unavailable?: boolean;
}

/**
 * Apple's age rating questionnaire, as a set of answers.
 *
 * Apple exposes this through `ageRatingDeclarations`, so it is a real write. Google's
 * equivalent is the IARC questionnaire, which has no API at all and is a catalog entry.
 */
export interface AgeRatingDeclaration {
  /** Answers keyed by Apple's declaration field, e.g. `violenceCartoonOrFantasy`. */
  readonly answers: Readonly<Record<string, string | boolean>>;
  /** True when every answer is the safe default; backends can then use one flag. */
  readonly allNone?: boolean;
}

/**
 * Google's Data Safety declaration.
 *
 * Play's API takes the same CSV the console exports, so that is what travels: generating it
 * from the neutral model is Agentship's job, and the backend only hands it over.
 */
export interface DataSafetyDeclaration {
  /** The CSV document, in Play Console's export format. */
  readonly csv: string;
  /** One line per declared data type, for the diff and the journal. */
  readonly summary: readonly string[];
}

/** A single write inside a batch. */
export type BatchOp =
  | { readonly op: 'ensure_version'; readonly id?: string; readonly spec: VersionSpec }
  | { readonly op: 'set_metadata'; readonly id?: string; readonly changes: MetadataChanges }
  | { readonly op: 'sync_screenshots'; readonly id?: string; readonly plan: ScreenshotPlan }
  | { readonly op: 'upload_build'; readonly id?: string; readonly artifact: BuildArtifact }
  | {
      readonly op: 'distribute_to_testers';
      readonly id?: string;
      readonly buildNumber: string;
      readonly groups: readonly string[];
      readonly track?: ReleaseTrack;
      /**
       * Fraction of users the release should reach, in `(0, 1]`. Google applies it when
       * assigning the build to a track; Apple has no equivalent for a TestFlight
       * distribution and reports it as an ignored field.
       */
      readonly userFraction?: number;
    }
  | {
      readonly op: 'manage_tester_groups';
      readonly id?: string;
      readonly changes: TesterGroupChanges;
    }
  | { readonly op: 'set_pricing'; readonly id?: string; readonly schedule: PricingSchedule }
  | {
      readonly op: 'set_phased_release';
      readonly id?: string;
      readonly action: PhasedReleaseAction;
    }
  | { readonly op: 'submit_for_review'; readonly id?: string; readonly submission: SubmissionSpec }
  | { readonly op: 'create_product'; readonly id?: string; readonly product: ProductSpec }
  | { readonly op: 'update_product'; readonly id?: string; readonly product: ProductSpec }
  | {
      readonly op: 'set_product_pricing';
      readonly id?: string;
      readonly pricing: ProductPricingSpec;
    }
  | { readonly op: 'set_product_offers'; readonly id?: string; readonly offers: ProductOffersSpec }
  | {
      readonly op: 'set_age_rating';
      readonly id?: string;
      readonly declaration: AgeRatingDeclaration;
    }
  | {
      readonly op: 'set_data_safety';
      readonly id?: string;
      readonly declaration: DataSafetyDeclaration;
    };

export interface BatchOptions {
  /**
   * Produce what would happen without changing anything. Both backends validate
   * server-side where the platform allows it, so a dry run is more than a local guess.
   */
  readonly dryRun?: boolean;
  /**
   * Prepare everything but do not send it to review. On Google this maps onto committing
   * without review; on Apple it stops before creating the review submission.
   */
  readonly holdForReview?: boolean;
  /** Stop at the first failure (the default) instead of attempting the remaining ops. */
  readonly stopOnError?: boolean;
}

/**
 * A set of ops the backend executed as one unit.
 *
 * This is where the two platforms differ in a way the engine must see rather than guess:
 * Google commits a Play *edit* atomically, so several ops can share one transaction and
 * either all land or none do. Apple's API has no transaction, so each op is its own
 * non-atomic transaction. Reporting it explicitly lets the kernel decide what is safe to
 * retry after a failure instead of assuming.
 */
export interface BatchTransaction {
  /** Identifier scoped to this batch, for correlation with log records. */
  readonly id: string;
  /** Indexes into the `ops` array the caller passed, in execution order. */
  readonly opIndexes: readonly number[];
  /** True when the platform guarantees all-or-nothing for these ops. */
  readonly atomic: boolean;
  /** False when the transaction was rolled back, discarded, or never reached. */
  readonly committed: boolean;
}

export interface BatchOpResult extends OpResult {
  readonly index: number;
  /** `undefined` when the op succeeded. */
  readonly errorCode?: AgentshipErrorCode;
  readonly errorMessage?: string;
  /** True when the op was not attempted because an earlier one failed. */
  readonly skipped?: boolean;
}

export interface BatchResult {
  readonly ok: boolean;
  readonly store: Store;
  readonly dryRun: boolean;
  readonly results: readonly BatchOpResult[];
  readonly transactions: readonly BatchTransaction[];
  readonly pending: readonly PendingOperation[];
  /** Index of the op that failed, when one did. */
  readonly failedAt?: number;
  /** Refs produced along the way, so the caller does not have to re-query. */
  readonly builds?: readonly BuildRef[];
  readonly submission?: SubmissionRef;
}

/**
 * Every operation the contract can name.
 *
 * The list covers more than the methods of {@link import('./adapter.js').StoreAdapter}:
 * it also names the things Agentship deliberately does *not* implement, so that
 * `capabilities()` can classify them as `agent_browser` or `human_only` and the kernel can
 * plan around them. Coverage is data, not code.
 */
export const OPERATION_IDS = [
  // --- readable state ---------------------------------------------------------
  'checkAuth',
  'listApps',
  'getAppState',
  'listProducts',
  /** Read one product's full state: prices per territory, offers, availability. */
  'getProductState',
  'getSubmissionStatus',
  // --- work that happens on this machine ----------------------------------------
  /** Compile and sign the user's app locally, producing the artifact to upload. */
  'buildArtifact',
  // --- writes the contract implements ------------------------------------------
  'ensureVersion',
  'setMetadata',
  'syncScreenshots',
  'uploadBuild',
  'distributeToTesters',
  'manageTesterGroups',
  'setPricing',
  'submitForReview',
  'setPhasedRelease',
  /** Hand an approved version to users when the store held it for a manual release. */
  'releaseVersion',
  // --- monetisation writes -------------------------------------------------------
  'createProduct',
  'updateProduct',
  'setProductPricing',
  'setProductOffers',
  // --- writes with no API on at least one platform ------------------------------
  'createApp',
  'firstRelease',
  'privacyLabels',
  'dataSafety',
  'contentRating',
  'appPricing',
  'appAvailability',
  'appContentDeclarations',
  'playAppSigning',
  'resolutionCenter',
  'reviewStatus',
  'agreementsTaxBanking',
] as const;

export type OperationId = (typeof OPERATION_IDS)[number];

/** Operation is impossible on this store by any means Agentship will use. */
export type Unsupported = 'unsupported';
