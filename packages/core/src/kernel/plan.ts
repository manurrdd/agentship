import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CapabilityMap } from '../adapter.js';
import type { AppAnalysis } from '../analysis.js';
import { AgentshipError, ERROR_CODES } from '../errors.js';
import { optional } from '../optional.js';
import { ensureDir, FILE_MODE, stateDir } from '../paths.js';
import { redactValue } from '../redact.js';
import type { BatchOp, OperationId } from '../store-ops.js';
import type { RemoteAppState } from '../store-state.js';
import type { ActionClass, PendingOperation, Store } from '../types.js';
import type { ActionDraft, DiffEntry, DifferProposals, DifferRegistry, LocalOp } from './differ.js';
import { shortHash } from './hash.js';
import type { AgentshipManifest } from './manifest.js';
import type { PrivacyFinding } from './privacy.js';
import { privacyLint, privacySnapshotLint } from './privacy.js';
import { stateFingerprint } from './snapshot.js';
import { AGENTSHIP_VERSION } from './version.js';

/**
 * The `ReleasePlan`: every change Agentship intends to make, classified and inspectable
 * before anything executes.
 *
 * Identity is content: an action's id embeds a hash of exactly what the action will do,
 * and the plan's id hashes the set of action ids. Replanning against an unchanged store
 * and manifest reproduces every id bit-for-bit; any change — local edit or remote drift —
 * produces new ids, which is what invalidates stale approvals without bookkeeping.
 */
// v3: the plan carries `blocked`, the resources that could not be diffed at all.
export const RELEASE_PLAN_VERSION = 3;

/**
 * A resource whose differ could not produce anything, and why.
 *
 * A differ owns one resource of one store, and it fails for reasons that belong to that
 * resource alone: a screenshot the manifest lists but the disk does not have, a locale with
 * no text, a product whose price table will not resolve. Before this existed such a failure
 * escaped `buildPlan` and there was no plan at all — so a stale path to a PNG stopped a
 * build and an upload that had nothing to do with it, and the whole session fell out of
 * Agentship. A resource that cannot be diffed is now exactly that: one blocked resource,
 * reported next to a plan that still contains every action Agentship *could* work out.
 */
export interface BlockedResource {
  readonly store: Store;
  /** Resource of the differ that failed, e.g. `screenshots`. */
  readonly resource: string;
  /** The error's code when it was an {@link AgentshipError}, for callers that branch on it. */
  readonly code?: string;
  readonly reason: string;
  readonly remediation?: string;
}

export interface PlannedAction {
  /** `<kind>:<target>:<hash16>` — readable, and self-invalidating on content change. */
  readonly id: string;
  readonly store: Store;
  /** Resource of the differ that drafted it, e.g. `metadata`. */
  readonly resource: string;
  readonly kind: string;
  readonly target: string;
  readonly operation: OperationId;
  readonly classification: ActionClass;
  readonly summary: string;
  readonly diff: readonly DiffEntry[];
  /** Ids of actions that must complete first. */
  readonly dependsOn: readonly string[];
  /** Ids of pending operations that gate this action. */
  readonly blockedBy: readonly string[];
  readonly riskNotes: readonly string[];
  /** Present iff the action is executable through the store contract. */
  readonly op?: BatchOp;
  /** Present iff the action is performed on this machine (a build) rather than in a store. */
  readonly local?: LocalOp;
  /** Present iff the action is fulfilled by a pending operation instead of an API call. */
  readonly pending?: PendingOperation;
  /** Manifest paths whose `NEEDS_INPUT` sentinels keep this action from executing. */
  readonly needsInput?: readonly string[];
}

export interface PlanSnapshotMeta {
  readonly capturedAt: string;
  readonly fingerprint: string;
}

