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

    // Launch checks reach the agent through the summary: the core set plus what the
    // detected SDKs make necessary, each with its source.
    const launchChecks = (result.payload['analysis'] as Record<string, unknown>)[
      'launchChecks'
    ] as { id: string; claim: string; source: string }[];
    expect(launchChecks.map((check) => check.id)).toContain('privacy-policy-published');

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

  /**
   * The repository that produced this test had `app/.agentship/` and, after one `analyze`
   * at the wrong level, a second manifest at the root. The root one declared only Apple,
   * called a Flutter project `ios-native` with confidence `certain`, and reset the build
   * number — while carrying fresh provenance comments that made it look authoritative.
   * Two sources of truth diverging in silence, and the wrong one looking better.
   */
  it('does not create a rival manifest above a project that already exists', async () => {
    harness = await createMcpHarness({ withoutManifest: true });
    const parent = await mkdtemp(join(tmpdir(), 'agentship-analyze-'));
    repo = parent;
    await cp(join(FIXTURES, 'flutter-app'), join(parent, 'app'), { recursive: true });

    // Initialise the real project one level down, then analyze the parent.
    const inner = await harness.call('agentship_analyze', { projectDir: join(parent, 'app') });
    expect((inner.payload['manifest'] as { created: boolean }).created).toBe(true);

    const outer = await harness.call('agentship_analyze', { projectDir: parent });
    expect(outer.isError).toBe(false);
    const manifest = outer.payload['manifest'] as {
      created: boolean;
      note: string;
      existingProjects?: string[];
    };
    expect(manifest.created).toBe(false);
    expect(manifest.existingProjects?.[0]).toContain('app');
    expect(manifest.note).toContain('rival source of truth');
    expect(outer.payload['nextStep']).toContain('existing project');

    // Nothing was written at the parent: no second manifest exists.
    await expect(readFile(join(parent, '.agentship', 'agentship.yaml'), 'utf8')).rejects.toThrow();
    await expect(
      readFile(join(parent, '.agentship', 'state', 'analysis.json'), 'utf8'),
    ).rejects.toThrow();

    // The analysis itself is still returned — only the write was withheld.
    expect(outer.payload['analysis']).toBeDefined();
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
