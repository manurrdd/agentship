import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathExists } from '@agentship/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../src/doctor.js';
import { runSetup, runUninstall, runUpdate } from '../src/install.js';
import { readIntegrations } from '../src/registry.js';
import { createSkillsSource, createTestEnv, type TestEnv } from './helpers.js';

/**
 * The installer as a whole: setup, update, doctor, uninstall.
 *
 * Tool downloads are switched off (`AGENTSHIP_SKIP_TOOL_INSTALL`) so the suite stays offline;
 * everything else — detection, registration, skills, the record of what was installed and
 * its precise removal — runs for real against scratch directories.
 */
const BINARY = '/opt/agentship/dist/bin.js';

describe('installer', () => {
  let context: TestEnv | undefined;
  let skills: { dir: string; cleanup(): Promise<void> } | undefined;

  beforeEach(async () => {
    process.env['AGENTSHIP_SKIP_TOOL_INSTALL'] = '1';
    skills = await createSkillsSource();
  });

  afterEach(async () => {
    delete process.env['AGENTSHIP_SKIP_TOOL_INSTALL'];
    await context?.cleanup();
    await skills?.cleanup();
    context = undefined;
    skills = undefined;
  });

  async function setup(agents: 'detected' | 'none' | readonly ('claude-code' | 'codex')[]) {
    return runSetup({
      binaryPath: BINARY,
      skillsSourceDir: (skills as { dir: string }).dir,
      agents,
      env: (context as TestEnv).env,
    });
  }

  it('reports what it would do without --yes and changes nothing', async () => {
    context = await createTestEnv({ onPath: ['claude'] });
    const report = await runSetup({
      binaryPath: BINARY,
      skillsSourceDir: (skills as { dir: string }).dir,
      env: context.env,
      dryRun: true,
    });

    expect(report.dryRun).toBe(true);
    expect(report.selected).toEqual(['claude-code']);
    expect(await pathExists(join(context.home, '.claude.json'))).toBe(false);
    expect((await readIntegrations()).agents).toEqual([]);
  });

  it('registers the detected agents, installs the skills and records both', async () => {
    context = await createTestEnv({ onPath: ['claude'] });
    const report = await setup('detected');

    expect(report.selected).toEqual(['claude-code']);
    const agent = report.agents[0];
    expect(agent?.mcp?.serverName).toBe('agentship');
    expect(agent?.errors).toEqual([]);
    expect(agent?.skills.map((skill) => skill.name)).toEqual(['demo-skill']);

    const installedSkill = join(context.home, '.claude', 'skills', 'demo-skill', 'SKILL.md');
    expect(await pathExists(installedSkill)).toBe(true);
    expect(await readFile(installedSkill, 'utf8')).toContain('name: demo-skill');

    const record = (await readIntegrations()).agents[0];
    expect(record?.agent).toBe('claude-code');
    expect(record?.binaryPath).toBe(BINARY);
    expect(record?.skills[0]?.hash).toHaveLength(64);
  });

  it('installs nothing for --agents none and stays green in doctor', async () => {
    context = await createTestEnv({ onPath: ['claude'] });
    const report = await setup('none');

    expect(report.agents).toEqual([]);
    expect((await readIntegrations()).agents).toEqual([]);
    expect(await pathExists(join(context.home, '.claude.json'))).toBe(false);

    const doctor = await runDoctor({ env: context.env });
    const agentsCheck = doctor.checks.find((check) => check.id === 'agents');
    expect(agentsCheck?.status).toBe('warn');
    // The managed binaries were skipped, so doctor must say so rather than pretend.
    expect(doctor.checks.filter((check) => check.id.startsWith('tool:'))).not.toHaveLength(0);
  });

  it('doctor reports skills as not applicable for an agent without a skills directory', async () => {
    context = await createTestEnv({});
    await mkdir(join(context.home, '.cursor'), { recursive: true });
    await setup(['cursor']);

    const doctor = await runDoctor({ env: context.env });
    const skillsCheck = doctor.checks.find((check) => check.id === 'skills:cursor');
    // Informative, never a warning: nothing is wrong, skills simply do not apply here.
    expect(skillsCheck?.status).toBe('ok');
    expect(skillsCheck?.detail).toContain('no Agent Skills directory');
  });

  it('is idempotent: a second setup changes nothing and keeps one record per agent', async () => {
    context = await createTestEnv({ onPath: ['claude'] });
    await setup('detected');
    const second = await setup('detected');

    expect(second.agents[0]?.mcp?.changed).toBe(false);
    expect((await readIntegrations()).agents).toHaveLength(1);
  });

  it('keeps going when one agent has an unreadable configuration', async () => {
    context = await createTestEnv();
    await mkdir(join(context.home, '.codex'), { recursive: true });
    await writeFile(join(context.home, '.codex', 'config.toml'), 'this is = not [ valid toml');

    const report = await setup(['claude-code', 'codex']);
    const codex = report.agents.find((agent) => agent.agent === 'codex');
    const claude = report.agents.find((agent) => agent.agent === 'claude-code');

    expect(codex?.errors.join(' ')).toContain('will not modify it');
    expect(claude?.mcp?.changed).toBe(true);
    // The skills still went in for Codex: only its MCP registration failed.
    expect(codex?.skills).toHaveLength(1);
  });

  it('update re-registers recorded agents and refreshes their skills', async () => {
    context = await createTestEnv({ onPath: ['claude'] });
    await setup('detected');

    const skillPath = join(context.home, '.claude', 'skills', 'demo-skill', 'SKILL.md');
    await writeFile(skillPath, 'edited by hand\n');

    const result = await runUpdate({
      binaryPath: BINARY,
      skillsSourceDir: (skills as { dir: string }).dir,
      env: context.env,
    });
    expect(result.agents[0]?.agent).toBe('claude-code');
    expect(await readFile(skillPath, 'utf8')).toContain('name: demo-skill');
  });

  it('uninstall removes exactly what it installed and nothing else', async () => {
    context = await createTestEnv({ onPath: ['claude'] });
    const configPath = join(context.home, '.claude.json');
    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: { other: { command: 'other' } }, theme: 'dark' }),
    );
    await setup('detected');

    const planned = await runUninstall({ env: context.env, dryRun: true });
    expect(planned.plan[0]?.skillPaths[0]).toContain('demo-skill');

    const report = await runUninstall({ env: context.env, removeTools: false });
    expect(report.unregistered[0]?.removed).toBe(true);
    expect(report.skills[0]?.removed).toBe(true);

    const written = JSON.parse(await readFile(configPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
      theme: string;
    };
    expect(written.theme).toBe('dark');
    expect(written.mcpServers['other']).toEqual({ command: 'other' });
    expect(written.mcpServers['agentship']).toBeUndefined();
    expect(await pathExists(join(context.home, '.claude', 'skills', 'demo-skill'))).toBe(false);
    expect((await readIntegrations()).agents).toEqual([]);
  });

  it('leaves a skill the user edited in place instead of deleting their work', async () => {
    context = await createTestEnv({ onPath: ['claude'] });
    await setup('detected');
    const skillPath = join(context.home, '.claude', 'skills', 'demo-skill', 'SKILL.md');
    await writeFile(skillPath, 'my own notes\n');

    const report = await runUninstall({ env: context.env, removeTools: false });
    expect(report.skills[0]?.removed).toBe(false);
    expect(report.skills[0]?.detail).toContain('edited after installation');
    expect(await readFile(skillPath, 'utf8')).toBe('my own notes\n');
  });
});
