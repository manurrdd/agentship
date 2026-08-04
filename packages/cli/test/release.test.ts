import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTSHIP_VERSION } from '@agentship/core';
import { describe, expect, it } from 'vitest';
import {
  checkCliCommands,
  checkDocs,
  checkLinks,
  checkToolNames,
  DOCS,
} from '../../../scripts/check-docs.js';
import { platformLimitsMarkdown } from '../../../scripts/generate-platform-limits.js';

/**
 * What must be true of a release before it can be one.
 *
 * The version has three homes — the package, the constant stamped into every journal and
 * plan, and whatever the binary prints — and a release where they disagree produces state
 * files that lie about which Agentship wrote them. The documentation is checked the same way
 * the skills are: its factual claims come from the code, so they cannot rot quietly.
 */
const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(CLI_DIR, '../..');

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

describe('the published package', () => {
  it('is publishable and has the metadata npm needs', async () => {
    const manifest = await json(join(CLI_DIR, 'package.json'));
    expect(manifest['name']).toBe('agentship');
    expect(manifest['private']).toBeUndefined();
    expect(manifest['license']).toBe('MIT');
    expect((manifest['publishConfig'] as { access?: string }).access).toBe('public');
    // Everything the runtime reads has to be in the tarball; pack.test.ts proves it lands.
    expect(manifest['files']).toEqual(
      expect.arrayContaining(['dist', 'skills', 'tools.lock.json', 'data']),
    );
    // No install-time code, in the package a user installs or in the workspace root.
    for (const file of ['packages/cli/package.json', 'package.json', 'e2e/package.json']) {
      const scripts = ((await json(join(REPO_ROOT, file)))['scripts'] ?? {}) as Record<
        string,
        string
      >;
      for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
        expect(scripts[hook], `${file} declares ${hook}`).toBeUndefined();
      }
    }
  });

  it('stamps the same version into state that it publishes', async () => {
    const manifest = await json(join(CLI_DIR, 'package.json'));
    expect(AGENTSHIP_VERSION).toBe(manifest['version']);
    expect(AGENTSHIP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('keeps every workspace package on one version', async () => {
    const root = await json(join(CLI_DIR, 'package.json'));
    for (const pkg of ['core', 'mcp', 'setup', 'toolchain', 'catalog']) {
      const manifest = await json(join(REPO_ROOT, 'packages', pkg, 'package.json'));
      expect(manifest['version'], `@agentship/${pkg}`).toBe(root['version']);
      // Bundled, never published on their own.
      expect(manifest['private'], `@agentship/${pkg}`).toBe(true);
    }
  });
});

describe('the documentation humans read', () => {
  it('says nothing about the product that is not true', async () => {
    const problems = await checkDocs();
    expect(problems.map((problem) => `${problem.file}: ${problem.message}`)).toEqual([]);
  });

  it('covers the pages the release checklist depends on', () => {
    expect(DOCS).toEqual(
      expect.arrayContaining(['README.md', 'PLATFORM-LIMITS.md', 'SECURITY.md', 'RELEASING.md']),
    );
  });

  it('has a PLATFORM-LIMITS.md generated from the current capability maps', async () => {
    const actual = await readFile(join(REPO_ROOT, 'PLATFORM-LIMITS.md'), 'utf8');
    expect(actual, 'stale; run pnpm generate:platform-limits').toBe(platformLimitsMarkdown());
  });

  // The checks themselves have to be able to fail, or the suite above proves nothing.
  it('catches a tool that does not exist, a command that does not exist and a dead link', async () => {
    expect(checkToolNames('x.md', 'call `agentship_publish_everything` now')).toHaveLength(1);
    expect(checkToolNames('x.md', 'call `agentship_plan` now')).toEqual([]);
    expect(checkCliCommands('x.md', '`agentship deploy --yes`', ['setup', 'doctor'])).toHaveLength(
      1,
    );
    expect(checkCliCommands('x.md', '`agentship setup --yes`', ['setup', 'doctor'])).toEqual([]);
    expect(await checkLinks('README.md', '[gone](docs/not-here.md)')).toHaveLength(1);
    expect(await checkLinks('README.md', '[real](SECURITY.md)')).toEqual([]);
    expect(await checkLinks('README.md', '[bad anchor](SECURITY.md#nope)')).toHaveLength(1);
  });
});
