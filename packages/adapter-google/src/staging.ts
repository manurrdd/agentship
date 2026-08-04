import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  ensureDir,
  FILE_MODE,
  type ImageSet,
  type LocalizedMetadata,
  tmpDir,
} from '@agentship/core';
import { GOOGLE_SCREENSHOT_TYPES, GOOGLE_SLOT_TYPES, LISTING_FILES } from './commands.js';

/**
 * Turning declarative payloads into the directory trees `gpc` reads.
 *
 * Two `gpc` commands take a directory rather than flags — `listings push` and
 * `listings images sync` — and both are the *atomic* form of their operation: everything
 * inside the directory lands in a single Play edit. Building those trees is therefore not a
 * workaround; it is how Agentship gets all-or-nothing semantics for a multi-locale change.
 *
 * Trees are built under `AGENTSHIP_HOME` (0700) and removed in a `finally`. Images are
 * symlinked rather than copied: a screenshot set runs to tens of megabytes.
 */

export interface StagedListing {
  readonly language: string;
  readonly title: string;
  readonly shortDescription: string;
  readonly fullDescription: string;
  readonly video?: string;
}

/**
 * Writes a Fastlane-format listing tree and hands its path to `fn`.
 *
 * Every language directory gets all three required files, always. `gpc` reads a missing
 * file as an empty string and pushes it, so writing only the fields a plan mentions would
 * silently blank the app's description — the caller is responsible for filling the rest
 * from the current listing, and this signature makes that obligation explicit by demanding
 * complete values.
 */
export async function withListingTree<T>(
  listings: readonly StagedListing[],
  fn: (directory: string) => Promise<T>,
): Promise<T> {
  const root = await ensureDir(join(tmpDir(), 'listings'));
  const directory = await mkdtemp(join(root, 'l-'));
  try {
    for (const listing of listings) {
      const languageDir = await ensureDir(join(directory, listing.language));
      await writeFile(join(languageDir, LISTING_FILES.title), `${listing.title}\n`, {
        mode: FILE_MODE,
      });
      await writeFile(
        join(languageDir, LISTING_FILES.shortDescription),
        `${listing.shortDescription}\n`,
        { mode: FILE_MODE },
      );
      await writeFile(
        join(languageDir, LISTING_FILES.fullDescription),
        `${listing.fullDescription}\n`,
        { mode: FILE_MODE },
      );
      if (listing.video !== undefined) {
        await writeFile(join(languageDir, LISTING_FILES.video), `${listing.video}\n`, {
          mode: FILE_MODE,
        });
      }
    }
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** What the store holds today for one locale, as `gpc listings get` reports it. */
export interface CurrentListing {
  readonly title?: string | undefined;
  readonly shortDescription?: string | undefined;
  readonly fullDescription?: string | undefined;
  readonly video?: string | undefined;
}

/** Merges a plan's fields over the listing the store holds today. */
export function mergeListing(change: LocalizedMetadata, current: CurrentListing): StagedListing {
  const video = change.videoUrl ?? current.video;
  return {
    language: change.locale,
    title: change.name ?? current.title ?? '',
    shortDescription: change.shortDescription ?? current.shortDescription ?? '',
    fullDescription: change.description ?? current.fullDescription ?? '',
    ...(video === undefined ? {} : { video }),
  };
}

export interface StagedImages {
  readonly directory: string;
  /** Sets the caller could not express on Google, with the reason. */
  readonly skipped: readonly string[];
}

/**
 * Builds the `<language>/<imageType>/` tree `gpc listings images sync` expects.
 *
 * Ordering matters to Play when `--delete` is used, and `gpc` sorts by file name, so each
 * link is prefixed with its index.
 */
export async function withImageTree<T>(
  sets: readonly ImageSet[],
  fn: (staged: StagedImages) => Promise<T>,
): Promise<T> {
  const root = await ensureDir(join(tmpDir(), 'images'));
  const directory = await mkdtemp(join(root, 'i-'));
  const skipped: string[] = [];
  try {
    for (const set of sets) {
      const slot = set.slot ?? 'screenshots';
      const imageType =
        slot === 'screenshots' ? GOOGLE_SCREENSHOT_TYPES[set.device] : GOOGLE_SLOT_TYPES[slot];
      if (imageType === undefined) {
        skipped.push(
          slot === 'screenshots'
            ? `${set.locale}: Google Play has no screenshot type for ${set.device}; set skipped.`
            : `${set.locale}: Google Play has no image type for ${slot}; set skipped.`,
        );
        continue;
      }
      const typeDir = await ensureDir(join(directory, set.locale, imageType));
      const ordered = [...set.assets].sort(
        (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.path.localeCompare(b.path),
      );
      for (const [index, asset] of ordered.entries()) {
        await symlink(
          asset.path,
          join(typeDir, `${String(index).padStart(3, '0')}-${basename(asset.path)}`),
        );
      }
    }
    return await fn({ directory, skipped });
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
