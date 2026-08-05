import { buildEnvironmentChecks } from '@agentship/build';
import { AGENTSHIP_VERSION, agentshipHome, type Remediation, STORES } from '@agentship/core';
import { credentialSource, keyringAvailable } from '@agentship/credentials';
import { currentPlatform, verifyInstall } from '@agentship/toolchain';
import { agentIntegration } from './agents.js';
import { defaultEnv, type IntegrationEnv } from './env.js';
import { readIntegrations } from './registry.js';
import { skillState } from './skills.js';

/**
 * `agentship doctor`: everything that can be wrong with an installation, in one pass.
 *
 * The audience is an agent relaying to a human, so every check answers two questions —
 * what is the state, and what does the user do about it. Checks never repair silently
 * (except the toolchain's own self-repair, which is what `verifyInstall` is for) and never
 * touch the network beyond what is already installed.
 */
export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly remediation?: Remediation;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly agentshipVersion: string;
  readonly home: string;
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorOptions {
  readonly env?: IntegrationEnv;
  /** Path the agents should be pointing at; when given, registrations are compared to it. */
  readonly binaryPath?: string;
}

const MIN_NODE_MAJOR = 20;

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? defaultEnv();
  const checks: DoctorCheck[] = [];

  checks.push(nodeCheck());
  checks.push(platformCheck());
  checks.push(...(await toolChecks()));
  checks.push(...(await buildChecks()));
  checks.push(await keyringCheck());
  checks.push(...(await credentialChecks()));
  checks.push(...(await integrationChecks(env, options.binaryPath)));

  return {
    ok: !checks.some((check) => check.status === 'fail'),
    agentshipVersion: AGENTSHIP_VERSION,
    home: agentshipHome(),
    checks,
  };
}

function nodeCheck(): DoctorCheck {
  const major = Number.parseInt(process.versions.node.split('.')[0] as string, 10);
  const ok = major >= MIN_NODE_MAJOR;
  return {
    id: 'node',
    title: 'Node.js version',
    status: ok ? 'ok' : 'fail',
    detail: `Node ${process.versions.node}`,
    ...(ok
      ? {}
      : {
          remediation: { summary: `Agentship needs Node ${MIN_NODE_MAJOR} or newer.` },
        }),
  };
}

function platformCheck(): DoctorCheck {
  try {
    const platform = currentPlatform();
    return {
      id: 'platform',
      title: 'Platform support',
      status: 'ok',
      detail: `${platform} is supported`,
    };
  } catch (error) {
    return {
      id: 'platform',
      title: 'Platform support',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
      remediation: { summary: 'Agentship supports macOS and Linux on x64 and arm64.' },
    };
  }
}

async function toolChecks(): Promise<readonly DoctorCheck[]> {
  let verifications: Awaited<ReturnType<typeof verifyInstall>>;
  try {
    verifications = await verifyInstall();
  } catch (error) {
    return [
      {
        id: 'tools',
        title: 'Managed toolchain',
        status: 'fail',
        detail: error instanceof Error ? error.message : String(error),
        remediation: { summary: 'Run agentship setup --yes to reinstall the managed binaries.' },
      },
    ];
  }
  return verifications.map((verification) => {
    const ok = verification.status === 'ok' || verification.status === 'repaired';
    return {
      id: `tool:${verification.tool}`,
      title: `Managed binary ${verification.tool}`,
      status: ok ? ('ok' as const) : ('fail' as const),
      detail: ok
        ? `${verification.status} at version ${verification.version ?? 'unknown'}`
        : `${verification.status}: ${verification.issues.join('; ') || 'not installed'}`,
      ...(ok
        ? {}
        : {
            remediation: {
              summary: 'Run agentship setup --yes (or agentship update) to install it.',
            },
          }),
    };
  });
}

/**
 * What this machine can build.
 *
 * These never fail the report. Xcode, a JDK and the Flutter SDK belong to the user, not to
 * Agentship, and a machine with none of them is perfectly healthy for someone whose artifacts
 * come from CI — so a missing build tool is a warning that says what it would enable, and
 * an .ipa outside macOS is stated as a fact with the way around it.
 */
