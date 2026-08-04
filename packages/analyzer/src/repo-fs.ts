import type { Dirent } from 'node:fs';
import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AgentshipError, assertInside, ERROR_CODES, isInside } from '@agentship/core';

/**
 * Bounded, read-only view of a repository under analysis.
 *
 * The repository is untrusted input: it is written by whoever the user is publishing for,
 * and Agentship must survive a repository designed to hurt it. Three rules make that true and
 * are enforced here rather than remembered at each call site:
 *
 * 1. **Nothing is executed.** This layer only reads bytes; no build tool, no script, no
 *    config file evaluated as code. `app.config.js` is read as text, never imported.
 * 2. **Nothing outside the root is read.** Symlinks are never followed — not even ones that
 *    stay inside the repository — which also makes symlink loops impossible.
 * 3. **Everything is bounded.** File size, file count, directory depth and total bytes all
 *    have ceilings; hitting one marks the analysis `truncated` instead of hanging.
 */

export interface ScanLimits {
  readonly maxFiles: number;
  readonly maxDepth: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_LIMITS: ScanLimits = {
  maxFiles: 20_000,
  maxDepth: 12,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};

/**
 * Directories that never hold source of interest but can hold hundreds of thousands of
 * files. Skipping them is what keeps analysis fast on a real project.
 */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.dart_tool',
  '.gradle',
  '.idea',
  '.vscode',
  'Pods',
  'Carthage',
  'DerivedData',
  'build',
  '.build',
  'dist',
  'out',
  '.next',
  '.expo',
  '.venv',
  'venv',
  '__pycache__',
  'vendor',
  'coverage',
  '.turbo',
  '.yarn',
]);

export interface SkippedEntry {
  readonly path: string;
  readonly reason: 'symlink' | 'too-large' | 'unreadable';
}

export class RepoFs {
  readonly root: string;
  readonly limits: ScanLimits;

  #files: string[] | undefined;
  #truncated = false;
  #directories = 0;
  #bytesRead = 0;
  readonly #cache = new Map<string, string | undefined>();
  readonly #skipped: SkippedEntry[] = [];

  private constructor(root: string, limits: ScanLimits) {
    this.root = root;
    this.limits = limits;
  }

  /** Resolves and validates the repository root. */
  static async open(root: string, limits: ScanLimits = DEFAULT_LIMITS): Promise<RepoFs> {
    const absolute = resolve(root);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(absolute);
    } catch (cause) {
      throw AgentshipError.from(
        ERROR_CODES.ANALYZE_PATH_NOT_FOUND,
        `There is nothing to analyze at ${absolute}.`,
        cause,
      );
    }
    if (info.isSymbolicLink()) {
      // Resolve the root itself once, so a symlinked checkout still works while every
      // path below it is compared against the resolved root.
      return new RepoFs(await realpath(absolute), limits);
    }
    if (!info.isDirectory()) {
      throw new AgentshipError(
        ERROR_CODES.ANALYZE_NOT_A_DIRECTORY,
        `${absolute} is not a directory.`,
        { details: { path: absolute } },
      );
    }
    return new RepoFs(absolute, limits);
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  get directoriesScanned(): number {
    return this.#directories;
  }

  get filesScanned(): number {
    return this.#files?.length ?? 0;
  }

  get skipped(): readonly SkippedEntry[] {
    return this.#skipped;
  }

