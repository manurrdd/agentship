import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AgentshipError, ERROR_CODES } from '@agentship/core';
import { z } from 'zod';

/**
 * The embedded lockfile.
 *
 * It ships inside the npm package and is the *only* source of truth for what Agentship will
 * execute: a URL, an exact SHA-256 and an exact size per tool and platform. Nothing is
 * fetched to decide what to trust — in particular the `checksums.txt` published by the
 * upstream projects is never consulted at install time, because a rewritten release would
 * come with a rewritten checksums file. It is cross-checked once, offline, by
 * `scripts/update-tools-lock.ts` when the team bumps a version.
 */

/** Platforms Agentship supports. Windows is out of scope for v1. */
export const SUPPORTED_PLATFORMS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
] as const;

export type PlatformKey = (typeof SUPPORTED_PLATFORMS)[number];

/** Tools Agentship manages. Any other name is rejected before touching the filesystem. */
export const TOOL_NAMES = ['asc', 'gpc'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const PlatformEntrySchema = z.object({
  url: z.url(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex characters'),
  size: z.number().int().positive(),
});

const ToolEntrySchema = z.object({
  version: z.string().min(1),
  tag: z.string().min(1),
  repo: z.string().min(1),
  license: z.string().min(1),
  description: z.string().min(1),
  checksumsUrl: z.url(),
  platforms: z.record(z.enum(SUPPORTED_PLATFORMS), PlatformEntrySchema),
});

export const LockfileSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.iso.datetime(),
  platforms: z.array(z.enum(SUPPORTED_PLATFORMS)).min(1),
  tools: z.record(z.enum(TOOL_NAMES), ToolEntrySchema),
});

export type PlatformEntry = z.infer<typeof PlatformEntrySchema>;
export type ToolEntry = z.infer<typeof ToolEntrySchema>;
export type Lockfile = z.infer<typeof LockfileSchema>;

let cached: Lockfile | undefined;

/**
 * Loads and validates the lockfile shipped with this package.
 *
 * Resolved relative to this module, which sits one level below the package root both in
 * `src/` (tests, tsx) and in `dist/` (published build).
 */
export function loadLockfile(): Lockfile {
  if (cached !== undefined) return cached;
  const path = fileURLToPath(new URL('../tools.lock.json', import.meta.url));
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw AgentshipError.from(
      ERROR_CODES.CONFIG_NOT_FOUND,
      `The embedded toolchain lockfile is missing at ${path}. The Agentship installation is incomplete.`,
      cause,
      { remediation: { summary: 'Reinstall Agentship (`npx agentship@latest setup`).' } },
    );
  }
  const parsed = LockfileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new AgentshipError(
      ERROR_CODES.CONFIG_INVALID,
      `The embedded toolchain lockfile at ${path} is invalid.`,
      { details: { issues: z.treeifyError(parsed.error) } },
    );
  }
  cached = parsed.data;
  return cached;
}

/** Detects the current platform key, or explains that Agentship does not support it. */
export function currentPlatform(): PlatformKey {
  const key = `${process.platform}-${process.arch}`;
  if ((SUPPORTED_PLATFORMS as readonly string[]).includes(key)) return key as PlatformKey;
  throw new AgentshipError(
    ERROR_CODES.TOOL_PLATFORM_UNSUPPORTED,
    `Agentship does not support ${process.platform}/${process.arch}. Supported: ${SUPPORTED_PLATFORMS.join(', ')}.`,
    {
      details: { platform: process.platform, arch: process.arch },
      remediation: {
        summary:
          process.platform === 'win32'
            ? 'Run Agentship from WSL2 or from macOS/Linux; the store backends ship no Windows-supported build in v1.'
            : 'Use a supported platform.',
      },
    },
  );
}

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

/** Returns the lockfile entry for a tool, or a precise error explaining what is missing. */
export function lockEntryFor(
  lockfile: Lockfile,
  tool: string,
  platform: PlatformKey = currentPlatform(),
): { tool: ToolName; entry: ToolEntry; platformEntry: PlatformEntry; platform: PlatformKey } {
  if (!isToolName(tool)) {
    throw new AgentshipError(
      ERROR_CODES.TOOL_UNKNOWN,
      `"${tool}" is not a tool managed by Agentship. Managed tools: ${TOOL_NAMES.join(', ')}.`,
      { details: { tool } },
    );
  }
  const entry = lockfile.tools[tool];
  if (entry === undefined) {
    throw new AgentshipError(
      ERROR_CODES.TOOL_LOCK_ENTRY_MISSING,
      `The lockfile has no entry for ${tool}.`,
      { details: { tool } },
    );
  }
  const platformEntry = entry.platforms[platform];
  if (platformEntry === undefined) {
    throw new AgentshipError(
      ERROR_CODES.TOOL_LOCK_ENTRY_MISSING,
      `The lockfile has no ${tool} build for ${platform}.`,
      { details: { tool, platform } },
    );
  }
  return { tool, entry, platformEntry, platform };
}
