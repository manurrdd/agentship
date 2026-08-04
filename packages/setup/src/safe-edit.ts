import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AgentshipError, DIR_MODE, ERROR_CODES } from '@agentship/core';
import { parse as parseToml } from 'smol-toml';

/**
 * Editing configuration files Agentship does not own.
 *
 * Every agent's MCP configuration belongs to the user: it may contain other servers,
 * unrelated settings and (in TOML) comments. So the rules here are conservative by
 * construction:
 *
 * 1. **Never write over something we could not read.** A file that does not parse is left
 *    exactly as it is and reported with manual instructions — a corrupt file is far more
 *    likely to be a file we misunderstood than one worth overwriting.
 * 2. **Back up before the first byte changes**, next to the original.
 * 3. **Touch only our own key.** JSON edits go through a clone-and-merge; TOML edits are
 *    line-surgical so that comments and formatting elsewhere survive verbatim.
 * 4. **Verify after writing.** The file is re-read and re-parsed: our entry must be there
 *    (or gone, for a removal) and everything else must be byte-for-byte what it was. If
 *    not, the backup is restored and the operation fails loudly.
 */
export const BACKUP_SUFFIX = '.agentship-backup';

export type ConfigFormat = 'json' | 'toml';

export interface ConfigEdit {
  readonly path: string;
  readonly created: boolean;
  readonly changed: boolean;
  readonly backupPath?: string;
}

function unreadable(path: string, format: ConfigFormat, cause: unknown): AgentshipError {
  const jsonc =
    format === 'json' ? ' If it uses comments (JSONC), Agentship cannot edit it safely.' : '';
  return AgentshipError.from(
    ERROR_CODES.CONFIG_INVALID,
    `${path} is not valid ${format.toUpperCase()}; Agentship will not modify it.${jsonc}`,
    cause,
    {
      details: { path, format },
      remediation: {
        summary: `Fix ${path} by hand (or add the Agentship entry manually), then run agentship doctor.`,
      },
    },
  );
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw AgentshipError.from(ERROR_CODES.CONFIG_INVALID, `Could not read ${path}.`, cause);
  }
}

async function backup(path: string): Promise<string> {
  const backupPath = `${path}${BACKUP_SUFFIX}`;
  await copyFile(path, backupPath);
  return backupPath;
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  const existing = await stat(path).catch(() => undefined);
  const tmp = join(dir, `.agentship-${process.pid}.tmp`);
  await writeFile(tmp, text, existing === undefined ? { mode: 0o600 } : { mode: existing.mode });
  await rename(tmp, path);
}

/** Deep structural equality for parsed configuration values. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface JsonEditInput {
  readonly path: string;
  /** Returns the next document, or `undefined` when nothing has to change. */
  readonly mutate: (current: Record<string, unknown>) => Record<string, unknown> | undefined;
  /** Re-read check: must hold on the freshly written file. */
  readonly verify: (written: Record<string, unknown>) => boolean;
  /** Keys of the document this edit is allowed to touch. */
  readonly ownedKeys: readonly string[];
}

/**
 * Reads, merges and writes a JSON configuration file.
 *
 * A missing file is created; an unparseable one is refused. Keys outside `ownedKeys` are
 * compared before and after the write and must be identical.
 */
export async function editJsonConfig(input: JsonEditInput): Promise<ConfigEdit> {
  const raw = await readIfExists(input.path);
  const created = raw === undefined;

  let current: Record<string, unknown>;
  if (raw === undefined || raw.trim() === '') {
    current = {};
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw unreadable(input.path, 'json', cause);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw unreadable(input.path, 'json', new Error('the document is not a JSON object'));
    }
    current = parsed as Record<string, unknown>;
  }

  const next = input.mutate(structuredClone(current));
  if (next === undefined) return { path: input.path, created: false, changed: false };

  const untouchedBefore = otherKeys(current, input.ownedKeys);
  const backupPath = created ? undefined : await backup(input.path);
  await writeAtomic(input.path, `${JSON.stringify(next, null, 2)}\n`);

  const verification = await readFile(input.path, 'utf8');
  let written: Record<string, unknown>;
  try {
    written = JSON.parse(verification) as Record<string, unknown>;
  } catch (cause) {
    await restore(input.path, backupPath);
    throw unreadable(input.path, 'json', cause);
  }
  if (!input.verify(written) || !sameValue(untouchedBefore, otherKeys(written, input.ownedKeys))) {
    await restore(input.path, backupPath);
    throw new AgentshipError(
      ERROR_CODES.CONFIG_INVALID,
      `The Agentship entry could not be verified after writing ${input.path}; the file was restored.`,
      { details: { path: input.path } },
    );
  }
  return {
    path: input.path,
    created,
    changed: true,
    ...(backupPath === undefined ? {} : { backupPath }),
  };
}

function otherKeys(
  document: Record<string, unknown>,
  owned: readonly string[],
): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (!owned.includes(key)) rest[key] = value;
  }
  return rest;
}

