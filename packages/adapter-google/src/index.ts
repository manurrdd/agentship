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
  optional,
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
  type SubmissionReadiness,
  type SubmissionRef,
  type SubmissionSpec,
  type SubmissionStatus,
  type TesterGroupChanges,
  type ToolRunner,
  type VersionSpec,
} from '@agentship/core';
import { createToolRunner } from '@agentship/toolchain';
import { GOOGLE_CAPABILITIES, GOOGLE_PENDING_OPERATIONS } from './capabilities.js';
import { GoogleClient } from './client.js';
import { type CommitFlags, gpcCommands } from './commands.js';
import { GOOGLE_TOOL } from './environment.js';
import { parseGpcFailure } from './errors.js';
import {
  convertGooglePrice,
  createGoogleProduct,
  getGoogleProductState,
  setGoogleDataSafety,
  setGoogleProductOffers,
  setGoogleProductPricing,
  updateGoogleProduct,
} from './monetization.js';
import {
  distributeGoogleBuild,
  getGoogleSubmissionStatus,
  googleTrack,
  manageGoogleTesterGroups,
  setGoogleMetadata,
  setGooglePhasedRelease,
  setGooglePricing,
  submitGoogleForReview,
  syncGoogleImages,
  uploadGoogleBuild,
} from './operations.js';
import { getGoogleAppState } from './state.js';

export { GOOGLE_CAPABILITIES, GOOGLE_PENDING_OPERATIONS } from './capabilities.js';
export {
  GOOGLE_SCREENSHOT_TYPES,
  GOOGLE_SLOT_TYPES,
  GOOGLE_TRACKS,
  gpcCommands,
} from './commands.js';
export * from './differs/index.js';
export { GOOGLE_TOOL, googleEnv } from './environment.js';
export { classifyGpcFailure, parseGpcFailure } from './errors.js';

export interface GoogleAdapterOptions {
  /** Overrides how `gpc` is executed. Tests supply a fixture table; production does not. */
  readonly runner?: ToolRunner;
  readonly skipDriftCheck?: boolean;
}

/**
 * Google Play, behind the neutral contract.
 *
 * The backend is `gpc`, invoked statelessly. Two properties of the Play API shape
 * everything here:
 *
 * - **Every change is an edit.** Insert, mutate, validate, commit — atomically, or discard.
 *   `gpc` runs that cycle inside each mutating command, including a guaranteed discard on
 *   failure, so an Agentship batch is a sequence of edits rather than one; which ops share an
 *   edit is reported in {@link BatchResult.transactions} instead of being assumed.
 * - **Only one edit may be open per app.** Every invocation for a package therefore goes
 *   through a per-package lane in {@link GoogleClient}, and a batch holds that lane for its
 *   whole duration.
 */
export class GoogleAdapter implements StoreAdapter {
  readonly store = 'google' as const;
  readonly #client: GoogleClient;
  readonly #skipDriftCheck: boolean;
  #driftChecked = false;

