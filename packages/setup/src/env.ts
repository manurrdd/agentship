import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { getLogger, type Logger, pathExists } from '@agentship/core';

/**
 * Everything the installer touches outside its own tree, behind one injectable object.
 *
 * The installer edits files in the user's home directory and shells out to agent CLIs.
 * Both are exactly the operations a test must not perform for real, so they arrive here
 * instead of being reached for directly: a test builds an {@link IntegrationEnv} pointing
 * at a scratch home with a stubbed `which`/`run`, and the same code paths run unchanged.
 */
export interface CliResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface IntegrationEnv {
  /** Home directory whose agent configuration is edited. */
  readonly home: string;
  readonly platform: NodeJS.Platform;
  /** Resolves an executable on PATH, or `undefined` when it is not installed. */
  which(command: string): Promise<string | undefined>;
  /** Runs an agent's own CLI. Never throws on a non-zero exit; reports it. */
  run(command: string, args: readonly string[]): Promise<CliResult>;
  readonly logger: Logger;
}

/** Looks up `command` on PATH without executing anything. */
export async function whichOnPath(command: string): Promise<string | undefined> {
  const path = process.env['PATH'];
  if (path === undefined || path === '') return undefined;
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, command);
    if (await pathExists(candidate)) return candidate;
  }
  return undefined;
}

async function runCommand(command: string, args: readonly string[]): Promise<CliResult> {
  const { execa } = await import('execa');
  try {
    const result = await execa(command, [...args], {
      timeout: 60_000,
      reject: false,
      all: false,
      env: { NO_COLOR: '1' },
    });
    return {
      ok: result.exitCode === 0,
      exitCode: result.exitCode ?? -1,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
    };
  } catch (cause) {
    return {
      ok: false,
      exitCode: -1,
      stdout: '',
      stderr: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export function defaultEnv(overrides: Partial<IntegrationEnv> = {}): IntegrationEnv {
  return {
    home: overrides.home ?? homedir(),
    platform: overrides.platform ?? process.platform,
    which: overrides.which ?? whichOnPath,
    run: overrides.run ?? runCommand,
    logger: overrides.logger ?? getLogger(),
  };
}
