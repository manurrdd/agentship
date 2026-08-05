import {
  AgentshipError,
  loadManifest,
  loadPlan,
  type PendingStatus,
  type RemoteAppState,
  type Store,
} from '@agentship/core';
import { z } from 'zod';
import { type Detail, ok, type ToolResponse } from '../format.js';
import type { Session } from '../session.js';
import {
  ADOPTABLE_NOTE,
  adoptableFromStates,
  DRIFT_NOTE,
  driftFromStates,
  planReadiness,
  summarizeApply,
  summarizePlan,
  summarizeSnapshot,
} from '../summaries.js';
import {
  approvalsArg,
  DETAIL_DESCRIPTION,
  idArg,
  type Progress,
  projectDirArg,
  type ToolDefinition,
} from './types.js';

/** Stores the manifest declares, optionally narrowed by the caller. */
async function manifestStores(
  repoRoot: string,
  requested: readonly Store[] | undefined,
): Promise<readonly Store[]> {
  const manifest = await loadManifest(repoRoot);
  const declared: Store[] = [];
  if (manifest.stores.apple !== undefined) declared.push('apple');
  if (manifest.stores.google !== undefined) declared.push('google');
  return requested === undefined ? declared : declared.filter((store) => requested.includes(store));
}

const statusSchema = z.object({
  projectDir: projectDirArg,
  store: z
    .enum(['apple', 'google'])
    .optional()
    .describe('Limit the snapshot to one store. Default: every store the manifest declares.'),
  detail: z.enum(['concise', 'full']).optional().describe(DETAIL_DESCRIPTION),
});

export const storeStatusTool: ToolDefinition = {
  name: 'agentship_store_status',
  title: 'Snapshot the real store state',
  description: `Capture what the store says right now about this app: versions and their review state, builds, localizations, tracks, tester groups, pricing, plus the areas the store would not answer about ("gaps") and the console-only operations it reports as pending.

Use it to answer "how is my app doing?", to check whether a build finished processing, or to confirm that work done in a console has landed.

Gaps are not emptiness: an area listed there is unknown, not absent. Never tell the user something is missing from the store because it appears in gaps — say Agentship could not read it, and why.

This is a read: it never changes anything. It fails per store, so one store lacking credentials still lets you see the other.`,
  schema: statusSchema,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  async handler(session, args) {
    const input = statusSchema.parse(args);
    const detail: Detail = input.detail ?? 'concise';
    const repoRoot = await session.requireProject(input.projectDir);
    const kernel = await session.engine.kernel(repoRoot);
    const stores = await manifestStores(
      repoRoot,
      input.store === undefined ? undefined : [input.store],
    );

    const snapshots: Record<string, unknown> = {};
    const states: RemoteAppState[] = [];
    for (const store of stores) {
      try {
        const snapshot = await kernel.captureState(store);
        snapshots[store] = summarizeSnapshot(snapshot, detail);
        states.push(snapshot.state);
      } catch (error) {
        snapshots[store] = {
          error: AgentshipError.is(error)
            ? error.toJSON()
            : { code: 'INTERNAL', message: String(error) },
        };
      }
    }

    // Manifest gaps whose value the store already holds: offered for explicit adoption,
    // never written automatically.
    const manifest = await loadManifest(repoRoot).catch(() => undefined);
    const adoptable = manifest === undefined ? [] : adoptableFromStates(manifest, states);
    const drift = manifest === undefined ? [] : driftFromStates(manifest, states);

    // What the store says would block a submission, asked live — unlike the rest of
    // readiness, this needs no plan at all.
    const reported = await Promise.all(
      stores.map(async (store) => kernel.submissionReadiness(store)),
    );

    // The rest of readiness is presentation over what the last plan computed; a status call
    // does not re-plan, so it derives from the stored plan (with today's pending statuses)
    // and says so. No stored plan, no claim.
    const stored = await loadPlan(repoRoot);
    let readiness: Record<string, unknown> | undefined;
    if (stored !== undefined) {
      const statuses = new Map<string, PendingStatus>(
        (await kernel.listPending()).map((operation) => [operation.id, operation.status]),
      );
      readiness = {
        perStore: planReadiness(stored, statuses, reported),
        note: `Console and manifest items derive from the plan created at ${stored.createdAt} (run agentship_plan for a fresh computation); "store" items were read from the store just now.`,
      };
    } else if (reported.some((entry) => entry.blockers.length > 0)) {
      readiness = {
        perStore: Object.fromEntries(
          reported.map((entry) => [
            entry.store,
            entry.blockers.map((blocker) => ({
              severity: blocker.blocking ? 'blocking' : 'warning',
              source: 'store',
              summary: `[${blocker.code}] ${blocker.message}`,
              remediation: blocker.remediation ?? `Reported by the ${entry.store} store itself.`,
            })),
          ]),
        ),
        note: 'Read from the store just now. Run agentship_plan to also see what the manifest and the console still need.',
      };
    }

    return ok({
      projectDir: repoRoot,
      stores,
      snapshots,
      ...(adoptable.length === 0 ? {} : { adoptable, adoptableNote: ADOPTABLE_NOTE }),
      ...(drift.length === 0 ? {} : { drift, driftNote: DRIFT_NOTE }),
      ...(readiness === undefined ? {} : { readiness }),
    });
  },
};

