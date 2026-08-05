import type { AdapterContext, AuthCheckResult, CapabilityMap, StoreAdapter } from '../adapter.js';
import { AgentshipError, type AgentshipErrorCode, ERROR_CODES } from '../errors.js';
import { optional } from '../optional.js';
import type {
  AgeRatingDeclaration,
  BatchOp,
  BatchOpResult,
  BatchOptions,
  BatchResult,
  BatchTransaction,
  BuildArtifact,
  BuildRef,
  DataSafetyDeclaration,
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
  VersionSpec,
} from '../store-ops.js';
import type {
  AppRef,
  AppSummary,
  ImageSlot,
  ProductKind,
  ProductSummary,
  ReleaseStrategy,
  ReleaseTrack,
  RemoteAppState,
  RemoteLocalization,
  RemoteProduct,
  RemoteProductOffer,
  ScreenshotDevice,
  SubmissionBlocker,
  SubmissionReadiness,
  SubmissionRef,
  SubmissionStatus,
  VersionState,
} from '../store-state.js';
import type { PendingOperation, Store } from '../types.js';

/**
 * An in-memory store with enough semantics of both platforms to exercise the kernel.
 *
 * This is the test harness for every plan after 03. It is not a simulation of the real
 * adapters — it is a simulation of the *stores*, at the level the kernel cares about:
 *
 * - **Apple**: each op is its own non-atomic transaction; uploaded builds go through a
 *   `processing` state that clears after a configurable number of snapshots; a version
 *   already in review rejects a second submission.
 * - **Google**: `applyBatch` behaves like a Play edit — every op validates first and the
 *   whole batch commits atomically or not at all; pricing has no API and comes back as a
 *   `PendingOperation` proposal (`ok: true, changed: false`), never as a write.
 *
 * Failures are injected per operation with a phase: `before` fails without applying the
 * effect (validation, network down); `after` applies the effect *and then* throws (the
 * network died between the store committing and us hearing about it) — the exact case
 * write-ahead journaling exists for. Effect counters expose how many times each mutation
 * really happened, which is what the idempotence tests assert on.
 */
export interface MockLocalization {
  name?: string;
  subtitle?: string;
  shortDescription?: string;
  description?: string;
  keywords?: string;
  whatsNew?: string;
  promotionalText?: string;
  marketingUrl?: string;
  supportUrl?: string;
  privacyPolicyUrl?: string;
  videoUrl?: string;
}

export interface MockVersion {
  id: string;
  version: string;
  state: VersionState;
  track: ReleaseTrack;
  buildId?: string;
  releaseStrategy?: ReleaseStrategy;
  copyright?: string;
}

/** One published image, identified by the hash of its bytes — how a sync stays idempotent. */
export interface MockImage {
  id: string;
  sha256: string;
  fileName?: string;
}

/** What a track currently serves, which is the whole of Google's release model. */
export interface MockTrack {
  track: ReleaseTrack;
  buildNumbers: string[];
  state: VersionState;
  userFraction?: number;
  halted?: boolean;
  notes?: { locale: string; text: string }[];
}

export interface MockPhasedRelease {
  track: ReleaseTrack;
  state: 'inactive' | 'active' | 'paused' | 'complete';
  userFraction?: number;
  dayNumber?: number;
}

export interface MockBuild {
  id: string;
  buildNumber: string;
  version?: string;
  state: 'processing' | 'valid' | 'invalid';
  /** Snapshots left until a `processing` build becomes `valid`. */
  ticksLeft: number;
}

export interface MockTesterGroup {
  id: string;
  name: string;
  track: ReleaseTrack;
  members: string[];
}

export interface MockPricing {
  free: boolean;
  amount?: string;
  baseTerritory?: string;
}

/**
 * One monetisation product, with the parts of both models the kernel has to tell apart.
 *
 * `group` carries Apple's subscription group and Google's base plan id, because a mock that
 * merged them would let a differ pass that the real stores would reject.
 */
export interface MockProduct {
  id: string;
  productId: string;
  kind: ProductKind;
  referenceName?: string;
  displayName?: string;
  description?: string;
  group?: string;
  level?: number;
  period?: string;
  familySharable?: boolean;
  /** Territory → customer price. */
  prices: Map<string, string>;
  offers: RemoteProductOffer[];
  state: string;
}

/** Mutable store-side state. Tests reach in freely; the kernel only sees snapshots. */
export interface MockStoreState {
  appExists: boolean;
  name: string;
  bundleId: string;
  primaryLocale: string;
  localizations: Map<string, MockLocalization>;
  versions: MockVersion[];
  builds: MockBuild[];
  testerGroups: MockTesterGroup[];
  pricing: MockPricing;
  /** Published images, keyed `<locale>|<device>|<slot>`. */
  images: Map<string, MockImage[]>;
  tracks: MockTrack[];
  phasedRelease?: MockPhasedRelease;
  /** Gates review submission on Google (IARC questionnaire done in the console). */
  contentRatingDone: boolean;
  /**
   * Google only: a review is already running, so committing another edit would cancel it.
   * The real API answers `changesAlreadyInReview`; the mock refuses the same way.
   */
  reviewInProgress: boolean;
  /** Google only: the account publishes manually, so a commit only stages the change. */
  managedPublishing: boolean;
  submissions: { id: string; version: string; at: string }[];
  /** Monetisation catalog, keyed by store product id. */
  products: Map<string, MockProduct>;
  /** Apple only: the age rating declaration, keyed by Apple's own field names. */
  ageRating?: { id: string; answers: Record<string, string | boolean> };
  /** Google only: the Data Safety declaration, as the CSV last applied. */
  dataSafety?: { csv: string; updatedAt: string };
  /**
   * Apple only: whether App Privacy has been declared. False makes the snapshot report the
   * privacy pending, which is what gates a submission.
   */
  appPrivacyDone: boolean;
  /**
   * Apple only: what the store itself would refuse the submission for.
   *
   * Deliberately independent of everything else in this state — that is the point of asking
   * the store. A screenshot size Apple stopped accepting is not derivable from a manifest
   * diff, so the mock lets a test state one rather than compute it.
   */
  submissionBlockers: SubmissionBlocker[];
}

export interface MockEffects {
  metadataWrites: number;
  imageWrites: number;
  versionCreates: number;
  uploads: number;
  distributions: number;
  groupWrites: number;
  pricingWrites: number;
  submits: number;
  phasedWrites: number;
  /** Products created; the counter idempotence tests assert never exceeds one per product. */
  productCreates: number;
  productUpdates: number;
  productPriceWrites: number;
  productOfferWrites: number;
  ageRatingWrites: number;
  dataSafetyWrites: number;
  /** Committed Google edits (each successful google applyBatch is exactly one). */
  edits: number;
  snapshots: number;
}

export function createMockState(overrides: Partial<MockStoreState> = {}): MockStoreState {
  return {
    appExists: true,
    name: 'Mock App',
    bundleId: 'com.example.mock',
    primaryLocale: 'en-US',
    localizations: new Map([['en-US', { name: 'Mock App', description: 'The original text.' }]]),
    versions: [{ id: 'v-1', version: '1.0.0', state: 'live', track: 'production' }],
    builds: [],
    testerGroups: [],
    pricing: { free: true },
    images: new Map(),
    tracks: [],
    contentRatingDone: true,
    reviewInProgress: false,
    managedPublishing: false,
    submissions: [],
    products: new Map(),
    appPrivacyDone: true,
    submissionBlockers: [],
    ...overrides,
  };
}

export type FailurePhase = 'before' | 'after';

