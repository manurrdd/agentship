import { createHash } from 'node:crypto';
import { cp, readdir, readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { AgentshipError, assertInside, ERROR_CODES, ensureDir, pathExists } from '@agentship/core';

/**
 * Agent Skills: the documentation Agentship ships *to the agent*.
 *
 * A skill is a directory with a `SKILL.md` (YAML frontmatter `name` + `description`, then
 * the body) plus optional `references/`. Installing one is a plain directory copy into the
 * agent's skills directory; what makes it manageable is the content hash Agentship records
 * for it. The hash is what lets `update` know a skill is stale, `doctor` know it was
 * edited by hand, and `uninstall` know it is safe to delete — Agentship never removes a
 * directory whose content it did not put there.
 */
export interface SkillFile {
  /** Path relative to the skill directory. */
  readonly path: string;
  readonly bytes: number;
}

export interface SkillSource {
  readonly name: string;
  readonly dir: string;
  readonly description: string;
  readonly files: readonly SkillFile[];
  /** Content hash of every file in the skill. */
  readonly hash: string;
}

export interface InstalledSkill {
  readonly name: string;
  readonly path: string;
  readonly hash: string;
}

export type SkillState = 'ok' | 'modified' | 'missing';

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listFiles(join(dir, entry.name), rel)));
    else if (entry.isFile()) files.push(rel);
  }
  return files.sort();
}