export interface ReleasePlan {
  readonly schemaVersion: typeof RELEASE_PLAN_VERSION;
  readonly planId: string;
  readonly createdAt: string;
  readonly agentshipVersion: string;
  readonly stores: readonly Store[];
  /** In execution order (topological, deterministic). */
  readonly actions: readonly PlannedAction[];
  /**
   * Every pending operation relevant to this plan: store-wide ones, app-specific ones
   * from the snapshot, and those carried by actions — deduplicated by id, each listing
   * the action ids it blocks.
   */
  readonly pending: readonly PendingOperation[];
  /** Fingerprint of the snapshot each store was planned against. */
  readonly snapshots: Readonly<Partial<Record<Store, PlanSnapshotMeta>>>;
  /** Ids of actions that require an approval before they can execute. */
  readonly approvalsRequired: readonly string[];
  /**
   * Resources that could not be diffed. Everything else in this plan is unaffected and can
   * be applied; these are the parts of the release Agentship could not see.
   */
  readonly blocked: readonly BlockedResource[];
  readonly warnings: readonly string[];
  /**
   * The privacy findings behind the warnings, structured: code, severity, remediation.
   * `warnings` renders them as strings; this is what a caller ranks by severity.
   */
  readonly findings: readonly PrivacyFinding[];
}

/** Everything the planner needs for one store. */
export interface StorePlanInput {
  readonly store: Store;
  readonly state: RemoteAppState;
  readonly capabilities: CapabilityMap;
  /** Store-wide pending operations from `StoreAdapter.knownPendingOperations()`. */
  readonly knownPending: readonly PendingOperation[];
  /** Read-only questions differs may ask this store; see {@link DifferProposals}. */
  readonly proposals?: DifferProposals;
}

export interface BuildPlanInput {
  readonly repoRoot: string;
  readonly manifest: AgentshipManifest;
  readonly registry: DifferRegistry;
  readonly stores: readonly StorePlanInput[];
  /**
   * The last analysis of the repository, when one has been captured. Differs use it for
   * evidence; the planner uses it to lint the privacy declaration against what the code
   * actually shows.
   */
  readonly analysis?: AppAnalysis;
}

/**
 * Operations whose effects touch money, privacy declarations or end users. Policy, not
 * capability: even where a store would allow `auto`, these are always `needs_approval`.
 */
const SENSITIVE_OPERATIONS: ReadonlySet<OperationId> = new Set<OperationId>([
  'setPricing',
  'appPricing',
  'privacyLabels',
  'dataSafety',
  'submitForReview',
  // Monetisation: a product's price is money the user's customers pay, and a product that
  // exists is one customers can buy. Neither is ever applied without the exact content
  // having been seen.
  'setProductPricing',
  'setProductOffers',
  'createProduct',
  'updateProduct',
  // Apple's age rating is a declaration about the app's content, like a privacy label.
  'contentRating',
]);

/**
 * Classifies a draft: the store's capability, upgraded by the safety policy.
 *
 * The upgrade only ever tightens. `auto` becomes `needs_approval` for sensitive
 * operations, destructive changes and anything reaching production; `agent_browser`,
 * `human_only` and `needs_input` are never downgraded to something more automatic.
 */
export function classifyDraft(draft: ActionDraft, capabilities: CapabilityMap): ActionClass {
  if (draft.op !== undefined && draft.local !== undefined) {
    throw new AgentshipError(
      ERROR_CODES.PLAN_CONFLICT,
      `A differ drafted "${draft.kind}:${draft.target}" with both a store op and a local op; an action has exactly one way to execute.`,
      { details: { kind: draft.kind, target: draft.target } },
    );
  }
  const capability = capabilities[draft.operation];
  if (capability === undefined || capability === 'unsupported') {
    throw new AgentshipError(
      ERROR_CODES.PLAN_CONFLICT,
      `A differ drafted "${draft.kind}:${draft.target}" for operation "${draft.operation}", which this store reports as unsupported.`,
      { details: { kind: draft.kind, target: draft.target, operation: draft.operation } },
    );
  }
  if (draft.needsInput !== undefined && draft.needsInput.length > 0) return 'needs_input';
  if (capability === 'auto' || capability === 'needs_approval') {
    const sensitive =
      SENSITIVE_OPERATIONS.has(draft.operation) ||
      draft.destructive === true ||
      draft.production === true;
    return sensitive ? 'needs_approval' : capability;
  }
  return capability;
}

