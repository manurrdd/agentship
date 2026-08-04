import type { BuildOutcome, BuildSupport } from '@agentship/build';
import type {
  ActionOutcome,
  AppAnalysis,
  ApplyResult,
  PendingOperation,
  PlannedAction,
  ReleasePlan,
  RemoteAppState,
  StoredSnapshot,
} from '@agentship/core';
import type { Detail } from './format.js';

/**
 * Projections of engine results onto what an agent needs to decide the next step.
 *
 * The engine's own types are complete by design — a snapshot carries every localization,
 * a plan carries every diff entry. Handing those verbatim to a model would spend its
 * context on data it will not read. Each summary here keeps identity, classification and
 * anything a human must approve, and defers the rest to `detail: 'full'`.
 */
const CONCISE_DIFF_ENTRIES = 8;

export function summarizeAnalysis(analysis: AppAnalysis, detail: Detail): Record<string, unknown> {
  const identity = Object.fromEntries(
    Object.entries(analysis.identity).map(([key, value]) => [
      key,
      value === undefined
        ? undefined
        : {
            value: value.value,
            confidence: value.confidence,
            ...(value.source === undefined ? {} : { source: value.source }),
            ...(detail === 'full' && value.detail !== undefined ? { detail: value.detail } : {}),
          },
    ]),
  );
  const versions = Object.fromEntries(
    Object.entries(analysis.versions).map(([key, value]) => [
      key,
      value === undefined ? undefined : { value: value.value, confidence: value.confidence },
    ]),
  );

  return {
    root: analysis.root,
    framework: {
      framework: analysis.framework.framework,
      confidence: analysis.framework.confidence,
      ...(analysis.framework.expoWorkflow === undefined
        ? {}
        : { expoWorkflow: analysis.framework.expoWorkflow }),
      ...(detail === 'full' ? { evidence: analysis.framework.evidence } : {}),
    },
    platforms: analysis.platforms,
    identity,
    versions,
    sdks: analysis.sdks.map((sdk) => ({
      id: sdk.id,
      name: sdk.name,
      categories: sdk.categories,
      ...(sdk.version === undefined ? {} : { version: sdk.version }),
      ...(sdk.implications === undefined ? {} : { implications: sdk.implications }),
      ...(detail === 'full' ? { evidence: sdk.evidence } : {}),
    })),
    permissions:
      detail === 'full'
        ? analysis.permissions
        : {
            ios: analysis.permissions.ios.map((permission) => permission.key),
            android: analysis.permissions.android.map((permission) => permission.name),
          },
    privacySignals: analysis.privacySignals.map((signal) => ({
      dataType: signal.dataType,
      reason: signal.reason,
      sdkIds: signal.sdkIds,
      confidence: signal.confidence,
      ...(detail === 'full' ? { evidence: signal.evidence } : {}),
    })),
    assets: {
      appIcons: analysis.assets.appIcons.length,
      screenshots: analysis.assets.screenshots.length,
      listingFiles: analysis.assets.listingFiles,
    },
    buildHints: analysis.buildHints,
    warnings: analysis.warnings,
    stats: analysis.stats,
  };
}

export function summarizeAction(action: PlannedAction, detail: Detail): Record<string, unknown> {
  const diff = detail === 'full' ? action.diff : action.diff.slice(0, CONCISE_DIFF_ENTRIES);
  return {
    id: action.id,
    store: action.store,
    kind: action.kind,
    target: action.target,
    operation: action.operation,
    classification: action.classification,
    summary: action.summary,
    diff,
    ...(action.diff.length > diff.length ? { diffOmitted: action.diff.length - diff.length } : {}),
    ...(action.dependsOn.length > 0 ? { dependsOn: action.dependsOn } : {}),
    ...(action.blockedBy.length > 0 ? { blockedBy: action.blockedBy } : {}),
    ...(action.riskNotes.length > 0 ? { riskNotes: action.riskNotes } : {}),
    ...(action.needsInput === undefined ? {} : { needsInput: action.needsInput }),
    ...(action.pending === undefined ? {} : { pendingId: action.pending.id }),
    // Worth saying out loud: this one runs on the user's machine, not in a store, so it is
    // slow, it executes the project's own build scripts, and its failures are local.
    ...(action.local === undefined ? {} : { runsLocally: true }),
  };
}

