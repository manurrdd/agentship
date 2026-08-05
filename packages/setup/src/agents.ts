import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathExists } from '@agentship/core';
import { parse as parseToml } from 'smol-toml';
import type { IntegrationEnv } from './env.js';
import { type ConfigEdit, editJsonConfig, editTomlConfig } from './safe-edit.js';

/**
 * One integration per agent: how to detect it, how to register the Agentship MCP server in
 * its configuration, how to take it back out, and where its skills live.
 *
 * Registration prefers the agent's own CLI when there is one, because that is the only
 * path guaranteed to stay correct as the agent's configuration format evolves. When the
 * CLI is absent Agentship edits the configuration file itself, surgically and with a backup
 * (see `safe-edit.ts`). Either way the result is verified by reading the file back.
 */
export const MCP_SERVER_NAME = 'agentship';

export type AgentId = 'claude-code' | 'codex' | 'cursor' | 'gemini-cli' | 'vscode';

export const AGENT_IDS: readonly AgentId[] = [
  'claude-code',
  'codex',
  'cursor',
  'gemini-cli',
  'vscode',
];

export type RegistrationMethod = 'cli' | 'file';

export interface AgentDetection {
  readonly agent: AgentId;
  readonly name: string;
  readonly detected: boolean;
  /** What proved the agent is installed, e.g. `cli:claude` or `dir:~/.claude`. */
  readonly evidence: readonly string[];
  readonly configPath: string;
  readonly supportsSkills: boolean;
  readonly skillsDir?: string;
  /** Why skills are not installed for this agent, when they are not. */
  readonly skillsNote?: string;
}

export interface McpRegistration {
  readonly agent: AgentId;
  readonly method: RegistrationMethod;
  readonly configPath: string;
  readonly serverName: string;
  readonly changed: boolean;
  readonly backupPath?: string;
}

export interface RegistrationCheck {
  readonly registered: boolean;
  /** Command the agent would launch; present when an entry exists. */
  readonly command?: string;
  readonly args?: readonly string[];
}

export interface UnregisterResult {
  readonly agent: AgentId;
  readonly removed: boolean;
  readonly method?: RegistrationMethod;
  readonly detail: string;
}

interface AgentDefinition {
  readonly agent: AgentId;
  readonly name: string;
  /** The agent's own CLI, when it can manage MCP servers. */
  readonly cli?: {
    readonly command: string;
    readonly add: (binaryPath: string) => readonly string[];
    readonly remove: () => readonly string[];
  };
  readonly format: 'json' | 'toml';
  /** Top-level key holding MCP servers (JSON agents). */
  readonly jsonKey?: string;
  /** Dotted table holding the Agentship server (TOML agents). */
  readonly tomlTable?: string;
  readonly configPath: (env: IntegrationEnv) => string;
  /** Directory the agent loads Agent Skills from, when it supports them. */
  readonly skillsDir?: (env: IntegrationEnv) => string;
  /**
   * Why skills are not installed, for agents without a `skillsDir`. Honest about the state
   * of knowledge: "no directory Agentship knows of" is not a claim the agent cannot do it.
   */
  readonly skillsNote?: string;
  /** Extra paths whose existence proves the agent is installed. */
  readonly markers: (env: IntegrationEnv) => readonly string[];
  /** Server entry as the agent expects it. */
  readonly entry: (binaryPath: string) => Record<string, unknown>;
}