/** Content-derived action id; see the module doc. */
export function actionId(store: Store, draft: ActionDraft, classification: ActionClass): string {
  const hash = shortHash({
    store,
    kind: draft.kind,
    target: draft.target,
    operation: draft.operation,
    classification,
    op: draft.op ?? null,
    local: draft.local ?? null,
    pending: draft.pending === undefined ? null : { id: draft.pending.id },
    // Sorted by path: the diff is a set of field changes, not a sequence, so the order a
    // differ happened to emit it in must not change the id (or invalidate approvals).
    //
    // Only the *target* state is hashed, never the store's current value. What a user
    // approves is what the action will make true — "set the description to X" — and that is
    // unchanged whether the store currently says Y or Z. Including `before` meant an
    // unrelated upload, which moves the store on, rotated the id of every other action and
    // sent the user back to re-approve wording they had already approved. That happened
    // sixteen times across the sessions this rule comes from.
    diff: [...draft.diff]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((entry) => ({ path: entry.path, after: entry.after ?? null })),
  });
  return `${draft.kind}:${draft.target}:${hash}`;
}

/** Builds a {@link ReleasePlan} from fresh snapshots. Pure: no I/O, no clock in ids. */
export async function buildPlan(input: BuildPlanInput): Promise<ReleasePlan> {
  const warnings: string[] = [];
  const actions: PlannedAction[] = [];
  const blocked: BlockedResource[] = [];
  const pendingById = new Map<string, PendingOperation>();
  const blocking = new Map<string, string[]>();
  const snapshots: Partial<Record<Store, PlanSnapshotMeta>> = {};

  // Privacy findings are plan-level warnings: they are about the declaration and the code,
  // not about any one action, and a plan that quietly dropped them would let a submission be
  // approved with a purpose string App Review rejects.
  const findings: PrivacyFinding[] = [...privacyLint(input.manifest, input.analysis)];

  for (const storeInput of input.stores) {
    const { store, state, capabilities, knownPending } = storeInput;
    // Snapshot-level privacy checks: what the code shows against what the store declares.
    // Deliberately not gated on the declaration being confirmed — see privacySnapshotLint.
    findings.push(
      ...(await privacySnapshotLint({
        repoRoot: input.repoRoot,
        store,
        state,
        analysis: input.analysis,
      })),
    );
    snapshots[store] = {
      capturedAt: state.capturedAt,
      fingerprint: stateFingerprint(state),
    };
    for (const pending of [...knownPending, ...state.pending]) {
      mergePending(pendingById, pending);
    }

    const drafts: { draft: ActionDraft; resource: string }[] = [];
    for (const differ of input.registry.forStore(store)) {
      let produced: readonly ActionDraft[];
      try {
        produced = await differ.plan({
          store,
          manifest: input.manifest,
          state,
          repoRoot: input.repoRoot,
          ...optional('proposals', storeInput.proposals),
          ...optional('analysis', input.analysis),
        });
      } catch (error) {
        // Only the differ's own call is guarded. A failure inside the planner below — two
        // differs drafting one action, a dependency nobody satisfies — is a defect in
        // Agentship, not in the user's project, and must still stop everything.
        // The same applies to an unexpected raw exception from a differ: only a deliberately
        // classified AgentshipError is a project/resource problem safe to isolate.
        if (!AgentshipError.is(error)) throw error;
        blocked.push(describeBlocked(store, differ.resource, error));
        continue;
      }
      for (const draft of produced) drafts.push({ draft, resource: differ.resource });
    }

    // Ids must not depend on the order differs produced drafts in.
    const idByKey = new Map<string, string>();
    const prepared = drafts.map(({ draft, resource }) => {
      const classification = classifyDraft(draft, capabilities);
      const id = actionId(store, draft, classification);
      const key = `${draft.kind}:${draft.target}`;
      if (idByKey.has(key)) {
        throw new AgentshipError(
          ERROR_CODES.PLAN_CONFLICT,
          `Two differs drafted the same action "${key}" for ${store}.`,
          { details: { key, store } },
        );
      }
      idByKey.set(key, id);
      return { draft, resource, classification, id };
    });

    for (const { draft, resource, classification, id } of prepared) {
      const dependsOn: string[] = [];
      for (const ref of draft.dependsOn ?? []) {
        const dependencyId = idByKey.get(`${ref.kind}:${ref.target}`);
        if (dependencyId !== undefined) {
          dependsOn.push(dependencyId);
          continue;
        }
        // An optional reference that nothing satisfies means the other action simply is not
        // part of this plan — the normal case when independent differs compose.
        if (ref.optional === true) continue;
        throw new AgentshipError(
          ERROR_CODES.PLAN_CONFLICT,
          `Action "${draft.kind}:${draft.target}" depends on "${ref.kind}:${ref.target}", which no differ drafted.`,
          {
            details: {
              store,
              from: `${draft.kind}:${draft.target}`,
              to: `${ref.kind}:${ref.target}`,
            },
          },
        );
      }

      let pending = draft.pending;
      if (
        pending === undefined &&
        (classification === 'agent_browser' || classification === 'human_only')
      ) {
        pending = synthesizePending(store, draft, classification);
      }
      if (pending !== undefined) {
        mergePending(pendingById, pending);
        const blocked = blocking.get(pending.id) ?? [];
        blocked.push(id);
        blocking.set(pending.id, blocked);
      }

      const blockedBy = [...new Set([...(draft.blockedBy ?? [])])];
      for (const pendingId of blockedBy) {
        const blocked = blocking.get(pendingId) ?? [];
        blocked.push(id);
        blocking.set(pendingId, blocked);
      }

      actions.push({
        id,
        store,
        resource,
        kind: draft.kind,
        target: draft.target,
        operation: draft.operation,
        classification,
        summary: draft.summary,
        diff: draft.diff,
        dependsOn,
        blockedBy,
        riskNotes: draft.riskNotes ?? [],
        ...optional('op', draft.op),
        ...optional('local', draft.local),
        ...optional('pending', pending),
        ...optional('needsInput', draft.needsInput),
      });
    }
  }

  const ordered = topologicalOrder(actions);
  const pending = [...pendingById.values()].map((operation) => {
    const blocked = blocking.get(operation.id);
    return blocked === undefined
      ? operation
      : { ...operation, blocking: [...new Set(blocked)].sort() };
  });

  for (const finding of findings) {
    warnings.push(`[${finding.code}] ${finding.message} → ${finding.remediation}`);
  }
  for (const entry of blocked) {
    warnings.push(
      `Nothing could be planned for ${entry.store}/${entry.resource}: ${entry.reason} The rest of this plan is unaffected.`,
    );
  }

  const planId = `plan-${shortHash({ actions: ordered.map((action) => action.id).sort() })}`;
  return {
    schemaVersion: RELEASE_PLAN_VERSION,
    planId,
    createdAt: new Date().toISOString(),
    agentshipVersion: AGENTSHIP_VERSION,
    stores: input.stores.map((store) => store.store),
    actions: ordered,
    pending,
    snapshots,
    approvalsRequired: ordered
      .filter((action) => action.classification === 'needs_approval')
      .map((action) => action.id),
    // Deliberately outside the plan id: the id exists to invalidate approvals when the work
    // changes, and the work is the actions. A blocked resource contributes none, so a
    // differently-worded failure must not rotate every id and re-ask for approvals given.
    blocked: [...blocked].sort(
      (a, b) => a.store.localeCompare(b.store) || a.resource.localeCompare(b.resource),
    ),
    warnings,
    findings,
  };
}

