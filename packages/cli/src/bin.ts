import { AGENTSHIP_VERSION, AgentshipError } from '@agentship/core';
import { runStdioServer } from '@agentship/mcp';
import {
  AGENT_IDS,
  type AgentId,
  assertRequirements,
  runDoctor,
  runSetup,
  runUninstall,
  runUpdate,
} from '@agentship/setup';
import { Command } from 'commander';
import { binaryPath, skillsSourceDir } from './locations.js';
import { renderDoctor, renderSetup, renderUninstall, renderUpdate, write } from './render.js';

/**
 * `agentship` — the lifecycle CLI.
 *
 * Deliberately small: install, update, diagnose, remove, and run the MCP server. There is
 * no command to publish anything, because publishing is a conversation with an agent, and
 * a second interface would be a second thing to keep correct.
 *
 * Nothing here is interactive. A command with side effects run without `--yes` prints what
 * it would do and stops — an installer that waits for a keypress is unusable from inside
 * an agent, a CI job or a container.
 */
const program = new Command();

program
  .name('agentship')
  .description('Publish iOS and Android apps from an AI agent: MCP server, skills and toolchain.')
  .version(AGENTSHIP_VERSION, '-v, --version');

function parseAgents(raw: string | undefined): readonly AgentId[] | 'detected' | 'none' {
  if (raw === undefined) return 'detected';
  const value = raw.trim().toLowerCase();
  if (value === 'none') return 'none';
  if (value === 'detected' || value === 'all') return 'detected';
  const requested = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const unknown = requested.filter((entry) => !AGENT_IDS.includes(entry as AgentId));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown agent(s): ${unknown.join(', ')}. Known agents: ${AGENT_IDS.join(', ')}, or "none".`,
    );
  }
  return requested as AgentId[];
}

program
  .command('setup')
  .description('Install the managed binaries, register the MCP server and install the skills.')
  .option('--yes', 'perform the installation (without it, setup only reports what it would do)')
  .option(
    '--agents <list>',
    'comma-separated agents to install for, "none", or "detected" (default)',
  )
  .action(async (options: { yes?: boolean; agents?: string }) => {
    assertRequirements();
    const report = await runSetup({
      binaryPath: binaryPath(),
      skillsSourceDir: skillsSourceDir(),
      agents: parseAgents(options.agents),
      dryRun: options.yes !== true,
    });
    renderSetup(report);
    if (report.dryRun) {
      write();
      write('Nothing was changed. Run "agentship setup --yes" to perform it.');
      process.exitCode = 1;
      return;
    }
    const failed = report.agents.some((agent) => agent.errors.length > 0);
    if (failed || report.doctor?.ok === false) process.exitCode = 1;
  });

program
  .command('doctor')
  .description('Check the installation and report how to fix what is wrong.')
  .option('--json', 'print the report as JSON')
  .action(async (options: { json?: boolean }) => {
    const report = await runDoctor({ binaryPath: binaryPath() });
    if (options.json === true) write(JSON.stringify(report, null, 2));
    else renderDoctor(report);
    if (!report.ok) process.exitCode = 1;
  });

program
  .command('update')
  .description('Update the managed binaries and reinstall the skills of registered agents.')
  .option('--yes', 'perform the update')
  .action(async (options: { yes?: boolean }) => {
    if (options.yes !== true) {
      write('agentship update changes the installed binaries and the installed skills.');
      write('Run "agentship update --yes" to perform it.');
      process.exitCode = 1;
      return;
    }
    const result = await runUpdate({
      binaryPath: binaryPath(),
      skillsSourceDir: skillsSourceDir(),
    });
    renderUpdate(result);
    if (!result.doctor.ok) process.exitCode = 1;
  });

program
  .command('uninstall')
  .description('Remove the MCP registrations, the skills and the managed binaries.')
  .option('--yes', 'perform the removal')
  .option('--purge-credentials', 'also delete the stored store credentials')
  .action(async (options: { yes?: boolean; purgeCredentials?: boolean }) => {
    const report = await runUninstall({
      dryRun: options.yes !== true,
      ...(options.purgeCredentials === true ? { purgeCredentials: true } : {}),
    });
    renderUninstall(report);
    if (report.dryRun) {
      write();
      write('Nothing was removed. Run "agentship uninstall --yes" to perform it.');
      process.exitCode = 1;
    }
  });

program
  .command('mcp')
  .description('Run the Agentship MCP server on stdio (this is what agents launch).')
  .action(async () => {
    await runStdioServer();
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (AgentshipError.is(error)) {
      process.stderr.write(`agentship: ${error.message}\n`);
      if (error.remediation !== undefined) {
        process.stderr.write(`  → ${error.remediation.summary}\n`);
        for (const step of error.remediation.steps ?? []) process.stderr.write(`    - ${step}\n`);
      }
    } else {
      process.stderr.write(
        `agentship: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    process.exitCode = 1;
  }
}

await main();
