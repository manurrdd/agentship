import {
  catalogContext,
  findCatalogEntry,
  pendingOf,
  renderCatalogPending,
  renderStoreCatalog,
} from '@agentship/catalog';
import {
  AgentshipError,
  ERROR_CODES,
  isNeedsInput,
  loadAnalysis,
  loadManifest,
  mergePendingOperations,
  type PendingOperation,
  type Store,
} from '@agentship/core';
import { credentialSource } from '@agentship/credentials';
import { z } from 'zod';
import { type Detail, ok } from '../format.js';
import { summarizePendingOperation } from '../summaries.js';
import { DETAIL_DESCRIPTION, parseInput, projectDirArg, type ToolDefinition } from './types.js';

/**
 * The console itinerary this project needs, before any plan exists.
 *
 * A first release is mostly console work, and most of it has to happen *before* Agentship can
 * plan anything at all — the app record has to exist before a snapshot can be captured, and
 * a snapshot is what a plan is built from. Listing only the operations a plan emitted would
 * therefore leave exactly the first-release path invisible, which is the one that needs it
 * most.
 *
 * So the catalog is rendered against the manifest and merged under whatever the project has
 * already persisted: persisted status always wins, so completed work never reappears as
 * open, and the entries a plan has enriched keep the richer content.
 */
async function catalogPendings(repoRoot: string): Promise<readonly PendingOperation[]> {
  const manifest = await loadManifest(repoRoot).catch(() => undefined);
  if (manifest === undefined) return [];
  const stores: Store[] = [];
  if (manifest.stores.apple !== undefined) stores.push('apple');
  if (manifest.stores.google !== undefined) stores.push('google');
  const analysis = await loadAnalysis(repoRoot);
  const context = catalogContext({
    manifest,
    ...(analysis === undefined ? {} : { analysis }),
    release: { version: manifest.release.version, track: manifest.release.track },
  });
  return renderStoreCatalog(stores, { context }).map(pendingOf);
}

/** Writes the catalog's version of an operation when the project has none yet. */
async function ensurePersisted(
  repoRoot: string,
  id: string,
  kernel: { listPending(): Promise<readonly PendingOperation[]> },
): Promise<void> {
  const persisted = await kernel.listPending();
  if (persisted.some((operation) => operation.id === id)) return;
  const fallback = (await catalogPendings(repoRoot)).find((operation) => operation.id === id);
  if (fallback === undefined) return;
  await mergePendingOperations(repoRoot, [fallback]);
}

