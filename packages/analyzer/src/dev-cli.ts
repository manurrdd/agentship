#!/usr/bin/env tsx
/**
 * Internal development CLI: `pnpm analyze <dir> [--summary]`.
 *
 * Not part of the product — Agentship's only user-facing interface is the MCP server. This
 * exists so the team can point the analyzer at a fixture or a real repository and read what
 * it concluded, which is how extraction coverage gets debugged.
 */
import { AgentshipError, type AppAnalysis, ERROR_CODES } from '@agentship/core';
import { analyzeApp } from './analyze.js';

function summarise(analysis: AppAnalysis): string {
  const lines: string[] = [];
  const show = (
    label: string,
    value: { value: unknown; confidence: string; source?: string } | undefined,
  ): void => {
    lines.push(
      value === undefined
        ? `  ${label.padEnd(18)} —`
        : `  ${label.padEnd(18)} ${String(value.value)}  [${value.confidence}${value.source === undefined ? '' : ` from ${value.source}`}]`,
    );
  };

  lines.push(`${analysis.root}`);
  lines.push(
    `  framework          ${analysis.framework.framework}${analysis.framework.expoWorkflow === undefined ? '' : ` (${analysis.framework.expoWorkflow})`} [${analysis.framework.confidence}]`,
  );
  lines.push(`  platforms          ${analysis.platforms.join(', ') || '—'}`);
  show('bundleId', analysis.identity.bundleId);
  show('packageName', analysis.identity.packageName);
  show('displayName', analysis.identity.displayName);
  show('marketingVersion', analysis.versions.marketingVersion);
  show('buildNumber', analysis.versions.buildNumber);
  show('versionName', analysis.versions.versionName);
  show('versionCode', analysis.versions.versionCode);
  lines.push(`  sdks               ${analysis.sdks.map((s) => s.id).join(', ') || '—'}`);
  lines.push(
    `  permissions        ios: ${analysis.permissions.ios.length}, android: ${analysis.permissions.android.length}`,
  );
  lines.push(
    `  privacy signals    ${analysis.privacySignals.map((s) => s.dataType).join(', ') || '—'}`,
  );
  lines.push(
    `  assets             ${analysis.assets.appIcons.length} icon(s), ${analysis.assets.screenshots.length} screenshot(s)`,
  );
  lines.push(
    `  scan               ${analysis.stats.filesScanned} files in ${analysis.stats.durationMs} ms${analysis.stats.truncated ? ' (truncated)' : ''}`,
  );
  if (analysis.warnings.length > 0) {
    lines.push('  warnings');
    for (const warning of analysis.warnings) {
      lines.push(`    [${warning.severity}] ${warning.code}: ${warning.message}`);
    }
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const target = args.find((arg) => !arg.startsWith('--'));
  if (target === undefined) {
    console.error('usage: pnpm analyze <directory> [--summary]');
    process.exitCode = 2;
    return;
  }

  const analysis = await analyzeApp(target);
  console.log(args.includes('--summary') ? summarise(analysis) : JSON.stringify(analysis, null, 2));

  if (analysis.framework.framework === 'unknown') {
    console.error(
      new AgentshipError(
        ERROR_CODES.ANALYZE_FRAMEWORK_UNKNOWN,
        `No supported mobile app was found in ${target}.`,
      ).message,
    );
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
