import type { AdapterContext, StoreAdapter } from '../adapter.js';
import { AgentshipError, ERROR_CODES } from '../errors.js';
import { optional } from '../optional.js';
import type { AppRef } from '../store-state.js';
import type { PendingOperation, Store } from '../types.js';
import { loadAnalysis } from './analysis-store.js';
import { checkApprovals } from './approvals.js';
import type { DifferProposals, DifferRegistry } from './differ.js';
import type { ChaosHook, DryRunLevel, ExecutionResult, LocalRunnerMap } from './executor.js';
import { executePlan } from './executor.js';
import { openJournal, readJournal, summarizeJournal } from './journal.js';
import { acquireProjectLock } from './lock.js';
import type { AgentshipManifest } from './manifest.js';
import { isNeedsInput, loadManifest } from './manifest.js';
import type { PendingVerifierMap, VerifyPendingResult } from './pending.js';
import {
  completePending,
  getPending,
  listPending,
  mergePendingOperations,
  verifyPending,
} from './pending.js';
import type { ReleasePlan, StorePlanInput } from './plan.js';
import { buildPlan, loadPlan, savePlan } from './plan.js';
import type { StoredSnapshot } from './snapshot.js';
import { captureSnapshot, loadSnapshot } from './snapshot.js';

/**
 * The kernel: the single entry point everything else builds on.
 *
 * `plan` captures fresh snapshots and produces a {@link ReleasePlan}. `apply` re-captures,
 * replans, matches approvals against the fresh plan (which is how drift invalidates them),
 * and executes under the project lock with write-ahead journaling. `resume` is `apply`
 * against whatever the journal and the store say is left to do — there is no separate
 * resume bookkeeping, because the fresh snapshot is always the authority on progress.
 */
export interface KernelOptions {
  readonly repoRoot: string;
  readonly adapters: ReadonlyMap<Store, StoreAdapter>;
  readonly context: AdapterContext;
  readonly registry: DifferRegistry;
  readonly verifiers?: PendingVerifierMap;
  /** Runners for actions performed on this machine (`build` is the only one). */
  readonly localRunners?: LocalRunnerMap;
}

export interface PlanOptions {
  /** Stores to plan; defaults to every store both configured and present in the manifest. */
  readonly stores?: readonly Store[];
}

export interface ApplyOptions {
  /** Id of the plan the caller saw. Must match the stored plan (guards stale callers). */
  readonly planId: string;
  /** Action ids the human approved. Stale ones are reported, never executed. */
  readonly approvals?: readonly string[];
  readonly dryRun?: DryRunLevel;
  readonly stopOnError?: boolean;
  /** Test-only crash injection; see {@link ChaosHook}. */
  readonly chaos?: ChaosHook;
}

export interface ApplyResult extends ExecutionResult {
  /** Id of the fresh plan that was actually executed. */
  readonly planId: string;
  /** Id the caller passed in; differs from `planId` when replanning changed content. */
  readonly requestedPlanId: string;
  /** Stores whose state changed since the plan the caller approved against. */
  readonly driftDetected: readonly Store[];
  /** Approvals that no longer match any current action content. */
  readonly staleApprovals: readonly string[];
  readonly warnings: readonly string[];
  /** The fresh plan, so callers can re-present remaining approvals without replanning. */
  readonly plan: ReleasePlan;
}

export class Kernel {
  private readonly repoRoot: string;
  private readonly adapters: ReadonlyMap<Store, StoreAdapter>;
  private readonly context: AdapterContext;
  private readonly registry: DifferRegistry;
  private readonly verifiers: PendingVerifierMap;
  private readonly localRunners: LocalRunnerMap;

  constructor(options: KernelOptions) {
    this.repoRoot = options.repoRoot;
    this.adapters = options.adapters;
    this.context = options.context;
    this.registry = options.registry;
    this.verifiers = options.verifiers ?? new Map();
    this.localRunners = options.localRunners ?? new Map();
  }

  /** Loads the manifest, captures fresh snapshots and produces the current plan. */
  async plan(options: PlanOptions = {}): Promise<ReleasePlan> {
    const manifest = await loadManifest(this.repoRoot);
    const stores = this.selectStores(manifest, options.stores);
    const inputs: StorePlanInput[] = [];
    for (const store of stores) {
      const adapter = this.adapter(store);
      const snapshot = await captureSnapshot(
        adapter,
        this.context,
        this.ref(manifest, store),
        this.repoRoot,
      );
      inputs.push({
        store,
        state: snapshot.state,
        capabilities: adapter.capabilities(),
        knownPending: adapter.knownPendingOperations(),
        proposals: this.proposals(adapter, snapshot.state.ref),
      });
    }
    const analysis = await loadAnalysis(this.repoRoot);
    const plan = await buildPlan({
      repoRoot: this.repoRoot,
      manifest,
      registry: this.registry,
      stores: inputs,
      ...optional('analysis', analysis),
    });
    await savePlan(this.repoRoot, plan);
    await mergePendingOperations(this.repoRoot, plan.pending);
    return plan;
  }