export function summarizePendingOperation(
  operation: PendingOperation,
  detail: Detail,
): Record<string, unknown> {
  return {
    id: operation.id,
    store: operation.store,
    category: operation.category,
    title: operation.title,
    actionClass: operation.actionClass,
    status: operation.status,
    reason: operation.reason,
    ...(operation.console === undefined ? {} : { console: operation.console }),
    ...(operation.blocking === undefined || operation.blocking.length === 0
      ? {}
      : { blocking: operation.blocking }),
    // Steps and fields are what `get` is for. A whole first-release itinerary carries a few
    // dozen instructions across both stores, and putting all of them in every `list` would
    // blow past the response ceiling — which trims arrays, so entries would silently vanish
    // from the list an agent is using to navigate. Counts here, contents on request.
    ...(detail === 'full'
      ? {
          steps: operation.steps,
          ...(operation.fields === undefined
            ? {}
            : {
                fields: operation.fields.map((field) => ({
                  name: field.name,
                  label: field.label,
                  required: field.required,
                  ...(field.proposedValue === undefined
                    ? {}
                    : { proposedValue: field.proposedValue }),
                  ...(field.rationale === undefined ? {} : { rationale: field.rationale }),
                  ...(field.options === undefined ? {} : { options: field.options }),
                  ...(field.secret === true ? { secret: true } : {}),
                })),
              }),
        }
      : {
          ...(operation.steps === undefined ? {} : { steps: operation.steps.length }),
          ...(operation.fields === undefined ? {} : { fields: operation.fields.length }),
        }),
    ...(operation.verification === undefined ? {} : { verification: operation.verification }),
    ...(operation.notes === undefined ? {} : { notes: operation.notes }),
    ...(operation.updatedAt === undefined ? {} : { updatedAt: operation.updatedAt }),
  };
}

