import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Puts every home of the version back in step with the one that is published.
 *
 * `agentship` is the only package on the registry, so its version is the one that means
 * something; the other two homes have to follow it. `AGENTSHIP_VERSION` is stamped into every
 * journal, snapshot and plan, and the workspace packages are bundled into the same tarball —
 * a release where they disagree produces state files that lie about which Agentship wrote
 * them, which is why `packages/cli/test/release.test.ts` fails on any drift.
 *
 * This has to be a step of `changeset:version` rather than something a human remembers.
 * `changeset version` bumps the published package and nothing else: private packages are not
 * versioned, and no changeset can reach a TypeScript constant. Doing either by hand is worse
 * than it looks — bump when writing the changeset and `main` is red until the version pull
 * request lands; leave it and that pull request is red instead, and it is the one a release
 * has to merge. Running here closes the window: one commit bumps all of them.
 *
 * Internal dependencies are declared `workspace:*`, so these numbers are bookkeeping and
 * moving them cannot change what resolves against what.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = join(REPO_ROOT, 'packages');
const PUBLISHED = join(PACKAGES, 'cli/package.json');
const VERSION_FILE = join(PACKAGES, 'core/src/kernel/version.ts');
const DECLARATION = /^(export const AGENTSHIP_VERSION = ')(.+)(';)$/m;

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

const version = (await readJson(PUBLISHED))['version'];
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
  throw new Error(`packages/cli/package.json has no usable version (${String(version)}).`);
}

const changed: string[] = [];

for (const entry of (await readdir(PACKAGES, { withFileTypes: true }))
  .filter((candidate) => candidate.isDirectory())
  .map((candidate) => candidate.name)
  .sort()) {
  const path = join(PACKAGES, entry, 'package.json');
  const manifest = await readJson(path).catch(() => undefined);
  if (manifest === undefined || manifest['version'] === version) continue;
  // Rewritten as text rather than re-serialised, so nothing else in the file moves.
  const source = await readFile(path, 'utf8');
  const updated = source.replace(/^(\s*"version":\s*")[^"]+(",)$/m, `$1${version}$2`);
  if (updated === source) throw new Error(`${path} has no "version" line to rewrite.`);
  await writeFile(path, updated);
  changed.push(`${manifest['name'] as string} -> ${version}`);
}

const source = await readFile(VERSION_FILE, 'utf8');
const declaration = DECLARATION.exec(source);
if (declaration === null) {
  throw new Error(
    `${VERSION_FILE} no longer declares AGENTSHIP_VERSION in the shape this script rewrites.`,
  );
}
if (declaration[2] !== version) {
  await writeFile(VERSION_FILE, source.replace(DECLARATION, `$1${version}$3`));
  changed.push(`AGENTSHIP_VERSION ${declaration[2]} -> ${version}`);
}

console.log(changed.length === 0 ? `Everything is already ${version}.` : changed.join('\n'));