  /**
   * Executes the current plan under the project lock.
   *
   * The sequence is fixed and load-bearing: read the journal, then re-capture snapshots,
   * then replan. Because every snapshot postdates every journal intent, an orphan intent
   * whose effect landed is invisible in the fresh plan (nothing to do), and one whose
   * effect did not land shows up again as a plain action — verification by query, not by
   * trusting the journal.
   */
  async apply(options: ApplyOptions): Promise<ApplyResult> {
    const lock = await acquireProjectLock(this.repoRoot);
    try {
      const stored = await loadPlan(this.repoRoot);
      if (stored === undefined || stored.planId !== options.planId) {
        throw new AgentshipError(
          ERROR_CODES.PLAN_NOT_FOUND,
          stored === undefined
            ? 'No plan exists for this project.'
            : `Plan "${options.planId}" is not the current plan ("${stored.planId}").`,
          { remediation: { summary: 'Run plan again and review the new actions.' } },
        );
      }

      const warnings: string[] = [];
      const journalRead = await readJournal(this.repoRoot);
      warnings.push(...journalRead.warnings);
      const journalSummary = journalRead.corrupt
        ? new Map()
        : summarizeJournal(journalRead.entries);

      const manifest = await loadManifest(this.repoRoot);
      const driftDetected: Store[] = [];
      const inputs: StorePlanInput[] = [];
      for (const store of stored.stores) {
        const adapter = this.adapter(store);
        const snapshot = await captureSnapshot(
          adapter,
          this.context,
          this.ref(manifest, store),
          this.repoRoot,
        );
        const planned = stored.snapshots[store];
        if (planned !== undefined && planned.fingerprint !== snapshot.fingerprint) {
          driftDetected.push(store);
        }
        inputs.push({
          store,
          state: snapshot.state,
          capabilities: adapter.capabilities(),
          knownPending: adapter.knownPendingOperations(),
          proposals: this.proposals(adapter, snapshot.state.ref),
        });
      }

      const analysis = await loadAnalysis(this.repoRoot);
      const fresh = await buildPlan({
        repoRoot: this.repoRoot,
        manifest,
        registry: this.registry,
        stores: inputs,
        ...optional('analysis', analysis),
      });
      await savePlan(this.repoRoot, fresh);

      for (const state of journalSummary.values()) {
        if (!state.orphanIntent) continue;
        const stillPlanned = fresh.actions.some((action) => action.id === state.actionId);
        warnings.push(
          stillPlanned
            ? `Interrupted action ${state.actionId}: the store shows no effect; it will run again.`
            : `Interrupted action ${state.actionId}: the store confirms it (or it became moot); not re-executing.`,
        );
      }

      const approvalCheck = checkApprovals(fresh, options.approvals ?? []);
      const merged = await mergePendingOperations(this.repoRoot, fresh.pending);
      const pendingById = new Map(merged.map((operation) => [operation.id, operation]));

      const journal = await openJournal(this.repoRoot);
      const previousAttempts = new Map<string, number>();
      for (const [actionId, state] of journalSummary) {
        const attempt = state.lastIntent?.attempt ?? state.lastResult?.attempt;
        if (attempt !== undefined) previousAttempts.set(actionId, attempt);
      }

      const execution = await executePlan({
        plan: fresh,
        approvalCheck,
        adapters: this.adapters,
        refs: this.refs(manifest, fresh.stores),
        context: this.context,
        journal,
        repoRoot: this.repoRoot,
        localRunners: this.localRunners,
        previousAttempts,
        pendingStatus: (id) => pendingById.get(id)?.status,
        ...optional('dryRun', options.dryRun),
        ...optional('stopOnError', options.stopOnError),
        ...optional('chaos', options.chaos),
      });

      if (execution.emittedPending.length > 0) {
        await mergePendingOperations(this.repoRoot, execution.emittedPending);
      }

      return {
        ...execution,
        planId: fresh.planId,
        requestedPlanId: options.planId,
        driftDetected,
        staleApprovals: approvalCheck.stale,
        warnings,
        plan: fresh,
      };
    } finally {
      await lock.release();
    }
  }

