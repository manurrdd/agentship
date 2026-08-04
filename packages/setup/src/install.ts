import { rm } from 'node:fs/promises';
import {
  AGENTSHIP_VERSION,
  AgentshipError,
  agentshipHome,
  ERROR_CODES,
  ensureAgentshipHome,
} from '@agentship/core';
import { deleteCredentials } from '@agentship/credentials';
import { removeAll, type UpdateReport, updateTools } from '@agentship/toolchain';
import {
  type AgentDetection,
  type AgentId,
  agentIntegration,
  detectAgents,
  type McpRegistration,
  type UnregisterResult,
} from './agents.js';
import type { DoctorReport } from './doctor.js';
import { runDoctor } from './doctor.js';
import { defaultEnv, type IntegrationEnv } from './env.js';
import {
  type AgentRecord,
  forgetIntegration,
  readIntegrations,
  recordIntegration,
} from './registry.js';
import {
  type InstalledSkill,
  installSkill,
  readSkillSources,
  removeSkill,
  type SkillRemoval,
  type SkillSource,
} from './skills.js';

/**
 * `agentship setup`, `agentship update` and `agentship uninstall`.
 *
 * Three properties shape the implementation:
 *
 * - **Idempotent.** Every step checks the world before changing it, so running setup twice
 *   is indistinguishable from running it once, and a run interrupted halfway is repaired
 *   by running it again.
 * - **Isolated failures.** One agent with a configuration Agentship refuses to touch must
 *   not stop the others: its error is collected and reported with instructions.
 * - **Nothing implicit.** The report lists exactly what was done, which is also what
 *   `uninstall` reads back from `integrations.json` to undo it.
 */
export interface AgentSetupResult {
  readonly agent: AgentId;
  readonly name: string;
  readonly mcp?: McpRegistration;
  readonly skills: readonly InstalledSkill[];
  readonly errors: readonly string[];
}

export interface SetupReport {
  readonly dryRun: boolean;
  readonly agentshipVersion: string;
  readonly binaryPath: string;
  readonly home: string;
  readonly detected: readonly AgentDetection[];
  readonly selected: readonly AgentId[];
  readonly tools: readonly UpdateReport[];
  readonly agents: readonly AgentSetupResult[];
  readonly warnings: readonly string[];
  readonly doctor?: DoctorReport;
}

export interface SetupOptions {
  /** Absolute path of the `agentship` binary agents will be pointed at. */
  readonly binaryPath: string;
  /** Directory holding the bundled skills (one subdirectory per skill). */
  readonly skillsSourceDir: string;
  /**
   * Agents to install for: an explicit list, `'detected'` (every agent found on this
   * machine) or `'none'`.
   */
  readonly agents?: readonly AgentId[] | 'detected' | 'none';
  readonly env?: IntegrationEnv;
  /**
   * Downloads and verifies the managed binaries. On by default; turned off by
   * `AGENTSHIP_SKIP_TOOL_INSTALL=1` so the offline suite can exercise the installer.
   */
  readonly installTools?: boolean;
  /** Reports what would happen without changing anything (`setup` without `--yes`). */
  readonly dryRun?: boolean;
}

function skipToolInstall(): boolean {
  return process.env['AGENTSHIP_SKIP_TOOL_INSTALL'] === '1';
}

async function selectAgents(
  detected: readonly AgentDetection[],
  requested: SetupOptions['agents'],
): Promise<readonly AgentId[]> {
  if (requested === 'none') return [];
  if (requested === undefined || requested === 'detected') {
    return detected.filter((detection) => detection.detected).map((detection) => detection.agent);
  }
  return requested;
}

