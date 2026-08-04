import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AgentshipError,
  agentshipHome,
  assertInside,
  ERROR_CODES,
  FILE_MODE,
  toolsDir,
} from '@agentship/core';
import { z } from 'zod';
import type { ToolName } from './lockfile.js';

/**
 * On-disk layout of the managed toolchain:
 *
 * ```
 * ~/.agentship/tools/
 *   asc/
 *     current.json          <- pointer: which version is active, and which was before
 *     3.4.1/
 *       asc                 <- the binary, mode 0500
 *       install.json        <- what was verified at install time
 *     3.4.0/                <- kept for rollback
 *     .staging-<pid>-<rand>/  <- transient; removed by verifyInstall()
 *     .lock                 <- cross-process install lock
 * ```
 *
 * Directories are switched by `rename`, and the pointer is a small JSON file rather than a
 * symlink: renames are atomic on every supported filesystem, and a plain file avoids the
 * symlink-following hazards a compromised tree could otherwise exploit.
 */

/** Prefix of transient staging directories. */
export const STAGING_PREFIX = '.staging-';
export const POINTER_FILE = 'current.json';
export const INSTALL_MANIFEST_FILE = 'install.json';
export const LOCK_FILE = '.lock';

/** Binaries are installed read-only and executable by the owner only. */
export const BINARY_MODE = 0o500;

export function toolRoot(tool: ToolName): string {
  return join(toolsDir(), tool);
}

export function versionDir(tool: ToolName, version: string): string {
  return join(toolRoot(tool), version);
}

export function binaryPath(tool: ToolName, version: string): string {
  return join(versionDir(tool, version), tool);
}

export function pointerPath(tool: ToolName): string {
  return join(toolRoot(tool), POINTER_FILE);
}

export function installManifestPath(tool: ToolName, version: string): string {
  return join(versionDir(tool, version), INSTALL_MANIFEST_FILE);
}

export function lockPath(tool: ToolName): string {
  return join(toolRoot(tool), LOCK_FILE);
}

const PointerSchema = z.object({
  schemaVersion: z.literal(1),
  tool: z.string().min(1),
  version: z.string().min(1),
  /** Digest of the active binary, repeated here so the pointer alone is verifiable. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  activatedAt: z.iso.datetime(),
  /** Version to roll back to. Absent on a first install. */
  previousVersion: z.string().min(1).optional(),
});

const InstallManifestSchema = z.object({
  schemaVersion: z.literal(1),
  tool: z.string().min(1),
  version: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().positive(),
  url: z.string().min(1),
  installedAt: z.iso.datetime(),
});

export type Pointer = z.infer<typeof PointerSchema>;
export type InstallManifest = z.infer<typeof InstallManifestSchema>;

async function readJsonFile<T>(
  path: string,
  schema: z.ZodType<T>,
  what: string,
): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw AgentshipError.from(ERROR_CODES.TOOL_INSTALL_CORRUPT, `Could not read ${what}.`, cause);
  }
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    // Malformed JSON is treated exactly like a missing file: the caller repairs it.
    return undefined;
  }
}

/** Reads the active-version pointer. Returns `undefined` when absent or unreadable. */
export function readPointer(tool: ToolName): Promise<Pointer | undefined> {
  return readJsonFile(pointerPath(tool), PointerSchema, `the ${tool} pointer`);
}

/** Reads the install manifest of a specific version. */
export function readInstallManifest(
  tool: ToolName,
  version: string,
): Promise<InstallManifest | undefined> {
  return readJsonFile(
    installManifestPath(tool, version),
    InstallManifestSchema,
    `the ${tool} ${version} install manifest`,
  );
}

/** Writes a JSON file atomically (temp file in the same directory, then `rename`). */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE });
  await rename(tmp, path);
}

export async function writePointer(pointer: Pointer): Promise<void> {
  await writeJsonAtomic(pointerPath(pointer.tool as ToolName), PointerSchema.parse(pointer));
}

/**
 * Recursive delete confined to `AGENTSHIP_HOME`.
 *
 * Every destructive path in the toolchain goes through here: a crafted tool name, a
 * leftover symlink or a `..` segment must never let Agentship delete outside its own tree.
 */
export async function safeRemove(path: string): Promise<void> {
  await assertInside(agentshipHome(), path);
  await rm(path, { recursive: true, force: true });
}