/** Content hash of a skill directory: every file's path and bytes, in a stable order. */
export async function hashSkillDir(dir: string): Promise<string> {
  const hash = createHash('sha256');
  for (const file of await listFiles(dir)) {
    hash.update(file);
    hash.update('\0');
    hash.update(await readFile(join(dir, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Frontmatter of a `SKILL.md`, as the Agent Skills standard defines it. */
export interface SkillFrontmatter {
  readonly name?: string;
  readonly description?: string;
  readonly extra: readonly string[];
}

/**
 * Reads the frontmatter of a `SKILL.md`.
 *
 * Deliberately minimal: the standard's frontmatter is a flat block of `key: value` lines,
 * and parsing it with a full YAML engine would accept documents the standard does not.
 */
export function parseSkillFrontmatter(text: string): SkillFrontmatter | undefined {
  if (!text.startsWith('---\n')) return undefined;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return undefined;
  const block = text.slice(4, end + 1);
  let name: string | undefined;
  let description: string | undefined;
  const extra: string[] = [];
  for (const line of block.split('\n')) {
    if (line.trim() === '') continue;
    const separator = line.indexOf(':');
    if (separator === -1) return undefined;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === 'name') name = value;
    else if (key === 'description') description = value;
    else extra.push(key);
  }
  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    extra,
  };
}

/** Body of a `SKILL.md`, without its frontmatter block. */
export function skillBody(text: string): string {
  if (!text.startsWith('---\n')) return text;
  const end = text.indexOf('\n---', 3);
  return end === -1 ? text : text.slice(end + 4);
}

/** Reads every skill directory under `sourceDir`. */
export async function readSkillSources(sourceDir: string): Promise<readonly SkillSource[]> {
  let entries: string[];
  try {
    entries = (await readdir(sourceDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (cause) {
    throw AgentshipError.from(
      ERROR_CODES.CONFIG_NOT_FOUND,
      `Could not read the bundled skills at ${sourceDir}.`,
      cause,
      { remediation: { summary: 'Reinstall Agentship; the package looks incomplete.' } },
    );
  }

  const sources: SkillSource[] = [];
  for (const name of entries) {
    const dir = join(sourceDir, name);
    const skillPath = join(dir, 'SKILL.md');
    if (!(await pathExists(skillPath))) continue;
    const text = await readFile(skillPath, 'utf8');
    const frontmatter = parseSkillFrontmatter(text);
    const files = await listFiles(dir);
    const withSizes: SkillFile[] = [];
    for (const file of files) {
      withSizes.push({ path: file, bytes: (await readFile(join(dir, file))).byteLength });
    }
    sources.push({
      name: frontmatter?.name ?? name,
      dir,
      description: frontmatter?.description ?? '',
      files: withSizes,
      hash: await hashSkillDir(dir),
    });
  }
  return sources;
}

/** Copies a skill into an agent's skills directory, replacing any previous copy. */
export async function installSkill(
  source: SkillSource,
  skillsDir: string,
): Promise<InstalledSkill> {
  await ensureDir(skillsDir);
  const target = join(skillsDir, source.name);
  await assertInside(skillsDir, target);
  await rm(target, { recursive: true, force: true });
  await cp(source.dir, target, { recursive: true });
  return { name: source.name, path: target, hash: await hashSkillDir(target) };
}

/** Compares an installed skill against the hash recorded when Agentship installed it. */
export async function skillState(installed: InstalledSkill): Promise<SkillState> {
  if (!(await pathExists(installed.path))) return 'missing';
  return (await hashSkillDir(installed.path)) === installed.hash ? 'ok' : 'modified';
}

export interface SkillRemoval {
  readonly name: string;
  readonly path: string;
  readonly removed: boolean;
  readonly detail: string;
}

/**
 * Removes a skill Agentship installed — unless it was edited afterwards, in which case the
 * directory is left alone and reported: an uninstall must not throw away someone's work.
 */
export async function removeSkill(installed: InstalledSkill): Promise<SkillRemoval> {
  const state = await skillState(installed);
  if (state === 'missing') {
    return { name: installed.name, path: installed.path, removed: false, detail: 'already absent' };
  }
  if (state === 'modified') {
    return {
      name: installed.name,
      path: installed.path,
      removed: false,
      detail: 'edited after installation; left in place',
    };
  }
  await rm(installed.path, { recursive: true, force: true });
  return { name: installed.name, path: installed.path, removed: true, detail: 'removed' };
}

export interface SkillValidation {
  readonly name: string;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/** Frontmatter keys the Agent Skills standard defines for `SKILL.md`. */
const ALLOWED_FRONTMATTER = new Set(['name', 'description', 'license', 'allowed-tools']);
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
/** Rough ceiling for the body, in characters (~3000 tokens at 4 characters per token). */
const MAX_BODY_CHARS = 12_000;

/** Validates a skill directory against the Agent Skills standard. */
export async function validateSkill(source: SkillSource): Promise<SkillValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const text = await readFile(join(source.dir, 'SKILL.md'), 'utf8');
  const frontmatter = parseSkillFrontmatter(text);

  if (frontmatter === undefined) {
    errors.push('SKILL.md does not start with a YAML frontmatter block.');
    return { name: source.name, errors, warnings };
  }
  const name = frontmatter.name;
  if (name === undefined || name === '') errors.push('frontmatter is missing "name".');
  else {
    if (!NAME_PATTERN.test(name)) errors.push(`name "${name}" is not lowercase-kebab-case.`);
    if (name.length > MAX_NAME_LENGTH) errors.push(`name is longer than ${MAX_NAME_LENGTH}.`);
    if (name !== basename(source.dir)) {
      errors.push(`name "${name}" does not match the directory name.`);
    }
  }
  const description = frontmatter.description;
  if (description === undefined || description === '') {
    errors.push('frontmatter is missing "description".');
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`description is longer than ${MAX_DESCRIPTION_LENGTH} characters.`);
  }
  for (const key of frontmatter.extra) {
    if (!ALLOWED_FRONTMATTER.has(key)) errors.push(`frontmatter key "${key}" is not standard.`);
  }
  const body = skillBody(text);
  if (body.length > MAX_BODY_CHARS) {
    errors.push(`SKILL.md body is ${body.length} characters, over the ${MAX_BODY_CHARS} budget.`);
  }
  if (body.trim() === '') errors.push('SKILL.md has no body.');
  return { name: source.name, errors, warnings };
}