const DEFINITIONS: readonly AgentDefinition[] = [
  {
    agent: 'claude-code',
    name: 'Claude Code',
    cli: {
      command: 'claude',
      add: (binaryPath) => ['mcp', 'add', '-s', 'user', MCP_SERVER_NAME, '--', binaryPath, 'mcp'],
      remove: () => ['mcp', 'remove', '-s', 'user', MCP_SERVER_NAME],
    },
    format: 'json',
    jsonKey: 'mcpServers',
    configPath: (env) => join(env.home, '.claude.json'),
    skillsDir: (env) => join(env.home, '.claude', 'skills'),
    markers: (env) => [join(env.home, '.claude'), join(env.home, '.claude.json')],
    entry: (binaryPath) => ({ command: binaryPath, args: ['mcp'] }),
  },
  {
    agent: 'codex',
    name: 'Codex CLI',
    cli: {
      command: 'codex',
      add: (binaryPath) => ['mcp', 'add', MCP_SERVER_NAME, '--', binaryPath, 'mcp'],
      remove: () => ['mcp', 'remove', MCP_SERVER_NAME],
    },
    format: 'toml',
    tomlTable: `mcp_servers.${MCP_SERVER_NAME}`,
    configPath: (env) => join(env.home, '.codex', 'config.toml'),
    // Codex reads the cross-agent skills directory rather than one of its own.
    skillsDir: (env) => join(env.home, '.agents', 'skills'),
    markers: (env) => [join(env.home, '.codex')],
    entry: (binaryPath) => ({ command: binaryPath, args: ['mcp'] }),
  },
  {
    agent: 'cursor',
    name: 'Cursor',
    skillsNote:
      'This agent has no Agent Skills directory Agentship knows of (checked against its documentation when this integration was last verified), so the bundled skills are not installed; the MCP tool descriptions carry the essential guidance instead.',
    format: 'json',
    jsonKey: 'mcpServers',
    configPath: (env) => join(env.home, '.cursor', 'mcp.json'),
    markers: (env) => [join(env.home, '.cursor')],
    entry: (binaryPath) => ({ command: binaryPath, args: ['mcp'] }),
  },
  {
    agent: 'gemini-cli',
    name: 'Gemini CLI',
    skillsNote:
      'This agent has no Agent Skills directory Agentship knows of (checked against its documentation when this integration was last verified), so the bundled skills are not installed; the MCP tool descriptions carry the essential guidance instead.',
    format: 'json',
    jsonKey: 'mcpServers',
    configPath: (env) => join(env.home, '.gemini', 'settings.json'),
    markers: (env) => [join(env.home, '.gemini')],
    entry: (binaryPath) => ({ command: binaryPath, args: ['mcp'] }),
  },
  {
    agent: 'vscode',
    name: 'VS Code (Copilot)',
    skillsNote:
      'This agent has no Agent Skills directory Agentship knows of (checked against its documentation when this integration was last verified), so the bundled skills are not installed; the MCP tool descriptions carry the essential guidance instead.',
    format: 'json',
    jsonKey: 'servers',
    configPath: (env) => vscodeUserDir(env, 'mcp.json'),
    markers: (env) => [vscodeUserDir(env, '')],
    entry: (binaryPath) => ({ type: 'stdio', command: binaryPath, args: ['mcp'] }),
  },
];

function vscodeUserDir(env: IntegrationEnv, file: string): string {
  const base =
    env.platform === 'darwin'
      ? join(env.home, 'Library', 'Application Support', 'Code', 'User')
      : join(env.home, '.config', 'Code', 'User');
  return file === '' ? base : join(base, file);
}

export interface AgentIntegration {
  readonly agent: AgentId;
  readonly name: string;
  readonly supportsSkills: boolean;
  /** Present exactly when `supportsSkills` is false: the honest reason why. */
  readonly skillsNote?: string;
  skillsDir(env: IntegrationEnv): string | undefined;
  configPath(env: IntegrationEnv): string;
  detect(env: IntegrationEnv): Promise<AgentDetection>;
  register(env: IntegrationEnv, binaryPath: string): Promise<McpRegistration>;
  unregister(env: IntegrationEnv): Promise<UnregisterResult>;
  check(env: IntegrationEnv): Promise<RegistrationCheck>;
}

/**
 * The agent's own CLI is only used when Agentship is operating on the real home directory:
 * a test (or an operator) pointing the installer at another home must never have an
 * external tool write to the actual one.
 */
