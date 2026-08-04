import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AgentshipError, ERROR_CODES } from './errors.js';

/** Directory mode for everything Agentship owns: owner-only. */
export const DIR_MODE = 0o700;
/** File mode for anything that may hold sensitive material. */
export const FILE_MODE = 0o600;

/**
 * Root of Agentship's per-user state.
 *
 * Read from the environment on every call (never cached) so that tests and CI can point
 * Agentship at a scratch directory with `AGENTSHIP_HOME`.
 */
export function agentshipHome(): string {
  const override = process.env['AGENTSHIP_HOME'];
  if (override !== undefined && override.trim() !== '') return resolve(override);
  return join(homedir(), '.agentship');
}

export function toolsDir(): string {
  return join(agentshipHome(), 'tools');
}

export function logsDir(): string {
  return join(agentshipHome(), 'logs');
}

/** Scratch space for temporary files that must not leave the user's private tree. */
export function tmpDir(): string {
  return join(agentshipHome(), 'tmp');
}

/**
 * Working directory every managed binary is launched in.
 *
 * Both backends discover configuration by walking up from the current directory —
 * `asc` reads a repo-local `./.asc/config.json`, `gpc` walks up looking for `.gpcrc.json`.
 * Running them inside the user's repository would therefore let a file committed by
 * someone else choose which credentials the tool uses. They run here instead, in a
 * directory Agentship owns and never populates with tool configuration.
 */
export function runDir(): string {
  return join(agentshipHome(), 'run');
}

/** Per-tool state Agentship redirects a backend's own config/cache directories to. */
export function toolStateDir(tool: string): string {
  return join(runDir(), tool);
}

/** Non-secret user configuration (secrets live in the OS keyring). */
export function userConfigPath(): string {
  return join(agentshipHome(), 'config.json');
}

/** Project-local Agentship directory, e.g. `<repo>/.agentship`. */
export function projectDir(repoRoot: string): string {
  return join(resolve(repoRoot), '.agentship');
}

/** Declarative desired-state manifest of a project. */
export function manifestPath(repoRoot: string): string {
  return join(projectDir(repoRoot), 'agentship.yaml');
}

/** Kernel state (journal, snapshots) — never committed. */
export function stateDir(repoRoot: string): string {
  return join(projectDir(repoRoot), 'state');
}

/** Emitted pending operations — never committed. */
export function pendingDir(repoRoot: string): string {
  return join(projectDir(repoRoot), 'pending');
}

/**
 * Creates a directory (and parents) with owner-only permissions, tightening the mode of
 * the final directory if it already existed with looser bits.
 */
export async function ensureDir(path: string, mode: number = DIR_MODE): Promise<string> {
  try {
    await mkdir(path, { recursive: true, mode });
    // `mkdir` honours the process umask, and does nothing when the directory exists.
    await chmod(path, mode);
    return path;
  } catch (cause) {
    throw AgentshipError.from(
      ERROR_CODES.CONFIG_HOME_UNWRITABLE,
      `Could not create directory ${path} with mode ${mode.toString(8)}.`,
      cause,
      {
        remediation: {
          summary:
            'Check ownership and permissions of the parent directory, or set AGENTSHIP_HOME.',
        },
      },
    );
  }
}

/** Creates `AGENTSHIP_HOME` and its standard subdirectories, and verifies it is writable. */
export async function ensureAgentshipHome(): Promise<string> {
  const home = agentshipHome();
  await ensureDir(home);
  await Promise.all([
    ensureDir(toolsDir()),
    ensureDir(logsDir()),
    ensureDir(tmpDir()),
    ensureDir(runDir()),
  ]);
  try {
    await access(home, fsConstants.W_OK | fsConstants.X_OK);
  } catch (cause) {
    throw AgentshipError.from(
      ERROR_CODES.CONFIG_HOME_UNWRITABLE,
      `Agentship home ${home} is not writable.`,
      cause,
      {
        remediation: { summary: 'Fix the directory permissions or set AGENTSHIP_HOME elsewhere.' },
      },
    );
  }
  return home;
}

/** True when `target` is `base` itself or lies inside it, purely lexically. */
export function isInside(base: string, target: string): boolean {
  const from = resolve(base);
  const to = resolve(target);
  if (from === to) return true;
  const rel = relative(from, to);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/**
 * Throws unless `target` resolves inside `base`, following symlinks on the parts that
 * exist. Used before any destructive filesystem operation so that a crafted symlink or a
 * `..` in a tool name can never make Agentship delete outside its own tree.
 */
export async function assertInside(base: string, target: string): Promise<void> {
  if (!isInside(base, target)) {
    throw new AgentshipError(
      ERROR_CODES.CONFIG_HOME_UNWRITABLE,
      `Refusing to operate on ${target}: it is outside ${base}.`,
      { details: { base, target } },
    );
  }
  const realBase = await realpath(base).catch(() => resolve(base));
  const realTarget = await realpathBestEffort(target);
  if (!isInside(realBase, realTarget)) {
    throw new AgentshipError(
      ERROR_CODES.CONFIG_HOME_UNWRITABLE,
      `Refusing to operate on ${target}: it resolves to ${realTarget}, outside ${realBase}.`,
      { details: { base: realBase, target: realTarget } },
    );
  }
}

/** Resolves symlinks for the longest existing prefix of `path`. */
async function realpathBestEffort(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    // The leaf may not exist yet; resolve its parent instead.
    const parent = resolve(absolute, '..');
    if (parent === absolute) return absolute;
    const realParent = await realpathBestEffort(parent);
    return join(realParent, absolute.slice(parent.length + 1));
  }
}

/** True when the path exists (of any type). */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