function mergeById(
  persisted: readonly PendingOperation[],
  fallback: readonly PendingOperation[],
): PendingOperation[] {
  const byId = new Map(fallback.map((operation) => [operation.id, operation]));
  for (const operation of persisted) byId.set(operation.id, operation);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Marks operations `done` when local evidence already proves the work happened.
 *
 * An App Store Connect API key in the keyring proves someone created one (and, since Apple
 * only issues them to active memberships, that the enrolment exists); an app id in the
 * manifest proves the app record exists. Presenting those as "open" sends the user back to
 * console work they finished before Agentship arrived.
 *
 * Computed at list time and never persisted: anything in `.agentship/pending/` still wins,
 * and if the evidence disappears (credentials deleted, app id removed) the operation goes
 * honestly back to open. Google's create-app is deliberately not inferred from the package
 * name — the manifest always has one, so it proves nothing.
 */
async function withLocalEvidence(
  repoRoot: string,
  profile: string,
  operations: readonly PendingOperation[],
): Promise<PendingOperation[]> {
  const evidence = new Map<string, string>();
  const appleCredentials = (await credentialSource('apple', { profile })) !== 'none';
  if (appleCredentials) {
    evidence.set('apple:api-key', 'credentials configured via agentship_configure_auth');
    evidence.set(
      'apple:developer-enrollment',
      'inferred from the configured App Store Connect credentials: Apple only issues a team API key to an active Apple Developer Program membership',
    );
  }
  const manifest = await loadManifest(repoRoot).catch(() => undefined);
  const appId = manifest?.stores.apple?.appId;
  if (appId !== undefined && !isNeedsInput(appId)) {
    evidence.set(
      'apple:create-app-record',
      `the manifest already carries stores.apple.appId (${appId}), which only exists once the app record does`,
    );
  }

  return operations.map((operation) => {
    const note = evidence.get(operation.id);
    // Persisted progress always wins; evidence only lifts states that still read as open.
    const upgradable =
      operation.status === 'open' ||
      operation.status === 'in_progress' ||
      operation.status === 'failed';
    if (note === undefined || !upgradable) return operation;
    return { ...operation, status: 'done', notes: note };
  });
}

/**
 * The itinerary in dependency order (unblocked first), using the catalog's `blockedBy`
 * graph. Kahn's algorithm with ids as the tie-break, so the order is deterministic. Ids the
 * catalog does not know keep their relative (alphabetical) position at the end of each rank.
 */
function itineraryOrder(operations: readonly PendingOperation[]): PendingOperation[] {
  const ids = new Set(operations.map((operation) => operation.id));
  const blockers = new Map<string, Set<string>>();
  for (const operation of operations) {
    const declared = findCatalogEntry(operation.id)?.blockedBy ?? [];
    blockers.set(operation.id, new Set(declared.filter((id) => ids.has(id))));
  }
  const remaining = new Map([...blockers].map(([id, set]) => [id, new Set(set)]));
  const out: PendingOperation[] = [];
  const byId = new Map(operations.map((operation) => [operation.id, operation]));
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, set]) => set.size === 0)
      .map(([id]) => id)
      .sort();
    // A cycle would stall the loop; the catalog is validated, but a persisted operation
    // could in theory collide. Flush the rest alphabetically rather than hang.
    const batch = ready.length > 0 ? ready : [...remaining.keys()].sort();
    for (const id of batch) {
      remaining.delete(id);
      const operation = byId.get(id);
      if (operation !== undefined) out.push(operation);
    }
    for (const set of remaining.values()) for (const id of batch) set.delete(id);
  }
  return out;
}

const schema = z.object({
  projectDir: projectDirArg,
  action: z
    .enum(['list', 'get', 'complete', 'verify'])
    .describe(
      'list: every pending operation with its status. get: one, with full console instructions. complete: mark the console work as done. verify: ask the store whether it actually landed.',
    ),
  id: z
    .string()
    .optional()
    .describe('Pending operation id. Required for get and complete, and for a single verify.'),
  ids: z
    .array(z.string())
    .optional()
    .describe(
      'Verify only: several operation ids in one call. Agentship reads each store once for the whole batch, so this is much faster than one call per id — and far better than issuing them in parallel, which only queues full store snapshots behind each other.',
    ),
  refresh: z
    .boolean()
    .optional()
    .describe(
      'List only: when true, verify every store-checkable operation against one fresh snapshot per store before returning. Default false so a plain list is instant and offline.',
    ),
  notes: z
    .string()
    .optional()
    .describe('What was done, recorded with a "complete" transition. No secrets.'),
  detail: z.enum(['concise', 'full']).optional().describe(DETAIL_DESCRIPTION),
});

