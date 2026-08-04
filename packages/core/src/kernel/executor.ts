import type { AdapterContext, StoreAdapter } from '../adapter.js';
import { AgentshipError, type AgentshipErrorCode, ERROR_CODES } from '../errors.js';
import { optional } from '../optional.js';
import type { BatchOp } from '../store-ops.js';
import type { AppRef } from '../store-state.js';
import type { PendingOperation, PendingStatus, Store } from '../types.js';
import type { ApprovalCheck } from './approvals.js';
import { isApproved } from './approvals.js';
import { archiveDeclaration, DATA_SAFETY_ARCHIVE } from './archive.js';
import type { LocalOp } from './differ.js';
import type { JournalWriter } from './journal.js';
import { pendingSatisfied } from './pending.js';
import type { PlannedAction, ReleasePlan } from './plan.js';

/**
 * Executes a {@link ReleasePlan} with write-ahead journaling.
 *
 * The executor walks the plan's topological order and turns every maximal run of
 * consecutive executable same-store actions into one `applyBatch` call. For Google that
 * is the difference between one Play edit and several; for Apple it changes nothing
 * semantically (each op is its own transaction) but keeps the code path single.
 *
 * The journal discipline is absolute: every op gets an `intent` record on disk before
 * the adapter is called, and a `result` after. An error the adapter reports is caught,
 * journaled and turned into an outcome; anything else (a crash, an injected kill) is
 * deliberately not caught — it leaves orphan intents behind, which is exactly the state
 * resume is designed to recover from.
 */
export type DryRunLevel = 'local' | 'server';

/**
 * Test-only hook: called at the two crash-critical points around an adapter call. A
 * throwing hook simulates a process kill at that point. Production code never sets it.
 */
export type ChaosPoint = 'after_intent' | 'before_result';
export type ChaosHook = (point: ChaosPoint, actionId: string) => void;

/** What a local runner reports back; the shape of an {@link OpResult} minus the store. */
export interface LocalActionResult {
  readonly ok: boolean;
  readonly changed: boolean;
  readonly detail?: string;
  readonly warnings?: readonly string[];
  readonly pending?: readonly PendingOperation[];
  readonly errorCode?: AgentshipErrorCode;
  readonly errorMessage?: string;
}

export interface LocalActionInput {
  readonly action: PlannedAction;
  readonly op: LocalOp;
  readonly repoRoot: string;
  readonly context: AdapterContext;
  /** True under a dry run: produce what would happen, change nothing on disk. */
  readonly dryRun: boolean;
}

/**
 * Performs an action whose effect is on this machine. Registered on the kernel by
 * {@link LocalOp.kind}; there is exactly one today, `build`.
 */
export type LocalActionRunner = (input: LocalActionInput) => Promise<LocalActionResult>;

export type LocalRunnerMap = ReadonlyMap<string, LocalActionRunner>;

export type ActionOutcomeStatus =
  /** Executed (or validated, under dry run) successfully. */
  | 'done'
  /** The store rejected it, or an earlier op in its atomic transaction failed. */
  | 'failed'
  /** Not attempted: an earlier failure stopped the run, or a dependency did not execute. */
  | 'skipped'
  /** Withheld: a pending operation in `blockedBy` is not done yet. */
  | 'blocked'
  /** Withheld: no valid approval covers this `needs_approval` action. */
  | 'needs_approval'
  /** Withheld: the manifest still has `NEEDS_INPUT` sentinels for it. */
  | 'needs_input'
  /** Not an API action: its pending operation was emitted/refreshed instead. */
  | 'pending_emitted';

export interface ActionOutcome {
  readonly actionId: string;
  readonly status: ActionOutcomeStatus;
  readonly changed?: boolean;
  /** True when the platform executed this op inside an all-or-nothing transaction. */
  readonly atomic?: boolean;
  readonly errorCode?: AgentshipErrorCode;
  readonly errorMessage?: string;
  readonly warnings?: readonly string[];
  readonly detail?: string;
}

export interface ExecutionResult {
  readonly ok: boolean;
  readonly outcomes: readonly ActionOutcome[];
  /** Pending operations surfaced by adapters during execution (e.g. Google pricing). */
  readonly emittedPending: readonly PendingOperation[];
  readonly failedActionId?: string;
}

export interface ExecuteInput {
  readonly plan: ReleasePlan;
  readonly approvalCheck: ApprovalCheck;
  readonly adapters: ReadonlyMap<Store, StoreAdapter>;
  readonly refs: ReadonlyMap<Store, AppRef>;
  readonly context: AdapterContext;
  readonly journal: JournalWriter;
  readonly repoRoot: string;
  /** Runners for actions performed on this machine, keyed by {@link LocalOp.kind}. */
  readonly localRunners?: LocalRunnerMap;
  /** Last attempt number per action id, from the journal; 0 when never attempted. */
  readonly previousAttempts: ReadonlyMap<string, number>;
  /** Status of each persisted pending operation, for `blockedBy` gating. */
  readonly pendingStatus: (id: string) => PendingStatus | undefined;
  readonly dryRun?: DryRunLevel;
  /** Stop at the first failure (default) instead of attempting independent actions. */
  readonly stopOnError?: boolean;
  readonly chaos?: ChaosHook;
}

