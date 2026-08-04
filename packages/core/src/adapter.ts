import type { Logger } from './logger.js';
import type {
  BatchOp,
  BatchOptions,
  BatchResult,
  BuildArtifact,
  BuildRef,
  MetadataChanges,
  OperationId,
  OpResult,
  PhasedReleaseAction,
  PriceConversion,
  PricingSchedule,
  ProductOffersSpec,
  ProductPricingSpec,
  ProductSpec,
  ScreenshotPlan,
  SubmissionSpec,
  TesterGroupChanges,
  Unsupported,
  VersionSpec,
} from './store-ops.js';
import type {
  AppRef,
  AppSummary,
  ProductKind,
  ProductSummary,
  ReleaseTrack,
  RemoteAppState,
  RemoteProduct,
  SubmissionRef,
  SubmissionStatus,
} from './store-state.js';
import type { ActionClass, PendingOperation, Store } from './types.js';

/**
 * The neutral store contract.
 *
 * Everything above this interface — kernel, MCP tools, build pipeline — is written once
 * and works for both stores. Nothing above it knows that App Store Connect is reached
 * through `asc`, that Google Play changes travel inside an *edit*, or that either tool
 * exists at all: swapping a backend for Apple's official OpenAPI client or for
 * `googleapis` is a change confined to one package.
 *
 * Two properties make that substitution real rather than aspirational:
 *
 * - **Stateless.** Adapters hold no session. Credentials, cancellation and logging arrive
 *   per call through {@link AdapterContext}; nothing is cached on disk between calls.
 * - **Honest.** What a platform cannot do through an API is never silently skipped. It
 *   comes back as a {@link PendingOperation} and is classified in {@link CapabilityMap},
 *   so the engine can plan around a gap instead of discovering it at execution time.
 */
export interface AdapterContext {
  /** Credential profile to use, e.g. `default`. */
  readonly profile: string;
  readonly logger: Logger;
  /**
   * Directory of the project being operated on. Used to resolve relative artifact paths;
   * it is never used as the working directory of a managed binary, which always runs in a
   * neutral Agentship-owned directory so that repo-local tool configuration cannot hijack it.
   */
  readonly cwd?: string;
  readonly cancelSignal?: AbortSignal;
  /** Never perform writes; produce what would happen instead. */
  readonly dryRun?: boolean;
}

/** Result of a cheap credentials check, used by `doctor` and before any plan. */
export interface AuthCheckResult {
  readonly ok: boolean;
  /** Account/team the credentials belong to, when the backend reports it. */
  readonly account?: string;
  readonly detail?: string;
}

/**
 * Declares, per operation, how Agentship may execute it on this store.
 *
 * `unsupported` means Agentship will not do it at all — not even by handing instructions to
 * an agent — because no viable path exists (Google's review status, for instance, is not
 * exposed anywhere Agentship is willing to read).
 */
export type CapabilityMap = Readonly<Record<OperationId, ActionClass | Unsupported>>;

export interface StoreAdapter {
  readonly store: Store;

  /** Coverage table for this store. Pure and synchronous: it is data, not a call. */
  capabilities(): CapabilityMap;

  /**
   * Operations this store can never automate, ready to be surfaced to the user before any
   * plan runs. App-specific pending operations come from {@link StoreAdapter.getAppState}.
   */
  knownPendingOperations(): readonly PendingOperation[];

  /** Version of the underlying backend. Used for drift detection against the lockfile. */
  version(context: AdapterContext): Promise<string>;

  /**
   * Proves the stored credentials are accepted by the store, with one cheap real call.
   *
   * `ref` is optional because Apple has an account-level endpoint and Google does not: the
   * Play Developer API only answers questions about a specific app, so a Google check
   * without a package name can report nothing beyond "a key was loaded" — which is exactly
   * the false confidence this method exists to avoid.
   */
  checkAuth(context: AdapterContext, ref?: AppRef): Promise<AuthCheckResult>;

  listApps(context: AdapterContext): Promise<AppSummary[]>;

  /** Complete normalised snapshot. Read-only; safe to call at any time. */
  getAppState(context: AdapterContext, ref: AppRef): Promise<RemoteAppState>;