const planSchema = z.object({
  projectDir: projectDirArg,
  stores: z
    .array(z.enum(['apple', 'google']))
    .optional()
    .describe('Stores to plan. Default: every store the manifest declares.'),
  dryRunLevel: z
    .enum(['local', 'server'])
    .optional()
    .describe(
      'Also rehearse the plan without effects: "local" only compares the diff, "server" asks the store to validate the payloads. Omit for a plain plan.',
    ),
  detail: z.enum(['concise', 'full']).optional().describe(DETAIL_DESCRIPTION),
});

export const planTool: ToolDefinition = {
  name: 'agentship_plan',
  title: 'Plan what would change',
  description: `Capture fresh store state, diff it against the manifest, and return the plan: every action with an id, a classification, the exact field-level diff, the risks, and the pending operations that block it.

Classifications decide what you may do:
- auto — Agentship performs it. Nothing to ask.
- needs_approval — a human must approve THIS action, by id, after seeing its diff. Present the diff, ask, and pass only the ids the user approved to agentship_apply. Never approve on the user's behalf, never offer "approve everything", and never guess an id: an approval is bound to the content hash inside the id, and the kernel rejects anything else.
- needs_input — a value is missing from the manifest. Ask the user for exactly the listed manifest paths, write them into .agentship/agentship.yaml, and plan again.
- agent_browser / human_only — no API exists. See the pending operations in the response and use agentship_pending.

An empty plan means the stores already match the manifest. That is a success, not a failure — say so instead of looking for something to do.

"readiness" is what still stands between the project and a review submission. Items with source "store" are the store's own verdict, read live: a reviewer field that became mandatory, a screenshot in a size no longer accepted, a build still processing. Nothing in a manifest diff can predict those, so do not treat an empty plan as "ready to submit" without reading them.

"drift" is where the store already disagrees with the manifest — text that differs, or a locale published in the store that the manifest never declares. Applying the manifest overwrites the first and ignores the second. Show drift to the user before approving a metadata change: Agentship cannot tell whether the store's version is stale or newer than the manifest's.

Plans are cheap and always fresh; re-plan whenever anything may have changed rather than reusing an old plan or old approvals.`,
  schema: planSchema,
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },

  async handler(session, args, progress) {
    const input = planSchema.parse(args);
    const detail: Detail = input.detail ?? 'concise';
    const repoRoot = await session.requireProject(input.projectDir);
    const kernel = await session.engine.kernel(repoRoot);

    await progress('capturing store state');
    const plan = await kernel.plan(input.stores === undefined ? {} : { stores: input.stores });

    // Adoptable values: manifest gaps the store can already answer, offered — never
    // written — from the snapshots this very plan was built on.
    const manifest = await loadManifest(repoRoot);
    const states: RemoteAppState[] = [];
    for (const store of plan.stores) {
      const snapshot = await kernel.lastSnapshot(store);
      if (snapshot !== undefined) states.push(snapshot.state);
    }
    const adoptable = adoptableFromStates(manifest, states);

    // What the store itself would refuse. One extra read-only call per store, and the only
    // source for obstacles no manifest diff can see (a reviewer field that became mandatory,
    // a screenshot size that stopped being accepted, a build still processing).
    await progress('asking the stores what would block a submission');
    const reported = await Promise.all(
      plan.stores.map(async (store) => kernel.submissionReadiness(store)),
    );
    const unanswered = reported.filter((entry) => !entry.supported);

    // Where the store already disagrees with the manifest. Reported before the approval, so
    // an overwrite is a decision rather than a surprise.
    const drift = driftFromStates(manifest, states);

    const extras = {
      /** What still stands between this project and a review submission, blockers first. */
      readiness: planReadiness(plan, undefined, reported),
      ...(drift.length === 0 ? {} : { drift, driftNote: DRIFT_NOTE }),
      ...(unanswered.length === 0
        ? {}
        : {
            readinessNotAsked: unanswered.map((entry) => ({
              store: entry.store,
              reason: entry.reason,
            })),
          }),
      ...(adoptable.length === 0 ? {} : { adoptable, adoptableNote: ADOPTABLE_NOTE }),
    };

    if (input.dryRunLevel === undefined) {
      return ok({
        projectDir: repoRoot,
        plan: summarizePlan(plan, detail),
        ...extras,
        nextStep: nextStepForPlan(plan.actions.length, plan.approvalsRequired.length),
      });
    }

    await progress(`rehearsing the plan (${input.dryRunLevel} dry run)`);
    // A dry run carries no approvals on purpose: rehearsing must never be a way to get an
    // action executed, so approval-gated actions come back withheld exactly as they are.
    const rehearsal = await kernel.apply({
      planId: plan.planId,
      approvals: [],
      dryRun: input.dryRunLevel,
    });
    return ok({
      projectDir: repoRoot,
      plan: summarizePlan(rehearsal.plan, detail),
      ...extras,
      dryRun: {
        level: input.dryRunLevel,
        ok: rehearsal.ok,
        outcomes: rehearsal.outcomes.map((outcome) => ({
          actionId: outcome.actionId,
          status: outcome.status,
          ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
          ...(outcome.errorMessage === undefined ? {} : { errorMessage: outcome.errorMessage }),
        })),
        note: 'Nothing was executed or journaled. Actions needing approval are reported as withheld.',
      },
      nextStep: nextStepForPlan(
        rehearsal.plan.actions.length,
        rehearsal.plan.approvalsRequired.length,
      ),
    });
  },
};

