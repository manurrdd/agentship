import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpHarness, type McpHarness } from './helpers.js';

/**
 * `agentship_analyze` against a real repository fixture: it must fix the session's project,
 * report provenance, and generate a manifest that names what it could not determine
 * instead of guessing it.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../analyzer/test/fixtures');

describe('agentship_analyze', () => {
  let harness: McpHarness | undefined;
  let repo: string | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    if (repo !== undefined) await rm(repo, { recursive: true, force: true });
    harness = undefined;
    repo = undefined;
  });

  async function fixtureCopy(name: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'agentship-analyze-'));
    await cp(join(FIXTURES, name), dir, { recursive: true });
    return dir;
  }

  it('analyzes a Flutter app, writes the manifest and reports its gaps', async () => {
    harness = await createMcpHarness({ withoutManifest: true });
    repo = await fixtureCopy('flutter-app');

    const result = await harness.call('agentship_analyze', { projectDir: repo });
    expect(result.isError).toBe(false);

    const analysis = result.payload['analysis'] as {
      framework: { framework: string; confidence: string };
      identity: Record<string, { value: string; confidence: string; source?: string }>;
    };
    expect(analysis.framework.framework).toBe('flutter');
    expect(analysis.identity['bundleId']?.value).toBeDefined();

    const manifest = result.payload['manifest'] as {
      path: string;
      created: boolean;
      gaps: string[];
    };
    expect(manifest.created).toBe(true);
    expect(manifest.gaps).toContain('metadata.locales.en-US.description');

    // The generated YAML carries the provenance comments, and the sentinel — never a guess.
    const yaml = await readFile(manifest.path, 'utf8');
    expect(yaml).toContain('<needs_input>');
    expect(yaml).toMatch(/# (inferred|needs_input)/);

    // The project is now the session's: later tools need no path.
    const status = await harness.call('agentship_store_status', {});
    expect(status.payload['projectDir']).toBe(
      manifest.path.replace('/.agentship/agentship.yaml', ''),
    );
  });

  it('does not overwrite a manifest the project already has', async () => {
    harness = await createMcpHarness({ stores: ['apple'] });
    repo = harness.repoRoot;
    const result = await harness.call('agentship_analyze', { projectDir: harness.repoRoot });
    const manifest = result.payload['manifest'] as { created: boolean; note: string };
    expect(manifest.created).toBe(false);
    expect(manifest.note).toContain('did not touch it');
    repo = undefined;
  });

  it('reports a missing directory as an error with a remediation', async () => {
    harness = await createMcpHarness();
    const result = await harness.call('agentship_analyze', {
      projectDir: '/definitely/not/here',
    });
    expect(result.isError).toBe(true);
    const error = result.payload['error'] as { code: string; remediation?: { summary: string } };
    expect(error.code).toBe('ANALYZE_PATH_NOT_FOUND');
    expect(error.remediation?.summary).toBeDefined();
  });
});
