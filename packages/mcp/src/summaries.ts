import type { BuildOutcome, BuildSupport } from '@agentship/build';
import type {
  ActionOutcome,
  AgentshipManifest,
  AppAnalysis,
  ApplyResult,
  PendingOperation,
  PendingStatus,
  PlannedAction,
  ReleasePlan,
  RemoteAppState,
  RemoteProduct,
  RemoteProductOffer,
  RemoteProductPrice,
  StoredSnapshot,
  SubmissionReadiness,
} from '@agentship/core';
import { isNeedsInput, manifestGaps } from '@agentship/core';
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
    // Reminders, not gates: work a launch may need outside the stores. The agent walks
    // them with the user before submitting; dismissing one with a reason is a valid outcome.
    launchChecks: analysis.launchChecks,
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

/** Identical offers across many territories collapse into one line with a count. */
const OFFER_TERRITORY_LIST_LIMIT = 5;
/** Per-territory prices above this collapse into count + base + range. */
const PRICE_LIST_LIMIT = 10;

/**
 * Offers aggregated by content.
 *
 * Apple scopes an introductory offer per territory, so one commercial decision ("one week
 * free") comes back as dozens of identical resources. What a reader needs is the decision
 * and its reach, not three hundred lines: identical offers are grouped by
 * (kind, mode, duration, periods, price) with the number of territories, and the list of
 * territories only when it is short enough to be information.
 */
function aggregateOffers(offers: readonly RemoteProductOffer[]): Record<string, unknown>[] {
  const groups = new Map<string, { sample: RemoteProductOffer; territories: string[] }>();
  for (const offer of offers) {
    const key = [offer.kind, offer.mode, offer.duration, offer.periods, offer.price].join('|');
    const group = groups.get(key) ?? { sample: offer, territories: [] };
    if (offer.territory !== undefined) group.territories.push(offer.territory);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ sample, territories }) => ({
    kind: sample.kind,
    ...(sample.mode === undefined ? {} : { mode: sample.mode }),
    ...(sample.duration === undefined ? {} : { duration: sample.duration }),
    ...(sample.periods === undefined ? {} : { periods: sample.periods }),
    ...(sample.price === undefined ? {} : { price: sample.price }),
    ...(sample.state === undefined ? {} : { state: sample.state }),
    territories: territories.length,
    ...(territories.length > 0 && territories.length <= OFFER_TERRITORY_LIST_LIMIT
      ? { territoryList: [...territories].sort() }
      : {}),
  }));
}

/** Fifty territory prices become a count, the base territory's price and the range. */
function summarizePrices(
  prices: readonly RemoteProductPrice[],
  baseTerritory: string | undefined,
): unknown {
  if (prices.length <= PRICE_LIST_LIMIT) return prices;
  const numeric = prices
    .map((price) => ({ price, value: Number.parseFloat(price.price) }))
    .filter((entry) => Number.isFinite(entry.value));
  const base = prices.find((price) => price.territory === (baseTerritory ?? 'USA')) ?? prices[0];
  return {
    territories: prices.length,
    ...(base === undefined ? {} : { base }),
    ...(numeric.length === 0
      ? {}
      : {
          range: {
            min: numeric.reduce((a, b) => (a.value <= b.value ? a : b)).price,
            max: numeric.reduce((a, b) => (a.value >= b.value ? a : b)).price,
          },
        }),
  };
}

