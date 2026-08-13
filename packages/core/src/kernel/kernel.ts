import type { AdapterContext, StoreAdapter } from '../adapter.js';
import { AgentshipError, ERROR_CODES } from '../errors.js';
import { optional } from '../optional.js';
import type { AppRef, SubmissionReadiness } from '../store-state.js';
import type { PendingOperation, Store } from '../types.js';
import { loadAnalysis } from './analysis-store.js';
import { type ApprovalCheck, checkApprovals } from './approvals.js';
import type { DifferProposals, DifferRegistry } from './differ.js';
import type { ChaosHook, DryRunLevel, ExecutionResult, LocalRunnerMap } from './executor.js';
import { executePlan } from './executor.js';
import { openJournal, readJournal, summarizeJournal } from './journal.js';
import { acquireProjectLock } from './lock.js';
import type { AgentshipManifest } from './manifest.js';
import { isNeedsInput, loadManifest, setManifestValue } from './manifest.js';
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
    const refNotes: string[] = [];
    const inputs: StorePlanInput[] = [];
    for (const store of stores) {
      const adapter = this.adapter(store);
      const snapshot = await captureSnapshot(
        adapter,
        this.context,
        await this.ensureRef(manifest, store, refNotes),
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
    const built = await buildPlan({
      repoRoot: this.repoRoot,
      manifest,
      registry: this.registry,
      stores: inputs,
      ...optional('analysis', analysis),
    });
    const plan: ReleasePlan =
      refNotes.length === 0 ? built : { ...built, warnings: [...built.warnings, ...refNotes] };
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
          await this.ensureRef(manifest, store, warnings),
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

      const approvalCheck = withdrawOnDrift(
        checkApprovals(fresh, options.approvals ?? []),
        fresh,
        driftDetected,
      );
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

      // Record where the stores stand *after* this run, so the next apply's drift check
      // measures what someone else did rather than what Agentship just did. The plan was
      // saved with snapshots taken before execution; leaving them there made every
      // successful apply look like external drift to the one after it, which withdrew
      // approvals the user had given for work Agentship itself had just completed.
      if (execution.outcomes.some((outcome) => outcome.changed === true)) {
        await savePlan(this.repoRoot, {
          ...fresh,
          snapshots: await this.currentSnapshots(manifest, fresh.stores, fresh.snapshots),
        });
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

  /**
   * Fresh fingerprints for the stores a plan touched, keeping the old ones where a store
   * cannot be read. A snapshot that fails here must not erase the reference point the next
   * drift check needs — losing it would make the next apply see no drift at all.
   */
  private async currentSnapshots(
    manifest: AgentshipManifest,
    stores: readonly Store[],
    previous: ReleasePlan['snapshots'],
  ): Promise<ReleasePlan['snapshots']> {
    const snapshots: Record<string, unknown> = { ...previous };
    for (const store of stores) {
      try {
        const snapshot = await captureSnapshot(
          this.adapter(store),
          this.context,
          await this.ensureRef(manifest, store, []),
          this.repoRoot,
        );
        snapshots[store] = {
          capturedAt: snapshot.state.capturedAt,
          fingerprint: snapshot.fingerprint,
        };
      } catch {
        // Keep the previous fingerprint: an unreadable store is not "unchanged".
      }
    }
    return snapshots as ReleasePlan['snapshots'];
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
      await this.ensureRef(manifest, store, []),
      this.repoRoot,
    );
  }

  /** Last persisted snapshot of one store, without touching the network. */
  async lastSnapshot(store: Store): Promise<StoredSnapshot | undefined> {
    return loadSnapshot(this.repoRoot, store);
  }

  /**
   * What the store itself says still blocks a submission.
   *
   * Never throws: a readiness report is an *extra* opinion on top of the plan, so a store
   * that cannot be reached (no app record yet, credentials for the other store only) must
   * degrade to "could not ask" rather than fail the plan that carries it.
   */
  async submissionReadiness(store: Store): Promise<SubmissionReadiness> {
    const manifest = await loadManifest(this.repoRoot);
    try {
      const ref = await this.ensureRef(manifest, store, []);
      return await this.adapter(store).submissionReadiness(
        this.context,
        ref,
        manifest.release.version,
      );
    } catch (error) {
      return {
        store,
        supported: false,
        reason: `Agentship could not ask the ${store} store: ${AgentshipError.is(error) ? error.message : String(error)}`,
        blockers: [],
      };
    }
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

  async verifyPending(
    ids: readonly string[],
    onProgress?: (message: string) => void | Promise<void>,
  ): Promise<readonly VerifyPendingResult[]> {
    const manifest = await loadManifest(this.repoRoot);
    // Only the stores the operations belong to need a ref: verifying a Google pending must
    // not fail because the Apple half of the manifest still lacks its app id. Each id's
    // store comes from the persisted operation, whose prefix ("apple:"/"google:") it echoes.
    const operations = await Promise.all(ids.map(async (id) => getPending(this.repoRoot, id)));
    const refs = new Map<Store, AppRef>();
    for (const store of new Set(operations.map((operation) => operation.store))) {
      if (!this.adapters.has(store)) continue;
      try {
        refs.set(store, await this.ensureRef(manifest, store, []));
      } catch {
        // No resolvable ref: verifyPending reports it gracefully instead of throwing.
      }
    }
    return verifyPending({
      repoRoot: this.repoRoot,
      ids,
      adapters: this.adapters,
      context: this.context,
      refs,
      verifiers: this.verifiers,
      manifest,
      ...(onProgress === undefined ? {} : { onProgress }),
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

  /**
   * The ref for one store, resolving a missing Apple app id from the store itself.
   *
   * An App Store Connect app id is a fact the store already knows — asking the user for it
   * when the bundle id is in the manifest and credentials are configured is pure friction.
   * So when `stores.apple.appId` is absent (or still the sentinel) and the adapter can
   * search by bundle id, the kernel looks it up once, persists it into the manifest with a
   * provenance comment, and reports what it did through `notes`. No network is touched when
   * the app id is already present, and an empty or failed lookup falls back to the original
   * `PLAN_INPUT_REQUIRED` — whose remediation is then genuinely the right next step.
   */
  private async ensureRef(
    manifest: AgentshipManifest,
    store: Store,
    notes: string[],
  ): Promise<AppRef> {
    if (store === 'apple') {
      const apple = manifest.stores.apple;
      if (
        apple !== undefined &&
        !isNeedsInput(apple.bundleId) &&
        (apple.appId === undefined || isNeedsInput(apple.appId))
      ) {
        const adapter = this.adapters.get('apple');
        if (adapter?.findApp !== undefined) {
          let found: { id: string; name: string } | undefined;
          try {
            found = await adapter.findApp(this.context, apple.bundleId);
          } catch {
            // Unreachable store or missing credentials: fall through to the normal error,
            // whose remediation tells the user what to fill in by hand.
            found = undefined;
          }
          if (found !== undefined) {
            const date = new Date().toISOString().slice(0, 10);
            await setManifestValue(
              this.repoRoot,
              ['stores', 'apple', 'appId'],
              found.id,
              ` resolved from App Store Connect by bundle id ${apple.bundleId} on ${date}`,
            );
            apple.appId = found.id;
            notes.push(
              `Resolved stores.apple.appId to ${found.id} ("${found.name}") from App Store Connect by bundle id ${apple.bundleId}, and saved it to .agentship/agentship.yaml.`,
            );
          }
        }
      }
    }
    return this.ref(manifest, store);
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

/**
 * Withdraws approvals for a store that moved under the user's feet.
 *
 * Someone editing the listing in the console while a plan is being applied is a different
 * situation from Agentship's own writes landing one after another, and only the first is a
 * reason to ask the user again: their colleague may have made that change deliberately, and
 * the diff they approved is no longer the diff they would see.
 *
 * This used to happen by accident. An action id hashed the store's *current* value as well
 * as the target, so any movement rotated the id and the approval stopped matching. That
 * caught external drift — and equally caught Agentship's own sequential applies, sending
 * users back to re-approve wording nothing had touched. The id now hashes only what the
 * action will make true, so the drift rule has to be stated rather than fall out of a hash.
 */
function withdrawOnDrift(
  check: ApprovalCheck,
  plan: ReleasePlan,
  drifted: readonly Store[],
): ApprovalCheck {
  if (drifted.length === 0) return check;
  const affected = new Set(
    plan.actions
      .filter((action) => drifted.includes(action.store))
      .map((action) => action.id)
      .filter((id) => check.valid.has(id)),
  );
  if (affected.size === 0) return check;
  return {
    valid: new Set([...check.valid].filter((id) => !affected.has(id))),
    stale: [...check.stale, ...affected].sort(),
    unknown: check.unknown,
    missing: [...new Set([...check.missing, ...affected])].sort(),
  };
}

function manifestRefError(path: string, extra?: string): AgentshipError {
  return new AgentshipError(
    ERROR_CODES.PLAN_INPUT_REQUIRED,
    `The manifest does not identify the app: "${path}" is missing or needs input.`,
    { remediation: { summary: extra ?? `Fill in ${path} in .agentship/agentship.yaml.` } },
  );
}