type Decision =
  | { readonly kind: 'execute' }
  | { readonly kind: 'withhold'; readonly status: ActionOutcomeStatus; readonly detail: string };

function decide(
  action: PlannedAction,
  approvalCheck: ApprovalCheck,
  pendingStatus: (id: string) => PendingStatus | undefined,
  decisions: ReadonlyMap<string, Decision>,
): Decision {
  for (const dependencyId of action.dependsOn) {
    const dependency = decisions.get(dependencyId);
    if (dependency !== undefined && dependency.kind === 'withhold') {
      return {
        kind: 'withhold',
        status: 'skipped',
        detail: `Dependency ${dependencyId} will not execute (${dependency.status}).`,
      };
    }
  }
  for (const pendingId of action.blockedBy) {
    const status = pendingStatus(pendingId);
    if (status === undefined || !pendingSatisfied(status)) {
      return {
        kind: 'withhold',
        status: 'blocked',
        detail: `Blocked by pending operation "${pendingId}" (${status ?? 'unknown'}).`,
      };
    }
  }
  if (action.classification === 'needs_input') {
    return {
      kind: 'withhold',
      status: 'needs_input',
      detail: `Missing manifest values: ${(action.needsInput ?? []).join(', ')}.`,
    };
  }
  if (action.classification === 'agent_browser' || action.classification === 'human_only') {
    return {
      kind: 'withhold',
      status: 'pending_emitted',
      detail: `No API path; complete pending operation "${action.pending?.id ?? 'unknown'}".`,
    };
  }
  if (!isApproved(action, approvalCheck)) {
    return {
      kind: 'withhold',
      status: 'needs_approval',
      detail: `Approve action id "${action.id}" to execute it.`,
    };
  }
  if (action.op === undefined && action.local === undefined) {
    return {
      kind: 'withhold',
      status: 'skipped',
      detail: 'The differ attached no executable payload to this action.',
    };
  }
  return { kind: 'execute' };
}

/**
 * One unit of execution: a run of consecutive store actions that share an `applyBatch`, or
 * a single local action. A local action never joins a store batch — it does not travel to
 * an adapter — so it also splits the run around it, which is exactly the ordering a build
 * needs (build, then upload what it produced).
 */
type Unit =
  | { readonly kind: 'store'; readonly store: Store; readonly actions: PlannedAction[] }
  | { readonly kind: 'local'; readonly action: PlannedAction };

/**
 * Groups executable actions into units.
 *
 * With `stopOnError` on (the default) a dependency that fails stops the run, so a dependent
 * may safely share its batch: the adapter skips the rest of the batch after the failure.
 * With `stopOnError` off nothing stops, and an adapter has no way to honour `dependsOn`
 * inside a single `applyBatch` — it does not know the graph. So in that mode a dependent is
 * split into its own unit, which is what lets the executor withhold it once its dependency
 * has actually failed. The cost is smaller batches; the alternative is writing metadata to a
 * version that was never created.
 */
function batchify(
  executable: readonly PlannedAction[],
  splitOnDependency: boolean,
): readonly Unit[] {
  const units: Unit[] = [];
  for (const action of executable) {
    if (action.local !== undefined) {
      units.push({ kind: 'local', action });
      continue;
    }
    const current = units[units.length - 1];
    const joinable =
      current !== undefined &&
      current.kind === 'store' &&
      current.store === action.store &&
      !(splitOnDependency && current.actions.some((a) => action.dependsOn.includes(a.id)));
    if (joinable) {
      (current as { actions: PlannedAction[] }).actions.push(action);
    } else {
      units.push({ kind: 'store', store: action.store, actions: [action] });
    }
  }
  return units;
}