function nextStepForPlan(actions: number, approvals: number): string {
  if (actions === 0) return 'Nothing to do: the stores already match the manifest. Tell the user.';
  if (approvals === 0) {
    return 'No approvals are required. Call agentship_apply with this planId to execute.';
  }
  return 'Show the user the diff of every needs_approval action and ask about each one separately. Pass only the ids they approved to agentship_apply.';
}

const applySchema = z.object({
  projectDir: projectDirArg,
  planId: idArg.describe('Id of the plan the user saw, exactly as agentship_plan returned it.'),
  approvals: approvalsArg
    .optional()
    .describe(
      'Action ids the human explicitly approved after seeing their diff, one entry per approved action. Omit for none. Never include an id the user did not approve in this conversation.',
    ),
  dryRun: z
    .enum(['local', 'server'])
    .optional()
    .describe('Rehearse without effects: "local" (diff only) or "server" (store-side validation).'),
  stopOnError: z
    .boolean()
    .optional()
    .describe('Stop at the first failure instead of attempting independent actions. Default true.'),
  detail: z.enum(['concise', 'full']).optional().describe(DETAIL_DESCRIPTION),
});

export const applyTool: ToolDefinition = {
  name: 'agentship_apply',
  title: 'Apply an approved plan',
  description: `Execute the plan. Agentship re-reads its journal, re-captures store state and re-plans before running anything, so what executes is always the current truth rather than what the plan said a minute ago.

Pass only action ids a human approved in this conversation, after seeing that action's diff. Approving on the user's behalf is not possible: ids embed a content hash, and the kernel withholds anything without a matching approval.

Calling it with no approvals at all is useful and safe — everything classified auto runs, and everything else comes back as needs_approval / needs_input / blocked with its reason. That is the normal way to make progress while approvals are being discussed.

Read the response in this order:
1. outcomes — what ran (done / failed / skipped) and what was withheld and why.
2. staleApprovals and driftDetected — the store moved, so some approvals no longer match. This is expected: applying part of a plan changes the store, so the ids rotate. Do not treat it as an error and do not retry the same ids.
3. plan — the freshly built plan. Present its diffs again and ask for approval against THESE ids.
4. emittedPending — console work that now blocks progress; continue with agentship_pending.

If the run was interrupted (a crash, a lost connection), call agentship_resume: no operation is ever performed twice, because a fresh snapshot decides what is left.`,
  schema: applySchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },

  async handler(session, args, progress) {
    const input = applySchema.parse(args);
    return runApply(session, progress, {
      projectDir: input.projectDir,
      planId: input.planId,
      approvals: input.approvals,
      dryRun: input.dryRun,
      stopOnError: input.stopOnError,
      detail: input.detail,
    });
  },
};

