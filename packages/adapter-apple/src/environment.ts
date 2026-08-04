import { join } from 'node:path';
import { ensureDir, toolStateDir } from '@agentship/core';
import { assertNoSecretEnv } from '@agentship/credentials';

/**
 * The environment `asc` runs in, and why every entry is there.
 *
 * `asc` resolves credentials from, in order: the selected profile (macOS keychain, or a
 * config file), then environment variables for whatever is still missing. A repo-local
 * `./.asc/config.json` takes precedence over the user-level one. Left alone, that means a
 * file committed to the repository being published — or a login the user happened to
 * create by hand — could decide which Apple account Agentship writes to.
 *
 * Three settings close that off, and they only work together:
 *
 * - `ASC_BYPASS_KEYCHAIN=1` — never read or write the user's own keychain entries.
 * - `ASC_CONFIG_PATH` — points at a file inside Agentship's own state directory that Agentship
 *   never creates, so the config source is guaranteed empty.
 * - the working directory — every invocation runs in {@link runDir}, so the upward search
 *   for `./.asc/config.json` starts outside any user repository.
 *
 * What is left is exactly one credential source: the three variables Agentship exports from
 * the profile the caller asked for.
 */

export const APPLE_TOOL = 'asc';

export interface AppleEnvOptions {
  readonly keyId: string;
  readonly issuerId: string;
  /** Path of the short-lived `.p8` file created by `withAppleKeyFile`. */
  readonly privateKeyPath: string;
  /** Absolute path of the neutral working directory the invocation will use. */
  readonly stateDir: string;
}

/** Absolute path of the config file `asc` is pointed at, which Agentship never creates. */
export function absentConfigPath(stateDir: string): string {
  return join(stateDir, 'no-asc-config.json');
}

export function appleEnv(options: AppleEnvOptions): Record<string, string> {
  const env: Record<string, string> = {
    ASC_KEY_ID: options.keyId,
    ASC_ISSUER_ID: options.issuerId,
    ASC_PRIVATE_KEY_PATH: options.privateKeyPath,
    // Agentship only supports team keys: an individual key cannot manage another team's apps.
    ASC_KEY_TYPE: 'team',
    ASC_BYPASS_KEYCHAIN: '1',
    ASC_CONFIG_PATH: absentConfigPath(options.stateDir),
    // No telemetry, no update checks, no spinner bytes interleaved with the output.
    DO_NOT_TRACK: '1',
    ASC_TELEMETRY_DISABLED: '1',
    ASC_SKILLS_AUTO_CHECK: '0',
    ASC_SPINNER_DISABLED: '1',
    ASC_DEFAULT_OUTPUT: 'json',
    // Retries are Agentship's decision, taken from the classified error, not the tool's.
    ASC_MAX_RETRIES: '0',
  };
  assertNoSecretEnv(env);
  return env;
}

/** Creates (and returns) the directory `asc` is confined to. */
export async function appleStateDir(): Promise<string> {
  return ensureDir(toolStateDir(APPLE_TOOL));
}