export async function runSetup(options: SetupOptions): Promise<SetupReport> {
  const env = options.env ?? defaultEnv();
  const dryRun = options.dryRun ?? false;
  const warnings: string[] = [];

  const detected = await detectAgents(env);
  const selected = await selectAgents(detected, options.agents);
  const sources = await readSkillSources(options.skillsSourceDir);

  if (dryRun) {
    return {
      dryRun,
      agentshipVersion: AGENTSHIP_VERSION,
      binaryPath: options.binaryPath,
      home: agentshipHome(),
      detected,
      selected,
      tools: [],
      agents: selected.map((agent) => {
        const integration = agentIntegration(agent);
        return {
          agent,
          name: integration.name,
          skills: integration.supportsSkills
            ? sources.map((source) => ({
                name: source.name,
                path: `${integration.skillsDir(env) as string}/${source.name}`,
                hash: source.hash,
              }))
            : [],
          errors: [],
        };
      }),
      warnings,
    };
  }

  await ensureAgentshipHome();

  const installTools = options.installTools ?? !skipToolInstall();
  let tools: UpdateReport[] = [];
  if (installTools) {
    tools = await updateTools({ logger: env.logger });
  } else {
    warnings.push('The managed binaries were not installed (AGENTSHIP_SKIP_TOOL_INSTALL=1).');
  }

  const agents: AgentSetupResult[] = [];
  for (const agent of selected) {
    agents.push(await setupAgent(agent, env, options.binaryPath, sources));
  }

  const doctor = await runDoctor({ env, binaryPath: options.binaryPath });
  return {
    dryRun,
    agentshipVersion: AGENTSHIP_VERSION,
    binaryPath: options.binaryPath,
    home: agentshipHome(),
    detected,
    selected,
    tools,
    agents,
    warnings,
    doctor,
  };
}

async function setupAgent(
  agent: AgentId,
  env: IntegrationEnv,
  binaryPath: string,
  sources: readonly SkillSource[],
): Promise<AgentSetupResult> {
  const integration = agentIntegration(agent);
  const errors: string[] = [];
  let mcp: McpRegistration | undefined;
  const skills: InstalledSkill[] = [];

  try {
    mcp = await integration.register(env, binaryPath);
  } catch (error) {
    errors.push(describe(error));
  }

  const skillsDir = integration.skillsDir(env);
  if (skillsDir !== undefined) {
    for (const source of sources) {
      try {
        skills.push(await installSkill(source, skillsDir));
      } catch (error) {
        errors.push(`skill ${source.name}: ${describe(error)}`);
      }
    }
  }

  if (mcp !== undefined || skills.length > 0) {
    const record: AgentRecord = {
      agent,
      binaryPath,
      agentshipVersion: AGENTSHIP_VERSION,
      installedAt: new Date().toISOString(),
      skills,
      ...(mcp === undefined
        ? {}
        : {
            mcp: {
              method: mcp.method,
              configPath: mcp.configPath,
              serverName: mcp.serverName,
            },
          }),
    };
    await recordIntegration(record);
  }

  return {
    agent,
    name: integration.name,
    ...(mcp === undefined ? {} : { mcp }),
    skills,
    errors,
  };
}

export interface UpdateResult {
  readonly agentshipVersion: string;
  readonly tools: readonly UpdateReport[];
  readonly agents: readonly AgentSetupResult[];
  readonly doctor: DoctorReport;
}

/**
 * Brings an existing installation up to this version: managed binaries first, then every
 * agent already recorded in `integrations.json` (re-registered and given the current
 * skills). Agents that were never set up are left alone — adding one is `setup`'s job.
 */
export async function runUpdate(options: SetupOptions): Promise<UpdateResult> {
  const env = options.env ?? defaultEnv();
  const installed = await readIntegrations();
  const sources = await readSkillSources(options.skillsSourceDir);
  const tools =
    (options.installTools ?? !skipToolInstall()) ? await updateTools({ logger: env.logger }) : [];

  const agents: AgentSetupResult[] = [];
  for (const record of installed.agents) {
    agents.push(await setupAgent(record.agent, env, options.binaryPath, sources));
  }
  return {
    agentshipVersion: AGENTSHIP_VERSION,
    tools,
    agents,
    doctor: await runDoctor({ env, binaryPath: options.binaryPath }),
  };
}

