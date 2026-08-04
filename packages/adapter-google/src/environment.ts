import { ensureDir, toolStateDir } from '@agentship/core';
import { assertNoSecretEnv } from '@agentship/credentials';

/**
 * The environment `gpc` runs in, and why every entry is there.
 *
 * `gpc` resolves credentials in this order (verified on 0.9.93): its config file's
 * `auth.serviceAccount`, then `GPC_SERVICE_ACCOUNT`, then `GOOGLE_APPLICATION_CREDENTIALS`,
 * then Application Default Credentials. The last step is the dangerous one — on a machine
 * where someone has run `gcloud auth application-default login`, an unconfigured `gpc auth
 * status` reports a healthy, *personal* identity. Agentship must never publish through that.
 *
 * The config file is found by two independent searches: `$XDG_CONFIG_HOME/gpc/config.json`,
 * and a walk up from the working directory looking for `.gpcrc.json`. Both are neutralised:
 *
 * - the three XDG directories point inside Agentship's own state tree, which contains no
 *   `gpc/config.json`;
 * - every invocation runs in that same directory, so the upward `.gpcrc.json` search starts
 *   outside any user repository.
 *
 * With both config sources empty and `GOOGLE_APPLICATION_CREDENTIALS` absent from the
 * runner's environment allow-list, `GPC_SERVICE_ACCOUNT` is reached first and ADC is never
 * consulted.
 *
 * `GPC_SERVICE_ACCOUNT` accepts either raw JSON or a path. Agentship passes a **path** to the
 * short-lived file `withGoogleServiceAccountFile` creates: on Linux the environment of a
 * process is readable through `/proc/<pid>/environ`, so a private key in a variable is a
 * secret handed to every process the same user runs.
 */

export const GOOGLE_TOOL = 'gpc';

export interface GoogleEnvOptions {
  /** Path of the short-lived service-account file created by `withGoogleServiceAccountFile`. */
  readonly serviceAccountPath: string;
  /** Absolute path of the neutral working directory the invocation will use. */
  readonly stateDir: string;
}

export function googleEnv(options: GoogleEnvOptions): Record<string, string> {
  const env: Record<string, string> = {
    GPC_SERVICE_ACCOUNT: options.serviceAccountPath,
    // Redirect every directory `gpc` derives from the user's home, including the OAuth
    // access-token cache, into Agentship's own 0700 tree.
    XDG_CONFIG_HOME: options.stateDir,
    XDG_CACHE_HOME: options.stateDir,
    XDG_DATA_HOME: options.stateDir,
    GPC_NO_INTERACTIVE: '1',
    GPC_NO_UPDATE_CHECK: '1',
    GPC_NO_COLOR: '1',
    GPC_OUTPUT: 'json',
    DO_NOT_TRACK: '1',
    // Retries are Agentship's decision, taken from the classified error, not the tool's.
    GPC_MAX_RETRIES: '0',
  };
  assertNoSecretEnv(env);
  return env;
}

/** Creates (and returns) the directory `gpc` is confined to. */
export async function googleStateDir(): Promise<string> {
  return ensureDir(toolStateDir(GOOGLE_TOOL));
}
