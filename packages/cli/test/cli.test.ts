import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathExists } from '@agentship/core';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The lifecycle CLI as a user runs it: a real process, a scratch home, and no network.
 *
 * The point of these tests is the contract of the binary itself — exit codes, the refusal
 * to act without `--yes`, and the fact that a machine with nothing installed is diagnosed
 * honestly rather than reported as fine.
 */
const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../src/bin.ts');

interface Run {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

describe('agentship CLI', () => {
  let home: string;
  let agentshipHome: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agentship-cli-home-'));
    agentshipHome = await mkdtemp(join(tmpdir(), 'agentship-cli-state-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(agentshipHome, { recursive: true, force: true });
  });

  async function run(...args: string[]): Promise<Run> {
    const result = await execa(
      process.execPath,
      ['--import', 'tsx', '--conditions', 'agentship-source', BIN, ...args],
      {
        reject: false,
        env: {
          HOME: home,
          AGENTSHIP_HOME: agentshipHome,
          AGENTSHIP_SKIP_TOOL_INSTALL: '1',
          // A minimal PATH so no real agent CLI on this machine is ever invoked.
          PATH: '/usr/bin:/bin',
          NO_COLOR: '1',
        },
        extendEnv: false,
      },
    );
    return {
      exitCode: result.exitCode ?? -1,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
    };
  }

  it('prints its version', async () => {
    const result = await run('--version');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('offers only lifecycle commands — nothing that publishes', async () => {
    const result = await run('--help');
    expect(result.stdout).toContain('setup');
    expect(result.stdout).toContain('doctor');
    expect(result.stdout).toContain('update');
    expect(result.stdout).toContain('uninstall');
    expect(result.stdout).toContain('mcp');
    expect(result.stdout).not.toMatch(/\bpublish\b|\brelease\b\s+\[/);
  });

  it('refuses to install without --yes and changes nothing', async () => {
    const result = await run('setup');
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('agentship setup --yes');
    expect(await pathExists(join(agentshipHome, 'integrations.json'))).toBe(false);
  });

  it('sets up with --agents none and records an empty installation', async () => {
    const result = await run('setup', '--yes', '--agents', 'none');
    expect(result.stdout).toContain('(no agents selected)');
    expect(await pathExists(join(home, '.claude.json'))).toBe(false);
    // The managed binaries were skipped, so doctor is not green — and says why.
    expect(result.stdout).toContain('Managed binary');
  });

  it('reports a machine without tools as not ready, in JSON too', async () => {
    const result = await run('doctor', '--json');
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: { id: string; status: string; remediation?: { summary: string } }[];
    };
    expect(report.ok).toBe(false);
    const tool = report.checks.find((check) => check.id.startsWith('tool:'));
    expect(tool?.status).toBe('fail');
    expect(tool?.remediation?.summary).toContain('agentship setup');
  });

  it('rejects an unknown agent name instead of silently ignoring it', async () => {
    const result = await run('setup', '--yes', '--agents', 'emacs');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown agent(s): emacs');
  });

  it('installs for a named agent and lists what an uninstall would remove', async () => {
    const installed = await run('setup', '--yes', '--agents', 'claude-code');
    expect(installed.stdout).toContain('Claude Code');
    expect(await pathExists(join(home, '.claude.json'))).toBe(true);
    expect(await pathExists(join(home, '.claude', 'skills', 'agentship-publish'))).toBe(true);

    const result = await run('uninstall');
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Repositories are never touched');
    expect(result.stdout).toContain('agentship-publish');
    // A dry run removes nothing.
    expect(await pathExists(join(home, '.claude', 'skills', 'agentship-publish'))).toBe(true);
    expect(await pathExists(join(agentshipHome, 'integrations.json'))).toBe(true);

    const removed = await run('uninstall', '--yes');
    expect(removed.stdout).toContain('removed');
    expect(await pathExists(join(home, '.claude', 'skills', 'agentship-publish'))).toBe(false);
    const config = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(config.mcpServers?.['agentship']).toBeUndefined();
  });

  it('answers the MCP protocol on stdio', async () => {
    const request = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'smoke', version: '0.0.0' },
      },
    })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`;

    const result = await execa(
      process.execPath,
      ['--import', 'tsx', '--conditions', 'agentship-source', BIN, 'mcp'],
      {
        input: request,
        reject: false,
        timeout: 30_000,
        env: {
          HOME: home,
          AGENTSHIP_HOME: agentshipHome,
          PATH: '/usr/bin:/bin',
          AGENTSHIP_MOCK_STORES: '1',
        },
        extendEnv: false,
      },
    );

    const lines = (typeof result.stdout === 'string' ? result.stdout : '')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { id: number; result?: { tools?: { name: string }[] } });
    const toolsList = lines.find((line) => line.id === 2);
    expect(toolsList?.result?.tools?.map((tool) => tool.name)).toContain('agentship_plan');
    // stdout carried protocol messages only.
    expect(lines).toHaveLength(2);
  });

  it('keeps the skills the package ships next to the binary', async () => {
    const skillPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../skills/agentship-publish/SKILL.md',
    );
    expect(await readFile(skillPath, 'utf8')).toContain('name: agentship-publish');
  });
});