export async function executePlan(input: ExecuteInput): Promise<ExecutionResult> {
  const { plan, approvalCheck, dryRun } = input;
  const stopOnError = input.stopOnError ?? true;
  const outcomes = new Map<string, ActionOutcome>();
  const decisions = new Map<string, Decision>();
  const emittedPending: PendingOperation[] = [];

  for (const action of plan.actions) {
    const decision = decide(action, approvalCheck, input.pendingStatus, decisions);
    decisions.set(action.id, decision);
    if (decision.kind === 'withhold') {
      outcomes.set(action.id, {
        actionId: action.id,
        status: decision.status,
        detail: decision.detail,
      });
    }
  }

  const executable = plan.actions.filter((action) => decisions.get(action.id)?.kind === 'execute');

  if (dryRun === 'local') {
    // Local dry run: the diff already is the answer. No adapter, no journal, no effects.
    for (const action of executable) {
      outcomes.set(action.id, {
        actionId: action.id,
        status: 'done',
        changed: true,
        detail: 'dry-run (local)',
      });
    }
    return finish(plan, outcomes, emittedPending);
  }

  let aborted = false;
  // Actions that failed or were withheld during this run. A dependent of one of these must
  // not execute even when `stopOnError` is off: the plan says it needs the other action's
  // effect, and that effect is not there.
  const unmet = new Set<string>();
  for (const unit of batchify(executable, !stopOnError)) {
    const unitActions = unit.kind === 'local' ? [unit.action] : unit.actions;
    if (aborted) {
      for (const action of unitActions) {
        outcomes.set(action.id, {
          actionId: action.id,
          status: 'skipped',
          detail: 'An earlier action failed and stopOnError is on.',
        });
        unmet.add(action.id);
      }
      continue;
    }

    const blockedDependency = unitActions
      .flatMap((action) => action.dependsOn.filter((id) => unmet.has(id)))
      .at(0);
    if (blockedDependency !== undefined) {
      for (const action of unitActions) {
        outcomes.set(action.id, {
          actionId: action.id,
          status: 'skipped',
          detail: `Dependency ${blockedDependency} did not complete, so this action cannot run.`,
        });
        unmet.add(action.id);
      }
      continue;
    }

    if (unit.kind === 'local') {
      const failed = await runLocal(input, unit.action, outcomes, emittedPending);
      if (failed) {
        unmet.add(unit.action.id);
        if (stopOnError) aborted = true;
      }
      continue;
    }

    const batch = unit;
    const adapter = input.adapters.get(batch.store);
    const ref = input.refs.get(batch.store);
    if (adapter === undefined || ref === undefined) {
      throw new AgentshipError(
        ERROR_CODES.PLAN_CONFLICT,
        `The plan contains ${batch.store} actions but no ${batch.store} adapter is configured.`,
      );
    }

    const ops: BatchOp[] = [];
    const attempts = new Map<string, number>();
    for (const action of batch.actions) {
      const op = action.op as BatchOp;
      ops.push({ ...op, id: action.id });
      attempts.set(action.id, (input.previousAttempts.get(action.id) ?? 0) + 1);
    }

    const journaling = dryRun !== 'server';
    if (journaling) {
      // Write-ahead: every op of the batch is announced before the store hears about any
      // of them. A crash from here on leaves orphan intents, never silent effects.
      for (const action of batch.actions) {
        input.journal.intent({
          planId: plan.planId,
          actionId: action.id,
          idempotencyKey: action.id,
          store: batch.store,
          kind: action.kind,
          attempt: attempts.get(action.id) as number,
        });
        input.chaos?.('after_intent', action.id);
      }
    }

    let failed = false;
    try {
      const result = await adapter.applyBatch(input.context, ref, ops, {
        stopOnError,
        ...(dryRun === 'server' ? { dryRun: true } : {}),
      });

      input.chaos?.('before_result', batch.actions[0]?.id ?? '');

      emittedPending.push(...result.pending);
      const atomicByIndex = new Map<number, boolean>();
      for (const transaction of result.transactions) {
        for (const index of transaction.opIndexes) atomicByIndex.set(index, transaction.atomic);
      }

      // A declaration the store will never read back has to be recorded here, after it
      // landed: Google's Data Safety endpoint has no GET, so the only thing a later plan can
      // compare against is a copy of what was actually applied. It is the kernel's job
      // rather than an adapter's, because it is project state and every adapter — including
      // the mock the tests run against — must produce it identically.
      for (const [index, opResult] of result.results.entries()) {
        if (!opResult.ok || dryRun !== undefined) continue;
        const op = ops[index];
        if (op?.op !== 'set_data_safety') continue;
        await archiveDeclaration({
          repoRoot: input.repoRoot,
          kind: DATA_SAFETY_ARCHIVE,
          document: op.declaration.csv,
          summary: op.declaration.summary,
        });
      }

      result.results.forEach((opResult, index) => {
        const action = batch.actions[index];
        if (action === undefined) return;
        const status: ActionOutcomeStatus =
          opResult.skipped === true ? 'skipped' : opResult.ok ? 'done' : 'failed';
        if (status === 'failed') failed = true;
        if (status !== 'done') unmet.add(action.id);
        if (journaling) {
          input.journal.result({
            planId: plan.planId,
            actionId: action.id,
            idempotencyKey: action.id,
            attempt: attempts.get(action.id) as number,
            status: status === 'done' ? 'done' : status === 'failed' ? 'failed' : 'skipped',
            changed: opResult.changed,
            ...optional('atomic', atomicByIndex.get(index)),
            ...optional('errorCode', opResult.errorCode),
            ...optional('errorMessage', opResult.errorMessage),
          });
        }
        outcomes.set(action.id, {
          actionId: action.id,
          status,
          changed: opResult.changed,
          ...optional('atomic', atomicByIndex.get(index)),
          ...optional('errorCode', opResult.errorCode),
          ...optional('errorMessage', opResult.errorMessage),
          ...optional('warnings', opResult.warnings),
        });
        if (opResult.pending !== undefined) emittedPending.push(...opResult.pending);
      });
    } catch (cause) {
      if (!AgentshipError.is(cause)) throw cause; // crash semantics: leave orphan intents
      failed = true;
      for (const action of batch.actions) {
        unmet.add(action.id);
        if (journaling) {
          input.journal.result({
            planId: plan.planId,
            actionId: action.id,
            idempotencyKey: action.id,
            attempt: attempts.get(action.id) as number,
            status: 'failed',
            errorCode: cause.code,
            errorMessage: cause.message,
          });
        }
        outcomes.set(action.id, {
          actionId: action.id,
          status: 'failed',
          errorCode: cause.code,
          errorMessage: cause.message,
        });
      }
    }

    if (failed && stopOnError) aborted = true;
  }

  return finish(plan, outcomes, emittedPending);
}

