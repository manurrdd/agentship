import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analysisPath, ensureDir, loadAnalysis, stateDir } from '@agentship/core';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Area 5 — kernel. The journal-tamper, approval-reuse and concurrent-apply attacks were run
 * adversarially and held (they are pinned by the kernel-executor / kernel-journal / kernel-lock
 * suites). The one fix this area needed was making a tampered analysis.json degrade instead of
 * crashing `plan`; that is what this file guards.
 */

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function repoWithAnalysis(json: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'agentship-analysis-'));
  cleanups.push(repo);
  await ensureDir(stateDir(repo));
  await writeFile(analysisPath(repo), json);
  return repo;
}

describe('a tampered analysis.json never crashes the kernel', () => {
  it('returns undefined for a right-versioned file with hostile shapes', async () => {
    // The exact payload that used to throw "privacySignals is not iterable" during plan.
    const repo = await repoWithAnalysis(
      JSON.stringify({
        schemaVersion: 2,
        permissions: { ios: 'not-an-array' },
        privacySignals: 42,
        sdks: [],
        platforms: [],
      }),
    );
    await expect(loadAnalysis(repo)).resolves.toBeUndefined();
  });

  it('returns undefined for unparseable JSON', async () => {
    const repo = await repoWithAnalysis('{ this is not json ');
    await expect(loadAnalysis(repo)).resolves.toBeUndefined();
  });

  it('keeps a valid analysis, preserving fields the schema does not model', async () => {
    const repo = await repoWithAnalysis(
      JSON.stringify({
        schemaVersion: 2,
        analyzedAt: 'now',
        root: '/some/repo',
        framework: { framework: 'flutter', confidence: 'high', evidence: [] },
        platforms: ['ios'],
        identity: {},
        versions: {},
        sdks: [{ id: 'revenuecat', name: 'RevenueCat', categories: ['purchases'], evidence: [] }],
        permissions: { ios: [{ key: 'NSCameraUsageDescription', source: 'x' }], android: [] },
        entitlements: [],
        privacySignals: [
          {
            dataType: 'purchases',
            reason: 'r',
            sdkIds: ['revenuecat'],
            confidence: 'medium',
            evidence: [],
          },
        ],
        launchChecks: [],
        assets: { appIcons: [], screenshots: [], listingFiles: [] },
        buildHints: { appDir: '.' },
        warnings: [],
        stats: { filesScanned: 1, directoriesScanned: 1, truncated: false, durationMs: 1 },
      }),
    );
    const analysis = await loadAnalysis(repo);
    expect(analysis?.sdks[0]?.name).toBe('RevenueCat');
    expect(analysis?.privacySignals[0]?.reason).toBe('r');
  });
});
