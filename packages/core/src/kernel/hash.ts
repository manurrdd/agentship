import { createHash } from 'node:crypto';

/**
 * Stable content hashing, the primitive under both idempotence and approvals.
 *
 * An action id is the hash of what the action will do; an approval references that id.
 * Two properties follow directly from hashing canonical JSON:
 *
 * - Reordering object keys (a manifest rewritten by hand, a differ built differently)
 *   never changes an id, so approvals survive cosmetic churn.
 * - Any change to the *content* — a price, a locale text, a build number — produces a new
 *   id, which silently invalidates every approval that referenced the old one.
 */

/** JSON with every object's keys sorted recursively. Array order is preserved: it is data. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      // Dropping undefined members mirrors JSON.stringify, which would omit them anyway
      // but *would* serialise them inside arrays as null.
      if (item !== undefined) out[key] = sortValue(item);
    }
    return out;
  }
  return value;
}

/** SHA-256 of the canonical JSON form of `value`, hex-encoded lowercase. */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** Shortened hash used inside human-visible identifiers. 16 hex chars = 64 bits. */
export function shortHash(value: unknown): string {
  return contentHash(value).slice(0, 16);
}
