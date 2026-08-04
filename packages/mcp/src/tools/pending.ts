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
  loadAnalysis,
  loadManifest,
  mergePendingOperations,
  type PendingOperation,
  type Store,
} from '@agentship/core';
import { z } from 'zod';
import { type Detail, ok } from '../format.js';
import { summarizePendingOperation } from '../summaries.js';
import { DETAIL_DESCRIPTION, projectDirArg, type ToolDefinition } from './types.js';

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
    .describe('Pending operation id. Required for get, complete and verify.'),
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

Flow: get the instructions -> the work happens in the console -> "complete" -> "verify". Verification re-reads the store; if it answers verified:false with "no verifier registered", that is honest, not a failure — Agentship simply cannot confirm this one automatically, so ask the user to confirm instead.

Proposed field values are proposals. The user decides; never present them as decided, and never invent a value for a field Agentship left empty.

An action blocked by a pending operation stays blocked until that operation is done or verified — completing it is what unblocks the next agentship_apply.`,
  schema,
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },

  async handler(session, args) {
    const input = schema.parse(args);
    const detail: Detail = input.detail ?? 'concise';
    const repoRoot = await session.requireProject(input.projectDir);
    const kernel = await session.engine.kernel(repoRoot);

    if (input.action === 'list') {
      const operations = mergeById(await kernel.listPending(), await catalogPendings(repoRoot));
      return ok({
        projectDir: repoRoot,
        counts: {
          total: operations.length,
          open: operations.filter((operation) => operation.status === 'open').length,
          done: operations.filter((operation) => operation.status === 'done').length,
          verified: operations.filter((operation) => operation.status === 'verified').length,
        },
        pending: operations.map((operation) => summarizePendingOperation(operation, detail)),
        nextStep:
          operations.length === 0
            ? 'No console work is pending.'
            : 'Call this tool with action "get" and an id to see the full instructions for one operation.',
      });
    }

    const id = input.id;
    if (id === undefined) {
      throw new AgentshipError(
        ERROR_CODES.PLAN_INPUT_REQUIRED,
        `The "${input.action}" action needs a pending operation id.`,
        { remediation: { summary: 'Call agentship_pending with action "list" to see the ids.' } },
      );
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

    if (input.action === 'complete') {
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
        nextStep: 'Call action "verify" so Agentship confirms it against the store.',
      });
    }

    const result = await kernel.verifyPending(id);
    return ok({
      projectDir: repoRoot,
      verified: result.verified,
      detail: result.detail,
      pending: summarizePendingOperation(result.operation, detail),
      nextStep: result.verified
        ? 'Call agentship_apply (or agentship_resume) to run the actions this operation was blocking.'
        : 'Agentship could not confirm it. Ask the user to check the console, or continue and let the next plan tell you.',
    });
  },
};
