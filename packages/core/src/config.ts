import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { AgentshipError, ERROR_CODES } from './errors.js';
import { ensureAgentshipHome, FILE_MODE, userConfigPath } from './paths.js';

/** Schema version of `~/.agentship/config.json`. Bumped only on breaking changes. */
export const USER_CONFIG_VERSION = 1;

/**
 * Non-secret metadata about a stored Apple credential.
 * The private key itself lives in the OS keyring and never in this file.
 */
const AppleProfileMetaSchema = z.object({
  keyId: z.string().min(1),
  issuerId: z.string().min(1),
  /** Optional label the user gave the key in App Store Connect. */
  keyName: z.string().optional(),
  updatedAt: z.iso.datetime(),
});

/** Non-secret metadata about a stored Google service account. */
const GoogleProfileMetaSchema = z.object({
  clientEmail: z.string().min(1),
  projectId: z.string().min(1),
  updatedAt: z.iso.datetime(),
});

const ProfileMetaSchema = z.object({
  apple: AppleProfileMetaSchema.optional(),
  google: GoogleProfileMetaSchema.optional(),
});

export const UserConfigSchema = z.object({
  schemaVersion: z.literal(USER_CONFIG_VERSION).default(USER_CONFIG_VERSION),
  /** Credential profile used when a project does not name one. */
  defaultProfile: z.string().min(1).default('default'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error', 'silent']).optional(),
  /** Non-secret metadata per credential profile, keyed by profile name. */
  profiles: z.record(z.string(), ProfileMetaSchema).default({}),
});

export type UserConfig = z.infer<typeof UserConfigSchema>;
export const DEFAULT_PROFILE = 'default';

function emptyConfig(): UserConfig {
  return UserConfigSchema.parse({});
}

/**
 * Reads and validates the user configuration.
 *
 * A missing file yields defaults; a malformed one is a hard `CONFIG_INVALID` error, because
 * silently rewriting a file the user may have edited by hand would lose information.
 */
export async function readUserConfig(): Promise<UserConfig> {
  const path = userConfigPath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return emptyConfig();
    throw AgentshipError.from(ERROR_CODES.CONFIG_INVALID, `Could not read ${path}.`, cause);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw AgentshipError.from(ERROR_CODES.CONFIG_INVALID, `${path} is not valid JSON.`, cause, {
      remediation: { summary: `Fix or delete ${path}; Agentship recreates it with defaults.` },
    });
  }

  const version = (parsed as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (version !== undefined && version !== USER_CONFIG_VERSION) {
    throw new AgentshipError(
      ERROR_CODES.CONFIG_UNSUPPORTED_VERSION,
      `${path} declares schema version ${String(version)}, but this Agentship supports ${USER_CONFIG_VERSION}.`,
      { remediation: { summary: 'Update Agentship, or remove the file to start fresh.' } },
    );
  }

  const result = UserConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new AgentshipError(ERROR_CODES.CONFIG_INVALID, `${path} failed validation.`, {
      details: { issues: z.treeifyError(result.error) },
      remediation: { summary: `Fix the reported fields in ${path}, or delete the file.` },
    });
  }
  return result.data;
}

/** Writes the user configuration atomically with owner-only permissions. */
export async function writeUserConfig(config: UserConfig): Promise<void> {
  await ensureAgentshipHome();
  const path = userConfigPath();
  const validated = UserConfigSchema.parse(config);
  const tmp = join(dirname(path), `.config.${process.pid}.tmp`);
  await writeFile(tmp, `${JSON.stringify(validated, null, 2)}\n`, { mode: FILE_MODE });
  await rename(tmp, path);
}

/** Read-modify-write helper. Not safe against concurrent writers by design (single user). */
export async function updateUserConfig(
  mutate: (config: UserConfig) => UserConfig | Promise<UserConfig>,
): Promise<UserConfig> {
  const current = await readUserConfig();
  const next = await mutate(structuredClone(current));
  await writeUserConfig(next);
  return next;
}