/**
 * Turns whatever a differ threw into a report about one resource.
 *
 * The remediation is carried through verbatim when the error has one, because it is written
 * for exactly this failure. What it must not do is read as an instruction to the agent: the
 * manifest is the user's file, and a differ failing over a path in it is a question for
 * them, not a licence to rewrite it.
 */
function describeBlocked(store: Store, resource: string, error: AgentshipError): BlockedResource {
  return {
    store,
    resource,
    code: error.code,
    reason: error.message,
    ...optional('remediation', error.remediation?.summary),
  };
}

function mergePending(byId: Map<string, PendingOperation>, incoming: PendingOperation): void {
  const existing = byId.get(incoming.id);
  byId.set(incoming.id, existing === undefined ? incoming : { ...existing, ...incoming });
}

function synthesizePending(
  store: Store,
  draft: ActionDraft,
  actionClass: Extract<ActionClass, 'agent_browser' | 'human_only'>,
): PendingOperation {
  return {
    id: `${store}:${draft.kind}:${draft.target}`,
    store,
    category: 'other',
    title: draft.summary,
    reason: `The ${store} store exposes no API for "${draft.operation}"; it must be completed in the console.`,
    actionClass,
    status: 'open',
  };
}

/**
 * Deterministic topological order: dependencies first, ties broken by
 * (store, resource, target, id) so replans list actions identically.
 */