async function usableCli(
  definition: AgentDefinition,
  env: IntegrationEnv,
): Promise<string | undefined> {
  if (definition.cli === undefined) return undefined;
  if (env.home !== homedir()) return undefined;
  return env.which(definition.cli.command);
}

async function readEntry(
  definition: AgentDefinition,
  env: IntegrationEnv,
): Promise<Record<string, unknown> | undefined> {
  const path = definition.configPath(env);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    if (definition.format === 'toml') {
      const document = parseToml(raw) as Record<string, unknown>;
      const servers = document['mcp_servers'];
      const entry = (servers as Record<string, unknown> | undefined)?.[MCP_SERVER_NAME];
      return entry as Record<string, unknown> | undefined;
    }
    const document = JSON.parse(raw) as Record<string, unknown>;
    const servers = document[definition.jsonKey as string] as Record<string, unknown> | undefined;
    return servers?.[MCP_SERVER_NAME] as Record<string, unknown> | undefined;
  } catch {
    // An unreadable configuration is reported by the edit path, not here.
    return undefined;
  }
}

function tomlBody(binaryPath: string): readonly string[] {
  return [`command = ${JSON.stringify(binaryPath)}`, 'args = ["mcp"]'];
}

function matchesBinary(entry: Record<string, unknown> | undefined, binaryPath: string): boolean {
  if (entry === undefined) return false;
  const args = entry['args'];
  return (
    entry['command'] === binaryPath && Array.isArray(args) && args.length === 1 && args[0] === 'mcp'
  );
}

function createIntegration(definition: AgentDefinition): AgentIntegration {
  return {
    agent: definition.agent,
    name: definition.name,
    supportsSkills: definition.skillsDir !== undefined,
    ...(definition.skillsNote === undefined ? {} : { skillsNote: definition.skillsNote }),
    skillsDir: (env) => definition.skillsDir?.(env),
    configPath: (env) => definition.configPath(env),

    async detect(env) {
      const evidence: string[] = [];
      if (definition.cli !== undefined) {
        const found = await env.which(definition.cli.command);
        if (found !== undefined) evidence.push(`cli:${definition.cli.command}`);
      }
      for (const marker of definition.markers(env)) {
        if (await pathExists(marker)) evidence.push(`path:${marker}`);
      }
      const skills = definition.skillsDir?.(env);
      return {
        agent: definition.agent,
        name: definition.name,
        detected: evidence.length > 0,
        evidence,
        configPath: definition.configPath(env),
        supportsSkills: skills !== undefined,
        ...(skills === undefined ? {} : { skillsDir: skills }),
        ...(skills !== undefined || definition.skillsNote === undefined
          ? {}
          : { skillsNote: definition.skillsNote }),
      };
    },

    async register(env, binaryPath) {
      const path = definition.configPath(env);
      if (matchesBinary(await readEntry(definition, env), binaryPath)) {
        return {
          agent: definition.agent,
          method: 'file',
          configPath: path,
          serverName: MCP_SERVER_NAME,
          changed: false,
        };
      }

      const cli = await usableCli(definition, env);
      if (cli !== undefined && definition.cli !== undefined) {
        const result = await env.run(cli, definition.cli.add(binaryPath));
        if (result.ok && matchesBinary(await readEntry(definition, env), binaryPath)) {
          return {
            agent: definition.agent,
            method: 'cli',
            configPath: path,
            serverName: MCP_SERVER_NAME,
            changed: true,
          };
        }
        env.logger.warn('the agent CLI could not register the server; editing its config instead', {
          agent: definition.agent,
          exitCode: result.exitCode,
        });
      }

      const edit = await writeEntry(definition, env, binaryPath);
      return {
        agent: definition.agent,
        method: 'file',
        configPath: edit.path,
        serverName: MCP_SERVER_NAME,
        changed: edit.changed,
        ...(edit.backupPath === undefined ? {} : { backupPath: edit.backupPath }),
      };
    },

    async unregister(env) {
      const path = definition.configPath(env);
      if ((await readEntry(definition, env)) === undefined) {
        return {
          agent: definition.agent,
          removed: false,
          detail: `No Agentship entry was present in ${path}.`,
        };
      }

      const cli = await usableCli(definition, env);
      if (cli !== undefined && definition.cli !== undefined) {
        const result = await env.run(cli, definition.cli.remove());
        if (result.ok && (await readEntry(definition, env)) === undefined) {
          return {
            agent: definition.agent,
            removed: true,
            method: 'cli',
            detail: `Removed with ${definition.cli.command} from ${path}.`,
          };
        }
      }

      const edit = await removeEntry(definition, env);
      return {
        agent: definition.agent,
        removed: edit.changed,
        method: 'file',
        detail: edit.changed
          ? `Removed the Agentship entry from ${path}; everything else was left untouched.`
          : `Nothing to remove in ${path}.`,
      };
    },

    async check(env) {
      const entry = await readEntry(definition, env);
      if (entry === undefined) return { registered: false };
      const args = entry['args'];
      return {
        registered: true,
        ...(typeof entry['command'] === 'string' ? { command: entry['command'] } : {}),
        ...(Array.isArray(args) ? { args: args as readonly string[] } : {}),
      };
    },
  };
}

