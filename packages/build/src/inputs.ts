import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileSha256 } from '@agentship/core';

/**
 * A fingerprint of everything a build reads, so a recorded artifact is only reused when the
 * project that produced it has not moved.
 *
 * The artifact register answers "are these still the same bytes?" by hashing the artifact.
 * That is the wrong question on its own, and the gap is not theoretical: change an app icon,
 * leave the build number alone, and the previously built `.ipa` still hashes exactly as
 * recorded — so the build action disappears from the plan and the *old* binary is uploaded
 * as the new release. Silently shipping the wrong build is the worst failure this tool can
 * have, and it needs no unusual sequence to happen; it is what "I changed the icon since the
 * last version" produces.
 *
 * So an artifact also records what it was built *from*. Reuse now requires both: the same
 * output bytes and the same input tree.
 *
 * Content is hashed rather than modification times. Times would be cheaper, but a checkout,
 * a branch switch or a `git stash` rewrites them all and would force a rebuild that changes
 * nothing — and an unnecessary twenty-minute build is its own kind of broken. Reading the
 * source of an app repository costs milliseconds by comparison, once the directories below
 * are excluded.
 */

/**
 * Directories that never contribute to a build's inputs: version control, dependency caches,
 * and — importantly — build outputs, which would otherwise make every digest depend on the
 * result of the previous build.
 */
const EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  '.agentship',
  '.dart_tool',
  '.gradle',
  '.idea',
  '.svn',
  'DerivedData',
  'Pods',
  'build',
  'dist',
  'node_modules',
]);

/**
 * Ceilings. An app repository with its outputs excluded is a few thousand files; a tree past
 * these is not a shape this reader can honestly fingerprint, and it says so rather than
 * hashing a subset and calling it complete — a partial digest would miss exactly the change
 * it exists to catch.
 */
const MAX_FILES = 20_000;
const MAX_BYTES = 2_000_000_000;

export interface InputsFingerprint {
  /** Hex SHA-256 over every input path and its content hash, in a stable order. */
  readonly digest: string;
  readonly files: number;
  readonly bytes: number;
}

/**
 * Fingerprints the source tree a build would read.
 *
 * Returns `undefined` when the tree is unreadable or past the ceilings above. A caller that
 * cannot get a fingerprint must treat the artifact as unusable and rebuild: "I could not
 * check" and "nothing changed" are different answers, and only one of them is safe.
 */
export async function fingerprintBuildInputs(
  appDir: string,
): Promise<InputsFingerprint | undefined> {
  const entries: { path: string; hash: string }[] = [];
  let bytes = 0;

  const walk = async (dir: string): Promise<boolean> => {
    let contents: Dirent[];
    try {
      contents = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    // Sorted so the digest does not depend on the order the filesystem happens to return.
    for (const entry of [...contents].sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        if (!(await walk(full))) return false;
        continue;
      }
      // A symlink is followed only far enough to see it is a regular file; a link pointing
      // outside the tree still contributes its content, which is what the build would read.
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const info = await stat(full).catch(() => undefined);
      if (info === undefined || !info.isFile()) continue;

      bytes += info.size;
      if (entries.length >= MAX_FILES || bytes > MAX_BYTES) return false;
      try {
        entries.push({
          path: relative(appDir, full).split(sep).join('/'),
          hash: await fileSha256(full),
        });
      } catch {
        return false;
      }
    }
    return true;
  };

  if (!(await walk(appDir))) return undefined;
  if (entries.length === 0) return undefined;

  const hash = createHash('sha256');
  for (const entry of entries) hash.update(`${entry.path}\0${entry.hash}\n`);
  return { digest: hash.digest('hex'), files: entries.length, bytes };
}