  /** Absolute path of a repo-relative path, refusing anything that escapes the root lexically. */
  #absolute(relPath: string): string {
    if (isAbsolute(relPath)) {
      throw new AgentshipError(
        ERROR_CODES.ANALYZE_UNREADABLE,
        `Repository paths must be relative, got "${relPath}".`,
      );
    }
    const absolute = resolve(this.root, relPath);
    if (!isInside(this.root, absolute)) {
      throw new AgentshipError(
        ERROR_CODES.ANALYZE_UNREADABLE,
        `Refusing to read ${relPath}: it resolves outside the repository.`,
        { details: { path: relPath } },
      );
    }
    return absolute;
  }

  /**
   * Absolute path of a repo-relative path, or `undefined` when it — or a symlinked directory
   * on the way to it — resolves outside the repository.
   *
   * A lexical check (`#absolute`) is not enough on its own: a hostile repository can plant a
   * directory symlink (`ios -> /etc`) so that a fixed path an extractor reads
   * (`ios/Runner/Info.plist`) stays lexically inside the root yet reads a file outside it,
   * because the OS follows the symlink on the intermediate component. `assertInside` resolves
   * symlinks on both sides before comparing, which closes that gap. Directory traversal in
   * {@link files} never needs this — it skips symlinks as it walks — so the cost lands only on
   * the handful of fixed-path reads.
   */
  async #resolveInside(relPath: string): Promise<string | undefined> {
    let absolute: string;
    try {
      absolute = this.#absolute(relPath);
    } catch {
      return undefined;
    }
    try {
      await assertInside(this.root, absolute);
    } catch {
      this.#skipped.push({ path: relPath, reason: 'symlink' });
      return undefined;
    }
    return absolute;
  }

  /**
   * Reads a text file, or returns `undefined` when it is absent, a symlink, too large or
   * unreadable. Absence is a normal outcome for an analyzer and never an exception.
   */
  async readText(relPath: string): Promise<string | undefined> {
    if (this.#cache.has(relPath)) return this.#cache.get(relPath);
    const result = await this.#readTextUncached(relPath);
    this.#cache.set(relPath, result);
    return result;
  }

  async #readTextUncached(relPath: string): Promise<string | undefined> {
    const absolute = await this.#resolveInside(relPath);
    if (absolute === undefined) return undefined;
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        this.#skipped.push({ path: relPath, reason: 'symlink' });
        return undefined;
      }
      if (!info.isFile()) return undefined;
      if (info.size > this.limits.maxFileBytes) {
        this.#skipped.push({ path: relPath, reason: 'too-large' });
        this.#truncated = true;
        return undefined;
      }
      if (this.#bytesRead + info.size > this.limits.maxTotalBytes) {
        this.#truncated = true;
        return undefined;
      }
      const content = await readFile(absolute, 'utf8');
      this.#bytesRead += info.size;
      return content;
    } catch {
      this.#skipped.push({ path: relPath, reason: 'unreadable' });
      return undefined;
    }
  }

  /** Reads the first bytes of a file, for format headers. Never follows symlinks. */
  async readHeader(relPath: string, maxBytes: number): Promise<Buffer | undefined> {
    const absolute = await this.#resolveInside(relPath);
    if (absolute === undefined) return undefined;
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || !info.isFile()) return undefined;
      const handle = await open(absolute, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(maxBytes, info.size));
        await handle.read(buffer, 0, buffer.byteLength, 0);
        // Counted like any other read: headers are small individually, but a repository
        // full of them must still run into the same total ceiling as one full of text.
        this.#bytesRead += buffer.byteLength;
        return buffer;
      } finally {
        await handle.close();
      }
    } catch {
      return undefined;
    }
  }

  /** Reads and JSON-parses a file. Malformed JSON yields `undefined`, never a throw. */
  async readJson<T = unknown>(relPath: string): Promise<T | undefined> {
    const text = await this.readText(relPath);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined;
    }
  }

  async exists(relPath: string): Promise<boolean> {
    const absolute = await this.#resolveInside(relPath);
    if (absolute === undefined) return false;
    try {
      const info = await lstat(absolute);
      return !info.isSymbolicLink();
    } catch {
      return false;
    }
  }

  async isDirectory(relPath: string): Promise<boolean> {
    const absolute = await this.#resolveInside(relPath);
    if (absolute === undefined) return false;
    try {
      const info = await lstat(absolute);
      return info.isDirectory();
    } catch {
      return false;
    }
  }

  async fileSize(relPath: string): Promise<number | undefined> {
    const absolute = await this.#resolveInside(relPath);
    if (absolute === undefined) return undefined;
    try {
      const info = await lstat(absolute);
      return info.isFile() ? info.size : undefined;
    } catch {
      return undefined;
    }
  }

  /** Immediate children of a directory, excluding symlinks. */
  async list(relDir: string): Promise<string[]> {
    const absolute = await this.#resolveInside(relDir);
    if (absolute === undefined) return [];
    try {
      const entries = await readdir(absolute, { withFileTypes: true });
      return entries.filter((e) => !e.isSymbolicLink()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  /** Every regular file in the repository, repo-relative, computed once and cached. */
  async files(): Promise<readonly string[]> {
    if (this.#files !== undefined) return this.#files;
    const found: string[] = [];
    const queue: { dir: string; depth: number }[] = [{ dir: '', depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      if (current.depth > this.limits.maxDepth) {
        this.#truncated = true;
        continue;
      }
      this.#directories += 1;

      let entries: Dirent<string>[];
      try {
        entries = await readdir(this.#absolute(current.dir), { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const relPath = current.dir === '' ? entry.name : `${current.dir}${sep}${entry.name}`;
        if (entry.isSymbolicLink()) {
          // Never followed, in either direction: a symlink cannot widen the scan.
          this.#skipped.push({ path: relPath, reason: 'symlink' });
          continue;
        }
        if (entry.isDirectory()) {
          if (IGNORED_DIRECTORIES.has(entry.name)) continue;
          queue.push({ dir: relPath, depth: current.depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;
        if (found.length >= this.limits.maxFiles) {
          this.#truncated = true;
          this.#files = found;
          return found;
        }
        found.push(relPath);
      }
    }

    this.#files = found;
    return found;
  }

  /** Files whose repo-relative path matches `pattern`, in traversal order. */
  async find(pattern: RegExp): Promise<string[]> {
    return (await this.files()).filter((file) => pattern.test(file));
  }

  /** First existing path among the candidates, in order of preference. */
  async firstExisting(candidates: readonly string[]): Promise<string | undefined> {
    for (const candidate of candidates) {
      if (await this.exists(candidate)) return candidate;
    }
    return undefined;
  }

  /** Repo-relative form of an absolute path inside the repository. */
  relative(absolute: string): string {
    return relative(this.root, absolute);
  }

  join(...parts: string[]): string {
    return join(...parts);
  }
}