function summarizeProduct(
  product: RemoteProduct,
  baseTerritory: string | undefined,
): Record<string, unknown> {
  const { prices, offers, ...rest } = product;
  return {
    ...rest,
    ...(prices === undefined ? {} : { prices: summarizePrices(prices, baseTerritory) }),
    ...(offers === undefined ? {} : { offers: aggregateOffers(offers) }),
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
    ...(detail === 'full'
      ? {
          images: state.images,
          products: state.products.map((product) =>
            summarizeProduct(product, state.pricing?.baseTerritory),
          ),
        }
      : {}),
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

/** Manifest locale fields that map one-to-one onto a store localization's fields. */
const ADOPTABLE_LOCALE_FIELDS = [
  'name',
  'subtitle',
  'shortDescription',
  'description',
  'keywords',
  'whatsNew',
  'promotionalText',
  'marketingUrl',
  'supportUrl',
  'privacyPolicyUrl',
  'videoUrl',
] as const;

const ADOPTABLE_VALUE_LIMIT = 200;

export interface AdoptableEntry {
  /** Manifest dot path of the gap, e.g. `metadata.locales.en-US.description`. */
  readonly path: string;
  readonly store: string;
  /** The store's current value, truncated for the response; the store holds the full text. */
  readonly remoteValue: string;
  readonly note: string;
}

/** Instruction that travels with every adoptable list. The agent adopts; Agentship never writes. */
export const ADOPTABLE_NOTE =
  'These manifest gaps have a value the store already holds. Show each one to the user; if they agree, write the value into .agentship/agentship.yaml yourself with a provenance comment: "# adopted from <store> on <date>". Agentship never writes them automatically.';

/**
 * Manifest gaps whose value the store already knows.
 *
 * A `<needs_input>` description on an app that is already listed is not a question for the
 * user — the answer is on the store page. This offers those values for explicit adoption:
 * the agent shows them, the user agrees, the agent writes the manifest with a provenance
 * comment. Nothing is backfilled silently, because a store value is a fact about the store,
 * not automatically the user's intent.
 */
export function adoptableFromStates(
  manifest: AgentshipManifest,
  states: readonly RemoteAppState[],
): AdoptableEntry[] {
  const entries: AdoptableEntry[] = [];
  for (const gap of manifestGaps(manifest)) {
    const match = /^metadata\.locales\.([^.]+)\.([^.]+)$/.exec(gap.path);
    if (match === null) continue;
    const [, locale, field] = match;
    if (!ADOPTABLE_LOCALE_FIELDS.includes(field as (typeof ADOPTABLE_LOCALE_FIELDS)[number])) {
      continue;
    }
    for (const state of states) {
      const value = state.localizations
        .filter((localization) => localization.locale === locale)
        .map((localization) => localization[field as keyof typeof localization] as unknown)
        .find((candidate): candidate is string => typeof candidate === 'string');
      if (value === undefined || value.trim() === '') continue;
      entries.push({
        path: gap.path,
        store: state.store,
        remoteValue:
          value.length > ADOPTABLE_VALUE_LIMIT
            ? `${value.slice(0, ADOPTABLE_VALUE_LIMIT)}…`
            : value,
        note: `Read from the ${state.store} listing for ${locale}. Offer it to the user for adoption before asking them to write one.`,
      });
      break;
    }
  }
  return entries;
}

export interface DriftEntry {
  /** `undeclared_locale` — the store publishes it and the manifest is silent about it.
   *  `differs` — both have a value and they are not the same text. */
  readonly kind: 'undeclared_locale' | 'differs';
  readonly store: string;
  readonly locale: string;
  /** Manifest dot path, for `differs`. */
  readonly path?: string;
  readonly detail: string;
}

/** Instruction that travels with every drift report. */
export const DRIFT_NOTE =
  'The store holds listing text the manifest does not describe, or describes differently. Agentship applies the manifest, so an unreviewed difference here is published over. Show these to the user before approving a metadata change: whoever wrote the store version may not have been Agentship.';

/**
 * Where the store and the manifest disagree about text that already exists.
 *
 * The manifest is the desired state, so a plan proposes to make the store match it — which
 * is correct, and dangerous exactly once: when the store's version is the newer one because
 * someone edited it in the console. Agentship keeps a single snapshot per store and cannot
 * tell who wrote what, so it does not claim to know which side is right. It reports the
 * disagreement and lets the user decide, which is the difference between an informed
 * overwrite and a silent revert.
 *
 * Locales the store publishes and the manifest never mentions are the other half: nothing
 * diffs them, so without this they are invisible — a manifest with one locale looks complete
 * next to a listing published in ten.
 */
export function driftFromStates(
  manifest: AgentshipManifest,
  states: readonly RemoteAppState[],
): DriftEntry[] {
  const entries: DriftEntry[] = [];
  for (const state of states) {
    for (const localization of state.localizations) {
      const declared = manifest.metadata.locales[localization.locale];
      if (declared === undefined) {
        const published = ADOPTABLE_LOCALE_FIELDS.filter(
          (field) => typeof localization[field] === 'string' && localization[field] !== '',
        );
        if (published.length === 0) continue;
        entries.push({
          kind: 'undeclared_locale',
          store: state.store,
          locale: localization.locale,
          detail: `The ${state.store} listing is published in ${localization.locale} (${published.join(', ')}), and the manifest does not declare that locale. Agentship neither updates nor removes it.`,
        });
        continue;
      }
      for (const field of ADOPTABLE_LOCALE_FIELDS) {
        const wanted = declared[field];
        const published = localization[field];
        if (typeof wanted !== 'string' || typeof published !== 'string') continue;
        if (wanted === published || isNeedsInput(wanted)) continue;
        entries.push({
          kind: 'differs',
          store: state.store,
          locale: localization.locale,
          path: `metadata.locales.${localization.locale}.${field}`,
          detail: `The manifest says ${describeText(wanted)}; the ${state.store} listing has ${describeText(published)}. Applying the manifest replaces the published text.`,
        });
      }
    }
  }
  return entries;
}

/** Length plus a short head, so a 1,300-character description is comparable without quoting it. */
function describeText(value: string): string {
  const head = value.length > 60 ? `${value.slice(0, 60)}…` : value;
  return `${value.length} characters ("${head}")`;
}

export interface ReadinessItem {
  readonly severity: 'blocking' | 'warning';
  /** What kind of obstacle: `manifest`, `console`, `privacy`, `build`, `store`. */
  readonly source: string;
  readonly summary: string;
  readonly remediation: string;
}

/**
 * What stands between this project and a review submission, per store, blockers first.
 *
 * Two sources, and the second is the one that matters. Most items are derived from what the
 * plan already computed — `needs_input` actions, open pending operations that block actions,
 * the structured privacy findings, a planned build standing in for a missing artifact — and
 * those can only ever report the gaps Agentship was built to look for. The `store` items come
 * from asking the store itself what it would refuse, which is the only way to learn about a
 * reviewer field that became mandatory or a screenshot size that stopped being accepted.
 */
export function planReadiness(
  plan: ReleasePlan,
  pendingStatuses?: ReadonlyMap<string, PendingStatus>,
  submissionReadiness?: readonly SubmissionReadiness[],
): Record<string, ReadinessItem[]> {
  const readiness: Record<string, ReadinessItem[]> = {};
  for (const store of plan.stores) {
    const items: ReadinessItem[] = [];

    const reported = submissionReadiness?.find((entry) => entry.store === store);
    for (const blocker of reported?.blockers ?? []) {
      // The store's own severity is kept: it decides what stops a submission, not Agentship.
      items.push({
        severity: blocker.blocking ? 'blocking' : 'warning',
        source: 'store',
        summary: `[${blocker.code}] ${blocker.message}`,
        remediation:
          blocker.remediation ??
          `Reported by the ${store} store itself. Fix it in the manifest if Agentship can write that field, in the console otherwise.`,
      });
    }

    for (const action of plan.actions) {
      if (action.store !== store) continue;
      if (action.classification === 'needs_input') {
        items.push({
          severity: 'blocking',
          source: 'manifest',
          summary: action.summary,
          remediation: `Fill ${(action.needsInput ?? []).join(', ')} in .agentship/agentship.yaml, then plan again.`,
        });
      }
      if (action.local !== undefined) {
        items.push({
          severity: 'warning',
          source: 'build',
          summary: 'No usable signed artifact exists yet; the plan includes a build.',
          remediation:
            'Let agentship_apply run the build action, or declare a pre-built artifact under release.artifacts.',
        });
      }
    }

    for (const operation of plan.pending) {
      if (operation.store !== store) continue;
      const status = pendingStatuses?.get(operation.id) ?? operation.status;
      const open = status === 'open' || status === 'in_progress' || status === 'failed';
      if (!open || operation.blocking === undefined || operation.blocking.length === 0) continue;
      items.push({
        severity: 'blocking',
        source: 'console',
        summary: `${operation.title} (${operation.id}) is still ${status} and blocks ${operation.blocking.length} planned action(s).`,
        remediation: `Complete it via agentship_pending (get "${operation.id}" → the work happens → complete → verify).`,
      });
    }

    for (const finding of plan.findings) {
      if (finding.store !== undefined && finding.store !== store) continue;
      items.push({
        severity: finding.severity === 'error' ? 'blocking' : 'warning',
        source: 'privacy',
        summary: `[${finding.code}] ${finding.message}`,
        remediation: finding.remediation,
      });
    }

    items.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
    readiness[store] = items;
  }
  return readiness;
}

function severityRank(severity: ReadinessItem['severity']): number {
  return severity === 'blocking' ? 0 : 1;
}