/**
 * Runs one local action under the same write-ahead discipline as a store batch.
 *
 * The journal entry is what makes an interrupted build recoverable: on the next `apply` the
 * orphan intent is reported, the differ re-checks the artifact register (and re-hashes the
 * file), and the action either reappears because nothing usable was produced or vanishes
 * because it was. As with the store path, a non-`AgentshipError` throw is left uncaught so a
 * genuine crash keeps crash semantics.
 */
async function runLocal(
  input: ExecuteInput,
  action: PlannedAction,
  outcomes: Map<string, ActionOutcome>,
  emittedPending: PendingOperation[],
): Promise<boolean> {
  const op = action.local as LocalOp;
  const runner = input.localRunners?.get(op.kind);
  if (runner === undefined) {
    outcomes.set(action.id, {
      actionId: action.id,
      status: 'failed',
      errorCode: ERROR_CODES.PLAN_CONFLICT,
      errorMessage: `No runner is registered for local action kind "${op.kind}".`,
    });
    return true;
  }

  const journaling = input.dryRun !== 'server';
  const attempt = (input.previousAttempts.get(action.id) ?? 0) + 1;
  if (journaling) {
    input.journal.intent({
      planId: input.plan.planId,
      actionId: action.id,
      idempotencyKey: action.id,
      store: action.store,
      kind: action.kind,
      attempt,
    });
    input.chaos?.('after_intent', action.id);
  }

  let result: LocalActionResult;
  try {
    result = await runner({
      action,
      op,
      repoRoot: input.repoRoot,
      context: input.context,
      dryRun: input.dryRun === 'server',
    });
    input.chaos?.('before_result', action.id);
  } catch (cause) {
    if (!AgentshipError.is(cause)) throw cause; // crash semantics: leave an orphan intent
    result = {
      ok: false,
      changed: false,
      errorCode: cause.code,
      errorMessage: cause.message,
    };
  }

  if (journaling) {
    input.journal.result({
      planId: input.plan.planId,
      actionId: action.id,
      idempotencyKey: action.id,
      attempt,
      status: result.ok ? 'done' : 'failed',
      changed: result.changed,
      // A local build has no store transaction; saying so keeps `atomic` honest.
      atomic: false,
      ...optional('errorCode', result.errorCode),
      ...optional('errorMessage', result.errorMessage),
    });
  }
  if (result.pending !== undefined) emittedPending.push(...result.pending);
  outcomes.set(action.id, {
    actionId: action.id,
    status: result.ok ? 'done' : 'failed',
    changed: result.changed,
    atomic: false,
    ...optional('errorCode', result.errorCode),
    ...optional('errorMessage', result.errorMessage),
    ...optional('warnings', result.warnings),
    ...optional('detail', result.detail),
  });
  return !result.ok;
}

function finish(
  plan: ReleasePlan,
  outcomes: ReadonlyMap<string, ActionOutcome>,
  emittedPending: readonly PendingOperation[],
): ExecutionResult {
  const ordered = plan.actions.map(
    (action) =>
      outcomes.get(action.id) ?? {
        actionId: action.id,
        status: 'skipped' as const,
        detail: 'Not reached.',
      },
  );
  const firstFailure = ordered.find((outcome) => outcome.status === 'failed');
  return {
    ok: firstFailure === undefined,
    outcomes: ordered,
    emittedPending,
    ...optional('failedActionId', firstFailure?.actionId),
  };
}