/** Locates `[table]` in a TOML text, returning the line range it spans. */
function tableRange(
  lines: readonly string[],
  table: string,
): { start: number; end: number } | null {
  const headers = [`[${table}]`, `[${quoteLast(table)}]`];
  const start = lines.findIndex((line) => headers.includes(line.trim()));
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if ((lines[index] as string).trimStart().startsWith('[')) {
      end = index;
      break;
    }
  }
  return { start, end };
}

/** `mcp_servers.agentship` → `mcp_servers."agentship"`, the other spelling TOML allows. */
function quoteLast(table: string): string {
  const cut = table.lastIndexOf('.');
  return cut === -1 ? `"${table}"` : `${table.slice(0, cut)}."${table.slice(cut + 1)}"`;
}

export interface TomlEditInput {
  readonly path: string;
  /** Dotted table name, e.g. `mcp_servers.agentship`. */
  readonly table: string;
  /** Body lines of the table, or `undefined` to remove it. */
  readonly body?: readonly string[];
  /** Re-read check on the table's parsed value (`undefined` after a removal). */
  readonly verify: (table: unknown) => boolean;
}

/**
 * Adds, replaces or removes exactly one TOML table, line by line.
 *
 * Serialising a parsed document back to TOML would silently drop the user's comments and
 * formatting, so the file is edited as text and only *parsed* to prove the result is
 * valid and that nothing outside our table moved.
 */
export async function editTomlConfig(input: TomlEditInput): Promise<ConfigEdit> {
  const raw = await readIfExists(input.path);
  const created = raw === undefined;
  const text = raw ?? '';

  let before: Record<string, unknown>;
  try {
    before = (text.trim() === '' ? {} : parseToml(text)) as Record<string, unknown>;
  } catch (cause) {
    throw unreadable(input.path, 'toml', cause);
  }

  const lines = text === '' ? [] : text.split('\n');
  const range = tableRange(lines, input.table);
  let nextLines: string[];

  if (input.body === undefined) {
    if (range === null) return { path: input.path, created: false, changed: false };
    nextLines = [...lines.slice(0, range.start), ...lines.slice(range.end)];
  } else {
    const block = [`[${input.table}]`, ...input.body];
    if (range === null) {
      const prefix = lines.length === 0 ? [] : [...lines];
      while (prefix.length > 0 && (prefix[prefix.length - 1] as string).trim() === '') prefix.pop();
      nextLines = [...prefix, ...(prefix.length > 0 ? [''] : []), ...block, ''];
    } else {
      if (sameValue(lines.slice(range.start, range.end).join('\n').trimEnd(), block.join('\n'))) {
        return { path: input.path, created: false, changed: false };
      }
      nextLines = [...lines.slice(0, range.start), ...block, '', ...lines.slice(range.end)];
    }
  }

  const nextText = `${nextLines.join('\n').replace(/\n+$/, '')}\n`;
  const backupPath = created ? undefined : await backup(input.path);
  await writeAtomic(input.path, nextText);

  let after: Record<string, unknown>;
  try {
    after = parseToml(await readFile(input.path, 'utf8')) as Record<string, unknown>;
  } catch (cause) {
    await restore(input.path, backupPath);
    throw unreadable(input.path, 'toml', cause);
  }
  if (!input.verify(tableValue(after, input.table))) {
    await restore(input.path, backupPath);
    throw new AgentshipError(
      ERROR_CODES.CONFIG_INVALID,
      `The Agentship entry could not be verified after writing ${input.path}; the file was restored.`,
      { details: { path: input.path, table: input.table } },
    );
  }
  if (!sameValue(withoutTable(before, input.table), withoutTable(after, input.table))) {
    await restore(input.path, backupPath);
    throw new AgentshipError(
      ERROR_CODES.CONFIG_INVALID,
      `Editing ${input.path} would have changed entries other than "${input.table}"; the file was restored.`,
      { details: { path: input.path, table: input.table } },
    );
  }
  return {
    path: input.path,
    created,
    changed: true,
    ...(backupPath === undefined ? {} : { backupPath }),
  };
}

function tableValue(document: Record<string, unknown>, table: string): unknown {
  let node: unknown = document;
  for (const segment of table.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/**
 * The document without our table — and without the parent tables that only existed to
 * hold it, so that "the file had no `[mcp_servers]` section at all" and "it had one with
 * our entry in it" compare equal.
 */
function withoutTable(document: Record<string, unknown>, table: string): Record<string, unknown> {
  const clone = structuredClone(document);
  const segments = table.split('.');
  const last = segments.pop() as string;
  const chain: Record<string, unknown>[] = [clone];
  for (const segment of segments) {
    const child: unknown = chain[chain.length - 1]?.[segment];
    if (child === null || typeof child !== 'object') return clone;
    chain.push(child as Record<string, unknown>);
  }
  delete (chain[chain.length - 1] as Record<string, unknown>)[last];
  for (let index = chain.length - 1; index > 0; index -= 1) {
    const node = chain[index] as Record<string, unknown>;
    if (Object.keys(node).length > 0) break;
    delete (chain[index - 1] as Record<string, unknown>)[segments[index - 1] as string];
  }
  return clone;
}

async function restore(path: string, backupPath: string | undefined): Promise<void> {
  if (backupPath === undefined) return;
  await copyFile(backupPath, path).catch(() => undefined);
}