const resumeSchema = z.object({
  projectDir: projectDirArg,
  approvals: approvalsArg
    .optional()
    .describe('Action ids the human approved for whatever is left to do.'),
  dryRun: z.enum(['local', 'server']).optional().describe('Rehearse without effects.'),
  detail: z.enum(['concise', 'full']).optional().describe(DETAIL_DESCRIPTION),
});

export const resumeTool: ToolDefinition = {
  name: 'agentship_resume',
  title: 'Resume an interrupted run',
  description: `Continue after an interruption: a crash, a killed process, a lost network, a store error mid-run.

There is no separate resume state to worry about. Agentship reads its write-ahead journal, asks the store what actually happened, and re-plans; whatever already landed is simply not in the new plan. A non-idempotent operation — uploading a build, submitting for review — is never performed twice, and an operation whose effect never landed comes back as a normal action.

Approvals rotate here too: the new plan has new ids for anything whose content changed. Re-present the diffs and pass only what the human approves now.

Safe to call when unsure: with nothing left to do it returns an empty outcome list.`,
  schema: resumeSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },

  async handler(session, args, progress) {
    const input = resumeSchema.parse(args);
    return runApply(session, progress, {
      projectDir: input.projectDir,
      approvals: input.approvals,
      dryRun: input.dryRun,
      detail: input.detail,
      resume: true,
    });
  },
};

interface ApplyInput {
  readonly projectDir?: string | undefined;
  readonly planId?: string | undefined;
  readonly approvals?: readonly string[] | undefined;
  readonly dryRun?: 'local' | 'server' | undefined;
  readonly stopOnError?: boolean | undefined;
  readonly detail?: Detail | undefined;
  readonly resume?: boolean;
}

async function runApply(
  session: Session,
  progress: Progress,
  input: ApplyInput,
): Promise<ToolResponse> {
  const detail: Detail = input.detail ?? 'concise';
  const repoRoot = await session.requireProject(input.projectDir);
  const kernel = await session.engine.kernel(repoRoot);

  await progress(
    input.resume === true
      ? 'reading the journal and re-capturing store state'
      : 'checking for drift and re-planning',
  );

  const options = {
    ...(input.approvals === undefined ? {} : { approvals: input.approvals }),
    ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
    ...(input.stopOnError === undefined ? {} : { stopOnError: input.stopOnError }),
  };
  const result =
    input.resume === true
      ? await kernel.resume(options)
      : await kernel.apply({ planId: input.planId as string, ...options });

  await progress('execution finished', 1, 1);
  return ok({
    projectDir: repoRoot,
    ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
    ...summarizeApply(result, detail),
    nextStep: nextStepForApply(result.ok, result.staleApprovals.length, result.plan.actions.length),
  });
}

function nextStepForApply(succeeded: boolean, stale: number, remaining: number): string {
  if (!succeeded) {
    return 'Report the failed action and its error to the user. Fix the cause, then call agentship_resume.';
  }
  if (remaining === 0) return 'Everything the manifest asks for is in place. Tell the user.';
  if (stale > 0) {
    return 'Some approvals became stale because the store changed. Present the new diffs from "plan" and ask for approval against the new ids.';
  }
  return 'Present the remaining actions from "plan": approve what is pending, or complete the blocking pending operations with agentship_pending.';
}
