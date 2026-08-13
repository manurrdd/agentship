import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { AgentshipError, ERROR_CODES } from '../errors.js';
import type { ImageSet, ImageUpload } from '../store-ops.js';
import type { RemoteImageSet } from '../store-state.js';
import { fileSha256 } from './artifacts.js';

/**
 * Turning the manifest's screenshot lists into something a store sync can be idempotent
 * about.
 *
 * The whole design rests on hashing the files locally. A plan's action id covers the diff,
 * and the diff quotes the hashes, so changing one screenshot changes the action id and
 * therefore invalidates the approval that was given for the old set — automatically, with
 * no extra machinery. It also means "are these already published?" is answered by comparing
 * hashes rather than by re-uploading and hoping the store de-duplicates.
 *
 * The two stores make that comparison possible to different degrees, and the difference is
 * surfaced rather than hidden: Google reports a SHA-256 per published image, so the
 * comparison is exact; App Store Connect reports an MD5 computed at upload time, so the
 * remote hashes are not comparable and Agentship falls back to comparing how many images each
 * set holds. That fallback is stated in the diff, so nobody reads "no change" as proof.
 */
export interface ResolvedImageSet extends ImageSet {
  /** Repo-relative paths, in the order the manifest listed them. */
  readonly sources: readonly string[];
}

export interface ManifestScreenshotSet {
  readonly locale: string;
  readonly device: ImageSet['device'];
  readonly slot?: ImageSet['slot'];
  readonly files: readonly string[];
}

/**
 * Hashes every listed file and builds the store-facing sets.
 *
 * The *sets* come back in a canonical order (locale, then device, then slot), not in
 * manifest order, because the order sets appear in carries no meaning to either store —
 * while the order of files *within* a set is the display order and is preserved verbatim.
 *
 * That distinction is load-bearing rather than tidy. An action's id hashes its payload, and
 * an id is an approval: if reordering two locales in a YAML file rotated the ids, every
 * approval a user had given would silently go stale and the agent would ask again about
 * changes it had already asked about.
 */
export async function resolveScreenshotSets(
  repoRoot: string,
  sets: readonly ManifestScreenshotSet[],
): Promise<readonly ResolvedImageSet[]> {
  const resolved: ResolvedImageSet[] = [];
  const ordered = [...sets].sort(
    (a, b) =>
      a.locale.localeCompare(b.locale) ||
      a.device.localeCompare(b.device) ||
      (a.slot ?? 'screenshots').localeCompare(b.slot ?? 'screenshots'),
  );
  // Every missing file is collected before anything is reported. A manifest whose screenshot
  // paths moved has *all* of them wrong, and failing on the first turns one fixable mistake
  // into a dozen round trips — each one a full re-plan to discover the next identical
  // problem. One error naming every missing file is the same information, once.
  const missing: MissingScreenshot[] = [];

  for (const set of ordered) {
    const assets: ImageUpload[] = [];
    for (const [index, file] of set.files.entries()) {
      const path = isAbsolute(file) ? file : resolve(repoRoot, file);
      const info = await stat(path).catch(() => undefined);
      if (info === undefined || !info.isFile()) {
        missing.push({ file, locale: set.locale, device: set.device });
        continue;
      }
      assets.push({ path, sha256: await fileSha256(path), order: index });
    }
    if (missing.length > 0) continue;
    resolved.push({
      locale: set.locale,
      device: set.device,
      ...(set.slot === undefined ? {} : { slot: set.slot }),
      assets,
      sources: set.files,
    });
  }

  if (missing.length > 0) {
    const shown = missing.slice(0, MAX_LISTED_MISSING);
    const rest = missing.length - shown.length;
    throw new AgentshipError(
      ERROR_CODES.CONFIG_MANIFEST_INVALID,
      `The manifest lists ${missing.length} screenshot${missing.length === 1 ? '' : 's'} that ${
        missing.length === 1 ? 'does' : 'do'
      } not exist: ${shown.map((entry) => entry.file).join(', ')}${
        rest > 0 ? `, and ${rest} more` : ''
      }.`,
      {
        details: { missing },
        remediation: {
          // The manifest belongs to the user, and where their screenshots went is something
          // only they know. Asking is the remediation; editing their file is not.
          summary:
            'Ask the user where these files are now, and whether assets.screenshots should point somewhere else or drop the entries. Do not edit .agentship/agentship.yaml on their behalf.',
        },
      },
    );
  }
  return resolved;
}

/** One screenshot the manifest promises and the repository does not have. */
export interface MissingScreenshot {
  readonly file: string;
  readonly locale: string;
  readonly device: ImageSet['device'];
}

/** Enough to show the pattern in the message; the full list stays in `details.missing`. */
const MAX_LISTED_MISSING = 5;

export interface ImageSetComparison {
  readonly matches: boolean;
  /** True when the store reports no comparable hash, so only the count could be compared. */
  readonly byCountOnly: boolean;
  readonly detail: string;
}

/**
 * Whether a store already holds the desired set.
 *
 * `prune` changes the question: without it the desired images only have to be present,
 * with it the published set must be exactly the desired one, in order.
 */
export function compareImageSet(
  desired: ResolvedImageSet,
  remote: RemoteImageSet | undefined,
  prune: boolean,
): ImageSetComparison {
  const wanted = desired.assets.map((asset) => asset.sha256);
  if (remote === undefined) {
    return {
      matches: wanted.length === 0,
      byCountOnly: false,
      detail: `the store has no ${desired.locale}/${desired.device} set`,
    };
  }
  const published = remote.images.map((image) => image.sha256);
  const comparable = published.every((hash) => hash !== undefined);
  if (!comparable) {
    const matches = prune
      ? remote.images.length === wanted.length
      : remote.images.length >= wanted.length;
    return {
      matches,
      byCountOnly: true,
      detail: `the store reports no comparable hash for ${desired.locale}/${desired.device}, so only the number of images (${remote.images.length} published, ${wanted.length} wanted) could be compared`,
    };
  }
  const hashes = published as readonly string[];
  const matches = prune
    ? hashes.length === wanted.length && hashes.every((hash, index) => hash === wanted[index])
    : wanted.every((hash) => hashes.includes(hash));
  return {
    matches,
    byCountOnly: false,
    detail: matches
      ? `${desired.locale}/${desired.device} already matches`
      : `${desired.locale}/${desired.device} differs (${wanted.length} wanted, ${hashes.length} published)`,
  };
}

/** Finds the published set for a locale/device/slot combination. */
export function findRemoteSet(
  images: readonly RemoteImageSet[],
  set: ResolvedImageSet,
): RemoteImageSet | undefined {
  const slot = set.slot ?? 'screenshots';
  return images.find(
    (candidate) =>
      candidate.locale === set.locale && candidate.device === set.device && candidate.slot === slot,
  );
}
