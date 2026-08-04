import { appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ensureDir, FILE_MODE, stateDir } from '../paths.js';
import { AGENTSHIP_VERSION } from './version.js';

/**
 * Write-ahead journal: `.agentship/state/journal.jsonl`, append-only JSONL.
 *
 * Before the executor asks an adapter to change anything it appends an `intent` record;
 * after the call it appends a `result`. The journal therefore never under-reports: any
 * effect the store may have received has an intent on disk. That asymmetry is the whole
 * design — recovery must over-suspect, never over-trust:
 *
 * - An `intent` without a `result` (orphan) means "the effect may or may not have landed".
 *   Resume never re-executes it blindly: it re-captures the store and replans, so the
 *   fresh snapshot — not the journal — decides whether the action still needs doing.
 * - A truncated final line is the signature of a kill mid-append. It is discarded with a
 *   warning; safe, because the record it lost was either an intent (over-suspicion) or a
 *   result (the fresh snapshot supersedes it).
 * - Any other malformed content marks the journal corrupt. A corrupt journal never
 *   causes execution: it only removes the "already done" shortcut, forcing the same
 *   snapshot-verified path as above.
 *
 * The journal records ids, kinds and outcomes — never payloads — so no secret or
 * store-visible content can leak through it.
 */

const JournalEntrySchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('intent'),
      v: z.literal(1),
      agentship: z.string(),
      at: z.iso.datetime(),
      planId: z.string().min(1),
      actionId: z.string().min(1),
      /** Equal to `actionId` today; recorded separately so the contract is explicit. */
      idempotencyKey: z.string().min(1),
      store: z.enum(['apple', 'google']),
      kind: z.string().min(1),
      attempt: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal('result'),
      v: z.literal(1),
      agentship: z.string(),
      at: z.iso.datetime(),
      planId: z.string().min(1),
      actionId: z.string().min(1),
      idempotencyKey: z.string().min(1),
      attempt: z.number().int().positive(),
      status: z.enum(['done', 'failed', 'pending', 'skipped']),
      changed: z.boolean().optional(),
      /** Whether the op was part of a platform-guaranteed atomic transaction. */
      atomic: z.boolean().optional(),
      errorCode: z.string().optional(),
      errorMessage: z.string().optional(),
    })
    .strict(),
]);

export type JournalEntry = z.infer<typeof JournalEntrySchema>;
export type JournalIntent = Extract<JournalEntry, { type: 'intent' }>;
export type JournalResult = Extract<JournalEntry, { type: 'result' }>;

export function journalPath(repoRoot: string): string {
  return join(stateDir(repoRoot), 'journal.jsonl');
}

export interface JournalWriter {
  intent(fields: Omit<JournalIntent, 'type' | 'v' | 'agentship' | 'at'>): void;
  result(fields: Omit<JournalResult, 'type' | 'v' | 'agentship' | 'at'>): void;
}

/**
 * Opens the journal for appending. Writes are synchronous on purpose: an intent must be
 * on disk before the adapter call it announces, whatever happens to the process next.
 */
export async function openJournal(repoRoot: string): Promise<JournalWriter> {
  await ensureDir(stateDir(repoRoot));
  const path = journalPath(repoRoot);
  const append = (entry: JournalEntry): void => {
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: FILE_MODE });
  };
  return {
    intent(fields) {
      append({ type: 'intent', v: 1, agentship: AGENTSHIP_VERSION, at: nowIso(), ...fields });
    },
    result(fields) {
      append({ type: 'result', v: 1, agentship: AGENTSHIP_VERSION, at: nowIso(), ...fields });
    },
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface JournalReadResult {
  readonly entries: readonly JournalEntry[];
  readonly warnings: readonly string[];
  /**
   * True when a non-final line was unreadable. Callers must then ignore every completion
   * claim and let a fresh snapshot decide — which is what resume does anyway.
   */
  readonly corrupt: boolean;
}

/** Reads and validates the journal. Never throws on bad content; see the module doc. */
export async function readJournal(repoRoot: string): Promise<JournalReadResult> {
  let raw: string;
  try {
    raw = await readFile(journalPath(repoRoot), 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return { entries: [], warnings: [], corrupt: false };
    }
    return {
      entries: [],
      warnings: [`Journal unreadable (${String(cause)}); treating all prior work as unverified.`],
      corrupt: true,
    };
  }

  const lines = raw.split('\n');
  // A well-formed journal ends with '\n', so the final split element is ''.
  const trailer = lines.pop();
  const entries: JournalEntry[] = [];
  const warnings: string[] = [];
  let corrupt = false;

  lines.forEach((line, index) => {
    const entry = parseLine(line);
    if (entry !== undefined) {
      entries.push(entry);
      return;
    }
    corrupt = true;
    warnings.push(
      `Journal line ${index + 1} is malformed; ignoring all completion claims and verifying against the store.`,
    );
  });

  if (trailer !== undefined && trailer !== '') {
    const entry = parseLine(trailer);
    if (entry !== undefined) {
      entries.push(entry);
    } else {
      // Kill mid-append: the classic write-ahead casualty. Safe to drop.
      warnings.push('Journal ends in a truncated line (interrupted write); discarded.');
    }
  }

  return { entries, warnings, corrupt };
}

function parseLine(line: string): JournalEntry | undefined {
  if (line.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const result = JournalEntrySchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

/** Last known intent/result per action id, in journal order. */
export interface ActionJournalState {
  readonly actionId: string;
  readonly lastIntent?: JournalIntent;
  readonly lastResult?: JournalResult;
  /** An intent with no matching result: the effect may or may not have landed. */
  readonly orphanIntent: boolean;
}

/** Folds the journal into per-action state. Meaningless when the journal is corrupt. */
export function summarizeJournal(
  entries: readonly JournalEntry[],
): ReadonlyMap<string, ActionJournalState> {
  const byAction = new Map<
    string,
    { intent: JournalIntent | undefined; result: JournalResult | undefined }
  >();
  for (const entry of entries) {
    const slot = byAction.get(entry.actionId) ?? { intent: undefined, result: undefined };
    if (entry.type === 'intent') {
      slot.intent = entry;
      // A new attempt supersedes the previous result.
      if (slot.result !== undefined && slot.result.attempt < entry.attempt) {
        slot.result = undefined;
      }
    } else {
      slot.result = entry;
    }
    byAction.set(entry.actionId, slot);
  }
  const out = new Map<string, ActionJournalState>();
  for (const [actionId, slot] of byAction) {
    out.set(actionId, {
      actionId,
      ...(slot.intent === undefined ? {} : { lastIntent: slot.intent }),
      ...(slot.result === undefined ? {} : { lastResult: slot.result }),
      orphanIntent:
        slot.intent !== undefined &&
        (slot.result === undefined || slot.result.attempt < slot.intent.attempt),
    });
  }
  return out;
}