export interface FailureInjection {
  /** Operation to fail, or `commit` for the Google edit commit itself. */
  readonly operation: OperationId | 'commit';
  readonly phase: FailurePhase;
  /** How many times to fire. Defaults to 1. */
  readonly times?: number;
  readonly code?: AgentshipErrorCode;
  readonly message?: string;
}

export interface MockAdapterOptions {
  readonly store: Store;
  readonly state?: MockStoreState;
  /** Snapshots a fresh upload stays `processing` for. Defaults to 0 (valid at once). */
  readonly processingTicks?: number;
}

const MOCK_CAPABILITIES: Record<Store, CapabilityMap> = {
  apple: {
    checkAuth: 'auto',
    listApps: 'auto',
    getAppState: 'auto',
    listProducts: 'auto',
    getProductState: 'auto',
    getSubmissionStatus: 'auto',
    buildArtifact: 'auto',
    ensureVersion: 'auto',
    releaseVersion: 'agent_browser',
    setMetadata: 'needs_approval',
    syncScreenshots: 'needs_approval',
    uploadBuild: 'auto',
    distributeToTesters: 'needs_approval',
    manageTesterGroups: 'auto',
    setPricing: 'needs_approval',
    submitForReview: 'needs_approval',
    setPhasedRelease: 'needs_approval',
    createProduct: 'needs_approval',
    updateProduct: 'needs_approval',
    setProductPricing: 'needs_approval',
    setProductOffers: 'needs_approval',
    createApp: 'agent_browser',
    privacyLabels: 'agent_browser',
    resolutionCenter: 'agent_browser',
    contentRating: 'needs_approval',
    appPricing: 'needs_approval',
    appAvailability: 'needs_approval',
    agreementsTaxBanking: 'human_only',
    firstRelease: 'unsupported',
    dataSafety: 'unsupported',
    appContentDeclarations: 'unsupported',
    playAppSigning: 'unsupported',
    reviewStatus: 'unsupported',
  },
  google: {
    checkAuth: 'auto',
    listApps: 'unsupported',
    getAppState: 'auto',
    listProducts: 'auto',
    getProductState: 'auto',
    getSubmissionStatus: 'auto',
    buildArtifact: 'auto',
    ensureVersion: 'unsupported',
    releaseVersion: 'agent_browser',
    setMetadata: 'needs_approval',
    syncScreenshots: 'needs_approval',
    uploadBuild: 'auto',
    distributeToTesters: 'needs_approval',
    manageTesterGroups: 'auto',
    submitForReview: 'needs_approval',
    setPhasedRelease: 'needs_approval',
    createProduct: 'needs_approval',
    updateProduct: 'needs_approval',
    setProductPricing: 'needs_approval',
    setProductOffers: 'needs_approval',
    dataSafety: 'needs_approval',
    createApp: 'agent_browser',
    firstRelease: 'agent_browser',
    contentRating: 'agent_browser',
    setPricing: 'agent_browser',
    appPricing: 'agent_browser',
    appAvailability: 'agent_browser',
    appContentDeclarations: 'agent_browser',
    playAppSigning: 'agent_browser',
    agreementsTaxBanking: 'human_only',
    reviewStatus: 'unsupported',
    privacyLabels: 'unsupported',
    resolutionCenter: 'unsupported',
  },
};

export const MOCK_CONTENT_RATING_CHECK = 'mock:content-rating-done';
export const MOCK_APP_PRIVACY_CHECK = 'mock:app-privacy-done';

export class MockStoreAdapter implements StoreAdapter {
  readonly store: Store;
  readonly state: MockStoreState;
  readonly effects: MockEffects = {
    metadataWrites: 0,
    imageWrites: 0,
    versionCreates: 0,
    uploads: 0,
    distributions: 0,
    groupWrites: 0,
    pricingWrites: 0,
    submits: 0,
    phasedWrites: 0,
    productCreates: 0,
    productUpdates: 0,
    productPriceWrites: 0,
    productOfferWrites: 0,
    ageRatingWrites: 0,
    dataSafetyWrites: 0,
    edits: 0,
    snapshots: 0,
  };
  private readonly processingTicks: number;
  private readonly failures: (FailureInjection & { remaining: number })[] = [];
  private nextId = 100;

  constructor(options: MockAdapterOptions) {
    this.store = options.store;
    this.state = options.state ?? createMockState();
    this.processingTicks = options.processingTicks ?? 0;
  }

  /** Arms a failure. Failures fire in registration order, once per matching call. */
  injectFailure(injection: FailureInjection): void {
    this.failures.push({ ...injection, remaining: injection.times ?? 1 });
  }

  private maybeFail(operation: OperationId | 'commit', phase: FailurePhase): void {
    const armed = this.failures.find(
      (failure) =>
        failure.remaining > 0 && failure.operation === operation && failure.phase === phase,
    );
    if (armed === undefined) return;
    armed.remaining -= 1;
    throw new AgentshipError(
      armed.code ?? ERROR_CODES.STORE_UNAVAILABLE,
      armed.message ?? `Injected ${phase}-phase failure on ${operation}.`,
      { store: this.store },
    );
  }

  capabilities(): CapabilityMap {
    return MOCK_CAPABILITIES[this.store];
  }

  knownPendingOperations(): readonly PendingOperation[] {
    return [];
  }

  async version(): Promise<string> {
    return '0.0.0-mock';
  }

  async checkAuth(_context: AdapterContext, ref?: AppRef): Promise<AuthCheckResult> {
    if (this.store === 'google' && ref === undefined) {
      // Not a rejection: the check simply cannot run without an app to run it against.
      return {
        status: 'unverifiable',
        ok: false,
        detail:
          'Google credentials can only be proven against a specific app; supply the package name.',
      };
    }
    return { status: 'ok', ok: true, account: 'mock-account' };
  }

  async findApp(
    _context: AdapterContext,
    bundleId: string,
  ): Promise<{ id: string; name: string } | undefined> {
    if (this.store !== 'apple' || bundleId !== this.state.bundleId) return undefined;
    return { id: 'app-1', name: this.state.name };
  }

  async listApps(): Promise<AppSummary[]> {
    if (this.store === 'google') {
      throw new AgentshipError(
        ERROR_CODES.STORE_UNSUPPORTED_OPERATION,
        'Google Play has no API to enumerate apps.',
        { store: 'google' },
      );
    }
    return [this.appSummary()];
  }

  private appSummary(): AppSummary {
    return {
      ref: this.ref(),
      name: this.state.name,
      bundleId: this.state.bundleId,
      primaryLocale: this.state.primaryLocale,
      platforms: [this.store === 'apple' ? 'ios' : 'android'],
    };
  }

  private ref(): AppRef {
    return {
      store: this.store,
      id: this.store === 'apple' ? 'app-1' : this.state.bundleId,
      bundleId: this.state.bundleId,
    };
  }

