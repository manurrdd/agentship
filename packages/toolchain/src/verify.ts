import { chmod, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AgentshipError,
  agentshipHome,
  assertInside,
  ERROR_CODES,
  toolsDir,
} from '@agentship/core';
import { fileSha256 } from './download.js';
import type { ToolchainOptions } from './install.js';
import {
  BINARY_MODE,
  binaryPath,
  LOCK_FILE,
  pointerPath,
  readInstallManifest,
  readPointer,
  STAGING_PREFIX,
  safeRemove,
  toolRoot,
  versionDir,
  writePointer,
} from './layout.js';
import { LOCK_TTL_MS } from './lock.js';
import { currentPlatform, loadLockfile, TOOL_NAMES, type ToolName } from './lockfile.js';

/**
 * Integrity audit and self-repair of the managed toolchain — what `agentship doctor` runs.
 *
 * It is written to be safe to call at any moment, including right after a `kill -9` in the
 * middle of an install. Anything transient is removed, anything inconsistent is either
 * repaired from material that still verifies or deleted so the next command reinstalls it.
 * The one thing it never does is leave an unverified binary reachable.
 */

export type ToolStatus = 'ok' | 'repaired' | 'missing' | 'corrupt';

export interface ToolVerification {
  readonly tool: ToolName;
  readonly status: ToolStatus;
  /** Active version after verification, when there is one. */
  readonly version?: string;
  /** Version pinned by the embedded lockfile. */
  readonly expectedVersion?: string;
  /** Problems found, in the order they were found. */
  readonly issues: readonly string[];
  /** Actions taken to fix them. */
  readonly repairs: readonly string[];
}

export async function verifyInstall(options: ToolchainOptions = {}): Promise<ToolVerification[]> {
  const lockfile = options.lockfile ?? loadLockfile();
  const platform = options.platform ?? currentPlatform();
  const results: ToolVerification[] = [];

  for (const tool of TOOL_NAMES) {
    const entry = lockfile.tools[tool];
    if (entry === undefined) continue;
    results.push(await verifyTool(tool, entry.version, entry.platforms[platform]?.sha256));
  }
  return results;
}

async function verifyTool(
  tool: ToolName,
  expectedVersion: string,
  expectedSha256: string | undefined,
): Promise<ToolVerification> {
  const issues: string[] = [];
  const repairs: string[] = [];
  const root = toolRoot(tool);

  const rootInfo = await stat(root).catch(() => undefined);
  if (rootInfo === undefined) {
    return { tool, status: 'missing', expectedVersion, issues: ['not installed'], repairs };
  }

  await cleanTransients(root, tool, issues, repairs);

  let pointer = await readPointer(tool);
  if (pointer === undefined) {
    // The pointer is gone or unreadable, but a verified installation may still be on disk.
    const adopted = await adoptExistingVersion(tool, expectedVersion, expectedSha256);
    if (adopted !== undefined) {
      issues.push('the active-version pointer was missing or unreadable');
      repairs.push(`re-pointed ${tool} at the verified ${adopted} installation`);
      pointer = await readPointer(tool);
    } else {
      return {
        tool,
        status: 'missing',
        expectedVersion,
        issues: [...issues, 'no verified installation found'],
        repairs,
      };
    }
  }

  const active = pointer as NonNullable<typeof pointer>;
  const problem = await inspectVersion(tool, active.version, expectedVersion, expectedSha256);
  if (problem === undefined) {
    await enforceBinaryMode(tool, active.version, repairs);
    return {
      tool,
      status: repairs.length > 0 ? 'repaired' : 'ok',
      version: active.version,
      expectedVersion,
      issues,
      repairs,
    };
  }

  issues.push(problem);
  await safeRemove(versionDir(tool, active.version)).catch(() => undefined);
  repairs.push(`removed the unusable ${tool} ${active.version} installation`);

  // Fall back to the rollback target when it still verifies.
  const previous = active.previousVersion;
  if (
    previous !== undefined &&
    (await inspectVersion(tool, previous, expectedVersion, expectedSha256, true)) === undefined
  ) {
    const manifest = await readInstallManifest(tool, previous);
    if (manifest !== undefined) {
      await writePointer({
        schemaVersion: 1,
        tool,
        version: previous,
        sha256: manifest.sha256,
        activatedAt: new Date().toISOString(),
      });
      repairs.push(`activated the kept ${tool} ${previous} installation`);
      return { tool, status: 'repaired', version: previous, expectedVersion, issues, repairs };
    }
  }

  await rm(pointerPath(tool), { force: true }).catch(() => undefined);
  repairs.push('cleared the active-version pointer; the next command reinstalls the tool');
  return { tool, status: 'missing', expectedVersion, issues, repairs };
}