  /**
   * Makes the requested store-side version exist and be editable, without touching its
   * content. Idempotent: a version that already exists in an editable state is reported as
   * `changed: false`.
   */
  ensureVersion(context: AdapterContext, ref: AppRef, spec: VersionSpec): Promise<OpResult>;

  setMetadata(context: AdapterContext, ref: AppRef, changes: MetadataChanges): Promise<OpResult>;

  /** Declarative and idempotent: unchanged images are never re-uploaded. */
  syncScreenshots(context: AdapterContext, ref: AppRef, plan: ScreenshotPlan): Promise<OpResult>;

  /** Uploads and waits for the store to finish processing, or reports it is still going. */
  uploadBuild(context: AdapterContext, ref: AppRef, artifact: BuildArtifact): Promise<BuildRef>;

  distributeToTesters(
    context: AdapterContext,
    ref: AppRef,
    build: BuildRef,
    groups: readonly string[],
    track?: ReleaseTrack,
  ): Promise<OpResult>;

  manageTesterGroups(
    context: AdapterContext,
    ref: AppRef,
    changes: TesterGroupChanges,
  ): Promise<OpResult>;

  setPricing(context: AdapterContext, ref: AppRef, schedule: PricingSchedule): Promise<OpResult>;

  submitForReview(
    context: AdapterContext,
    ref: AppRef,
    submission: SubmissionSpec,
  ): Promise<SubmissionRef>;

  getSubmissionStatus(
    context: AdapterContext,
    ref: AppRef,
    submission: SubmissionRef,
  ): Promise<SubmissionStatus>;

  setPhasedRelease(
    context: AdapterContext,
    ref: AppRef,
    action: PhasedReleaseAction,
  ): Promise<OpResult>;

  listProducts(context: AdapterContext, ref: AppRef): Promise<ProductSummary[]>;

  /**
   * Reads one product completely: prices per territory, offers, availability.
   *
   * Separate from {@link StoreAdapter.listProducts} because it is expensive — both stores
   * need several calls per product — and because a differ only ever needs it for the
   * products the manifest actually declares. `undefined` means the store has no such
   * product; a product it has but could not fully read comes back with the fields it could
   * fill and nothing invented.
   */
  getProductState(
    context: AdapterContext,
    ref: AppRef,
    productId: string,
    kind: ProductKind,
  ): Promise<RemoteProduct | undefined>;

  /** Creates a product. Idempotent: an existing product is reported as `changed: false`. */
  createProduct(context: AdapterContext, ref: AppRef, product: ProductSpec): Promise<OpResult>;

  /** Updates a product's own metadata (reference name, localizations, family sharing). */
  updateProduct(context: AdapterContext, ref: AppRef, product: ProductSpec): Promise<OpResult>;

  /**
   * Sets a product's price in every territory the caller listed.
   *
   * The prices arrive already decided and already approved: a backend never converts a base
   * price into territories on its own, because a conversion the user has not seen is a
   * price the user has not agreed to. {@link StoreAdapter.convertPrice} is how a caller gets
   * the store's proposal to *show* first.
   */
  setProductPricing(
    context: AdapterContext,
    ref: AppRef,
    pricing: ProductPricingSpec,
  ): Promise<OpResult>;

  setProductOffers(
    context: AdapterContext,
    ref: AppRef,
    offers: ProductOffersSpec,
  ): Promise<OpResult>;

  /**
   * Asks the store what a base price is worth in other territories.
   *
   * Read-only, and reported as `unavailable` rather than approximated when the backend
   * cannot answer — a made-up exchange rate would end up as a real price in someone's
   * store.
   */
  convertPrice(
    context: AdapterContext,
    ref: AppRef,
    basePrice: string,
    baseTerritory: string,
  ): Promise<PriceConversion>;

  /**
   * Applies several writes and reports which of them were atomic together.
   *
   * Google groups compatible ops into one Play *edit* (insert → changes → validate →
   * commit, with a guaranteed discard on any failure). Apple has no transaction, so ops
   * run in order and each is its own non-atomic unit. Either way the caller learns the
   * truth from {@link BatchResult.transactions} rather than assuming one or the other.
   */
  applyBatch(
    context: AdapterContext,
    ref: AppRef,
    ops: readonly BatchOp[],
    options?: BatchOptions,
  ): Promise<BatchResult>;
}
