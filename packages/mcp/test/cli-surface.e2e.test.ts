import { execFile } from 'node:child_process';
import { ascCommands } from '@agentship/adapter-apple';
import { gpcCommands } from '@agentship/adapter-google';
import { createLogger } from '@agentship/core';
import { ensureTool } from '@agentship/toolchain';
import { describe, expect, it } from 'vitest';

/**
 * Does the command table still describe the binary Agentship actually ships?
 *
 * Every other adapter test replaces the tool runner with canned answers, which proves the
 * adapter parses what it is given but says nothing about whether `asc` and `gpc` accept the
 * argv it builds. A misspelled flag or a subcommand that moved is invisible offline and
 * fatal in production — and it is exactly what a version bump of a young, fast-moving CLI
 * produces. This test closes that gap the only way it can be closed: by asking the real
 * binary.
 *
 * Gated behind `AGENTSHIP_E2E_CLI=1` because it downloads the pinned tools (~250 MB) — but
 * it needs no store credentials and no account, so it is the cheapest real check there is
 * and belongs in the pre-release checklist for every tool bump.
 *
 * How the check works: for each entry of the table, build its argv with placeholder values,
 * split it into the subcommand path and the long flags, then run `<tool> <path> --help` and
 * assert the path resolves and every flag appears in the help. `asc` only routes `--help`
 * once its required flags are present, so the flags are passed through as well.
 */
const enabled = process.env['AGENTSHIP_E2E_CLI'] === '1';

const logger = createLogger({ level: 'silent', sinks: [] });

/** Splits a built argv into (subcommand path, long flags), ignoring values. */
function dissect(argv: readonly string[]): { path: string[]; flags: string[] } {
  const path: string[] = [];
  const flags: string[] = [];
  let seenFlag = false;
  for (const token of argv) {
    // A builder fed placeholder arguments can emit a non-string value where a real call
    // would carry an id; it is not part of the surface being audited.
    if (typeof token !== 'string') continue;
    if (token.startsWith('--')) {
      seenFlag = true;
      flags.push(token);
      continue;
    }
    if (!seenFlag) path.push(token);
  }
  return { path, flags };
}

/** Global switches asc/gpc accept everywhere; not worth asserting per subcommand. */
const GLOBAL_FLAGS = new Set([
  '--output',
  '--app',
  '--no-interactive',
  '--no-color',
  '--yes',
  '--pretty',
]);

/**
 * Runs `<binary> <argv> --help` and returns its combined output.
 *
 * Deliberately not the shared runner: that one raises on a non-zero exit, and "the tool
 * rejected this command line" is precisely the outcome under test.
 */
function helpFor(binary: string, argv: readonly string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      binary,
      [...argv, '--help'],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      (_error, stdout, stderr) => resolve(`${stdout}\n${stderr}`),
    );
  });
}

interface Divergence {
  readonly name: string;
  readonly problem: string;
}

async function auditTable(
  binary: string,
  table: Record<string, unknown>,
  toolName: string,
): Promise<Divergence[]> {
  const divergences: Divergence[] = [];
  for (const [name, value] of Object.entries(table)) {
    if (typeof value !== 'function') continue;
    const build = value as (...args: unknown[]) => string[];
    let argv: string[];
    try {
      // Placeholders: a string for positional ids, an empty object for option bags.
      argv = build(...Array.from({ length: build.length }, () => 'PLACEHOLDER'));
    } catch {
      try {
        argv = build(...Array.from({ length: build.length }, () => ({})));
      } catch {
        continue; // A builder needing a richer shape is covered by its own contract test.
      }
    }
    const { path, flags } = dissect(argv);
    if (path.length === 0) continue; // `--version` and friends.

    // The argv is passed through in the shape the builder produced it: `asc` only routes
    // `--help` once its required flags carry values, and re-synthesising them would put a
    // value after boolean switches like `--wait` and break the parser instead of the table.
    // A placeholder argument that stayed `undefined` is filled in rather than dropped, so a
    // value-taking flag never ends up bare and misreported as unknown.
    const help = await helpFor(
      binary,
      argv.map((token) => (typeof token === 'string' ? token : 'PLACEHOLDER')),
    );
    if (/unknown command|unknown subcommand/i.test(help)) {
      divergences.push({ name, problem: `${toolName} does not know "${path.join(' ')}"` });
      continue;
    }
    // Both tools name the offending flag when they reject one. That line is the most
    // direct evidence there is — and it has to be read before the help body, because it
    // *contains* the rejected flag and would otherwise make the search below succeed on the
    // very output that proves the flag wrong.
    const rejected = [...help.matchAll(/unknown (?:flag|option):?\s*'?(--[\w-]+)/gi)].map(
      (match) => match[1] as string,
    );
    if (rejected.length > 0) {
      divergences.push({
        name,
        problem: `${toolName} ${path.join(' ')} rejects ${[...new Set(rejected)].join(', ')}`,
      });
      continue;
    }
    const body = help.replace(/^.*unknown (?:flag|option).*$/gim, '');
    const missing = flags.filter((f) => !GLOBAL_FLAGS.has(f) && !body.includes(f));
    if (missing.length > 0) {
      divergences.push({
        name,
        problem: `${toolName} ${path.join(' ')} does not accept ${missing.join(', ')}`,
      });
    }
  }
  return divergences;
}

describe.skipIf(!enabled)('command tables match the pinned binaries', () => {
  it('asc accepts every subcommand and flag the Apple table builds', {
    timeout: 10 * 60_000,
  }, async () => {
    const binary = await ensureTool('asc', { logger });
    const divergences = await auditTable(binary, ascCommands, 'asc');
    expect(divergences.map((d) => `${d.name}: ${d.problem}`)).toEqual([]);
  });

  it('gpc accepts every subcommand and flag the Google table builds', {
    timeout: 10 * 60_000,
  }, async () => {
    const binary = await ensureTool('gpc', { logger });
    const divergences = await auditTable(binary, gpcCommands, 'gpc');
    expect(divergences.map((d) => `${d.name}: ${d.problem}`)).toEqual([]);
  });
});