export const pendingTool: ToolDefinition = {
  name: 'agentship_pending',
  title: 'Work the store console can only do by hand',
  description: `List and advance the operations no API can perform. Each one carries why it cannot be automated, the console URL and path, the ordered steps, the fields with the values Agentship proposes, and how Agentship will later verify it.

Two kinds, and the difference matters:
- agent_browser — you may drive your own browser through the steps, if you have one. Show the user what you are about to submit first.
- human_only — a human must do it: identity, tax and banking details, legal agreements, two-factor authentication, anything binding. Never attempt these, never ask for the credentials they need. Hand over the steps and wait.

Flow: get the instructions -> the work happens in the console -> "complete" -> "verify". Verification re-reads the store; if it answers verified:false with "no verifier registered", that is honest, not a failure — Agentship simply cannot confirm this one automatically, so ask the user to confirm instead. A plain "list" stays fast and offline; use refresh:true when you explicitly want it to reconcile every checkable status first.

Verify several operations in ONE call with "ids". Reading a store is the slow part — a dozen calls, and Google serialises them per package — so one snapshot is captured and shared by the whole batch. Never issue verifies in parallel instead: they queue behind each other and each pays for its own snapshot.

Proposed field values are proposals. The user decides; never present them as decided, and never invent a value for a field Agentship left empty.

An action blocked by a pending operation stays blocked until that operation is done or verified — completing it is what unblocks the next agentship_apply.`,
  schema,
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },

  async handler(session, args, progress) {
    const input = parseInput(schema, args);
    const detail: Detail = input.detail ?? 'concise';
    const repoRoot = await session.requireProject(input.projectDir);
    const kernel = await session.engine.kernel(repoRoot);

    if (input.action === 'list') {
      // When refresh was requested, close what the stores already show as done before listing.
      //
      // A pending operation is console work, and the store is the only witness to it being
      // finished. Without this, an app with a live release in closed testing still listed
      // "Create the app record", "Create the app in Play Console" and "Publish the first
      // release" as open — work completed weeks earlier. A dozen false entries is not
      // cosmetic: it is what stops the itinerary from being readable at all, because the
      // user can no longer tell what is actually blocking them.
      //
      // Every operation that declares an automatic check is then confirmed against one fresh
      // snapshot per store, which is the same read `agentship_store_status` performs. A
      // store that cannot be reached must not turn listing into an error, so a failure here
      // only leaves the statuses as they were and says so.
      const closable = input.refresh
        ? (await kernel.listPending())
            .filter((operation) => operation.status === 'open' || operation.status === 'done')
            .filter((operation) => operation.verification?.check !== undefined)
            .map((operation) => operation.id)
        : [];
      let verificationNote: string | undefined;
      if (closable.length > 0) {
        try {
          await kernel.verifyPending(closable, (message) => progress(message));
        } catch (error) {
          verificationNote = `Statuses below may be stale: Agentship could not confirm them against the stores (${
            AgentshipError.is(error) ? error.message : String(error)
          }).`;
        }
      }

      const persisted = await kernel.listPending();
      const merged = mergeById(persisted, await catalogPendings(repoRoot));
      const profile = await session.engine.profileFor(repoRoot);
      const operations = await withLocalEvidence(repoRoot, profile, merged);

      // Contingencies are real catalog entries, but they only apply when their situation
      // occurs (a rejection, a transfer, a version the store is holding). Mixing them into
      // the itinerary makes twelve steps look like seventeen. The moment one is triggered
      // — a plan emitted it, so it is persisted — it is live work and rejoins the list.
      const persistedIds = new Set(persisted.map((operation) => operation.id));
      const contingencies = operations.filter(
        (operation) =>
          findCatalogEntry(operation.id)?.applicability === 'contingency' &&
          !persistedIds.has(operation.id),
      );
      const contingencyIds = new Set(contingencies.map((operation) => operation.id));
      const itinerary = itineraryOrder(
        operations.filter((operation) => !contingencyIds.has(operation.id)),
      );

      const summarize = (operation: PendingOperation): Record<string, unknown> => {
        const blockedBy = findCatalogEntry(operation.id)?.blockedBy ?? [];
        return {
          ...summarizePendingOperation(operation, detail),
          ...(blockedBy.length === 0 ? {} : { blockedBy }),
        };
      };
      const actorIds = (actionClass: string): string[] =>
        operations
          .filter((operation) => operation.actionClass === actionClass)
          .map((operation) => operation.id)
          .sort();

      return ok({
        projectDir: repoRoot,
        counts: {
          total: operations.length,
          open: operations.filter((operation) => operation.status === 'open').length,
          done: operations.filter((operation) => operation.status === 'done').length,
          verified: operations.filter((operation) => operation.status === 'verified').length,
        },
        /** The itinerary, in dependency order: entries whose blockers are done come first. */
        pending: itinerary.map(summarize),
        ...(contingencies.length === 0
          ? {}
          : {
              contingencies: contingencies.map(summarize),
              contingenciesNote:
                'Contingency operations only apply when their situation occurs (a rejection, an app transfer, a version the store is holding). Do not present them as steps of the itinerary; once one is actually triggered by a plan it moves into "pending".',
            }),
        /** Who can perform what: your browser may attempt agent_browser ids (after showing the user the values); human_only ids are the user's alone. */
        actors: {
          agent_browser: actorIds('agent_browser'),
          human_only: actorIds('human_only'),
        },
        ...(input.refresh === true
          ? {}
          : {
              refreshAvailable: operations
                .filter((operation) => operation.verification?.check !== undefined)
                .map((operation) => operation.id),
            }),
        ...(verificationNote === undefined ? {} : { verificationNote }),
        nextStep:
          operations.length === 0
            ? 'No console work is pending.'
            : 'Work the itinerary in the order listed (blockedBy names the prerequisites). Call this tool with action "get" and an id to see the full instructions for one operation.',
      });
    }

    // "verify" is the one action that takes a batch; the rest address exactly one operation.
    const missingId = (detail: string): AgentshipError =>
      new AgentshipError(ERROR_CODES.PLAN_INPUT_REQUIRED, detail, {
        remediation: { summary: 'Call agentship_pending with action "list" to see the ids.' },
      });

    if (input.action === 'verify') {
      const ids = input.ids ?? (input.id === undefined ? [] : [input.id]);
      if (ids.length === 0) {
        throw missingId(
          'The "verify" action needs at least one pending operation id, in "id" or "ids".',
        );
      }
      // The catalog knows operations no plan has emitted yet, and the whole first-release
      // path lives there: `list` shows "Create the app record in App Store Connect" and
      // `get` explains it, but `verify` used to answer `PLAN_NOT_FOUND: no pending operation
      // with id "apple:create-app-record"` — so the one step the user had just been told to
      // perform was the one step they could not confirm. Persisting the catalog's version
      // first makes the three actions agree about what exists.
      for (const id of ids) await ensurePersisted(repoRoot, id, kernel);
      const results = await kernel.verifyPending(ids, (message) => progress(message));
      const unconfirmed = results.filter((result) => !result.verified);
      return ok({
        projectDir: repoRoot,
        verifications: results.map((result) => ({
          id: result.operation.id,
          verified: result.verified,
          detail: result.detail,
          pending: summarizePendingOperation(result.operation, detail),
        })),
        nextStep:
          unconfirmed.length === 0
            ? 'Call agentship_apply (or agentship_resume) to run the actions these operations were blocking.'
            : `Agentship could not confirm ${unconfirmed.map((result) => result.operation.id).join(', ')}. Ask the user to check the console, or continue and let the next plan tell you.`,
      });
    }

    const id = input.id;
    if (id === undefined) {
      throw missingId(`The "${input.action}" action needs a pending operation id.`);
    }

    if (input.action === 'get') {
      // An id the project has never persisted is still answerable when the catalog knows it:
      // that is the whole first-release path, where nothing has been planned yet.
      const operation = await kernel.getPending(id).catch(async (error: unknown) => {
        const entry = findCatalogEntry(id);
        if (entry === undefined) throw error;
        const manifest = await loadManifest(repoRoot).catch(() => undefined);
        const analysis = await loadAnalysis(repoRoot);
        return pendingOf(
          renderCatalogPending(entry, {
            context: catalogContext({
              ...(manifest === undefined ? {} : { manifest }),
              ...(analysis === undefined ? {} : { analysis }),
              ...(manifest === undefined
                ? {}
                : {
                    release: { version: manifest.release.version, track: manifest.release.track },
                  }),
            }),
          }),
        );
      });
      return ok({
        projectDir: repoRoot,
        pending: summarizePendingOperation(operation, 'full'),
        nextStep:
          operation.actionClass === 'human_only'
            ? 'Relay these steps to the user. Do not attempt them. When they say it is done, call action "complete".'
            : 'You may perform these steps in your own browser after showing the user the values you will submit. Then call action "complete".',
      });
    }

    // Console work done before the first plan has nothing persisted to transition, so the
    // catalog entry is written first. Without this, the whole first-release path would be
    // impossible to record.
    await ensurePersisted(repoRoot, id, kernel);
    const operation = await kernel.completePending(
      id,
      ...(input.notes === undefined ? [] : ([input.notes] as const)),
    );
    return ok({
      projectDir: repoRoot,
      pending: summarizePendingOperation(operation, detail),
      nextStep:
        'Call action "verify" so Agentship confirms it against the store — with "ids" if more console work was finished, so one store read covers all of them.',
    });
  },
};
