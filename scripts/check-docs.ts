/**
 * Checks the human-facing documentation against the product it describes.
 *
 * Documentation for this product is unusual: the real consumer is an agent, and what it
 * reads are the skills and the MCP tool descriptions, which are already tested. What is
 * left for humans is small — five pages — and it exists to be believed. So the few claims
 * it makes that *can* be checked mechanically are checked here: tool names, CLI commands,
 * links that resolve, and generated pages that are current.
 *
 * Run with: pnpm check:docs
 */
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTSHIP_TOOL_NAMES } from '../packages/mcp/src/index.js';
import { PLATFORM_LIMITS_PATH, platformLimitsMarkdown } from './generate-platform-limits.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The pages written for humans. Everything else is either generated or written for agents. */
export const DOCS = [
  'README.md',
  'PLATFORM-LIMITS.md',
  'SECURITY.md',
  'RELEASING.md',
  'e2e/REAL_TESTING.md',
  '.changeset/README.md',
];

export interface Problem {
  readonly file: string;
  readonly message: string;
}

/** The commands the binary actually registers, read from its own help output. */
function cliCommands(): string[] {
  const help = execFileSync(
    process.execPath,
    // Run the sources, like the rest of the suite: a stale `dist/` must never be what
    // decides whether the documentation is right.
    [
      '--import',
      'tsx',
      '--conditions',
      'agentship-source',
      join(REPO_ROOT, 'packages/cli/src/bin.ts'),
      '--help',
    ],
    { encoding: 'utf8', env: { ...process.env, AGENTSHIP_SKIP_TOOL_INSTALL: '1' } },
  );
  const commands = help
    .split('\n')
    .map((line) => /^\s{2}([a-z][a-z-]*)(?:\s|\||$)/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined && name !== 'help');
  if (commands.length === 0) throw new Error('could not read any command from "agentship --help"');
  return commands;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Every `agentship_x` mentioned must be a tool that exists. The skills are checked separately. */
export function checkToolNames(file: string, text: string): Problem[] {
  const mentioned = new Set(text.match(/agentship_[a-z_]+/g) ?? []);
  return [...mentioned]
    .filter((name) => !AGENTSHIP_TOOL_NAMES.includes(name))
    .map((name) => ({ file, message: `mentions ${name}, which is not an MCP tool` }));
}

/**
 * Every `agentship <command>` must be a command the CLI registers.
 *
 * Only invocations count: the binary at the start of a line or of a code span. `npm view
 * agentship version` is a different program being told about a package.
 */
export function checkCliCommands(
  file: string,
  text: string,
  commands: readonly string[],
): Problem[] {
  const problems: Problem[] = [];
  for (const match of text.matchAll(/(?:^|`)\s*agentship ([a-z][a-z-]*)/gm)) {
    const command = match[1] as string;
    if (!commands.includes(command)) {
      problems.push({
        file,
        message: `documents "agentship ${command}", which the CLI does not provide (it has: ${commands.join(', ')})`,
      });
    }
  }
  return problems;
}

/** Every relative link must resolve to something in the repository. */
export async function checkLinks(file: string, text: string): Promise<Problem[]> {
  const problems: Problem[] = [];
  const base = dirname(join(REPO_ROOT, file));
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1] as string;
    if (/^(https?:|mailto:)/.test(target)) continue;
    const [path, anchor] = target.split('#');
    if (path === undefined || path === '') {
      // A same-page anchor: it must match a heading in this file.
      if (anchor !== undefined && !headings(text).includes(anchor)) {
        problems.push({ file, message: `links to #${anchor}, which is not a heading here` });
      }
      continue;
    }
    const resolved = resolve(base, path);
    if (!(await exists(resolved))) {
      problems.push({ file, message: `links to ${target}, which does not exist` });
      continue;
    }
    if (anchor !== undefined && resolved.endsWith('.md')) {
      const linked = await readFile(resolved, 'utf8');
      if (!headings(linked).includes(anchor)) {
        problems.push({
          file,
          message: `links to ${target}, but ${relative(REPO_ROOT, resolved)} has no such heading`,
        });
      }
    }
  }
  return problems;
}

/** GitHub's anchor slugs, near enough for links we write ourselves. */
function headings(text: string): string[] {
  return [...text.matchAll(/^#{1,6} (.+)$/gm)].map((match) =>
    (match[1] as string)
      .toLowerCase()
      .replace(/[^\w\- ]/g, '')
      .trim()
      .replace(/ /g, '-'),
  );
}

export async function checkDocs(): Promise<Problem[]> {
  const problems: Problem[] = [];
  const commands = cliCommands();

  for (const file of DOCS) {
    const path = join(REPO_ROOT, file);
    if (!(await exists(path))) {
      problems.push({ file, message: 'is missing' });
      continue;
    }
    const text = await readFile(path, 'utf8');
    problems.push(...checkToolNames(file, text));
    problems.push(...checkCliCommands(file, text, commands));
    problems.push(...(await checkLinks(file, text)));
  }

  // The generated page must be what the code says today.
  const generated = await readFile(PLATFORM_LIMITS_PATH, 'utf8').catch(() => '');
  if (generated !== platformLimitsMarkdown()) {
    problems.push({
      file: 'PLATFORM-LIMITS.md',
      message: 'is stale; run pnpm generate:platform-limits',
    });
  }

  return problems;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const problems = await checkDocs();
  for (const problem of problems) console.error(`${problem.file}: ${problem.message}`);
  if (problems.length > 0) {
    console.error(`\n${problems.length} documentation problem(s).`);
    process.exitCode = 1;
  } else {
    console.log(`documentation checked: ${DOCS.length} files, no problems.`);
  }
}