function topologicalOrder(actions: readonly PlannedAction[]): readonly PlannedAction[] {
  const byId = new Map(actions.map((action) => [action.id, action]));
  const sorted = [...actions].sort(
    (a, b) =>
      a.store.localeCompare(b.store) ||
      a.resource.localeCompare(b.resource) ||
      a.target.localeCompare(b.target) ||
      a.id.localeCompare(b.id),
  );
  const done = new Set<string>();
  const visiting = new Set<string>();
  const out: PlannedAction[] = [];

  const visit = (action: PlannedAction, chain: readonly string[]): void => {
    if (done.has(action.id)) return;
    if (visiting.has(action.id)) {
      throw new AgentshipError(
        ERROR_CODES.PLAN_CONFLICT,
        `Dependency cycle between planned actions: ${[...chain, action.id].join(' -> ')}.`,
        { details: { cycle: [...chain, action.id] } },
      );
    }
    visiting.add(action.id);
    for (const dependencyId of [...action.dependsOn].sort()) {
      const dependency = byId.get(dependencyId);
      if (dependency !== undefined) visit(dependency, [...chain, action.id]);
    }
    visiting.delete(action.id);
    done.add(action.id);
    out.push(action);
  };

  for (const action of sorted) visit(action, []);
  return out;
}

export function planPath(repoRoot: string): string {
  return join(stateDir(repoRoot), 'plan.json');
}

/**
 * Persists the plan as the project's single current plan.
 *
 * Written through the redactor: diffs quote store and manifest content, and nothing that
 * lands in `.agentship/state/` may contain secrets. The persisted copy is only ever used to
 * check `planId` continuity — execution always replans in memory — so redaction cannot
 * alter what runs.
 */
export async function savePlan(repoRoot: string, plan: ReleasePlan): Promise<void> {
  await ensureDir(stateDir(repoRoot));
  await writeFile(planPath(repoRoot), `${JSON.stringify(redactValue(plan), null, 2)}\n`, {
    mode: FILE_MODE,
  });
}

/** Loads the current plan, or `undefined` when none has been created. */
export async function loadPlan(repoRoot: string): Promise<ReleasePlan | undefined> {
  let raw: string;
  try {
    raw = await readFile(planPath(repoRoot), 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw AgentshipError.from(ERROR_CODES.PLAN_NOT_FOUND, 'Could not read the stored plan.', cause);
  }
  try {
    const plan = JSON.parse(raw) as ReleasePlan;
    return plan.schemaVersion === RELEASE_PLAN_VERSION ? plan : undefined;
  } catch (cause) {
    throw AgentshipError.from(
      ERROR_CODES.PLAN_NOT_FOUND,
      'The stored plan is unreadable; run plan again.',
      cause,
    );
  }
}
