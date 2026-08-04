import { chmod, mkdtemp, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AgentshipError,
  ERROR_CODES,
  ensureDir,
  FILE_MODE,
  getLogger,
  type Logger,
  runTool,
} from '@agentship/core';
import { downloadVerified, fileSha256 } from './download.js';
import {
  BINARY_MODE,
  binaryPath,
  INSTALL_MANIFEST_FILE,
  type Pointer,
  readInstallManifest,
  readPointer,
  STAGING_PREFIX,
  safeRemove,
  toolRoot,
  versionDir,
  writePointer,
} from './layout.js';
import { withToolLock } from './lock.js';
import {
  currentPlatform,
  type Lockfile,
  loadLockfile,
  lockEntryFor,
  type PlatformKey,
  TOOL_NAMES,
  type ToolName,
} from './lockfile.js';

export interface ToolchainOptions {
  /** Overrides the embedded lockfile. Used by tests; never in production code paths. */
  readonly lockfile?: Lockfile;
  readonly logger?: Logger;
  readonly cancelSignal?: AbortSignal;
  readonly lockTimeoutMs?: number;
  readonly downloadTimeoutMs?: number;
  /** Download attempts before giving up. Defaults to 3. */
  readonly downloadAttempts?: number;
  readonly platform?: PlatformKey;
  /** Runs `<tool> --version` after installing. On by default. */
  readonly healthCheck?: boolean;
}

const HEALTH_CHECK_TIMEOUT_MS = 30_000;

function resolveLockfile(options: ToolchainOptions): Lockfile {
  return options.lockfile ?? loadLockfile();
}

/**
 * Returns the absolute path of an installed, verified tool, installing it if needed.
 *
 * The returned path always points at a binary whose SHA-256 matched the embedded lockfile
 * at install time, and which answered `--version`. It is never resolved from `PATH`: a
 * tool the user happens to have installed is not a tool Agentship has verified.
 */
export async function ensureTool(tool: string, options: ToolchainOptions = {}): Promise<string> {
  const lockfile = resolveLockfile(options);
  const platform = options.platform ?? currentPlatform();
  const { tool: name, entry, platformEntry } = lockEntryFor(lockfile, tool, platform);
  const logger = (options.logger ?? getLogger()).child({ tool: name });

  const fast = await activePathIfCurrent(name, entry.version, platformEntry.size);
  if (fast !== undefined) return fast;

  return withToolLock(
    name,
    async () => {
      // Another process may have completed the install while we waited for the lock.
      const afterLock = await activePathIfCurrent(name, entry.version, platformEntry.size);
      if (afterLock !== undefined) return afterLock;
      return install(name, entry.version, platformEntry, options, logger);
    },
    {
      ...(options.lockTimeoutMs === undefined ? {} : { timeoutMs: options.lockTimeoutMs }),
      logger,
    },
  );
}

/**
 * Cheap "is the right version already active?" check.
 *
 * Deliberately does not re-hash the binary: that would cost hundreds of milliseconds on
 * every store call. Integrity is established when the file is installed — it is verified
 * before being made executable and before being moved into place — and re-checked in full
 * by {@link verifyInstall}, which `agentship doctor` runs.
 */
async function activePathIfCurrent(
  tool: ToolName,
  version: string,
  expectedSize: number,
): Promise<string | undefined> {
  const pointer = await readPointer(tool);
  if (pointer?.version !== version) return undefined;
  const path = binaryPath(tool, version);
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size !== expectedSize) return undefined;
    return path;
  } catch {
    return undefined;
  }
}

