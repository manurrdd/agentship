import {
  type AdapterContext,
  AgentshipError,
  type AppRef,
  type AppSummary,
  type AuthCheckResult,
  type BatchOp,
  type BatchOpResult,
  type BatchOptions,
  type BatchResult,
  type BatchTransaction,
  type BuildArtifact,
  type BuildRef,
  type CapabilityMap,
  ERROR_CODES,
  type MetadataChanges,
  type OperationId,
  type OpResult,
  type PendingOperation,
  type PhasedReleaseAction,
  type PriceConversion,
  type PricingSchedule,
  type ProductKind,
  type ProductOffersSpec,
  type ProductPricingSpec,
  type ProductSpec,
  type ProductSummary,
  type ReleaseTrack,
  type RemoteAppState,
  type RemoteProduct,
  type ScreenshotPlan,
  type StoreAdapter,
  type SubmissionRef,
  type SubmissionSpec,
  type SubmissionStatus,
  type TesterGroupChanges,
  type ToolRunner,
  type VersionSpec,
} from '@agentship/core';
import { createToolRunner } from '@agentship/toolchain';
import { APPLE_CAPABILITIES, APPLE_PENDING_OPERATIONS } from './capabilities.js';
import { AppleClient } from './client.js';
import { ascCommands } from './commands.js';
import { APPLE_TOOL } from './environment.js';
import {
  convertApplePrice,
  createAppleProduct,
  getAppleProductState,
  setAppleAgeRating,
  setAppleProductOffers,
  setAppleProductPricing,
  updateAppleProduct,
} from './monetization.js';
import {
  distributeAppleBuild,
  ensureAppleVersion,
  getAppleSubmissionStatus,
  manageAppleTesterGroups,
  setAppleMetadata,
  setApplePhasedRelease,
  setApplePricing,
  submitAppleForReview,
  syncAppleScreenshots,
  uploadAppleBuild,
} from './operations.js';
import { getAppleAppState, toAppSummary } from './state.js';

export { APPLE_CAPABILITIES, APPLE_PENDING_OPERATIONS } from './capabilities.js';
export { APPLE_DEVICE_TYPES, ascCommands } from './commands.js';
export * from './differs/index.js';
export { APPLE_TOOL, appleEnv } from './environment.js';
export { classifyAscFailure } from './errors.js';

export interface AppleAdapterOptions {
  /**
   * Overrides how `asc` is executed. Production leaves this unset and gets the
   * toolchain-backed runner, which can only ever hand out a hash-verified binary; the
   * contract tests supply a fixture table instead, so the whole surface is exercised
   * offline.
   */
  readonly runner?: ToolRunner;
  /** Skips the lockfile drift check. Only tests, which pin their own fixture version, set it. */
  readonly skipDriftCheck?: boolean;
}

/**
 * App Store Connect, behind the neutral contract.
 *
 * The backend is `asc`, invoked statelessly: credentials materialise for the duration of a
 * call and are removed afterwards, the tool's own config and keychain sources are cut off,
 * and no login is ever persisted. What Apple exposes only through its web console is not
 * attempted — `asc web ...` would drive an unofficial Apple ID session, password and 2FA
 * included — and comes back as a pending operation instead.
 */
export class AppleAdapter implements StoreAdapter {
  readonly store = 'apple' as const;
  readonly #client: AppleClient;
  readonly #skipDriftCheck: boolean;
  #driftChecked = false;