function countBy<T extends string>(values: readonly T[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

export function summarizePlan(plan: ReleasePlan, detail: Detail): Record<string, unknown> {
  return {
    planId: plan.planId,
    createdAt: plan.createdAt,
    stores: plan.stores,
    counts: {
      actions: plan.actions.length,
      byClassification: countBy(plan.actions.map((action) => action.classification)),
      pending: plan.pending.length,
    },
    /** Every action needing explicit human approval before `agentship_apply` will run it. */
    approvalsRequired: plan.approvalsRequired,
    actions: plan.actions.map((action) => summarizeAction(action, detail)),
    pending: plan.pending.map((operation) => summarizePendingOperation(operation, detail)),
    warnings: plan.warnings,
  };
}

export function summarizeOutcome(outcome: ActionOutcome): Record<string, unknown> {
  return {
    actionId: outcome.actionId,
    status: outcome.status,
    ...(outcome.changed === undefined ? {} : { changed: outcome.changed }),
    ...(outcome.atomic === undefined ? {} : { atomic: outcome.atomic }),
    ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
    ...(outcome.errorMessage === undefined ? {} : { errorMessage: outcome.errorMessage }),
    ...(outcome.warnings === undefined ? {} : { warnings: outcome.warnings }),
    ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
  };
}

/**
 * The result of an apply, arranged around the question the agent asks next: what ran, what
 * is still withheld, and what to do about it.
 *
 * Approvals rotate legitimately — executing part of a plan changes the store, so replanning
 * mints new action ids and the ids the human approved a moment ago become stale. That is
 * not an error, it is the design; the fresh plan travels back in the same response so the
 * agent can present the new diff and ask again.
 */
export function summarizeApply(result: ApplyResult, detail: Detail): Record<string, unknown> {
  const withheld = result.outcomes.filter(
    (outcome) =>
      outcome.status === 'needs_approval' ||
      outcome.status === 'needs_input' ||
      outcome.status === 'blocked' ||
      outcome.status === 'pending_emitted',
  );
  return {
    ok: result.ok,
    planId: result.planId,
    requestedPlanId: result.requestedPlanId,
    replanned: result.planId !== result.requestedPlanId,
    counts: countBy(result.outcomes.map((outcome) => outcome.status)),
    outcomes: result.outcomes.map(summarizeOutcome),
    withheld: withheld.map((outcome) => outcome.actionId),
    ...(result.failedActionId === undefined ? {} : { failedActionId: result.failedActionId }),
    driftDetected: result.driftDetected,
    staleApprovals: result.staleApprovals,
    warnings: result.warnings,
    emittedPending: result.emittedPending.map((operation) =>
      summarizePendingOperation(operation, detail),
    ),
    /** The plan as it stands after execution: approve against these ids, never older ones. */
    plan: summarizePlan(result.plan, detail),
  };
}

/**
 * A finished build, arranged so the agent never has to open the log.
 *
 * The log path travels, the log does not: a build log runs to tens of thousands of lines
 * and an agent that pastes one has spent its context on the least useful thing in the
 * response. What it needs is the artifact's identity, the commands that produced it, and
 * anything Agentship could *not* verify — stated as such, so an app bundle's unread version
 * code is never mistaken for a confirmed one.
 */
export function summarizeBuild(outcome: BuildOutcome, detail: Detail): Record<string, unknown> {
  const { artifact } = outcome;
  return {
    artifact: {
      path: artifact.path,
      kind: artifact.kind,
      version: artifact.version,
      buildNumber: artifact.buildNumber,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      ...(artifact.bundleId === undefined ? {} : { bundleId: artifact.bundleId }),
      builder: artifact.builder,
      ...(artifact.unverified === undefined ? {} : { unverified: artifact.unverified }),
    },
    durationMs: outcome.durationMs,
    logPath: outcome.logPath,
    ...(detail === 'full' ? { commands: outcome.commands } : {}),
    ...(outcome.warnings.length === 0 ? {} : { warnings: outcome.warnings }),
  };
}

/** What a platform's builder can and cannot do here, with the fix when it cannot. */
export function summarizeBuildSupport(support: BuildSupport): Record<string, unknown> {
  return {
    platform: support.platform,
    builder: support.builder,
    status: support.status,
    detail: support.detail,
    ...(support.needsInput === undefined ? {} : { needsInput: support.needsInput }),
    ...(support.remediation === undefined ? {} : { remediation: support.remediation }),
  };
}

export function summarizeState(state: RemoteAppState, detail: Detail): Record<string, unknown> {
  return {
    store: state.store,
    capturedAt: state.capturedAt,
    app: {
      id: state.app.ref.id,
      name: state.app.name,
      ...(state.app.bundleId === undefined ? {} : { bundleId: state.app.bundleId }),
      ...(state.app.primaryLocale === undefined ? {} : { primaryLocale: state.app.primaryLocale }),
      platforms: state.app.platforms,
    },
    versions: state.versions.map((version) => ({
      version: version.version,
      state: version.state,
      ...(version.track === undefined ? {} : { track: version.track }),
      ...(version.buildId === undefined ? {} : { buildId: version.buildId }),
    })),
    builds: state.builds.map((build) => ({
      buildNumber: build.buildNumber,
      state: build.state,
      ...(build.version === undefined ? {} : { version: build.version }),
    })),
    localizations:
      detail === 'full'
        ? state.localizations
        : state.localizations.map((localization) => localization.locale),
    tracks: state.tracks.map((track) => ({
      track: track.track,
      state: track.state,
      buildNumbers: track.buildNumbers,
      ...(track.userFraction === undefined ? {} : { userFraction: track.userFraction }),
    })),
    testerGroups: state.testerGroups.map((group) => ({
      name: group.name,
      track: group.track,
      memberCount: group.memberCount ?? group.members.length,
    })),
    ...(state.pricing === undefined ? {} : { pricing: state.pricing }),
    ...(detail === 'full' ? { images: state.images, products: state.products } : {}),
    /** Areas the store would not tell us about: unknown, never assumed empty. */
    gaps: state.gaps,
    pending: state.pending.map((operation) => summarizePendingOperation(operation, detail)),
  };
}

export function summarizeSnapshot(
  snapshot: StoredSnapshot,
  detail: Detail,
): Record<string, unknown> {
  return {
    fingerprint: snapshot.fingerprint,
    ...summarizeState(snapshot.state, detail),
  };
}
