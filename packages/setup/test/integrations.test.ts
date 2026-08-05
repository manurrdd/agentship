import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentshipError, pathExists } from '@agentship/core';
import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { agentIntegration, detectAgents } from '../src/agents.js';
import { createTestEnv, type TestEnv } from './helpers.js';

/**
 * Registering into configuration files Agentship does not own.
 *
 * The property under test is always the same: whatever else is in that file must come out
 * the other side untouched — other MCP servers, unrelated settings, comments — and a file
 * Agentship cannot parse must not be written to at all.
 */
const BINARY = '/opt/agentship/dist/bin.js';

describe('agent integrations', () => {
  let context: TestEnv | undefined;

  afterEach(async () => {
    await context?.cleanup();
    context = undefined;
  });

  it('adds the server to an existing JSON config without disturbing anything else', async () => {
    context = await createTestEnv();
    const path = join(context.home, '.claude.json');
    await writeFile(
      path,
      JSON.stringify(
        {
          numStartups: 42,
          mcpServers: { other: { command: 'other-server', args: ['--stdio'] } },
          projects: { '/tmp/x': { allowedTools: [] } },
        },
        null,
        2,
      ),
    );

    const integration = agentIntegration('claude-code');
    const registration = await integration.register(context.env, BINARY);
    expect(registration.method).toBe('file');
    expect(registration.changed).toBe(true);
    expect(registration.backupPath).toBe(`${path}.agentship-backup`);

    const written = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(written['numStartups']).toBe(42);
    expect(written['projects']).toEqual({ '/tmp/x': { allowedTools: [] } });
    const servers = written['mcpServers'] as Record<string, unknown>;
    expect(servers['other']).toEqual({ command: 'other-server', args: ['--stdio'] });
    expect(servers['agentship']).toEqual({ command: BINARY, args: ['mcp'] });
  });

  it('is idempotent and removes only its own entry', async () => {
    context = await createTestEnv();
    const integration = agentIntegration('cursor');
    await mkdir(join(context.home, '.cursor'), { recursive: true });
    const path = join(context.home, '.cursor', 'mcp.json');
    await writeFile(path, JSON.stringify({ mcpServers: { linear: { url: 'https://x' } } }));

    const first = await integration.register(context.env, BINARY);
    expect(first.changed).toBe(true);
    const second = await integration.register(context.env, BINARY);
    expect(second.changed).toBe(false);

    const removal = await integration.unregister(context.env);
    expect(removal.removed).toBe(true);
    const written = JSON.parse(await readFile(path, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(written.mcpServers['linear']).toEqual({ url: 'https://x' });
    expect(written.mcpServers['agentship']).toBeUndefined();

    const again = await integration.unregister(context.env);
    expect(again.removed).toBe(false);
  });

  it('creates a config file that did not exist', async () => {
    context = await createTestEnv();
    const integration = agentIntegration('gemini-cli');
    const registration = await integration.register(context.env, BINARY);
    expect(registration.created ?? true).toBeTruthy();
    expect(await pathExists(registration.configPath)).toBe(true);
    expect((await integration.check(context.env)).command).toBe(BINARY);
  });

  it('uses the "servers" key for VS Code', async () => {
    context = await createTestEnv({ platform: 'darwin' });
    const integration = agentIntegration('vscode');
    await integration.register(context.env, BINARY);
    const written = JSON.parse(await readFile(integration.configPath(context.env), 'utf8')) as {
      servers: Record<string, unknown>;
    };
    expect(written.servers['agentship']).toEqual({
      type: 'stdio',
      command: BINARY,
      args: ['mcp'],
    });
  });

  it('preserves comments and other tables when editing TOML', async () => {
    context = await createTestEnv();
    const dir = join(context.home, '.codex');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'config.toml');
    const original = [
      '# my codex configuration',
      'model = "gpt-5"',
      '',
      '[mcp_servers.linear]',
      '# the linear server',
      'command = "linear-mcp"',
      'args = ["--stdio"]',
      '',
    ].join('\n');
    await writeFile(path, original);

    const integration = agentIntegration('codex');
    await integration.register(context.env, BINARY);

    const written = await readFile(path, 'utf8');
    expect(written).toContain('# my codex configuration');
    expect(written).toContain('# the linear server');
    const parsed = parseToml(written) as {
      model: string;
      mcp_servers: Record<string, { command: string; args: string[] }>;
    };
    expect(parsed.model).toBe('gpt-5');
    expect(parsed.mcp_servers['linear']).toEqual({ command: 'linear-mcp', args: ['--stdio'] });
    expect(parsed.mcp_servers['agentship']).toEqual({ command: BINARY, args: ['mcp'] });

    await integration.unregister(context.env);
    const afterRemoval = await readFile(path, 'utf8');
    expect(afterRemoval).toContain('# my codex configuration');
    expect(afterRemoval).toContain('[mcp_servers.linear]');
    expect(afterRemoval).not.toContain('agentship');
  });

  it('refuses to touch a configuration it cannot parse', async () => {
    context = await createTestEnv();
    const path = join(context.home, '.claude.json');
    const corrupt = '{ "mcpServers": { "other": } // broken\n';
    await writeFile(path, corrupt);

    const integration = agentIntegration('claude-code');
    await expect(integration.register(context.env, BINARY)).rejects.toSatisfy(
      (error: unknown) =>
        AgentshipError.is(error) &&
        error.code === 'CONFIG_INVALID' &&
        error.remediation?.summary !== undefined,
    );
    expect(await readFile(path, 'utf8')).toBe(corrupt);
    expect(await pathExists(`${path}.agentship-backup`)).toBe(false);
  });

  it("never runs an agent CLI when operating on a home that is not the user's", async () => {
    context = await createTestEnv({ onPath: ['claude', 'codex'] });
    await agentIntegration('claude-code').register(context.env, BINARY);
    await agentIntegration('codex').register(context.env, BINARY);
    expect(context.cliCalls).toEqual([]);
  });

  it('detects agents from their CLI and their configuration directories', async () => {
    context = await createTestEnv({ onPath: ['claude'] });
    await mkdir(join(context.home, '.codex'), { recursive: true });

    const detections = await detectAgents(context.env);
    const byAgent = new Map(detections.map((detection) => [detection.agent, detection]));
    expect(byAgent.get('claude-code')?.detected).toBe(true);
    expect(byAgent.get('claude-code')?.evidence).toContain('cli:claude');
    expect(byAgent.get('codex')?.detected).toBe(true);
    expect(byAgent.get('cursor')?.detected).toBe(false);
    expect(byAgent.get('claude-code')?.supportsSkills).toBe(true);
    expect(byAgent.get('cursor')?.supportsSkills).toBe(false);
  });

  it('says why skills are not installed for agents without a skills directory', async () => {
    context = await createTestEnv({});
    const detections = await detectAgents(context.env);
    const byAgent = new Map(detections.map((detection) => [detection.agent, detection]));
    for (const agent of ['cursor', 'gemini-cli', 'vscode'] as const) {
      expect(byAgent.get(agent)?.supportsSkills).toBe(false);
      // Honest about the state of knowledge, never "the agent cannot do it".
      expect(byAgent.get(agent)?.skillsNote).toContain('no Agent Skills directory');
      expect(agentIntegration(agent).skillsNote).toContain('MCP tool descriptions');
    }
    expect(byAgent.get('claude-code')?.skillsNote).toBeUndefined();
  });
});
