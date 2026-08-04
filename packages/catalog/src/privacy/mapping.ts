import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentshipError, ERROR_CODES, type PrivacyDataType, type Store } from '@agentship/core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { DATA_DIR } from '../data-dir.js';

/**
 * The two store taxonomies, versioned as data.
 *
 * Both stores ask about the same world in different words, and both change their vocabulary
 * from time to time. Keeping the tables here means re-checking Apple's App Privacy page or
 * Google's Data safety documentation is a reviewed data change with a date on it, and means
 * the projection functions stay pure and testable.
 *
 * The interesting field is `unmapped`. Play has no "other purposes" answer; Apple has no
 * separate fraud-prevention purpose. Where a neutral value has no faithful equivalent the
 * table says so and the projection raises a question, because the alternative — quietly
 * choosing the nearest label — produces a legal declaration nobody agreed to.
 */
const UnmappedSchema = z.object({ unmapped: z.literal(true), reason: z.string().min(1) }).strict();

const DataTypeSchema = z
  .object({
    category: z.string().min(1),
    types: z.array(z.string().min(1)).min(1),
    /** Why the projection is a proposal rather than a fact, when it is. */
    note: z.string().optional(),
  })
  .strict();

const MappingFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    store: z.enum(['apple', 'google']),
    lastVerified: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    source: z.string().url(),
    purposes: z.record(z.string(), z.union([z.string().min(1), UnmappedSchema])),
    dataTypes: z.record(z.string(), DataTypeSchema),
  })
  .strict();

export type PrivacyMapping = z.infer<typeof MappingFileSchema>;

const PRIVACY_DIR = join(DATA_DIR, 'privacy');

const cache = new Map<Store, PrivacyMapping>();

export function privacyMapping(store: Store): PrivacyMapping {
  const cached = cache.get(store);
  if (cached !== undefined) return cached;
  const path = join(PRIVACY_DIR, `mapping-${store}.yaml`);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw AgentshipError.from(
      ERROR_CODES.CONFIG_NOT_FOUND,
      `The ${store} privacy mapping is missing at ${path}.`,
      cause,
    );
  }
  const parsed = MappingFileSchema.safeParse(parseYaml(raw));
  if (!parsed.success) {
    throw new AgentshipError(
      ERROR_CODES.CONFIG_INVALID,
      `The ${store} privacy mapping failed validation.`,
      { details: { path, issues: z.treeifyError(parsed.error) } },
    );
  }
  cache.set(store, parsed.data);
  return parsed.data;
}

export interface MappedDataType {
  readonly category: string;
  readonly types: readonly string[];
  readonly note?: string | undefined;
}

/** The store's category and types for a neutral data type, or `undefined` when it has none. */
export function mapDataType(store: Store, dataType: PrivacyDataType): MappedDataType | undefined {
  return privacyMapping(store).dataTypes[dataType];
}

export interface MappedPurpose {
  readonly label?: string;
  readonly unmappedReason?: string;
}

/** The store's label for a neutral purpose, or the reason it has none. */
export function mapPurpose(store: Store, purpose: string): MappedPurpose {
  const entry = privacyMapping(store).purposes[purpose];
  if (entry === undefined) {
    return { unmappedReason: `The ${store} mapping has no entry for the purpose "${purpose}".` };
  }
  return typeof entry === 'string' ? { label: entry } : { unmappedReason: entry.reason };
}