async function install(
  tool: ToolName,
  version: string,
  platformEntry: { url: string; sha256: string; size: number },
  options: ToolchainOptions,
  logger: Logger,
): Promise<string> {
  const root = await ensureDir(toolRoot(tool));
  const staging = await mkdtemp(join(root, STAGING_PREFIX));
  const stagedBinary = join(staging, tool);
  const target = versionDir(tool, version);

  try {
    logger.info('installing managed tool', { version, url: platformEntry.url });
    await downloadVerified({
      url: platformEntry.url,
      sha256: platformEntry.sha256,
      size: platformEntry.size,
      dest: stagedBinary,
      logger,
      ...(options.cancelSignal === undefined ? {} : { cancelSignal: options.cancelSignal }),
      ...(options.downloadTimeoutMs === undefined ? {} : { timeoutMs: options.downloadTimeoutMs }),
      ...(options.downloadAttempts === undefined ? {} : { attempts: options.downloadAttempts }),
    });
    // Only now — after size and digest matched — does the file become executable.
    await chmod(stagedBinary, BINARY_MODE);
    await writeInstallManifestInStaging(staging, {
      tool,
      version,
      sha256: platformEntry.sha256,
      size: platformEntry.size,
      url: platformEntry.url,
    });

    // A leftover directory for this version can only come from an interrupted install:
    // the lock guarantees no live writer, so replacing it is safe.
    await safeRemove(target);
    await rename(staging, target);
  } catch (error) {
    await safeRemove(staging).catch(() => undefined);
    throw error;
  }

  // Health check before activation: a binary that cannot run never becomes the current one.
  const installedBinary = binaryPath(tool, version);
  const reported = await healthCheck(tool, installedBinary, options, logger);
  if (reported === undefined) {
    await safeRemove(target).catch(() => undefined);
    throw new AgentshipError(
      ERROR_CODES.TOOL_HEALTHCHECK_FAILED,
      `${tool} ${version} was downloaded and verified but does not run on this machine.`,
      {
        details: { tool, version },
        remediation: {
          summary:
            'Check that the platform build matches this machine, then run `agentship doctor`.',
        },
      },
    );
  }

  const previous = await readPointer(tool);
  const pointer: Pointer = {
    schemaVersion: 1,
    tool,
    version,
    sha256: platformEntry.sha256,
    activatedAt: new Date().toISOString(),
    ...(previous !== undefined && previous.version !== version
      ? { previousVersion: previous.version }
      : {}),
  };
  await writePointer(pointer);
  logger.info('managed tool activated', { version, reported });

  await pruneVersions(tool, pointer);
  return installedBinary;
}

async function writeInstallManifestInStaging(
  staging: string,
  manifest: { tool: ToolName; version: string; sha256: string; size: number; url: string },
): Promise<void> {
  // The manifest is written inside the staging directory so it travels atomically with the
  // binary during the final `rename`.
  await writeFile(
    join(staging, INSTALL_MANIFEST_FILE),
    `${JSON.stringify(
      { schemaVersion: 1, ...manifest, installedAt: new Date().toISOString() },
      null,
      2,
    )}\n`,
    { mode: FILE_MODE },
  );
}

/** Runs `<tool> --version`. Returns the reported version, or `undefined` on any failure. */
async function healthCheck(
  tool: ToolName,
  path: string,
  options: ToolchainOptions,
  logger: Logger,
): Promise<string | undefined> {
  if (options.healthCheck === false) return 'skipped';
  try {
    const result = await runTool(path, {
      args: ['--version'],
      timeoutMs: HEALTH_CHECK_TIMEOUT_MS,
      retry: false,
      toolName: tool,
      logger,
      ...(options.cancelSignal === undefined ? {} : { cancelSignal: options.cancelSignal }),
    });
    return result.stdout.trim().split('\n')[0] ?? '';
  } catch (error) {
    logger.warn('tool health check failed', { path, err: error });
    return undefined;
  }
}

/** Removes every installed version except the active one and the rollback target. */
async function pruneVersions(tool: ToolName, pointer: Pointer): Promise<void> {
  const keep = new Set([pointer.version, pointer.previousVersion].filter(Boolean) as string[]);
  const root = toolRoot(tool);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith('.') || name === 'current.json' || keep.has(name)) continue;
    const candidate = join(root, name);
    const info = await stat(candidate).catch(() => undefined);
    if (info?.isDirectory() === true) await safeRemove(candidate).catch(() => undefined);
  }
}

/**
 * Absolute path of an already installed tool.
 *
 * Never falls back to `PATH` and never installs: callers that may need an install use
 * {@link ensureTool}.
 */
