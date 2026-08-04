import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  AgentshipError,
  agentshipHome,
  ERROR_CODES,
  ensureAgentshipHome,
  FILE_MODE,
} from '@agentship/core';
import { z } from 'zod';
import { AGENT_IDS, type AgentId } from './agents.js';

/**
 * `~/.agentship/integrations.json`: the record of what Agentship installed where.
 *
 * Without it, uninstalling would mean guessing — deleting whatever looks like ours in
 * files we do not own. With it, every removal is precise: this agent, this configuration
 * file, these skill directories with these content hashes. It also gives `update` and
 * `doctor` the two facts they need: which Agentship version installed each integration, and
 * whether its files still hash to what Agentship wrote.
 */
export const INTEGRATIONS_VERSION = 1;

const InstalledSkillSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  hash: z.string().min(1),
});

const McpRecordSchema = z.object({
  method: z.enum(['cli', 'file']),
  configPath: z.string().min(1),
  serverName: z.string().min(1),
});

const AgentRecordSchema = z.object({
  agent: z.enum(AGENT_IDS as [AgentId, ...AgentId[]]),
  /** Absolute path of the `agentship` binary the agent was pointed at. */
  binaryPath: z.string().min(1),
  agentshipVersion: z.string().min(1),
  installedAt: z.iso.datetime(),
  mcp: McpRecordSchema.optional(),
  skills: z.array(InstalledSkillSchema).default([]),
});

export const IntegrationsFileSchema = z.object({
  schemaVersion: z.literal(INTEGRATIONS_VERSION).default(INTEGRATIONS_VERSION),
  agents: z.array(AgentRecordSchema).default([]),
});

export type AgentRecord = z.infer<typeof AgentRecordSchema>;
export type IntegrationsFile = z.infer<typeof IntegrationsFileSchema>;

export function integrationsPath(): string {
  return join(agentshipHome(), 'integrations.json');
}

export async function readIntegrations(): Promise<IntegrationsFile> {
  const path = integrationsPath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return IntegrationsFileSchema.parse({});
    }
    throw AgentshipError.from(ERROR_CODES.CONFIG_INVALID, `Could not read ${path}.`, cause);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw AgentshipError.from(ERROR_CODES.CONFIG_INVALID, `${path} is not valid JSON.`, cause, {
      remediation: {
        summary: `Delete ${path} and run agentship setup again; agent configurations are left as they are.`,
      },
    });
  }
  const result = IntegrationsFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new AgentshipError(ERROR_CODES.CONFIG_INVALID, `${path} failed validation.`, {
      details: { issues: z.treeifyError(result.error) },
      remediation: { summary: `Delete ${path} and run agentship setup again.` },
    });
  }
  return result.data;
}

export async function writeIntegrations(file: IntegrationsFile): Promise<void> {
  await ensureAgentshipHome();
  const path = integrationsPath();
  const validated = IntegrationsFileSchema.parse(file);
  const tmp = join(dirname(path), `.integrations.${process.pid}.tmp`);
  await writeFile(tmp, `${JSON.stringify(validated, null, 2)}\n`, { mode: FILE_MODE });
  await rename(tmp, path);
}

/** Inserts or replaces the record of one agent. */
export async function recordIntegration(record: AgentRecord): Promise<IntegrationsFile> {
  const current = await readIntegrations();
  const agents = current.agents.filter((entry) => entry.agent !== record.agent);
  agents.push(record);
  agents.sort((a, b) => a.agent.localeCompare(b.agent));
  const next: IntegrationsFile = { ...current, agents };
  await writeIntegrations(next);
  return next;
}

/** Drops the record of one agent (after it has actually been unregistered). */
export async function forgetIntegration(agent: AgentId): Promise<IntegrationsFile> {
  const current = await readIntegrations();
  const next: IntegrationsFile = {
    ...current,
    agents: current.agents.filter((entry) => entry.agent !== agent),
  };
  await writeIntegrations(next);
  return next;
}