async function writeEntry(
  definition: AgentDefinition,
  env: IntegrationEnv,
  binaryPath: string,
): Promise<ConfigEdit> {
  const path = definition.configPath(env);
  if (definition.format === 'toml') {
    return editTomlConfig({
      path,
      table: definition.tomlTable as string,
      body: tomlBody(binaryPath),
      verify: (table) => matchesBinary(table as Record<string, unknown> | undefined, binaryPath),
    });
  }
  const key = definition.jsonKey as string;
  return editJsonConfig({
    path,
    ownedKeys: [key],
    mutate: (current) => {
      const servers = { ...((current[key] as Record<string, unknown> | undefined) ?? {}) };
      servers[MCP_SERVER_NAME] = definition.entry(binaryPath);
      return { ...current, [key]: servers };
    },
    verify: (written) => {
      const servers = written[key] as Record<string, unknown> | undefined;
      return matchesBinary(
        servers?.[MCP_SERVER_NAME] as Record<string, unknown> | undefined,
        binaryPath,
      );
    },
  });
}

async function removeEntry(definition: AgentDefinition, env: IntegrationEnv): Promise<ConfigEdit> {
  const path = definition.configPath(env);
  if (definition.format === 'toml') {
    return editTomlConfig({
      path,
      table: definition.tomlTable as string,
      verify: (table) => table === undefined,
    });
  }
  const key = definition.jsonKey as string;
  return editJsonConfig({
    path,
    ownedKeys: [key],
    mutate: (current) => {
      const servers = current[key] as Record<string, unknown> | undefined;
      if (servers?.[MCP_SERVER_NAME] === undefined) return undefined;
      const next = { ...servers };
      delete next[MCP_SERVER_NAME];
      return { ...current, [key]: next };
    },
    verify: (written) => {
      const servers = written[key] as Record<string, unknown> | undefined;
      return servers?.[MCP_SERVER_NAME] === undefined;
    },
  });
}

const INTEGRATIONS: readonly AgentIntegration[] = DEFINITIONS.map(createIntegration);

export function agentIntegrations(): readonly AgentIntegration[] {
  return INTEGRATIONS;
}

export function agentIntegration(agent: AgentId): AgentIntegration {
  const found = INTEGRATIONS.find((integration) => integration.agent === agent);
  if (found === undefined) throw new Error(`Unknown agent "${agent}".`);
  return found;
}

/** Detects every supported agent, in catalog order. */
export async function detectAgents(env: IntegrationEnv): Promise<readonly AgentDetection[]> {
  const detections: AgentDetection[] = [];
  for (const integration of INTEGRATIONS) detections.push(await integration.detect(env));
  return detections;
}
