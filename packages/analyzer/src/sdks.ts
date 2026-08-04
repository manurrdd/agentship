import type { DetectedSdk, Evidence } from '@agentship/core';
import { type Ecosystem, loadSdkCatalog, type SdkCatalogEntry } from './catalog.js';

/**
 * Matches a project's declared dependencies against the SDK catalog.
 *
 * Matching is on *declared* dependencies only — the names in `package.json`, `pubspec.yaml`,
 * the `Podfile` and the Gradle scripts. The analyzer does not scan source code for imports:
 * that would trade a precise, explainable signal for a noisy one, and would still miss
 * anything pulled in transitively.
 */

export interface DependencySource {
  readonly ecosystem: Ecosystem;
  readonly names: readonly string[];
  /** Repo-relative file the names were read from, used as evidence. */
  readonly file: string;
}

function matches(entry: SdkCatalogEntry, ecosystem: Ecosystem, name: string): boolean {
  const candidates = entry.match[ecosystem];
  const normalised = name.toLowerCase();
  return candidates.some((candidate) => {
    const target = candidate.toLowerCase();
    // A pod may be declared with a subspec (`Firebase/Analytics`) or bare (`Firebase`).
    return normalised === target || normalised.startsWith(`${target}/`);
  });
}

export function detectSdks(sources: readonly DependencySource[]): DetectedSdk[] {
  const catalog = loadSdkCatalog();
  const found = new Map<string, { entry: SdkCatalogEntry; evidence: Evidence[] }>();

  for (const source of sources) {
    for (const name of source.names) {
      for (const entry of catalog) {
        if (!matches(entry, source.ecosystem, name)) continue;
        const existing = found.get(entry.id) ?? { entry, evidence: [] };
        existing.evidence.push({
          file: source.file,
          note: `${source.ecosystem} dependency ${name}`,
        });
        found.set(entry.id, existing);
      }
    }
  }

  return [...found.values()]
    .map(({ entry, evidence }) => ({
      id: entry.id,
      name: entry.name,
      categories: entry.categories,
      evidence,
      ...(entry.implications.length === 0 ? {} : { implications: entry.implications }),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Catalog entries for the ids that were detected, for privacy derivation. */
export function catalogEntriesFor(ids: readonly string[]): SdkCatalogEntry[] {
  const wanted = new Set(ids);
  return loadSdkCatalog().filter((entry) => wanted.has(entry.id));
}