export async function toolPath(tool: string, options: ToolchainOptions = {}): Promise<string> {
  const lockfile = resolveLockfile(options);
  const { tool: name, entry } = lockEntryFor(lockfile, tool, options.platform ?? currentPlatform());
  const pointer = await readPointer(name);
  if (pointer === undefined) {
    throw new AgentshipError(ERROR_CODES.TOOL_NOT_INSTALLED, `${name} is not installed.`, {
      details: { tool: name },
      remediation: { summary: 'Run `agentship doctor`, or let the next command install it.' },
    });
  }
  // The active pointer is only trustworthy relative to the lockfile pin. Serving whatever
  // version it names — as this public accessor did — would hand a caller a binary the lockfile
  // does not pin if the pointer were ever tampered with. The pin is the single source of truth.
  if (pointer.version !== entry.version) {
    throw new AgentshipError(
      ERROR_CODES.TOOL_VERSION_DRIFT,
      `${name} is pinned to ${entry.version} but the active version is ${pointer.version}.`,
      {
        details: { tool: name, pinned: entry.version, active: pointer.version },
        remediation: { summary: 'Run `agentship doctor` to reinstall the pinned version.' },
      },
    );
  }
  const path = binaryPath(name, pointer.version);
  const info = await stat(path).catch(() => undefined);
  if (info?.isFile() !== true) {
    throw new AgentshipError(
      ERROR_CODES.TOOL_INSTALL_CORRUPT,
      `${name} ${pointer.version} is marked as active but its binary is missing.`,
      { details: { tool: name, version: pointer.version, path } },
    );
  }
  return path;
}

/** Version currently active for a tool, or `undefined` when it is not installed. */
export async function installedVersion(tool: ToolName): Promise<string | undefined> {
  return (await readPointer(tool))?.version;
}

export interface UpdateReport {
  readonly tool: ToolName;
  readonly action: 'installed' | 'updated' | 'up-to-date';
  readonly from?: string;
  readonly to: string;
}

/**
 * Brings every managed tool to the version pinned in the lockfile.
 *
 * New versions are staged next to the running one and only become active after passing
 * their health check, so an update that fails leaves the previous version serving requests.
 */
export async function updateTools(options: ToolchainOptions = {}): Promise<UpdateReport[]> {
  const lockfile = resolveLockfile(options);
  const reports: UpdateReport[] = [];
  for (const tool of TOOL_NAMES) {
    const entry = lockfile.tools[tool];
    if (entry === undefined) continue;
    const before = await installedVersion(tool);
    await ensureTool(tool, options);
    reports.push({
      tool,
      to: entry.version,
      ...(before === undefined ? {} : { from: before }),
      action:
        before === undefined ? 'installed' : before === entry.version ? 'up-to-date' : 'updated',
    });
  }
  return reports;
}

export interface RollbackResult {
  readonly tool: ToolName;
  readonly from: string;
  readonly to: string;
}

/**
 * Switches a tool back to the version it was running before the last update.
 *
 * The rollback target is re-verified (digest against its own install manifest, plus a health
 * check) before the pointer moves: rolling back onto a corrupted install would turn a bad
 * update into an unusable toolchain.
 */
export async function rollbackTool(
  tool: string,
  options: ToolchainOptions = {},
): Promise<RollbackResult> {
  const lockfile = resolveLockfile(options);
  const { tool: name } = lockEntryFor(lockfile, tool, options.platform ?? currentPlatform());
  const logger = (options.logger ?? getLogger()).child({ tool: name });

  return withToolLock(
    name,
    async () => {
      const pointer = await readPointer(name);
      const target = pointer?.previousVersion;
      if (pointer === undefined || target === undefined) {
        throw new AgentshipError(
          ERROR_CODES.TOOL_ROLLBACK_UNAVAILABLE,
          `No previous version of ${name} is kept, so there is nothing to roll back to.`,
          { details: { tool: name } },
        );
      }
      const manifest = await readInstallManifest(name, target);
      const path = binaryPath(name, target);
      const digest = await fileSha256(path).catch(() => undefined);
      if (manifest === undefined || digest === undefined || digest !== manifest.sha256) {
        throw new AgentshipError(
          ERROR_CODES.TOOL_ROLLBACK_UNAVAILABLE,
          `The kept ${name} ${target} installation is missing or corrupt; refusing to roll back onto it.`,
          { details: { tool: name, version: target } },
        );
      }
      if ((await healthCheck(name, path, options, logger)) === undefined) {
        throw new AgentshipError(
          ERROR_CODES.TOOL_ROLLBACK_UNAVAILABLE,
          `${name} ${target} does not run on this machine; refusing to roll back onto it.`,
          { details: { tool: name, version: target } },
        );
      }
      await writePointer({
        schemaVersion: 1,
        tool: name,
        version: target,
        sha256: manifest.sha256,
        activatedAt: new Date().toISOString(),
        previousVersion: pointer.version,
      });
      logger.warn('rolled back managed tool', { from: pointer.version, to: target });
      return { tool: name, from: pointer.version, to: target };
    },
    {
      ...(options.lockTimeoutMs === undefined ? {} : { timeoutMs: options.lockTimeoutMs }),
      logger,
    },
  );
}
