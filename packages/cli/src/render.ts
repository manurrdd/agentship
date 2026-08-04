import type { DoctorReport, SetupReport, UninstallReport, UpdateResult } from '@agentship/setup';

/**
 * Text output of the lifecycle commands.
 *
 * The CLI exists for install, update, diagnose and remove — nothing about publishing. So
 * the output is plain lines a human can read in a terminal and paste into an issue: no
 * colours, no spinners, no boxes. Everything an agent consumes goes through MCP instead,
 * and `doctor --json` covers the one case where a script wants structure.
 */
const STATUS_MARK = { ok: '✓', warn: '!', fail: '✗' } as const;

export function write(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function renderSetup(report: SetupReport): void {
  if (report.dryRun) {
    write('agentship setup would:');
  } else {
    write(`agentship ${report.agentshipVersion} setup`);
  }
  write(`  binary:  ${report.binaryPath}`);
  write(`  home:    ${report.home}`);

  write();
  write('Agents detected:');
  for (const detection of report.detected) {
    const mark = detection.detected ? '•' : ' ';
    const evidence = detection.evidence.length > 0 ? ` (${detection.evidence.join(', ')})` : '';
    write(`  ${mark} ${detection.name}${detection.detected ? evidence : ' — not found'}`);
  }

  if (report.tools.length > 0) {
    write();
    write('Managed binaries:');
    for (const tool of report.tools) {
      write(`  ${tool.tool} ${tool.to} (${tool.action})`);
    }
  }

  write();
  write(report.dryRun ? 'Would install:' : 'Installed:');
  if (report.agents.length === 0) write('  (no agents selected)');
  for (const agent of report.agents) {
    write(`  ${agent.name}`);
    if (agent.mcp !== undefined) {
      write(
        `    MCP server "${agent.mcp.serverName}" in ${agent.mcp.configPath} via ${agent.mcp.method}${agent.mcp.changed ? '' : ' (already registered)'}`,
      );
      if (agent.mcp.backupPath !== undefined) write(`    backup: ${agent.mcp.backupPath}`);
    }
    for (const skill of agent.skills) write(`    skill ${skill.name} → ${skill.path}`);
    for (const error of agent.errors) write(`    ! ${error}`);
  }

  for (const warning of report.warnings) write(`! ${warning}`);
  if (report.doctor !== undefined) {
    write();
    renderDoctor(report.doctor, { onlyProblems: true });
  }
}

export function renderUpdate(result: UpdateResult): void {
  write(`agentship ${result.agentshipVersion} update`);
  for (const tool of result.tools) {
    write(
      `  ${tool.tool}: ${tool.action}${tool.from === undefined ? '' : ` ${tool.from} →`} ${tool.to}`,
    );
  }
  for (const agent of result.agents) {
    write(
      `  ${agent.name}: ${agent.skills.length} skill(s), MCP ${agent.mcp?.method ?? 'unchanged'}`,
    );
    for (const error of agent.errors) write(`    ! ${error}`);
  }
  write();
  renderDoctor(result.doctor, { onlyProblems: true });
}

export function renderDoctor(report: DoctorReport, options: { onlyProblems?: boolean } = {}): void {
  const checks = options.onlyProblems
    ? report.checks.filter((check) => check.status !== 'ok')
    : report.checks;
  write(`agentship doctor — ${report.ok ? 'no blocking problems' : 'problems found'}`);
  for (const check of checks) {
    write(`  ${STATUS_MARK[check.status]} ${check.title}: ${check.detail}`);
    if (check.remediation !== undefined) write(`      → ${check.remediation.summary}`);
  }
  if (checks.length === 0) write('  (everything checked is fine)');
}

export function renderUninstall(report: UninstallReport): void {
  if (report.dryRun) {
    write('agentship uninstall would remove:');
    for (const item of report.plan) {
      write(`  ${item.name}`);
      if (item.configPath !== undefined) write(`    MCP entry in ${item.configPath}`);
      for (const path of item.skillPaths) write(`    skill directory ${path}`);
    }
    write('  the managed binaries in ~/.agentship/tools');
    if (report.plan.length === 0) write('  (nothing is registered)');
    write();
    write('Repositories are never touched: .agentship/ inside a project stays as it is.');
    return;
  }

  write('agentship uninstall');
  for (const entry of report.unregistered) write(`  ${entry.agent}: ${entry.detail}`);
  for (const skill of report.skills) write(`  skill ${skill.name}: ${skill.detail}`);
  if (report.toolsRemoved) write('  managed binaries removed');
  for (const store of report.credentialsPurged) write(`  ${store} credentials purged`);
  for (const warning of report.warnings) write(`  ! ${warning}`);
}
