import type { AgentshipManifest, AppAnalysis } from '@agentship/core';
import { isNeedsInput } from '@agentship/core';
import { ALLOWED_ROOTS, type CatalogContext, type ContextValue } from './interpolate.js';

/**
 * The data a catalog template is allowed to see.
 *
 * Built by flattening whole objects into dotted paths under a root, which keeps the
 * catalog's `{{manifest.app.name}}` readable and keeps this module free of a hand-written
 * list that would drift from the manifest schema. Two things are dropped on the way in, and
 * both matter:
 *
 * - **`NEEDS_INPUT` sentinels become absent.** A manifest value the user has not supplied is
 *   not a value; treating it as one would put the literal `<needs_input>` into a console
 *   form. Absent means the template reports the gap instead.
 * - **Nothing but scalars.** Arrays and objects are not rendered; a console field takes a
 *   string. Where a list matters (privacy data types, territories) the producer joins it
 *   into a scalar first, deliberately, rather than leaving `[object Object]` to chance.
 */
export interface CatalogContextInput {
  readonly manifest?: AgentshipManifest;
  readonly analysis?: AppAnalysis;
  /** Privacy projection summaries: see `privacy/projection.ts`. */
  readonly privacy?: Readonly<Record<string, unknown>>;
  /** The monetisation product an entry is about, when it is about one. */
  readonly product?: Readonly<Record<string, unknown>>;
  /** Release facts an entry needs without reaching into the whole manifest. */
  readonly release?: Readonly<Record<string, unknown>>;
}

function flatten(value: unknown, path: string, out: Record<string, ContextValue>): void {
  if (value === undefined || value === null) return;
  if (isNeedsInput(value)) return;
  if (typeof value === 'string') {
    if (value !== '') out[path] = value;
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out[path] = value;
    return;
  }
  if (Array.isArray(value) || value instanceof Map || value instanceof Set) return;
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      flatten(item, path === '' ? key : `${path}.${key}`, out);
    }
  }
}

/**
 * The analysis facts a console form can legitimately ask for.
 *
 * Curated rather than flattened whole: an analysis carries evidence, file paths and scan
 * statistics, none of which belongs in a store console, and exposing all of it would make
 * every future analyzer field silently reachable from a catalog template.
 */
function analysisFacts(analysis: AppAnalysis): Record<string, unknown> {
  return {
    framework: analysis.framework.framework,
    platforms: analysis.platforms.join(', '),
    bundleId: analysis.identity.bundleId?.value,
    packageName: analysis.identity.packageName?.value,
    displayName: analysis.identity.displayName?.value ?? analysis.identity.appName?.value,
    marketingVersion: analysis.versions.marketingVersion?.value,
    buildNumber: analysis.versions.buildNumber?.value,
    versionName: analysis.versions.versionName?.value,
    versionCode: analysis.versions.versionCode?.value,
    sdks: analysis.sdks.map((sdk) => sdk.name).join(', '),
    hasAds: analysis.sdks.some((sdk) => sdk.categories.includes('ads')),
    hasPurchases: analysis.sdks.some((sdk) => sdk.categories.includes('purchases')),
    hasTracking: analysis.sdks.some((sdk) => sdk.categories.includes('tracking')),
  };
}

/**
 * How each track is named on the page an operator has to open.
 *
 * Both consoles group testing by audience and label the pages in these words, so an entry
 * that has to say "open the X page" can say it from the manifest instead of hard-coding one
 * track. The manifest value (`closed_testing`) is what Agentship reasons with; this is what
 * the console shows, and sending an operator to a page that does not exist under that name
 * is how a first release lands on the wrong track.
 */
const TRACK_LABELS: Readonly<Record<string, string>> = {
  internal_testing: 'Internal testing',
  closed_testing: 'Closed testing',
  open_testing: 'Open testing',
  production: 'Production',
};

export function catalogContext(input: CatalogContextInput = {}): CatalogContext {
  const out: Record<string, ContextValue> = {};
  if (input.manifest !== undefined) flatten(input.manifest, 'manifest', out);
  if (input.analysis !== undefined) flatten(analysisFacts(input.analysis), 'analysis', out);
  if (input.privacy !== undefined) flatten(input.privacy, 'privacy', out);
  if (input.product !== undefined) flatten(input.product, 'product', out);
  if (input.release !== undefined) {
    const track = input.release['track'];
    const label = typeof track === 'string' ? TRACK_LABELS[track] : undefined;
    flatten(
      { ...input.release, ...(label === undefined ? {} : { trackLabel: label }) },
      'release',
      out,
    );
  }
  return out;
}

/** Every root a context may carry; exported so tests can prove the two lists agree. */
export const CONTEXT_ROOTS = ALLOWED_ROOTS;