  constructor(options: GoogleAdapterOptions = {}) {
    this.#client = new GoogleClient({
      runner: options.runner ?? createToolRunner(GOOGLE_TOOL),
    });
    this.#skipDriftCheck = options.skipDriftCheck === true;
  }

  capabilities(): CapabilityMap {
    return GOOGLE_CAPABILITIES;
  }

  knownPendingOperations(): readonly PendingOperation[] {
    return GOOGLE_PENDING_OPERATIONS;
  }

  async version(context: AdapterContext): Promise<string> {
    return this.#client.version(context);
  }

  async #ensureVersion(context: AdapterContext): Promise<void> {
    if (this.#skipDriftCheck || this.#driftChecked) return;
    await this.#client.assertNoDrift(context);
    this.#driftChecked = true;
  }

  /**
   * Proves the service account can reach the Play API.
   *
   * There is no account-level endpoint to call, so the check needs an app: without one it
   * can only report that credentials were loaded, which is exactly the false confidence
   * `gpc auth status` gives when it silently falls back to a developer's personal
   * Application Default Credentials.
   */
  async checkAuth(context: AdapterContext, ref?: AppRef): Promise<AuthCheckResult> {
    await this.#ensureVersion(context);
    if (ref === undefined) {
      // Not a rejection: the check simply cannot be performed without an app. Reporting
      // "the store rejected it" here would blame a credential nobody has tested.
      return {
        status: 'unverifiable',
        ok: false,
        detail:
          'Google Play has no account-level endpoint, so credentials can only be verified against a specific app. Supply a package name.',
      };
    }
    const result = await this.#client.withPackageLock(ref.id, () =>
      this.#client.runRaw(context, gpcCommands.tracksList(ref.id)),
    );
    if (result.exitCode !== 0) {
      // An app-not-found answer is authenticated: Play only says "no such app" to a caller
      // whose credentials it accepted (an invalid key fails with an auth error instead).
      // The credential works; the app is just not created or not linked to this service
      // account yet — so this is a working credential with an unverifiable target, never a
      // rejection.
      const failure = parseGpcFailure(result.stderr);
      if (failure.code === 'API_APP_NOT_FOUND') {
        return {
          status: 'ok',
          ok: true,
          detail: `Google Play accepted the service account, but has no app named ${ref.id} visible to it yet — create the app in Play Console (or grant the service account access to it), then verify again.`,
        };
      }
      return { status: 'rejected', ok: false, detail: firstLine(result.stderr) };
    }
    return {
      status: 'ok',
      ok: true,
      account: ref.id,
      detail: 'Google Play accepted the service account.',
    };
  }

  /**
   * Google publishes no endpoint that lists a developer account's apps.
   *
   * Returning an empty array would read as "you have no apps", which is worse than saying
   * the platform cannot answer.
   */
  async listApps(_context: AdapterContext): Promise<AppSummary[]> {
    throw new AgentshipError(
      ERROR_CODES.STORE_UNSUPPORTED_OPERATION,
      'The Google Play Developer API cannot list the apps in a developer account; a package name must be supplied.',
      {
        store: 'google',
        remediation: {
          summary:
            "Give Agentship the package name (it is the `applicationId` in the app's Gradle configuration), or read it from Play Console.",
          docsUrl: 'https://play.google.com/console',
        },
      },
    );
  }

  async getAppState(context: AdapterContext, ref: AppRef): Promise<RemoteAppState> {
    await this.#ensureVersion(context);
    return this.#client.withPackageLock(ref.id, () =>
      getGoogleAppState(this.#client, context, ref),
    );
  }

  /**
   * Google Play has no version resource: a release carries its own name, and nothing has to
   * exist before an edit can reference it. Reporting that as a no-op with a warning is the
   * honest answer; the capability table already says `unsupported`, so no plan drafts it.
   */
  async ensureVersion(
    _context: AdapterContext,
    _ref: AppRef,
    spec: VersionSpec,
  ): Promise<OpResult> {
    return {
      ok: true,
      store: 'google',
      operation: 'ensureVersion',
      changed: false,
      dryRun: false,
      warnings: [
        `Google Play has no version resource, so there is nothing to create for ${spec.version}; the release name carries it.`,
      ],
    };
  }

  async setMetadata(
    context: AdapterContext,
    ref: AppRef,
    changes: MetadataChanges,
  ): Promise<OpResult> {
    await this.#ensureVersion(context);
    return this.#client.withPackageLock(ref.id, () =>
      setGoogleMetadata(this.#client, context, ref, changes),
    );
  }

  async syncScreenshots(
    context: AdapterContext,
    ref: AppRef,
    plan: ScreenshotPlan,
  ): Promise<OpResult> {
    await this.#ensureVersion(context);
    return this.#client.withPackageLock(ref.id, () =>
      syncGoogleImages(this.#client, context, ref, plan),
    );
  }

  async uploadBuild(
    context: AdapterContext,
    ref: AppRef,
    artifact: BuildArtifact,
  ): Promise<BuildRef> {
    await this.#ensureVersion(context);
    return this.#client.withPackageLock(ref.id, () =>
      uploadGoogleBuild(this.#client, context, ref, artifact),
    );
  }

  async distributeToTesters(
    context: AdapterContext,
    ref: AppRef,
    build: BuildRef,
    groups: readonly string[],
    track?: ReleaseTrack,
  ): Promise<OpResult> {
    await this.#ensureVersion(context);
    return this.#client.withPackageLock(ref.id, () =>
      distributeGoogleBuild(this.#client, context, ref, build, groups, track),
    );
  }

  async manageTesterGroups(
    context: AdapterContext,
    ref: AppRef,
    changes: TesterGroupChanges,
  ): Promise<OpResult> {
    await this.#ensureVersion(context);
    return this.#client.withPackageLock(ref.id, () =>
      manageGoogleTesterGroups(this.#client, context, ref, changes),
    );
  }

  async setPricing(
    context: AdapterContext,
    ref: AppRef,
    schedule: PricingSchedule,
  ): Promise<OpResult> {
    return setGooglePricing(this.#client, context, ref, schedule);
  }

  async submitForReview(
    context: AdapterContext,
    ref: AppRef,
    submission: SubmissionSpec,
  ): Promise<SubmissionRef> {
    await this.#ensureVersion(context);
    return this.#client.withPackageLock(ref.id, () =>
      submitGoogleForReview(this.#client, context, ref, submission),
    );
  }

  async getSubmissionStatus(
    context: AdapterContext,
    ref: AppRef,
    submission: SubmissionRef,
  ): Promise<SubmissionStatus> {
    await this.#ensureVersion(context);
    return this.#client.withPackageLock(ref.id, () =>
      getGoogleSubmissionStatus(this.#client, context, ref, submission),
    );
  }

  /**
   * Play has no pre-submission readiness endpoint.
   *
   * `gpc validate` checks a *bundle file* — signing, permissions, size — which is a different
   * question from "would Play accept this release". What Play refuses is reported when the
   * edit is committed, and the App content answers behind most refusals have no read API at
   * all (see the state gaps). Saying so is the honest answer; an empty list of blockers would
   * read as "nothing is wrong".
   */
  async submissionReadiness(
    _context: AdapterContext,
    _ref: AppRef,
    _version: string,
  ): Promise<SubmissionReadiness> {
    return {
      store: 'google',
      supported: false,
      reason:
        'Google Play exposes no pre-submission readiness check: refusals surface when the edit is committed, and the App content declarations behind most of them cannot be read back at all.',
      blockers: [],
    };
  }

  async setPhasedRelease(
    context: AdapterContext,
    ref: AppRef,
    action: PhasedReleaseAction,
  ): Promise<OpResult> {
    await this.#ensureVersion(context);
    return this.#client.withPackageLock(ref.id, () =>
      setGooglePhasedRelease(this.#client, context, ref, action),
    );
  }

  async getProductState(
    context: AdapterContext,
    ref: AppRef,
    productId: string,
    kind: ProductKind,
  ): Promise<RemoteProduct | undefined> {
    await this.#ensureVersion(context);
    return getGoogleProductState(this.#client, context, ref, productId, kind);
  }

  async createProduct(
    context: AdapterContext,
    ref: AppRef,
    product: ProductSpec,
  ): Promise<OpResult> {
    await this.#ensureVersion(context);
    return createGoogleProduct(this.#client, context, ref, product);
  }

  async updateProduct(
    context: AdapterContext,
    ref: AppRef,
    product: ProductSpec,
  ): Promise<OpResult> {
    await this.#ensureVersion(context);
    return updateGoogleProduct(this.#client, context, ref, product);
  }

  async setProductPricing(
    context: AdapterContext,
    ref: AppRef,
    pricing: ProductPricingSpec,
  ): Promise<OpResult> {
    await this.#ensureVersion(context);
    return setGoogleProductPricing(this.#client, context, ref, pricing);
  }

  async setProductOffers(
    context: AdapterContext,
    ref: AppRef,
    offers: ProductOffersSpec,
  ): Promise<OpResult> {
    await this.#ensureVersion(context);
    return setGoogleProductOffers(this.#client, context, ref, offers);
  }

  async convertPrice(
    context: AdapterContext,
    ref: AppRef,
    basePrice: string,
    baseTerritory: string,
  ): Promise<PriceConversion> {
    await this.#ensureVersion(context);
    return convertGooglePrice(this.#client, context, ref, basePrice, baseTerritory);
  }

  async listProducts(context: AdapterContext, ref: AppRef): Promise<ProductSummary[]> {
    const state = await this.getAppState(context, ref);
    return [...state.products];
  }

  /**
   * Applies the ops, grouping what Google can commit together.
   *
   * `gpc` opens and commits one Play edit per command, so atomicity is per invocation, not
   * per batch. Agentship maximises it where the platform allows: a metadata change across
   * every locale is one `listings push` and therefore one edit; an image sync across every
   * locale, device and slot is one `images sync` and therefore one edit. What cannot share
   * an edit — a build upload, a rollout change, a release-notes update — is its own
   * transaction, and the result says so rather than implying a batch-wide guarantee that
   * does not exist.
   *
   * The whole batch holds the package's lane, so no other Agentship call can open a competing
   * edit while it runs.
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
    // `holdForReview` means "commit, but do not send to review" — the one Play switch that
    // separates staging a change from submitting it.
    const commit: CommitFlags = { ...optional('withoutReview', options.holdForReview) };

    return this.#client.withPackageLock(ref.id, async () => {
      const results: BatchOpResult[] = [];
      const transactions: BatchTransaction[] = [];
      const pending: PendingOperation[] = [];
      const builds: BuildRef[] = [];
      let submission: SubmissionRef | undefined;
      let failedAt: number | undefined;

      for (const [index, op] of ops.entries()) {
        if (failedAt !== undefined && stopOnError) {
          results.push({ ...emptyResult(op, index, dryRun), ok: false, skipped: true });
          transactions.push(transaction(index, false));
          continue;
        }
        try {
          const outcome = await this.#applyOne(runContext, ref, op, commit, builds);
          if (outcome.build !== undefined) builds.push(outcome.build);
          if (outcome.submission !== undefined) submission = outcome.submission;
          if (outcome.result.pending !== undefined) pending.push(...outcome.result.pending);
          results.push({ ...outcome.result, index });
          transactions.push(transaction(index, !dryRun && outcome.result.changed, outcome.atomic));
        } catch (error) {
          const agentship = AgentshipError.is(error)
            ? error
            : new AgentshipError(ERROR_CODES.PLAN_STEP_FAILED, String(error), { store: 'google' });
          failedAt = index;
          results.push({
            ...emptyResult(op, index, dryRun),
            ok: false,
            errorCode: agentship.code,
            errorMessage: agentship.message,
          });
          // The edit is already gone: `gpc` discards it on any failure, so nothing is left
          // half-applied and nothing is left open to block the next call.
          transactions.push(transaction(index, false));
          if (!stopOnError) continue;
        }
      }

      return {
        ok: failedAt === undefined,
        store: 'google' as const,
        dryRun,
        results,
        transactions,
        pending,
        ...optional('failedAt', failedAt),
        ...(builds.length === 0 ? {} : { builds }),
        ...optional('submission', submission),
      };
    });
  }

  async #applyOne(
    context: AdapterContext,
    ref: AppRef,
    op: BatchOp,
    commit: CommitFlags,
    builds: readonly BuildRef[],
  ): Promise<{
    result: OpResult;
    atomic: boolean;
    build?: BuildRef;
    submission?: SubmissionRef;
  }> {
    switch (op.op) {
      case 'ensure_version':
        return { result: await this.ensureVersion(context, ref, op.spec), atomic: true };
      case 'set_metadata': {
        const result = await setGoogleMetadata(this.#client, context, ref, op.changes, commit);
        // One `listings push` is atomic across every locale; a `whatsNew` change adds one
        // edit per locale, so the op as a whole stops being all-or-nothing.
        const atomic = !op.changes.locales.some((locale) => locale.whatsNew !== undefined);
        return { result, atomic };
      }
      case 'sync_screenshots':
        return {
          result: await syncGoogleImages(this.#client, context, ref, op.plan, commit),
          atomic: true,
        };
      case 'upload_build': {
        const build = await uploadGoogleBuild(this.#client, context, ref, op.artifact, commit);
        return {
          build,
          atomic: true,
          result: {
            ok: true,
            store: 'google',
            operation: 'uploadBuild',
            changed: context.dryRun !== true,
            dryRun: context.dryRun === true,
            details: { versionCode: build.buildNumber },
          },
        };
      }
      case 'distribute_to_testers': {
        const build =
          builds.find((candidate) => candidate.buildNumber === op.buildNumber) ??
          ({
            store: 'google' as const,
            id: op.buildNumber,
            buildNumber: op.buildNumber,
            state: 'valid' as const,
          } satisfies BuildRef);
        return {
          result: await distributeGoogleBuild(
            this.#client,
            context,
            ref,
            build,
            op.groups,
            op.track,
            commit,
            op.userFraction,
          ),
          // Adding testers and assigning the release are two commands, so two edits.
          atomic: op.groups.length === 0,
        };
      }
      case 'manage_tester_groups':
        return {
          result: await manageGoogleTesterGroups(this.#client, context, ref, op.changes, commit),
          atomic: op.changes.groups.length <= 1,
        };
      case 'set_pricing':
        return {
          result: await setGooglePricing(this.#client, context, ref, op.schedule),
          atomic: true,
        };
      case 'set_phased_release':
        return {
          result: await setGooglePhasedRelease(this.#client, context, ref, op.action, commit),
          atomic: true,
        };
      case 'submit_for_review': {
        const spec: SubmissionSpec = {
          ...op.submission,
          ...optional(
            'withoutReview',
            commit.withoutReview === true ? true : op.submission.withoutReview,
          ),
        };
        const created = await submitGoogleForReview(this.#client, context, ref, spec);
        return {
          submission: created,
          atomic: true,
          result: {
            ok: true,
            store: 'google',
            operation: 'submitForReview',
            changed: context.dryRun !== true,
            dryRun: context.dryRun === true,
            details: {
              submissionId: created.id,
              track: googleTrack(op.submission.track ?? 'production'),
              sentForReview: commit.withoutReview !== true && op.submission.withoutReview !== true,
            },
          },
        };
      }
      case 'create_product':
        return { result: await this.createProduct(context, ref, op.product), atomic: true };
      case 'update_product':
        return { result: await this.updateProduct(context, ref, op.product), atomic: true };
      case 'set_product_pricing':
        return { result: await this.setProductPricing(context, ref, op.pricing), atomic: true };
      case 'set_product_offers':
        return { result: await this.setProductOffers(context, ref, op.offers), atomic: true };
      case 'set_data_safety':
        return {
          result: await setGoogleDataSafety(this.#client, context, ref, op.declaration),
          atomic: true,
        };
      case 'set_age_rating':
        // Google's content rating is the IARC questionnaire, which has no API at all; the
        // capability table already says so, and reaching here means a differ picked the
        // wrong store.
        throw new AgentshipError(
          ERROR_CODES.STORE_UNSUPPORTED_OPERATION,
          'Google Play content ratings are issued by IARC through a console questionnaire.',
          { store: 'google' },
        );
    }
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
    store: 'google',
    operation: OPERATION_BY_BATCH_OP[op.op],
    changed: false,
    dryRun,
    index,
  };
}

function transaction(index: number, committed: boolean, atomic = false): BatchTransaction {
  return { id: `google-edit-${index}`, opIndexes: [index], atomic, committed };
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? 'gpc reported a failure'
  );
}

/** Convenience factory matching the shape later packages use to build adapters. */
export function createGoogleAdapter(options: GoogleAdapterOptions = {}): StoreAdapter {
  return new GoogleAdapter(options);
}