export interface UninstallPlanItem {
  readonly agent: AgentId;
  readonly name: string;
  readonly configPath?: string;
  readonly skillPaths: readonly string[];
}

export interface UninstallReport {
  readonly dryRun: boolean;
  readonly plan: readonly UninstallPlanItem[];
  readonly unregistered: readonly UnregisterResult[];
  readonly skills: readonly SkillRemoval[];
  readonly toolsRemoved: boolean;
  readonly credentialsPurged: readonly string[];
  readonly warnings: readonly string[];
}

export interface UninstallOptions {
  readonly env?: IntegrationEnv;
  readonly purgeCredentials?: boolean;
  /** Lists what would be removed without removing anything. */
  readonly dryRun?: boolean;
  /** Removes the managed binaries too. On by default. */
  readonly removeTools?: boolean;
}

/**
 * Undoes exactly what `integrations.json` says Agentship did — and nothing else.
 *
 * Repositories are never touched: `.agentship/` inside a project holds the manifest the user
 * wrote and the journal of what was published, and belongs to the project, not to the
 * installation.
 */
export async function runUninstall(options: UninstallOptions = {}): Promise<UninstallReport> {
  const env = options.env ?? defaultEnv();
  const dryRun = options.dryRun ?? false;
  const installed = await readIntegrations();
  const warnings: string[] = [];

  const plan: UninstallPlanItem[] = installed.agents.map((record) => {
    const integration = agentIntegration(record.agent);
    return {
      agent: record.agent,
      name: integration.name,
      ...(record.mcp === undefined ? {} : { configPath: record.mcp.configPath }),
      skillPaths: record.skills.map((skill) => skill.path),
    };
  });

  if (dryRun) {
    return {
      dryRun,
      plan,
      unregistered: [],
      skills: [],
      toolsRemoved: false,
      credentialsPurged: [],
      warnings,
    };
  }

  const unregistered: UnregisterResult[] = [];
  const skills: SkillRemoval[] = [];
  for (const record of installed.agents) {
    const integration = agentIntegration(record.agent);
    try {
      unregistered.push(await integration.unregister(env));
    } catch (error) {
      warnings.push(`${integration.name}: ${describe(error)}`);
    }
    for (const skill of record.skills) {
      try {
        skills.push(await removeSkill(skill));
      } catch (error) {
        warnings.push(`${integration.name} skill ${skill.name}: ${describe(error)}`);
      }
    }
    await forgetIntegration(record.agent);
  }

  const removeToolchain = options.removeTools ?? true;
  if (removeToolchain) await removeAll();

  const credentialsPurged: string[] = [];
  if (options.purgeCredentials === true) {
    for (const store of ['apple', 'google'] as const) {
      if (await deleteCredentials(store).catch(() => false)) credentialsPurged.push(store);
    }
  }

  // The run directory holds the neutral working directories of the managed binaries; the
  // logs and the user's config file are left in place unless credentials were purged.
  await rm(`${agentshipHome()}/run`, { recursive: true, force: true }).catch(() => undefined);

  return {
    dryRun,
    plan,
    unregistered,
    skills,
    toolsRemoved: removeToolchain,
    credentialsPurged,
    warnings,
  };
}

function describe(error: unknown): string {
  if (AgentshipError.is(error)) {
    const remediation = error.remediation?.summary;
    return remediation === undefined ? error.message : `${error.message} ${remediation}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Throws when the platform or Node version cannot run Agentship at all. */
export function assertRequirements(): void {
  const major = Number.parseInt(process.versions.node.split('.')[0] as string, 10);
  if (major < 20) {
    throw new AgentshipError(
      ERROR_CODES.TOOL_PLATFORM_UNSUPPORTED,
      `Agentship needs Node 20 or newer; this is Node ${process.versions.node}.`,
      { remediation: { summary: 'Install Node 20+ and run the command again.' } },
    );
  }
}