  constructor(options: AppleAdapterOptions = {}) {
    this.#client = new AppleClient({
      runner: options.runner ?? createToolRunner(APPLE_TOOL),
    });
    this.#skipDriftCheck = options.skipDriftCheck === true;
  }

  capabilities(): CapabilityMap {
    return APPLE_CAPABILITIES;
  }

  knownPendingOperations(): readonly PendingOperation[] {
    return APPLE_PENDING_OPERATIONS;
  }

  async version(context: AdapterContext): Promise<string> {
    return this.#client.version(context);
  }

  /**
   * Verified once per adapter instance, before the first store call.
   *
   * The command table is only true for the pinned version, so a drifted binary must fail
   * loudly rather than silently send the wrong flags to someone's App Store account.
   */
  async #ensureVersion(context: AdapterContext): Promise<void> {
    if (this.#skipDriftCheck || this.#driftChecked) return;
    await this.#client.assertNoDrift(context);
    this.#driftChecked = true;
  }

  async checkAuth(context: AdapterContext): Promise<AuthCheckResult> {
    await this.#ensureVersion(context);
    // The cheapest call that actually proves the key signs a token App Store Connect
    // accepts. `asc auth status` only inspects local configuration and would report
    // success for credentials Apple rejects.
    const result = await this.#client.runRaw(context, ascCommands.appsList({ limit: 1 }));
    if (result.exitCode !== 0) {
      return {
        ok: false,
        detail: result.stderr.split('\n')[0]?.replace(/^Error:\s*/, '') ?? 'asc reported a failure',
      };
    }
    return { ok: true, detail: 'App Store Connect accepted the API key.' };
  }

  async listApps(context: AdapterContext): Promise<AppSummary[]> {
    await this.#ensureVersion(context);
    const resources = await this.#client.list(context, ascCommands.appsList({ paginate: true }));
    return resources.map((resource) => toAppSummary({ store: 'apple', id: resource.id }, resource));
  }

  async getAppState(context: AdapterContext, ref: AppRef): Promise<RemoteAppState> {
    await this.#ensureVersion(context);
    return getAppleAppState(this.#client, context, ref);
  }

  async ensureVersion(context: AdapterContext, ref: AppRef, spec: VersionSpec): Promise<OpResult> {
    await this.#ensureVersion(context);
    return ensureAppleVersion(this.#client, context, ref, spec);
  }

  async setMetadata(
    context: AdapterContext,
    ref: AppRef,
    changes: MetadataChanges,
  ): Promise<OpResult> {
    await this.#ensureVersion(context);
    return setAppleMetadata(this.#client, context, ref, changes);
  }

  async syncScreenshots(
    context: AdapterContext,
    ref: AppRef,
    plan: ScreenshotPlan,
  ): Promise<OpResult> {
    await this.#ensureVersion(context);
    return syncAppleScreenshots(this.#client, context, ref, plan);
  }

  async uploadBuild(
    context: AdapterContext,
    ref: AppRef,
    artifact: BuildArtifact,
  ): Promise<BuildRef> {
    await this.#ensureVersion(context);
    return uploadAppleBuild(this.#client, context, ref, artifact);
  }

  async distributeToTesters(
    context: AdapterContext,
    ref: AppRef,
    build: BuildRef,
    groups: readonly string[],
    track?: ReleaseTrack,
  ): Promise<OpResult> {
    await this.#ensureVersion(context);
    return distributeAppleBuild(this.#client, context, ref, build, groups, track);
  }

  async manageTesterGroups(
    context: AdapterContext,
    ref: AppRef,
    changes: TesterGroupChanges,
  ): Promise<OpResult> {
    await this.#ensureVersion(context);
    return manageAppleTesterGroups(this.#client, context, ref, changes);
  }

  async setPricing(
    context: AdapterContext,
    ref: AppRef,
    schedule: PricingSchedule,
  ): Promise<OpResult> {
    await this.#ensureVersion(context);
    return setApplePricing(this.#client, context, ref, schedule);
  }

  async submitForReview(
    context: AdapterContext,
    ref: AppRef,
    submission: SubmissionSpec,
  ): Promise<SubmissionRef> {
    await this.#ensureVersion(context);
    return submitAppleForReview(this.#client, context, ref, submission);
  }

  async getSubmissionStatus(
    context: AdapterContext,
    _ref: AppRef,
    submission: SubmissionRef,
  ): Promise<SubmissionStatus> {
    await this.#ensureVersion(context);
    return getAppleSubmissionStatus(this.#client, context, submission);
  }

  async setPhasedRelease(
    context: AdapterContext,
    ref: AppRef,
    action: PhasedReleaseAction,
  ): Promise<OpResult> {
    await this.#ensureVersion(context);
    return setApplePhasedRelease(this.#client, context, ref, action);
  }

  async listProducts(context: AdapterContext, ref: AppRef): Promise<ProductSummary[]> {
    await this.#ensureVersion(context);
    const state = await getAppleAppState(this.#client, context, ref);
    return [...state.products];
  }

  async getProductState(
    context: AdapterContext,
    ref: AppRef,
    productId: string,
    kind: ProductKind,
  ): Promise<RemoteProduct | undefined> {
    await this.#ensureVersion(context);
    return getAppleProductState(this.#client, context, ref, productId, kind);
  }

  async createProduct(
    context: AdapterContext,
    ref: AppRef,
    product: ProductSpec,
  ): Promise<OpResult> {
    await this.#ensureVersion(context);
    return createAppleProduct(this.#client, context, ref, product);
  }

  async updateProduct(
    context: AdapterContext,
    ref: AppRef,
    product: ProductSpec,
  ): Promise<OpResult> {
    await this.#ensureVersion(context);
    return updateAppleProduct(this.#client, context, ref, product);
  }

  async setProductPricing(
    context: AdapterContext,
    ref: AppRef,
    pricing: ProductPricingSpec,
  ): Promise<OpResult> {
    await this.#ensureVersion(context);
    return setAppleProductPricing(this.#client, context, ref, pricing);
  }

  async setProductOffers(
    context: AdapterContext,
    ref: AppRef,
    offers: ProductOffersSpec,
  ): Promise<OpResult> {
    await this.#ensureVersion(context);
    return setAppleProductOffers(this.#client, context, ref, offers);
  }

  async convertPrice(
    context: AdapterContext,
    ref: AppRef,
    basePrice: string,
    baseTerritory: string,
  ): Promise<PriceConversion> {
    await this.#ensureVersion(context);
    return convertApplePrice(this.#client, context, ref, basePrice, baseTerritory);
  }

  /**
   * Applies the ops in order.
   *
   * App Store Connect has no transaction: each write lands the moment it is made, and
   * there is nothing to roll back. Rather than pretend otherwise, every op is reported as
   * its own non-atomic transaction, so the kernel knows exactly how far a failed batch got
   * and can resume from there instead of re-running writes that already succeeded.
   */
  async applyBatch(
    context: AdapterContext,
    ref: AppRef,
    ops: readonly BatchOp[],
    options: BatchOptions = {},
  ): Promise<BatchResult> {
    await this.#ensureVersion(context);
    const dryRun = context.dryRun === true || options.dryRun === true;
    const stopOnError = options.stopOnError !== false;
    const runContext: AdapterContext = { ...context, dryRun };

    const results: BatchOpResult[] = [];
    const transactions: BatchTransaction[] = [];
    const pending: PendingOperation[] = [];
    const builds: BuildRef[] = [];
    let submission: SubmissionRef | undefined;
    let failedAt: number | undefined;

    for (const [index, op] of ops.entries()) {
      if (failedAt !== undefined && stopOnError) {
        results.push({
          ...emptyResult(op, index, dryRun),
          ok: false,
          skipped: true,
        });
        transactions.push({
          id: `apple-${index}`,
          opIndexes: [index],
          atomic: false,
          committed: false,
        });
        continue;
      }
      try {
        const outcome = await this.#applyOne(runContext, ref, op, options, builds);
        if (outcome.build !== undefined) builds.push(outcome.build);
        if (outcome.submission !== undefined) submission = outcome.submission;
        if (outcome.result.pending !== undefined) pending.push(...outcome.result.pending);
        results.push({ ...outcome.result, index });
        transactions.push({
          id: `apple-${index}`,
          opIndexes: [index],
          atomic: false,
          committed: !dryRun,
        });
      } catch (error) {
        const agentship = AgentshipError.is(error)
          ? error
          : new AgentshipError(ERROR_CODES.PLAN_STEP_FAILED, String(error), { store: 'apple' });
        failedAt = index;
        results.push({
          ...emptyResult(op, index, dryRun),
          ok: false,
          errorCode: agentship.code,
          errorMessage: agentship.message,
        });
        transactions.push({
          id: `apple-${index}`,
          opIndexes: [index],
          atomic: false,
          committed: false,
        });
        if (!stopOnError) continue;
      }
    }

    return {
      ok: failedAt === undefined,
      store: 'apple',
      dryRun,
      results,
      transactions,
      pending,
      ...(failedAt === undefined ? {} : { failedAt }),
      ...(builds.length === 0 ? {} : { builds }),
      ...(submission === undefined ? {} : { submission }),
    };
  }

  async #applyOne(
    context: AdapterContext,
    ref: AppRef,
    op: BatchOp,
    options: BatchOptions,
    builds: readonly BuildRef[],
  ): Promise<{ result: OpResult; build?: BuildRef; submission?: SubmissionRef }> {
    switch (op.op) {
      case 'ensure_version':
        return { result: await this.ensureVersion(context, ref, op.spec) };
      case 'set_metadata':
        return { result: await this.setMetadata(context, ref, op.changes) };
      case 'sync_screenshots':
        return { result: await this.syncScreenshots(context, ref, op.plan) };
      case 'upload_build': {
        const build = await this.uploadBuild(context, ref, op.artifact);
        return {
          build,
          result: {
            ok: true,
            store: 'apple',
            operation: 'uploadBuild',
            changed: context.dryRun !== true,
            dryRun: context.dryRun === true,
            details: { buildNumber: build.buildNumber, state: build.state },
          },
        };
      }
      case 'distribute_to_testers': {
        // A build uploaded earlier in this same batch is the common case; falling back to
        // a lookup keeps the op usable on its own.
        const build =
          builds.find((candidate) => candidate.buildNumber === op.buildNumber) ??
          (await this.#lookupBuild(context, ref, op.buildNumber));
        return {
          result: await this.distributeToTesters(context, ref, build, op.groups, op.track),
        };
      }
      case 'manage_tester_groups':
        return { result: await this.manageTesterGroups(context, ref, op.changes) };
      case 'set_pricing':
        return { result: await this.setPricing(context, ref, op.schedule) };
      case 'set_phased_release':
        return { result: await this.setPhasedRelease(context, ref, op.action) };
      case 'create_product':
        return { result: await this.createProduct(context, ref, op.product) };
      case 'update_product':
        return { result: await this.updateProduct(context, ref, op.product) };
      case 'set_product_pricing':
        return { result: await this.setProductPricing(context, ref, op.pricing) };
      case 'set_product_offers':
        return { result: await this.setProductOffers(context, ref, op.offers) };
      case 'set_age_rating':
        return { result: await setAppleAgeRating(this.#client, context, ref, op.declaration) };
      case 'set_data_safety':
        // Data Safety is a Google concept; the capability table already reports it as
        // unsupported, so reaching here means a differ addressed the wrong store.
        throw new AgentshipError(
          ERROR_CODES.STORE_UNSUPPORTED_OPERATION,
          'The App Store has no Data Safety form; Apple App Privacy is console-only.',
          { store: 'apple' },
        );
      case 'submit_for_review': {
        if (options.holdForReview === true) {
          return {
            result: {
              ok: true,
              store: 'apple',
              operation: 'submitForReview',
              changed: false,
              dryRun: context.dryRun === true,
              warnings: ['holdForReview was set, so the version was prepared but not submitted.'],
            },
          };
        }
        const ref_ = await this.submitForReview(context, ref, op.submission);
        return {
          submission: ref_,
          result: {
            ok: true,
            store: 'apple',
            operation: 'submitForReview',
            changed: context.dryRun !== true,
            dryRun: context.dryRun === true,
            details: { submissionId: ref_.id },
          },
        };
      }
    }
  }

  async #lookupBuild(context: AdapterContext, ref: AppRef, buildNumber: string): Promise<BuildRef> {
    const state = await this.getAppState(context, ref);
    const build = state.builds.find((candidate) => candidate.buildNumber === buildNumber);
    if (build === undefined) {
      throw new AgentshipError(
        ERROR_CODES.STORE_NOT_FOUND,
        `Build ${buildNumber} does not exist for this app.`,
        { store: 'apple', details: { appId: ref.id, buildNumber } },
      );
    }
    return {
      store: 'apple',
      id: build.id,
      buildNumber: build.buildNumber,
      ...(build.version === undefined ? {} : { version: build.version }),
      state: build.state,
    };
  }
}

const OPERATION_BY_BATCH_OP: Readonly<Record<BatchOp['op'], OperationId>> = {
  ensure_version: 'ensureVersion',
  set_metadata: 'setMetadata',
  sync_screenshots: 'syncScreenshots',
  upload_build: 'uploadBuild',
  distribute_to_testers: 'distributeToTesters',
  manage_tester_groups: 'manageTesterGroups',
  set_pricing: 'setPricing',
  set_phased_release: 'setPhasedRelease',
  submit_for_review: 'submitForReview',
  create_product: 'createProduct',
  update_product: 'updateProduct',
  set_product_pricing: 'setProductPricing',
  set_product_offers: 'setProductOffers',
  set_age_rating: 'contentRating',
  set_data_safety: 'dataSafety',
};

function emptyResult(op: BatchOp, index: number, dryRun: boolean): BatchOpResult {
  return {
    ok: true,
    store: 'apple',
    operation: OPERATION_BY_BATCH_OP[op.op],
    changed: false,
    dryRun,
    index,
  };
}

/** Convenience factory matching the shape later packages use to build adapters. */
export function createAppleAdapter(options: AppleAdapterOptions = {}): StoreAdapter {
  return new AppleAdapter(options);
}