  /** Resumes the current plan: `apply` against whatever remains to be done. */
  async resume(options: Omit<ApplyOptions, 'planId'> = {}): Promise<ApplyResult> {
    const stored = await loadPlan(this.repoRoot);
    if (stored === undefined) {
      throw new AgentshipError(ERROR_CODES.PLAN_NOT_FOUND, 'No plan exists to resume.', {
        remediation: { summary: 'Run plan first.' },
      });
    }
    return this.apply({ ...options, planId: stored.planId });
  }

  /** Captures and persists a fresh snapshot of one store. */
  async captureState(store: Store): Promise<StoredSnapshot> {
    const manifest = await loadManifest(this.repoRoot);
    return captureSnapshot(
      this.adapter(store),
      this.context,
      this.ref(manifest, store),
      this.repoRoot,
    );
  }

  /** Last persisted snapshot of one store, without touching the network. */
  async lastSnapshot(store: Store): Promise<StoredSnapshot | undefined> {
    return loadSnapshot(this.repoRoot, store);
  }

  async listPending(): Promise<readonly PendingOperation[]> {
    return listPending(this.repoRoot);
  }

  async getPending(id: string): Promise<PendingOperation> {
    return getPending(this.repoRoot, id);
  }

  async completePending(id: string, notes?: string): Promise<PendingOperation> {
    return completePending(this.repoRoot, id, notes);
  }

  async verifyPending(id: string): Promise<VerifyPendingResult> {
    const manifest = await loadManifest(this.repoRoot);
    const stores = this.selectStores(manifest);
    return verifyPending({
      repoRoot: this.repoRoot,
      id,
      adapters: this.adapters,
      context: this.context,
      refs: this.refs(manifest, stores),
      verifiers: this.verifiers,
      manifest,
    });
  }

  private selectStores(
    manifest: AgentshipManifest,
    requested?: readonly Store[],
  ): readonly Store[] {
    const declared: Store[] = [];
    if (manifest.stores.apple !== undefined) declared.push('apple');
    if (manifest.stores.google !== undefined) declared.push('google');
    const configured = declared.filter((store) => this.adapters.has(store));
    if (requested === undefined) return configured;
    const unknown = requested.filter((store) => !configured.includes(store));
    if (unknown.length > 0) {
      throw new AgentshipError(
        ERROR_CODES.PLAN_CONFLICT,
        `Requested store(s) ${unknown.join(', ')} are not declared in the manifest (or have no adapter).`,
      );
    }
    return requested;
  }

  /**
   * The read-only questions a differ may ask this store.
   *
   * Only the price conversion, and only through this narrow object: a differ that could
   * reach the adapter could write, and planning would stop being a description of what would
   * happen. See {@link DifferProposals}.
   */
  private proposals(adapter: StoreAdapter, ref: AppRef): DifferProposals {
    return {
      convertPrice: (basePrice, baseTerritory) =>
        adapter.convertPrice(this.context, ref, basePrice, baseTerritory),
    };
  }

  private adapter(store: Store): StoreAdapter {
    const adapter = this.adapters.get(store);
    if (adapter === undefined) {
      throw new AgentshipError(
        ERROR_CODES.PLAN_CONFLICT,
        `No ${store} adapter is configured for this kernel.`,
      );
    }
    return adapter;
  }

  private refs(manifest: AgentshipManifest, stores: readonly Store[]): ReadonlyMap<Store, AppRef> {
    return new Map(stores.map((store) => [store, this.ref(manifest, store)]));
  }

  private ref(manifest: AgentshipManifest, store: Store): AppRef {
    if (store === 'apple') {
      const apple = manifest.stores.apple;
      if (apple === undefined || isNeedsInput(apple.bundleId)) {
        throw manifestRefError('stores.apple.bundleId');
      }
      if (apple.appId === undefined || isNeedsInput(apple.appId)) {
        throw manifestRefError(
          'stores.apple.appId',
          'Set it once the app record exists in App Store Connect (see the create-app pending operation).',
        );
      }
      return { store, id: apple.appId, bundleId: apple.bundleId, platform: 'ios' };
    }
    const google = manifest.stores.google;
    if (google === undefined || isNeedsInput(google.packageName)) {
      throw manifestRefError('stores.google.packageName');
    }
    return { store, id: google.packageName, bundleId: google.packageName, platform: 'android' };
  }
}

function manifestRefError(path: string, extra?: string): AgentshipError {
  return new AgentshipError(
    ERROR_CODES.PLAN_INPUT_REQUIRED,
    `The manifest does not identify the app: "${path}" is missing or needs input.`,
    { remediation: { summary: extra ?? `Fill in ${path} in .agentship/agentship.yaml.` } },
  );
}