  async getAppState(_context: AdapterContext, _ref: AppRef): Promise<RemoteAppState> {
    this.maybeFail('getAppState', 'before');
    if (!this.state.appExists) {
      throw new AgentshipError(ERROR_CODES.STORE_NOT_FOUND, 'This app does not exist yet.', {
        store: this.store,
      });
    }
    this.effects.snapshots += 1;
    // Time passes when someone looks: processing builds advance one tick per snapshot.
    for (const build of this.state.builds) {
      if (build.state === 'processing') {
        build.ticksLeft -= 1;
        if (build.ticksLeft <= 0) build.state = 'valid';
      }
    }

    const localizations: RemoteLocalization[] = [...this.state.localizations.entries()].map(
      ([locale, fields]) => ({ locale, ...fields }),
    );
    const pending: PendingOperation[] = [];
    if (this.store === 'google' && !this.state.contentRatingDone) {
      pending.push({
        id: 'google:content-rating',
        store: 'google',
        category: 'content_rating',
        title: 'Complete the IARC content rating questionnaire',
        reason: 'Content ratings are issued through a console questionnaire; there is no API.',
        actionClass: 'agent_browser',
        console: { url: 'https://play.google.com/console' },
        verification: {
          summary: 'The app reports a completed content rating.',
          check: MOCK_CONTENT_RATING_CHECK,
        },
        status: 'open',
      });
    }
    if (this.store === 'apple' && !this.state.appPrivacyDone) {
      // App Privacy has no API, so the only thing a snapshot can say is that Apple still
      // lists it as outstanding. The review differ gates the submission on exactly this.
      pending.push({
        id: 'apple:app-privacy',
        store: 'apple',
        category: 'privacy',
        title: 'Declare App Privacy data use',
        reason: 'App Privacy answers are not exposed by the public App Store Connect API.',
        actionClass: 'agent_browser',
        console: { url: 'https://appstoreconnect.apple.com/apps' },
        verification: {
          summary: 'App Store Connect no longer lists App Privacy as outstanding.',
          check: MOCK_APP_PRIVACY_CHECK,
        },
        status: 'open',
      });
    }

    return {
      store: this.store,
      ref: this.ref(),
      capturedAt: new Date().toISOString(),
      app: this.appSummary(),
      versions: this.state.versions.map((version) => ({
        id: version.id,
        version: version.version,
        state: version.state,
        track: version.track,
        ...optional('buildId', version.buildId),
        ...optional('releaseStrategy', version.releaseStrategy),
        ...optional('copyright', version.copyright),
      })),
      localizations,
      images: [...this.state.images.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, images]) => {
          const [locale, device, slot] = key.split('|') as [string, string, string];
          return {
            locale,
            device: device as ScreenshotDevice,
            slot: slot as ImageSlot,
            images: images.map((image) => ({
              id: image.id,
              sha256: image.sha256,
              ...optional('fileName', image.fileName),
            })),
          };
        }),
      builds: this.state.builds.map((build) => ({
        id: build.id,
        buildNumber: build.buildNumber,
        state: build.state,
        ...optional('version', build.version),
      })),
      testerGroups: this.state.testerGroups.map((group) => ({
        id: group.id,
        name: group.name,
        track: group.track,
        kind: this.store === 'apple' ? ('individuals' as const) : ('google_groups' as const),
        members: [...group.members],
      })),
      tracks: this.state.tracks.map((track) => ({
        track: track.track,
        state: track.state,
        buildNumbers: [...track.buildNumbers],
        ...optional('userFraction', track.userFraction),
        ...optional('halted', track.halted),
        ...(track.notes === undefined ? {} : { notes: track.notes.map((note) => ({ ...note })) }),
      })),
      // Google's app pricing has no API: the honest snapshot reports a gap, not a value.
      ...(this.store === 'apple' ? { pricing: { ...this.state.pricing } } : {}),
      ...(this.state.phasedRelease === undefined
        ? {}
        : { phasedRelease: { ...this.state.phasedRelease } }),
      products: [...this.state.products.values()]
        .sort((a, b) => a.productId.localeCompare(b.productId))
        .map((product) => this.toRemoteProduct(product)),
      ...(this.store === 'apple' && this.state.ageRating !== undefined
        ? {
            ageRating: {
              id: this.state.ageRating.id,
              answers: { ...this.state.ageRating.answers },
            },
          }
        : {}),
      ...(this.store === 'google' && this.state.dataSafety !== undefined
        ? { dataSafety: { ...this.state.dataSafety } }
        : {}),
      gaps:
        this.store === 'google'
          ? [
              {
                area: 'pricing',
                reason: 'App pricing and country availability are console-only on Google Play.',
                kind: 'no_api' as const,
                pendingId: 'google:pricing-and-countries',
              },
            ]
          : [],
      pending,
    };
  }

  // --- op implementations, shared by the direct methods and applyBatch ------------------

  private opResult(
    operation: OperationId,
    changed: boolean,
    extra: Partial<OpResult> = {},
  ): OpResult {
    return { ok: true, store: this.store, operation, changed, dryRun: false, ...extra };
  }

  /** Apple's "create the version if it is not there"; a no-op when it already is. */
  private applyEnsureVersion(spec: VersionSpec): OpResult {
    const existing = this.state.versions.find((version) => version.version === spec.version);
    if (existing !== undefined) {
      const editable = existing.state === 'draft' || existing.state === 'rejected';
      if (!editable) {
        throw new AgentshipError(
          ERROR_CODES.STORE_CONFLICT,
          `Version ${spec.version} is ${existing.state}; it is not editable.`,
          { store: this.store },
        );
      }
      let changed = false;
      if (spec.releaseStrategy !== undefined && existing.releaseStrategy !== spec.releaseStrategy) {
        existing.releaseStrategy = spec.releaseStrategy;
        changed = true;
      }
      if (spec.copyright !== undefined && existing.copyright !== spec.copyright) {
        existing.copyright = spec.copyright;
        changed = true;
      }
      if (changed) this.effects.versionCreates += 1;
      return this.opResult('ensureVersion', changed, { details: { versionId: existing.id } });
    }
    const created: MockVersion = {
      id: this.mintId('v'),
      version: spec.version,
      state: 'draft',
      track: 'production',
      ...optional('releaseStrategy', spec.releaseStrategy),
      ...optional('copyright', spec.copyright),
    };
    this.state.versions.push(created);
    this.effects.versionCreates += 1;
    return this.opResult('ensureVersion', true, { details: { versionId: created.id } });
  }

  private applyMetadata(changes: MetadataChanges): OpResult {
    let changed = false;
    for (const locale of changes.locales) {
      const existing = this.state.localizations.get(locale.locale) ?? {};
      const next: MockLocalization = { ...existing };
      const { locale: _locale, ...fields } = locale;
      for (const [field, value] of Object.entries(fields)) {
        if (value !== undefined && next[field as keyof MockLocalization] !== value) {
          next[field as keyof MockLocalization] = value;
          changed = true;
        }
      }
      this.state.localizations.set(locale.locale, next);
    }
    const version = changes.version;
    if (version !== undefined && !this.state.versions.some((v) => v.version === version)) {
      // Both real backends target-or-create an editable version; the mock mirrors that.
      this.state.versions.push({
        id: this.mintId('v'),
        version,
        state: 'draft',
        track: 'production',
      });
      changed = true;
    }
    if (changed) this.effects.metadataWrites += 1;
    return this.opResult('setMetadata', changed);
  }

  /**
   * Declarative image sync, keyed by the SHA-256 the caller computed.
   *
   * Re-running the same plan therefore uploads nothing, which is what lets a screenshots
   * differ converge and what a resume relies on.
   */
  private applyScreenshots(plan: ScreenshotPlan): OpResult {
    let changed = false;
    const warnings: string[] = [];
    for (const set of plan.sets) {
      const key = `${set.locale}|${set.device}|${set.slot ?? 'screenshots'}`;
      const current = this.state.images.get(key) ?? [];
      const wanted = [...set.assets]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.path.localeCompare(b.path))
        .map((asset) => asset.sha256);
      const currentHashes = current.map((image) => image.sha256);
      const same =
        plan.prune === true
          ? currentHashes.length === wanted.length &&
            currentHashes.every((hash, index) => hash === wanted[index])
          : wanted.every((hash) => currentHashes.includes(hash));
      if (same) continue;

      const kept =
        plan.prune === true ? [] : current.filter((image) => !wanted.includes(image.sha256));
      const next: MockImage[] = [
        ...kept,
        ...wanted.map((sha256) => {
          const existing = current.find((image) => image.sha256 === sha256);
          return existing ?? { id: this.mintId('img'), sha256 };
        }),
      ];
      this.state.images.set(key, next);
      changed = true;
      if (plan.prune !== true && kept.length > 0) {
        warnings.push(
          `${set.locale}/${set.device}: ${kept.length} store image(s) were left in place; set assets.prune to remove them.`,
        );
      }
    }
    if (changed) this.effects.imageWrites += 1;
    return this.opResult('syncScreenshots', changed, {
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  }

  /** The track a build is served on, created on first use like Play's own tracks. */
  private track(track: ReleaseTrack): MockTrack {
    const existing = this.state.tracks.find((candidate) => candidate.track === track);
    if (existing !== undefined) return existing;
    const created: MockTrack = { track, buildNumbers: [], state: 'draft' };
    this.state.tracks.push(created);
    return created;
  }

  private applyUpload(artifact: BuildArtifact): { result: OpResult; build: MockBuild } {
    const buildNumber = artifact.buildNumber;
    if (buildNumber === undefined) {
      throw new AgentshipError(
        ERROR_CODES.STORE_VALIDATION_FAILED,
        'The mock store requires an explicit buildNumber on uploads.',
        { store: this.store },
      );
    }
    const existing = this.state.builds.find((build) => build.buildNumber === buildNumber);
    if (existing !== undefined) {
      // Both real stores reject a duplicate build number; this is what makes a
      // double-executed upload loudly visible instead of silently tolerated.
      throw new AgentshipError(
        ERROR_CODES.STORE_CONFLICT,
        `A build with number ${buildNumber} already exists.`,
        { store: this.store },
      );
    }
    const build: MockBuild = {
      id: this.mintId('b'),
      buildNumber,
      ...optional('version', artifact.version),
      state: this.processingTicks > 0 ? 'processing' : 'valid',
      ticksLeft: this.processingTicks,
    };
    this.state.builds.push(build);
    this.effects.uploads += 1;
    return { result: this.opResult('uploadBuild', true), build };
  }

  private applyDistribute(
    buildNumber: string,
    groups: readonly string[],
    track?: ReleaseTrack,
    userFraction?: number,
  ): OpResult {
    const build = this.state.builds.find((candidate) => candidate.buildNumber === buildNumber);
    if (build === undefined) {
      throw new AgentshipError(
        ERROR_CODES.STORE_NOT_FOUND,
        `No build with number ${buildNumber} to distribute.`,
        { store: this.store },
      );
    }
    let changed = false;
    for (const name of groups) {
      const group = this.state.testerGroups.find((candidate) => candidate.name === name);
      if (group === undefined) {
        throw new AgentshipError(ERROR_CODES.STORE_NOT_FOUND, `No tester group named "${name}".`, {
          store: this.store,
        });
      }
      changed = true;
    }
    if (track !== undefined) {
      const target = this.track(track);
      if (!target.buildNumbers.includes(buildNumber)) {
        target.buildNumbers = [buildNumber];
        target.state = 'live';
        changed = true;
      }
      if (userFraction !== undefined && target.userFraction !== userFraction) {
        target.userFraction = userFraction;
        this.state.phasedRelease = {
          track,
          state: userFraction >= 1 ? 'complete' : 'active',
          userFraction,
        };
        changed = true;
      }
    }
    if (changed) this.effects.distributions += 1;
    return this.opResult('distributeToTesters', changed);
  }

  private applyGroups(changes: TesterGroupChanges): OpResult {
    let changed = false;
    for (const spec of changes.groups) {
      const existing = this.state.testerGroups.find((group) => group.name === spec.name);
      if (existing === undefined) {
        this.state.testerGroups.push({
          id: this.mintId('g'),
          name: spec.name,
          track: spec.track,
          members: [...(spec.members ?? [])],
        });
        changed = true;
      } else {
        const members = [...new Set([...existing.members, ...(spec.members ?? [])])];
        if (members.length !== existing.members.length) changed = true;
        existing.members = members;
      }
    }
    if (changed) this.effects.groupWrites += 1;
    return this.opResult('manageTesterGroups', changed);
  }

  private applyPricing(schedule: PricingSchedule): OpResult {
    if (this.store === 'google') {
      // No API: the adapter proposes; a browser-driving agent (or the user) disposes.
      return this.opResult('setPricing', false, {
        pending: [
          {
            id: 'google:pricing-and-countries',
            store: 'google',
            category: 'pricing',
            title: 'Set the app price in Play Console',
            reason: 'The Play Developer API cannot price the app itself.',
            actionClass: 'agent_browser',
            console: { url: 'https://play.google.com/console' },
            fields: [
              {
                name: 'price',
                label: 'Price',
                required: true,
                ...optional('proposedValue', schedule.free === true ? 'Free' : schedule.amount),
              },
            ],
            status: 'open',
          },
        ],
      });
    }
    const next: MockPricing = {
      free: schedule.free ?? false,
      ...optional('amount', schedule.amount),
      ...optional('baseTerritory', schedule.baseTerritory),
    };
    const changed = JSON.stringify(next) !== JSON.stringify(this.state.pricing);
    this.state.pricing = next;
    if (changed) this.effects.pricingWrites += 1;
    return this.opResult('setPricing', changed);
  }

  private applySubmit(submission: SubmissionSpec): { result: OpResult; ref: SubmissionRef } {
    const versionName = submission.version;
    if (versionName === undefined) {
      throw new AgentshipError(
        ERROR_CODES.STORE_VALIDATION_FAILED,
        'The mock store requires an explicit version on submissions.',
        { store: this.store },
      );
    }
    const build = this.requireValidBuild(submission.buildNumber);
    const track = submission.track ?? 'production';
    const result =
      this.store === 'apple'
        ? this.submitApple(versionName, track, build, submission)
        : this.submitGoogle(versionName, track, build, submission);

    this.effects.submits += 1;
    const ref: SubmissionRef = {
      store: this.store,
      id: this.mintId('s'),
      synthetic: this.store === 'google',
      submittedAt: new Date().toISOString(),
    };
    this.state.submissions.push({ id: ref.id, version: versionName, at: ref.submittedAt ?? '' });
    return { result, ref };
  }

  private requireValidBuild(buildNumber: string | undefined): MockBuild | undefined {
    if (buildNumber === undefined) return undefined;
    const build = this.state.builds.find((candidate) => candidate.buildNumber === buildNumber);
    if (build === undefined) {
      throw new AgentshipError(ERROR_CODES.STORE_NOT_FOUND, `No build ${buildNumber} to attach.`, {
        store: this.store,
      });
    }
    if (build.state !== 'valid') {
      throw new AgentshipError(
        ERROR_CODES.STORE_VALIDATION_FAILED,
        `Build ${buildNumber} is still ${build.state}; retry when processing finishes.`,
        { store: this.store, retryable: true },
      );
    }
    return build;
  }

  /** Apple: a submission moves an existing, editable version into review. */
  private submitApple(
    versionName: string,
    track: ReleaseTrack,
    build: MockBuild | undefined,
    submission: SubmissionSpec,
  ): OpResult {
    const version = this.state.versions.find((candidate) => candidate.version === versionName);
    if (version === undefined) {
      throw new AgentshipError(
        ERROR_CODES.STORE_NOT_FOUND,
        `No version ${versionName} to submit.`,
        {
          store: 'apple',
        },
      );
    }
    if (version.state !== 'draft' && version.state !== 'rejected') {
      throw new AgentshipError(
        ERROR_CODES.STORE_CONFLICT,
        `Version ${versionName} is ${version.state}; it cannot be submitted again.`,
        { store: 'apple' },
      );
    }
    if (build !== undefined) version.buildId = build.id;
    version.track = track;
    version.state = 'waiting_review';
    if (submission.holdForDeveloperRelease === true) version.releaseStrategy = 'manual';
    return this.opResult('submitForReview', true);
  }

  /**
   * Google: there is no version resource — committing an edit puts a version code on a
   * track, and that commit *is* the submission unless it says otherwise.
   */
  private submitGoogle(
    versionName: string,
    track: ReleaseTrack,
    build: MockBuild | undefined,
    submission: SubmissionSpec,
  ): OpResult {
    if (!this.state.contentRatingDone) {
      throw new AgentshipError(
        ERROR_CODES.STORE_VALIDATION_FAILED,
        'The content rating questionnaire has not been completed.',
        { store: 'google' },
      );
    }
    const staged = submission.withoutReview === true || this.state.managedPublishing;
    if (this.state.reviewInProgress && !staged) {
      // The Play API answers `changesAlreadyInReview`; committing anyway would cancel the
      // running review, so the mock refuses exactly where the real backend does.
      throw new AgentshipError(
        ERROR_CODES.STORE_CONFLICT,
        'Changes are already in review for this app; committing another edit would cancel that review.',
        {
          store: 'google',
          retryable: false,
          remediation: {
            summary:
              'Wait for the running review to finish, or commit without review by setting release.managedPublishing.',
          },
        },
      );
    }

    const target = this.track(track);
    if (build !== undefined) target.buildNumbers = [build.buildNumber];
    // A testing track goes live on commit; production waits for review.
    const state: VersionState = staged
      ? 'draft'
      : track === 'production'
        ? 'waiting_review'
        : 'live';
    target.state = state;
    if (!staged && track === 'production') this.state.reviewInProgress = true;

    // Play names its releases, and the neutral snapshot models a named release as a
    // version with a track. Recording it keeps `versions` meaningful for Google instead of
    // permanently empty, which is what `getSubmissionStatus` and any release-level differ
    // read.
    const existing = this.state.versions.find((candidate) => candidate.version === versionName);
    if (existing === undefined) {
      this.state.versions.push({
        id: this.mintId('r'),
        version: versionName,
        state,
        track,
        ...(build === undefined ? {} : { buildId: build.id }),
      });
    } else {
      existing.state = state;
      existing.track = track;
      if (build !== undefined) existing.buildId = build.id;
    }
    return this.opResult('submitForReview', true, {
      ...(staged
        ? { warnings: ['Committed without sending to review; a human must publish it.'] }
        : {}),
    });
  }

  private applyPhased(action: PhasedReleaseAction): OpResult {
    const track = action.track ?? 'production';
    const current = this.state.phasedRelease ?? { track, state: 'inactive' as const };
    let next: MockPhasedRelease;
    switch (action.action) {
      case 'start':
        next = {
          track,
          state: 'active',
          userFraction: action.userFraction ?? 0.01,
          dayNumber: 1,
        };
        break;
      case 'pause':
        next = { ...current, track, state: 'paused' };
        break;
      case 'resume':
        next = {
          ...current,
          track,
          state: 'active',
          ...optional('userFraction', action.userFraction ?? current.userFraction),
        };
        break;
      case 'complete':
        next = { track, state: 'complete', userFraction: 1 };
        break;
      case 'cancel':
        next = { track, state: 'inactive' };
        break;
    }

    const unchanged =
      current.state === next.state &&
      current.userFraction === next.userFraction &&
      current.track === next.track;
    if (unchanged)
      return this.opResult('setPhasedRelease', false, { details: { action: action.action } });

    this.state.phasedRelease = next;
    const target = this.state.tracks.find((candidate) => candidate.track === track);
    if (target !== undefined) {
      target.halted = next.state === 'paused';
      if (next.userFraction === undefined) {
        delete target.userFraction;
      } else {
        target.userFraction = next.userFraction;
      }
      if (next.state === 'complete') target.state = 'live';
    }
    this.effects.phasedWrites += 1;
    return this.opResult('setPhasedRelease', true, { details: { action: action.action } });
  }

  private toRemoteProduct(product: MockProduct): RemoteProduct {
    return {
      id: product.id,
      productId: product.productId,
      kind: product.kind,
      ...optional('referenceName', product.referenceName),
      ...optional('groupId', product.group),
      ...optional('displayName', product.displayName),
      ...optional('description', product.description),
      ...optional('period', product.period),
      ...optional('familySharable', product.familySharable),
      state: product.state,
      prices: [...product.prices.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([territory, price]) => ({ territory, price })),
      offers: product.offers.map((offer) => ({ ...offer })),
    };
  }

  /**
   * Creating a product is idempotent by store product id.
   *
   * Both real stores reject a duplicate product id, so a differ that re-created one would
   * fail loudly there and silently corrupt a catalog here. Reporting `changed: false`
   * instead is what makes the convergence tests meaningful.
   */
  private applyCreateProduct(spec: ProductSpec): OpResult {
    const existing = this.state.products.get(spec.productId);
    if (existing !== undefined) {
      return this.opResult('createProduct', false, {
        details: { productId: spec.productId, existed: true },
      });
    }
    const first = spec.localizations?.[0];
    this.state.products.set(spec.productId, {
      id: this.mintId('p'),
      productId: spec.productId,
      kind: spec.kind,
      ...optional('referenceName', spec.referenceName),
      ...optional('displayName', first?.displayName),
      ...optional('description', first?.description),
      ...optional('group', spec.group),
      ...optional('level', spec.level),
      ...optional('period', spec.period),
      ...optional('familySharable', spec.familySharable),
      prices: new Map(),
      offers: [],
      state: 'missing_metadata',
    });
    this.effects.productCreates += 1;
    return this.opResult('createProduct', true, { details: { productId: spec.productId } });
  }

  private applyUpdateProduct(spec: ProductSpec): OpResult {
    const existing = this.requireProduct(spec.productId);
    const first = spec.localizations?.[0];
    const next: MockProduct = {
      ...existing,
      ...optional('referenceName', spec.referenceName),
      ...optional('displayName', first?.displayName),
      ...optional('description', first?.description),
      ...optional('group', spec.group),
      ...optional('level', spec.level),
      ...optional('period', spec.period),
      ...optional('familySharable', spec.familySharable),
    };
    const changed =
      next.referenceName !== existing.referenceName ||
      next.displayName !== existing.displayName ||
      next.description !== existing.description ||
      next.group !== existing.group ||
      next.period !== existing.period ||
      next.familySharable !== existing.familySharable;
    this.state.products.set(spec.productId, next);
    if (changed) this.effects.productUpdates += 1;
    return this.opResult('updateProduct', changed, { details: { productId: spec.productId } });
  }

  private applyProductPricing(pricing: ProductPricingSpec): OpResult {
    const product = this.requireProduct(pricing.productId);
    const wanted = new Map<string, string>([[pricing.baseTerritory, pricing.basePrice]]);
    for (const [territory, price] of Object.entries(pricing.territories ?? {})) {
      wanted.set(territory, price);
    }
    let changed = false;
    for (const [territory, price] of wanted) {
      if (product.prices.get(territory) !== price) {
        product.prices.set(territory, price);
        changed = true;
      }
    }
    if (changed) {
      this.effects.productPriceWrites += 1;
      // Both stores clear the "missing metadata" state once a product has a price.
      product.state = 'ready_to_submit';
    }
    return this.opResult('setProductPricing', changed, {
      details: { productId: pricing.productId, territories: wanted.size },
      ...(pricing.preserveExistingSubscribers === true
        ? { warnings: ['Existing subscribers keep the price they signed up at.'] }
        : {}),
    });
  }

  private applyProductOffers(spec: ProductOffersSpec): OpResult {
    const product = this.requireProduct(spec.productId);
    const wanted: RemoteProductOffer[] = spec.offers.map((offer) => ({
      id: offer.id,
      kind: offer.kind,
      mode: offer.mode,
      duration: offer.duration,
      periods: offer.periods,
    }));
    const same =
      product.offers.length === wanted.length &&
      wanted.every(
        (offer, index) => JSON.stringify(product.offers[index]) === JSON.stringify(offer),
      );
    if (same) return this.opResult('setProductOffers', false);
    product.offers = wanted;
    this.effects.productOfferWrites += 1;
    return this.opResult('setProductOffers', true, {
      details: { productId: spec.productId, offers: wanted.length },
    });
  }

  private requireProduct(productId: string): MockProduct {
    const product = this.state.products.get(productId);
    if (product === undefined) {
      throw new AgentshipError(ERROR_CODES.STORE_NOT_FOUND, `No product "${productId}" exists.`, {
        store: this.store,
      });
    }
    return product;
  }

  private applyAgeRating(declaration: AgeRatingDeclaration): OpResult {
    const current = this.state.ageRating ?? { id: this.mintId('ar'), answers: {} };
    const next = { ...current, answers: { ...current.answers, ...declaration.answers } };
    const changed = JSON.stringify(next.answers) !== JSON.stringify(current.answers);
    this.state.ageRating = next;
    if (changed) this.effects.ageRatingWrites += 1;
    return this.opResult('contentRating', changed);
  }

  private applyDataSafety(declaration: DataSafetyDeclaration): OpResult {
    const changed = this.state.dataSafety?.csv !== declaration.csv;
    this.state.dataSafety = { csv: declaration.csv, updatedAt: new Date().toISOString() };
    if (changed) this.effects.dataSafetyWrites += 1;
    return this.opResult('dataSafety', changed, {
      details: { declaredTypes: declaration.summary.length },
    });
  }

  private mintId(prefix: string): string {
    this.nextId += 1;
    return `${prefix}-${this.nextId}`;
  }

  // --- contract methods -----------------------------------------------------------------

  async ensureVersion(
    _context: AdapterContext,
    _ref: AppRef,
    spec: VersionSpec,
  ): Promise<OpResult> {
    if (this.store === 'google') {
      return this.opResult('ensureVersion', false, {
        warnings: ['Google Play has no version resource; a release carries its own name.'],
      });
    }
    this.maybeFail('ensureVersion', 'before');
    const result = this.applyEnsureVersion(spec);
    this.maybeFail('ensureVersion', 'after');
    return result;
  }

  async setMetadata(
    _context: AdapterContext,
    _ref: AppRef,
    changes: MetadataChanges,
  ): Promise<OpResult> {
    this.maybeFail('setMetadata', 'before');
    const result = this.applyMetadata(changes);
    this.maybeFail('setMetadata', 'after');
    return result;
  }

  async syncScreenshots(
    _context: AdapterContext,
    _ref: AppRef,
    plan: ScreenshotPlan,
  ): Promise<OpResult> {
    this.maybeFail('syncScreenshots', 'before');
    const result = this.applyScreenshots(plan);
    this.maybeFail('syncScreenshots', 'after');
    return result;
  }

  async uploadBuild(
    _context: AdapterContext,
    _ref: AppRef,
    artifact: BuildArtifact,
  ): Promise<BuildRef> {
    this.maybeFail('uploadBuild', 'before');
    const { build } = this.applyUpload(artifact);
    this.maybeFail('uploadBuild', 'after');
    return {
      store: this.store,
      id: build.id,
      buildNumber: build.buildNumber,
      state: build.state === 'invalid' ? 'invalid' : build.state,
      ...optional('version', build.version),
    };
  }

  async distributeToTesters(
    _context: AdapterContext,
    _ref: AppRef,
    build: BuildRef,
    groups: readonly string[],
  ): Promise<OpResult> {
    this.maybeFail('distributeToTesters', 'before');
    const result = this.applyDistribute(build.buildNumber, groups);
    this.maybeFail('distributeToTesters', 'after');
    return result;
  }

  async manageTesterGroups(
    _context: AdapterContext,
    _ref: AppRef,
    changes: TesterGroupChanges,
  ): Promise<OpResult> {
    this.maybeFail('manageTesterGroups', 'before');
    const result = this.applyGroups(changes);
    this.maybeFail('manageTesterGroups', 'after');
    return result;
  }

  async setPricing(
    _context: AdapterContext,
    _ref: AppRef,
    schedule: PricingSchedule,
  ): Promise<OpResult> {
    this.maybeFail('setPricing', 'before');
    const result = this.applyPricing(schedule);
    this.maybeFail('setPricing', 'after');
    return result;
  }

  async submitForReview(
    _context: AdapterContext,
    _ref: AppRef,
    submission: SubmissionSpec,
  ): Promise<SubmissionRef> {
    this.maybeFail('submitForReview', 'before');
    const { ref } = this.applySubmit(submission);
    this.maybeFail('submitForReview', 'after');
    return ref;
  }

  async getSubmissionStatus(
    _context: AdapterContext,
    _ref: AppRef,
    submission: SubmissionRef,
  ): Promise<SubmissionStatus> {
    const known = this.state.submissions.some((candidate) => candidate.id === submission.id);
    return {
      state: known ? 'waiting_review' : 'unknown',
      confidence: this.store === 'google' ? 'inferred' : 'certain',
    };
  }

  /**
   * Apple answers; Google does not have the endpoint. Mirrors the real adapters, so a test
   * that consumes readiness sees the same asymmetry the product has.
   */
  async submissionReadiness(
    _context: AdapterContext,
    _ref: AppRef,
    _version: string,
  ): Promise<SubmissionReadiness> {
    if (this.store === 'google') {
      return {
        store: 'google',
        supported: false,
        reason: 'Google Play exposes no pre-submission readiness check.',
        blockers: [],
      };
    }
    return { store: 'apple', supported: true, blockers: [...this.state.submissionBlockers] };
  }

  async setPhasedRelease(
    _context: AdapterContext,
    _ref: AppRef,
    action: PhasedReleaseAction,
  ): Promise<OpResult> {
    this.maybeFail('setPhasedRelease', 'before');
    const result = this.applyPhased(action);
    this.maybeFail('setPhasedRelease', 'after');
    return result;
  }

  async listProducts(): Promise<ProductSummary[]> {
    return [...this.state.products.values()]
      .sort((a, b) => a.productId.localeCompare(b.productId))
      .map((product) => this.toRemoteProduct(product));
  }

  async getProductState(
    _context: AdapterContext,
    _ref: AppRef,
    productId: string,
  ): Promise<RemoteProduct | undefined> {
    const product = this.state.products.get(productId);
    return product === undefined ? undefined : this.toRemoteProduct(product);
  }

  async createProduct(
    _context: AdapterContext,
    _ref: AppRef,
    product: ProductSpec,
  ): Promise<OpResult> {
    this.maybeFail('createProduct', 'before');
    const result = this.applyCreateProduct(product);
    this.maybeFail('createProduct', 'after');
    return result;
  }

  async updateProduct(
    _context: AdapterContext,
    _ref: AppRef,
    product: ProductSpec,
  ): Promise<OpResult> {
    this.maybeFail('updateProduct', 'before');
    const result = this.applyUpdateProduct(product);
    this.maybeFail('updateProduct', 'after');
    return result;
  }

  async setProductPricing(
    _context: AdapterContext,
    _ref: AppRef,
    pricing: ProductPricingSpec,
  ): Promise<OpResult> {
    this.maybeFail('setProductPricing', 'before');
    const result = this.applyProductPricing(pricing);
    this.maybeFail('setProductPricing', 'after');
    return result;
  }

  async setProductOffers(
    _context: AdapterContext,
    _ref: AppRef,
    offers: ProductOffersSpec,
  ): Promise<OpResult> {
    this.maybeFail('setProductOffers', 'before');
    const result = this.applyProductOffers(offers);
    this.maybeFail('setProductOffers', 'after');
    return result;
  }

  /**
   * A fixed conversion table, so a test can assert on exact proposed prices.
   *
   * The numbers are arbitrary on purpose — what matters is that a conversion is a *proposal*
   * the differ must put in a diff before anything is applied, and a fixed table makes that
   * assertion deterministic.
   */
  async convertPrice(
    _context: AdapterContext,
    _ref: AppRef,
    basePrice: string,
    baseTerritory: string,
  ): Promise<PriceConversion> {
    const base = Number.parseFloat(basePrice);
    if (!Number.isFinite(base)) {
      return { baseTerritory, basePrice, prices: [], unavailable: true };
    }
    const factors: readonly [string, number, string][] = [
      ['GB', 0.9, 'GBP'],
      ['JP', 150, 'JPY'],
      ['MX', 18, 'MXN'],
    ];
    return {
      baseTerritory,
      basePrice,
      prices: [
        { territory: baseTerritory, price: base.toFixed(2), currency: 'USD' },
        ...factors.map(([territory, factor, currency]) => ({
          territory,
          price: (base * factor).toFixed(2),
          currency,
        })),
      ],
    };
  }

  async applyBatch(
    context: AdapterContext,
    ref: AppRef,
    ops: readonly BatchOp[],
    options?: BatchOptions,
  ): Promise<BatchResult> {
    return this.store === 'google'
      ? this.applyBatchAtomic(context, ref, ops, options)
      : this.applyBatchSequential(ops, options);
  }

  /** Apple semantics: ops run in order, each one its own non-atomic transaction. */
  private applyBatchSequential(ops: readonly BatchOp[], options?: BatchOptions): BatchResult {
    const stopOnError = options?.stopOnError ?? true;
    const dryRun = options?.dryRun ?? false;
    const results: BatchOpResult[] = [];
    const transactions: BatchTransaction[] = [];
    const pending: PendingOperation[] = [];
    const builds: BuildRef[] = [];
    let failedAt: number | undefined;

    ops.forEach((op, index) => {
      if (failedAt !== undefined && stopOnError) {
        results.push(this.skippedResult(op, index, dryRun));
        transactions.push({
          id: `t-${index}`,
          opIndexes: [index],
          atomic: false,
          committed: false,
        });
        return;
      }
      try {
        const result = dryRun
          ? { ...this.validateOp(op), dryRun: true }
          : this.executeOp(op, builds);
        results.push({ ...result, index });
        pending.push(...(result.pending ?? []));
        transactions.push({
          id: `t-${index}`,
          opIndexes: [index],
          atomic: false,
          committed: !dryRun,
        });
      } catch (cause) {
        const error = AgentshipError.from(ERROR_CODES.STORE_VALIDATION_FAILED, 'Op failed.', cause);
        results.push({
          ok: false,
          store: this.store,
          operation: operationOf(op),
          changed: false,
          dryRun,
          index,
          errorCode: error.code,
          errorMessage: error.message,
        });
        transactions.push({
          id: `t-${index}`,
          opIndexes: [index],
          atomic: false,
          committed: false,
        });
        failedAt ??= index;
      }
    });

    return {
      ok: failedAt === undefined,
      store: this.store,
      dryRun,
      results,
      transactions,
      pending,
      ...optional('failedAt', failedAt),
      ...(builds.length > 0 ? { builds } : {}),
    };
  }

  /**
   * Ops that do **not** travel inside a Play edit.
   *
   * Monetisation lives in its own REST resources (`inappproducts`,
   * `monetization.subscriptions`) and Data Safety in another; none of them is part of an
   * edit, so none of them shares the edit's all-or-nothing commit. Modelling them as edit
   * members would be worse than inaccurate — it would make a create-then-price batch fail
   * validation, because the product does not exist yet when the edit validates.
   */
  private static readonly NON_EDIT_OPS: ReadonlySet<BatchOp['op']> = new Set<BatchOp['op']>([
    'create_product',
    'update_product',
    'set_product_pricing',
    'set_product_offers',
    'set_data_safety',
  ]);

  /** Google semantics: one edit; validate everything, then commit all-or-nothing. */
  private applyBatchAtomic(
    context: AdapterContext,
    ref: AppRef,
    ops: readonly BatchOp[],
    options?: BatchOptions,
  ): BatchResult {
    const dryRun = options?.dryRun ?? false;
    const editOps = ops.filter((op) => !MockStoreAdapter.NON_EDIT_OPS.has(op.op));
    if (editOps.length !== ops.length) {
      return this.applyBatchMixed(context, ref, ops, options);
    }
    const allIndexes = ops.map((_, index) => index);

    // Validate phase: any invalid op discards the whole edit; nothing is applied.
    for (const [index, op] of ops.entries()) {
      try {
        this.validateOp(op);
      } catch (cause) {
        const error = AgentshipError.from(
          ERROR_CODES.STORE_VALIDATION_FAILED,
          'Validation failed.',
          cause,
        );
        return {
          ok: false,
          store: this.store,
          dryRun,
          results: ops.map((candidate, candidateIndex) =>
            candidateIndex === index
              ? {
                  ok: false,
                  store: this.store,
                  operation: operationOf(candidate),
                  changed: false,
                  dryRun,
                  index: candidateIndex,
                  errorCode: error.code,
                  errorMessage: error.message,
                }
              : this.skippedResult(candidate, candidateIndex, dryRun),
          ),
          transactions: [{ id: 'edit-1', opIndexes: allIndexes, atomic: true, committed: false }],
          pending: [],
          failedAt: index,
        };
      }
    }

    if (dryRun) {
      return {
        ok: true,
        store: this.store,
        dryRun: true,
        results: ops.map((op, index) => ({ ...this.validateOp(op), dryRun: true, index })),
        transactions: [{ id: 'edit-1', opIndexes: allIndexes, atomic: true, committed: false }],
        pending: [],
      };
    }

    this.maybeFail('commit', 'before');
    const results: BatchOpResult[] = [];
    const pending: PendingOperation[] = [];
    const builds: BuildRef[] = [];
    for (const [index, op] of ops.entries()) {
      // No per-op failure hooks here: a committed Google edit is all-or-nothing, so
      // failures are injected at `validate` (per op, phase `before`) or at `commit`.
      const result = this.performOp(op, builds);
      results.push({ ...result, index });
      pending.push(...(result.pending ?? []));
    }
    this.effects.edits += 1;
    // The commit landed; a failure here reaches the caller *after* the store changed.
    this.maybeFail('commit', 'after');

    return {
      ok: true,
      store: this.store,
      dryRun: false,
      results,
      transactions: [{ id: 'edit-1', opIndexes: allIndexes, atomic: true, committed: true }],
      pending,
      ...(builds.length > 0 ? { builds } : {}),
    };
  }

  /**
   * A Google batch that mixes edit members with resources that are not part of an edit.
   *
   * Each op becomes its own transaction, exactly as the real backend reports it: the ones
   * that would have shared an edit no longer can, because the batch as a whole is not
   * all-or-nothing. Saying so is the point — the kernel decides what is safe to retry from
   * `transactions`, and a false atomicity claim there is what would make a resume unsafe.
   */
  private applyBatchMixed(
    _context: AdapterContext,
    _ref: AppRef,
    ops: readonly BatchOp[],
    options?: BatchOptions,
  ): BatchResult {
    const result = this.applyBatchSequential(ops, options);
    if (!result.dryRun) {
      // One edit per surviving edit member, not one for the batch: mixing a product write
      // into a release means those changes no longer share a commit, and the effect counter
      // has to say so — that count is what the release tests assert on.
      this.effects.edits += result.results.filter(
        (entry) =>
          entry.ok &&
          entry.changed &&
          !MockStoreAdapter.NON_EDIT_OPS.has((ops[entry.index] as BatchOp).op),
      ).length;
    }
    return result;
  }

  private skippedResult(op: BatchOp, index: number, dryRun: boolean): BatchOpResult {
    return {
      ok: false,
      store: this.store,
      operation: operationOf(op),
      changed: false,
      dryRun,
      index,
      skipped: true,
    };
  }

  /** Server-side validation without effects (the Google validate phase, Apple dry runs). */
  private validateOp(op: BatchOp): OpResult {
    this.maybeFail(operationOf(op), 'before');
    switch (op.op) {
      case 'upload_build': {
        const buildNumber = op.artifact.buildNumber;
        if (
          buildNumber !== undefined &&
          this.state.builds.some((build) => build.buildNumber === buildNumber)
        ) {
          throw new AgentshipError(
            ERROR_CODES.STORE_CONFLICT,
            `A build with number ${buildNumber} already exists.`,
            { store: this.store },
          );
        }
        return this.opResult('uploadBuild', true);
      }
      case 'submit_for_review': {
        if (this.store === 'google' && !this.state.contentRatingDone) {
          throw new AgentshipError(
            ERROR_CODES.STORE_VALIDATION_FAILED,
            'The content rating questionnaire has not been completed.',
            { store: this.store },
          );
        }
        if (
          this.store === 'google' &&
          this.state.reviewInProgress &&
          op.submission.withoutReview !== true
        ) {
          throw new AgentshipError(
            ERROR_CODES.STORE_CONFLICT,
            'Changes are already in review for this app; committing another edit would cancel that review.',
            {
              store: 'google',
              retryable: false,
              remediation: {
                summary:
                  'Wait for the running review to finish, or commit without review by setting release.managedPublishing.',
              },
            },
          );
        }
        return this.opResult('submitForReview', true);
      }
      case 'ensure_version': {
        if (this.store === 'google') return this.opResult('ensureVersion', false);
        const existing = this.state.versions.find((version) => version.version === op.spec.version);
        if (existing !== undefined && existing.state !== 'draft' && existing.state !== 'rejected') {
          throw new AgentshipError(
            ERROR_CODES.STORE_CONFLICT,
            `Version ${op.spec.version} is ${existing.state}; it is not editable.`,
            { store: this.store },
          );
        }
        return this.opResult('ensureVersion', existing === undefined);
      }
      case 'set_metadata':
        return this.opResult('setMetadata', true);
      case 'sync_screenshots':
        return this.opResult('syncScreenshots', true);
      case 'distribute_to_testers':
        return this.opResult('distributeToTesters', true);
      case 'manage_tester_groups':
        return this.opResult('manageTesterGroups', true);
      case 'set_pricing':
        return this.opResult('setPricing', true);
      case 'set_phased_release':
        return this.opResult('setPhasedRelease', true);
      case 'create_product':
        return this.opResult('createProduct', !this.state.products.has(op.product.productId));
      case 'update_product':
        this.requireProduct(op.product.productId);
        return this.opResult('updateProduct', true);
      case 'set_product_pricing':
        this.requireProduct(op.pricing.productId);
        return this.opResult('setProductPricing', true);
      case 'set_product_offers':
        this.requireProduct(op.offers.productId);
        return this.opResult('setProductOffers', true);
      case 'set_age_rating':
        return this.opResult('contentRating', true);
      case 'set_data_safety':
        return this.opResult('dataSafety', true);
    }
  }

  private executeOp(op: BatchOp, builds: BuildRef[]): OpResult {
    const operation = operationOf(op);
    this.maybeFail(operation, 'before');
    const result = this.performOp(op, builds);
    this.maybeFail(operation, 'after');
    return result;
  }

  private performOp(op: BatchOp, builds: BuildRef[]): OpResult {
    let result: OpResult;
    switch (op.op) {
      case 'set_metadata':
        result = this.applyMetadata(op.changes);
        break;
      case 'ensure_version':
        result =
          this.store === 'google'
            ? this.opResult('ensureVersion', false, {
                warnings: ['Google Play has no version resource; a release carries its own name.'],
              })
            : this.applyEnsureVersion(op.spec);
        break;
      case 'sync_screenshots':
        result = this.applyScreenshots(op.plan);
        break;
      case 'upload_build': {
        const upload = this.applyUpload(op.artifact);
        result = upload.result;
        builds.push({
          store: this.store,
          id: upload.build.id,
          buildNumber: upload.build.buildNumber,
          state: upload.build.state === 'invalid' ? 'invalid' : upload.build.state,
          ...optional('version', upload.build.version),
        });
        break;
      }
      case 'distribute_to_testers':
        result = this.applyDistribute(op.buildNumber, op.groups, op.track, op.userFraction);
        break;
      case 'manage_tester_groups':
        result = this.applyGroups(op.changes);
        break;
      case 'set_pricing':
        result = this.applyPricing(op.schedule);
        break;
      case 'submit_for_review':
        result = this.applySubmit(op.submission).result;
        break;
      case 'set_phased_release':
        result = this.applyPhased(op.action);
        break;
      case 'create_product':
        result = this.applyCreateProduct(op.product);
        break;
      case 'update_product':
        result = this.applyUpdateProduct(op.product);
        break;
      case 'set_product_pricing':
        result = this.applyProductPricing(op.pricing);
        break;
      case 'set_product_offers':
        result = this.applyProductOffers(op.offers);
        break;
      case 'set_age_rating':
        result = this.applyAgeRating(op.declaration);
        break;
      case 'set_data_safety':
        result = this.applyDataSafety(op.declaration);
        break;
    }
    return result;
  }
}

function operationOf(op: BatchOp): OperationId {
  switch (op.op) {
    case 'ensure_version':
      return 'ensureVersion';
    case 'set_metadata':
      return 'setMetadata';
    case 'sync_screenshots':
      return 'syncScreenshots';
    case 'upload_build':
      return 'uploadBuild';
    case 'distribute_to_testers':
      return 'distributeToTesters';
    case 'manage_tester_groups':
      return 'manageTesterGroups';
    case 'set_pricing':
      return 'setPricing';
    case 'submit_for_review':
      return 'submitForReview';
    case 'set_phased_release':
      return 'setPhasedRelease';
    case 'create_product':
      return 'createProduct';
    case 'update_product':
      return 'updateProduct';
    case 'set_product_pricing':
      return 'setProductPricing';
    case 'set_product_offers':
      return 'setProductOffers';
    case 'set_age_rating':
      return 'contentRating';
    case 'set_data_safety':
      return 'dataSafety';
  }
}