async function buildChecks(): Promise<readonly DoctorCheck[]> {
  const checks = await buildEnvironmentChecks().catch(() => []);
  return checks.map((check) => ({
    id: check.id,
    title: check.title,
    status: check.status === 'ok' ? ('ok' as const) : ('warn' as const),
    detail: check.detail,
    ...(check.remediation === undefined ? {} : { remediation: { summary: check.remediation } }),
  }));
}

async function keyringCheck(): Promise<DoctorCheck> {
  const available = await keyringAvailable();
  return {
    id: 'keyring',
    title: 'OS keyring',
    status: available ? 'ok' : 'warn',
    detail: available
      ? 'the OS keyring is reachable'
      : 'the OS keyring is not available; credentials must come from environment variables',
    ...(available
      ? {}
      : {
          remediation: {
            summary:
              'Unlock the OS keyring, or export the credential environment variables (see agentship_setup_status).',
          },
        }),
  };
}

async function credentialChecks(): Promise<readonly DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const store of STORES) {
    const source = await credentialSource(store).catch(() => 'none' as const);
    checks.push({
      id: `credentials:${store}`,
      title: `${store === 'apple' ? 'App Store Connect' : 'Google Play'} credentials`,
      status: source === 'none' ? 'warn' : 'ok',
      detail: source === 'none' ? 'not configured' : `configured (source: ${source})`,
      ...(source === 'none'
        ? {
            remediation: {
              summary: `Ask the agent to run agentship_configure_auth for ${store}; it walks through the console steps.`,
            },
          }
        : {}),
    });
  }
  return checks;
}

async function integrationChecks(
  env: IntegrationEnv,
  binaryPath: string | undefined,
): Promise<readonly DoctorCheck[]> {
  const file = await readIntegrations();
  if (file.agents.length === 0) {
    return [
      {
        id: 'agents',
        title: 'Registered agents',
        status: 'warn',
        detail: 'no agent has the Agentship MCP server registered',
        remediation: {
          summary: 'Run agentship setup --yes to register the agents on this machine.',
        },
      },
    ];
  }

  const checks: DoctorCheck[] = [];
  for (const record of file.agents) {
    const integration = agentIntegration(record.agent);
    const expected = binaryPath ?? record.binaryPath;
    const check = await integration.check(env);
    if (!check.registered) {
      checks.push({
        id: `agent:${record.agent}`,
        title: `${integration.name} MCP registration`,
        status: 'fail',
        detail: `Agentship is recorded as installed but ${integration.configPath(env)} has no entry`,
        remediation: { summary: 'Run agentship setup --yes to register it again.' },
      });
    } else if (check.command !== expected) {
      checks.push({
        id: `agent:${record.agent}`,
        title: `${integration.name} MCP registration`,
        status: 'fail',
        detail: `registered command is ${check.command ?? 'unknown'}, expected ${expected}`,
        remediation: { summary: 'Run agentship update to point the agent at this installation.' },
      });
    } else {
      checks.push({
        id: `agent:${record.agent}`,
        title: `${integration.name} MCP registration`,
        status: 'ok',
        detail: `registered in ${integration.configPath(env)} (${record.mcp?.method ?? 'file'})`,
      });
    }

    // Agents without a skills directory have nothing to check — but silence would read as
    // "skills are fine", so an informative ok check says why they do not apply.
    if (!integration.supportsSkills) {
      checks.push({
        id: `skills:${record.agent}`,
        title: `Skills for ${integration.name}`,
        status: 'ok',
        detail:
          integration.skillsNote ??
          'this agent has no skills directory Agentship knows of; skills do not apply',
      });
    }

    for (const skill of record.skills) {
      const state = await skillState(skill);
      const stale = record.agentshipVersion !== AGENTSHIP_VERSION;
      checks.push({
        id: `skill:${record.agent}:${skill.name}`,
        title: `Skill ${skill.name} for ${integration.name}`,
        status: state === 'ok' ? (stale ? 'warn' : 'ok') : state === 'missing' ? 'fail' : 'warn',
        detail:
          state === 'missing'
            ? `not found at ${skill.path}`
            : state === 'modified'
              ? `edited after installation (${skill.path}); agentship update would overwrite it`
              : stale
                ? `installed by Agentship ${record.agentshipVersion}, this is ${AGENTSHIP_VERSION}`
                : `up to date at ${skill.path}`,
        ...(state === 'ok' && !stale
          ? {}
          : { remediation: { summary: 'Run agentship update to reinstall the bundled skills.' } }),
      });
    }
  }
  return checks;
}
