import type { PendingField, PendingOperation, PendingStatus, Store } from '@agentship/core';
import { optional } from '@agentship/core';
import type { CatalogContext } from './interpolate.js';
import { renderInstruction, resolveTemplate } from './interpolate.js';
import { type CatalogEntryWithStore, catalogEntries, catalogEntry } from './load.js';

/**
 * Turning a catalog entry into the {@link PendingOperation} the rest of Agentship speaks.
 *
 * The engine already has one vocabulary for console work; the catalog does not introduce a
 * second. What it adds is content: preconditions and cautions folded into the ordered steps
 * an operator reads, field values resolved from the project, and a verification that is
 * either a registered check or an explicit manual checklist.
 *
 * Every gap is visible rather than papered over. A field whose template found no value keeps
 * no `proposedValue` at all — an operator must never be shown an invented one — and the
 * missing manifest paths are collected into the operation's notes so the agent can ask for
 * exactly those.
 */
export interface RenderedPending extends PendingOperation {
  /** Context paths the entry wanted and the project did not have. */
  readonly missing: readonly string[];
}

export interface RenderOptions {
  readonly context?: CatalogContext;
  /** Status to render with; defaults to `open`. Persisted status wins on merge. */
  readonly status?: PendingStatus;
  /** Appended after the catalog's own notes, e.g. a privacy projection summary. */
  readonly extraNotes?: string;
  /**
   * Fields computed at plan time rather than written in the catalog.
   *
   * A catalog entry describes a *form*, and some forms have one row per thing the project
   * turns out to contain — an App Privacy declaration has one row per data type the app
   * collects, which no static file can enumerate. The producer computes those rows and
   * passes them here; the catalog still owns the instructions, the cautions and the
   * verification.
   */
  readonly extraFields?: readonly PendingField[];
  /** Steps appended after the catalog's own, for the same reason as `extraFields`. */
  readonly extraSteps?: readonly string[];
}

function renderFields(
  entry: CatalogEntryWithStore,
  context: CatalogContext,
  missing: string[],
): PendingField[] {
  const fields: PendingField[] = [];
  for (const step of entry.steps) {
    for (const field of step.fields) {
      const resolved =
        field.value === undefined ? undefined : resolveTemplate(field.value, context);
      if (resolved !== undefined) {
        for (const path of resolved.missing) if (!missing.includes(path)) missing.push(path);
      }
      // A value that could not be fully resolved is not a proposal: showing a half-rendered
      // string as "what Agentship suggests" is exactly how a wrong value reaches a store.
      const usable = resolved !== undefined && resolved.missing.length === 0;
      const rationale = [
        field.rationale,
        field.source === undefined ? undefined : `Source: ${field.source}.`,
        field.caution,
      ]
        .filter((part): part is string => part !== undefined)
        .join(' ');
      fields.push({
        name: field.name,
        label: field.label,
        required: field.required,
        ...(usable ? { proposedValue: (resolved as { text: string }).text } : {}),
        ...(rationale === '' ? {} : { rationale }),
        ...optional('options', field.options),
      });
    }
  }
  return fields;
}

function renderSteps(entry: CatalogEntryWithStore): string[] {
  const steps: string[] = [];
  for (const precondition of entry.preconditions) {
    steps.push(`Before you start: ${precondition}`);
  }
  for (const step of entry.steps) {
    const text = renderInstruction(step.instruction, step.fields);
    steps.push(step.caution === undefined ? text : `${text} — CAUTION: ${step.caution}`);
  }
  const fieldCautions = entry.steps
    .flatMap((step) => step.fields)
    .filter((field) => field.caution !== undefined)
    .map((field) => `CAUTION (${field.label}): ${field.caution as string}`);
  steps.push(...fieldCautions);
  if (entry.verify.kind === 'manual') {
    steps.push(
      `Confirm before leaving the console: ${entry.verify.checklist.join('; ')}. Agentship cannot check this from any API.`,
    );
  }
  return steps;
}

/** Renders one catalog entry against a project context. */
export function renderCatalogPending(
  entry: CatalogEntryWithStore,
  options: RenderOptions = {},
): RenderedPending {
  const context = options.context ?? {};
  const missing: string[] = [];
  const fields = [...renderFields(entry, context, missing), ...(options.extraFields ?? [])];

  const params: Record<string, string> = {};
  if (entry.verify.kind === 'api' && entry.verify.params !== undefined) {
    for (const [key, template] of Object.entries(entry.verify.params)) {
      const resolved = resolveTemplate(template, context);
      for (const path of resolved.missing) if (!missing.includes(path)) missing.push(path);
      if (resolved.missing.length === 0) params[key] = resolved.text;
    }
  }

  const notes = [
    entry.notes,
    entry.humanReason === undefined ? undefined : `Why a human: ${entry.humanReason}`,
    options.extraNotes,
    missing.length === 0
      ? undefined
      : `Agentship has no value for: ${missing.join(', ')}. Ask the user; never invent one.`,
  ]
    .filter((part): part is string => part !== undefined)
    .join('\n');

  return {
    id: entry.id,
    store: entry.store,
    category: entry.category,
    title: entry.title,
    reason: entry.reason,
    actionClass: entry.class,
    console: {
      url: entry.console.url,
      ...(entry.console.path.length === 0 ? {} : { path: entry.console.path }),
      lastVerified: entry.lastVerified,
    },
    steps: [...renderSteps(entry), ...(options.extraSteps ?? [])],
    ...(fields.length === 0 ? {} : { fields }),
    verification:
      entry.verify.kind === 'api'
        ? {
            summary: entry.verify.summary,
            check: entry.verify.check,
            ...(Object.keys(params).length === 0 ? {} : { params }),
          }
        : { summary: entry.verify.summary },
    status: options.status ?? 'open',
    ...(notes === '' ? {} : { notes }),
    missing,
  };
}

/** Renders one entry by id. */
export function renderPending(id: string, options: RenderOptions = {}): RenderedPending {
  return renderCatalogPending(catalogEntry(id), options);
}

/**
 * Drops the render-time bookkeeping, leaving the pending operation the kernel persists.
 *
 * `missing` is useful while composing the operation and meaningless once it is on disk — a
 * later render against a fuller manifest would contradict it — so it never reaches
 * `.agentship/pending/`.
 */
export function pendingOf(rendered: RenderedPending): PendingOperation {
  const { missing: _missing, ...operation } = rendered;
  return operation;
}

/**
 * Every catalog entry for the given stores, rendered.
 *
 * This is what makes a first release navigable before any plan exists: `agentship_pending`
 * can list the whole console itinerary — create the record, agreements, pricing, content
 * rating, privacy — from the manifest alone, with the values Agentship proposes already in
 * place.
 */
export function renderStoreCatalog(
  stores: readonly Store[],
  options: RenderOptions = {},
): readonly RenderedPending[] {
  return stores
    .flatMap((store) => catalogEntries(store))
    .map((entry) => renderCatalogPending(entry, options));
}
