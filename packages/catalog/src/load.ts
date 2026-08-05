import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentshipError, ERROR_CODES, type Store } from '@agentship/core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { DATA_DIR } from './data-dir.js';
import { type CatalogEntry, CatalogFileSchema } from './schema.js';

/**
 * Reading the catalog off disk, once.
 *
 * The files are shipped data, not user input, so they are read synchronously at first use
 * and cached: a differ asking "what are the console steps for creating an app?" must not
 * become an async call in the middle of planning. A malformed file is a packaging failure
 * and fails loudly rather than degrading into an empty catalog — an empty catalog would
 * silently turn "no API for this" into "nothing to do".
 */

export interface CatalogEntryWithStore extends CatalogEntry {
  readonly store: Store;
  /** File the entry came from, for diagnostics and for the editorial review table. */
  readonly sourceFile: string;
}

let cache: readonly CatalogEntryWithStore[] | undefined;

function readStore(store: Store): CatalogEntryWithStore[] {
  const dir = join(DATA_DIR, store);
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.yaml'));
  } catch (cause) {
    throw AgentshipError.from(
      ERROR_CODES.CONFIG_NOT_FOUND,
      `The ${store} console catalog is missing at ${dir}.`,
      cause,
    );
  }
  const entries: CatalogEntryWithStore[] = [];
  for (const file of files.sort()) {
    const path = join(dir, file);
    const parsed = CatalogFileSchema.safeParse(parseYaml(readFileSync(path, 'utf8')));
    if (!parsed.success) {
      throw new AgentshipError(
        ERROR_CODES.CONFIG_INVALID,
        `The catalog file ${file} failed validation.`,
        { details: { path, issues: z.treeifyError(parsed.error) } },
      );
    }
    if (parsed.data.store !== store) {
      throw new AgentshipError(
        ERROR_CODES.CONFIG_INVALID,
        `${file} declares store "${parsed.data.store}" but lives under ${store}/.`,
        { details: { path } },
      );
    }
    for (const entry of parsed.data.entries) {
      entries.push({ ...entry, store, sourceFile: `${store}/${file}` });
    }
  }
  return entries;
}

/** Every catalog entry, both stores, sorted by id. */
export function loadCatalog(): readonly CatalogEntryWithStore[] {
  if (cache !== undefined) return cache;
  const all = [...readStore('apple'), ...readStore('google')].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const seen = new Set<string>();
  for (const entry of all) {
    if (seen.has(entry.id)) {
      throw new AgentshipError(
        ERROR_CODES.CONFIG_INVALID,
        `Duplicate catalog entry id "${entry.id}".`,
      );
    }
    seen.add(entry.id);
  }
  // blockedBy is a graph over the catalog itself; a dangling reference is a packaging bug
  // and would silently drop an ordering an operator relies on.
  for (const entry of all) {
    for (const blocker of entry.blockedBy) {
      if (!seen.has(blocker)) {
        throw new AgentshipError(
          ERROR_CODES.CONFIG_INVALID,
          `Catalog entry "${entry.id}" is blockedBy unknown entry "${blocker}".`,
          { details: { id: entry.id, blocker } },
        );
      }
    }
  }
  cache = all;
  return all;
}

export function catalogEntries(store?: Store): readonly CatalogEntryWithStore[] {
  const all = loadCatalog();
  return store === undefined ? all : all.filter((entry) => entry.store === store);
}

/** One entry by id, or `undefined` when the catalog has none. */
export function findCatalogEntry(id: string): CatalogEntryWithStore | undefined {
  return loadCatalog().find((entry) => entry.id === id);
}

/** One entry by id; throws when it is missing, because a caller asking by id has a bug. */
export function catalogEntry(id: string): CatalogEntryWithStore {
  const entry = findCatalogEntry(id);
  if (entry === undefined) {
    throw new AgentshipError(
      ERROR_CODES.CONFIG_NOT_FOUND,
      `No console catalog entry with id "${id}".`,
      { details: { id, known: loadCatalog().map((candidate) => candidate.id) } },
    );
  }
  return entry;
}
