import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Puts `AGENTSHIP_VERSION` back in step with the version the packages carry.
 *
 * The constant is stamped into every journal, snapshot and plan, and
 * `packages/cli/test/release.test.ts` fails when it disagrees with the published package —
 * which is right, because state files that lie about which Agentship wrote them are worse
 * than a red build.
 *
 * It has to be a step of `changeset:version` rather than something a human remembers.
 * `changeset version` rewrites every `package.json` and nothing else, so both hand-written
 * orders are broken: bump the constant when writing the changeset and `main` is red until
 * the version pull request lands; leave it and the version pull request itself is red, which
 * is the branch a release has to merge. Running here closes the window — the same commit
 * that bumps the packages bumps the constant.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_FILE = join(REPO_ROOT, 'packages/core/src/kernel/version.ts');
const DECLARATION = /^(export const AGENTSHIP_VERSION = ')(.+)(';)$/m;

const packageJson = JSON.parse(
  await readFile(join(REPO_ROOT, 'packages/cli/package.json'), 'utf8'),
) as { version?: unknown };
const version = packageJson.version;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
  throw new Error(`packages/cli/package.json has no usable version (${String(version)}).`);
}

const source = await readFile(VERSION_FILE, 'utf8');
const declaration = DECLARATION.exec(source);
if (declaration === null) {
  throw new Error(
    `${VERSION_FILE} no longer declares AGENTSHIP_VERSION in the shape this script rewrites.`,
  );
}

if (declaration[2] === version) {
  console.log(`AGENTSHIP_VERSION is already ${version}.`);
} else {
  await writeFile(VERSION_FILE, source.replace(DECLARATION, `$1${version}$3`));
  console.log(`AGENTSHIP_VERSION ${declaration[2]} -> ${version}.`);
}
