import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@agentship/core';
import { defaultEnv, type IntegrationEnv } from '../src/env.js';

/**
 * Scratch home directories for the installer tests.
 *
 * Two are needed and they are different things: `AGENTSHIP_HOME` (Agentship's own state) and
 * the user's home (where agent configuration lives). Both are redirected so a test can
 * never touch the machine's real Claude, Codex or VS Code configuration.
 */
export interface TestEnv {
  readonly env: IntegrationEnv;
  readonly home: string;
  readonly agentshipHome: string;
  readonly cliCalls: { command: string; args: readonly string[] }[];
  cleanup(): Promise<void>;
}

export interface TestEnvOptions {
  /** Commands the fake PATH lookup should find. */
  readonly onPath?: readonly string[];
  readonly platform?: NodeJS.Platform;
}

export async function createTestEnv(options: TestEnvOptions = {}): Promise<TestEnv> {
  const home = await mkdtemp(join(tmpdir(), 'agentship-agents-home-'));
  const agentshipHome = await mkdtemp(join(tmpdir(), 'agentship-home-'));
  const previous = process.env['AGENTSHIP_HOME'];
  process.env['AGENTSHIP_HOME'] = agentshipHome;

  const cliCalls: { command: string; args: readonly string[] }[] = [];
  const onPath = new Set(options.onPath ?? []);
  const env = defaultEnv({
    home,
    platform: options.platform ?? 'darwin',
    logger: createLogger({ level: 'silent', sinks: [] }),
    which: async (command) => (onPath.has(command) ? `/usr/local/bin/${command}` : undefined),
    run: async (command, args) => {
      cliCalls.push({ command, args });
      return { ok: true, exitCode: 0, stdout: '', stderr: '' };
    },
  });

  return {
    env,
    home,
    agentshipHome,
    cliCalls,
    async cleanup() {
      if (previous === undefined) delete process.env['AGENTSHIP_HOME'];
      else process.env['AGENTSHIP_HOME'] = previous;
      await rm(home, { recursive: true, force: true });
      await rm(agentshipHome, { recursive: true, force: true });
    },
  };
}

/** A skills source directory with one minimal skill, for installer tests. */
export async function createSkillsSource(): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'agentship-skills-'));
  await mkdir(join(dir, 'demo-skill', 'references'), { recursive: true });
  await writeFile(
    join(dir, 'demo-skill', 'SKILL.md'),
    '---\nname: demo-skill\ndescription: A skill used by the installer tests.\n---\n\nBody.\n',
  );
  await writeFile(join(dir, 'demo-skill', 'references', 'notes.md'), '# Notes\n');
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