/** Removes staging directories, temp files and abandoned locks left by interrupted runs. */
async function cleanTransients(
  root: string,
  tool: ToolName,
  issues: string[],
  repairs: string[],
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  for (const name of entries) {
    const path = join(root, name);
    if (name.startsWith(STAGING_PREFIX)) {
      issues.push(`leftover staging directory ${name}`);
      await safeRemove(path).catch(() => undefined);
      repairs.push(`removed staging directory ${name}`);
      continue;
    }
    if (name.endsWith('.tmp')) {
      issues.push(`leftover temporary file ${name}`);
      await safeRemove(path).catch(() => undefined);
      repairs.push(`removed temporary file ${name}`);
      continue;
    }
    if (name === LOCK_FILE) {
      const info = await stat(path).catch(() => undefined);
      if (info !== undefined && Date.now() - info.mtimeMs > LOCK_TTL_MS) {
        issues.push(`abandoned install lock for ${tool}`);
        await rm(path, { force: true }).catch(() => undefined);
        repairs.push('removed an abandoned install lock');
      }
    }
  }
}

/**
 * Returns a description of what is wrong with an installed version, or `undefined` when it
 * is intact. Always re-hashes the binary: this is the full check the fast path skips.
 */
async function inspectVersion(
  tool: ToolName,
  version: string,
  expectedVersion: string,
  expectedSha256: string | undefined,
  quiet = false,
): Promise<string | undefined> {
  const path = binaryPath(tool, version);
  const info = await stat(path).catch(() => undefined);
  if (info === undefined || !info.isFile()) {
    return `${tool} ${version} is marked as installed but its binary is missing`;
  }
  const manifest = await readInstallManifest(tool, version);
  if (manifest === undefined) {
    return `${tool} ${version} has no readable install manifest`;
  }
  if (info.size !== manifest.size) {
    return `${tool} ${version} has size ${info.size}, expected ${manifest.size}`;
  }
  const digest = await fileSha256(path).catch(() => undefined);
  if (digest !== manifest.sha256) {
    return `${tool} ${version} failed its integrity check (SHA-256 ${digest ?? 'unreadable'})`;
  }
  // An install manifest is self-written next to its binary, so "the binary matches its own
  // manifest" only proves internal consistency, not that this is the version Agentship should
  // run. The lockfile is the sole source of truth: any active version other than the pinned
  // one is drift to repair, never a healthy install — otherwise anyone who can write the
  // 0700 tools tree could plant a self-consistent binary under a made-up version and have
  // doctor bless it. `quiet` exempts the rollback target, whose version legitimately differs.
  if (!quiet && version !== expectedVersion) {
    return `${tool} ${version} is active but the lockfile pins ${expectedVersion}`;
  }
  if (!quiet && expectedSha256 !== undefined && manifest.sha256 !== expectedSha256) {
    return `${tool} ${version} does not match the digest pinned in the lockfile`;
  }
  return undefined;
}

/**
 * Adopts the pinned installation when the pointer was lost, and only that one.
 *
 * A lost pointer is a normal crash artefact, so a verified on-disk install can be re-pointed
 * at rather than re-downloaded. But adoption trusts only the lockfile: the version must be
 * exactly the pinned one and must verify against the pinned digest. Scanning the tools
 * directory and adopting any self-consistent version would let planted code under an
 * arbitrary version string become "current", since an install manifest certifies itself.
 */
async function adoptExistingVersion(
  tool: ToolName,
  expectedVersion: string,
  expectedSha256: string | undefined,
): Promise<string | undefined> {
  if (
    (await inspectVersion(tool, expectedVersion, expectedVersion, expectedSha256)) !== undefined
  ) {
    return undefined;
  }
  const manifest = await readInstallManifest(tool, expectedVersion);
  if (manifest === undefined) return undefined;
  await writePointer({
    schemaVersion: 1,
    tool,
    version: expectedVersion,
    sha256: manifest.sha256,
    activatedAt: new Date().toISOString(),
  });
  return expectedVersion;
}

async function enforceBinaryMode(
  tool: ToolName,
  version: string,
  repairs: string[],
): Promise<void> {
  const path = binaryPath(tool, version);
  const info = await stat(path).catch(() => undefined);
  if (info === undefined) return;
  if ((info.mode & 0o777) !== BINARY_MODE) {
    await chmod(path, BINARY_MODE).catch(() => undefined);
    repairs.push(`restored owner-only permissions on ${tool} ${version}`);
  }
}

/**
 * Deletes every managed binary.
 *
 * Confined to `AGENTSHIP_HOME` by {@link assertInside}, which resolves symlinks: a planted
 * link inside the tools directory cannot turn this into a delete somewhere else.
 */
export async function removeAll(): Promise<void> {
  const home = agentshipHome();
  const dir = toolsDir();
  await assertInside(home, dir);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (cause) {
    throw AgentshipError.from(
      ERROR_CODES.CONFIG_HOME_UNWRITABLE,
      `Could not remove the managed toolchain at ${dir}.`,
      cause,
    );
  }
}
