import { readFile, writeFile } from 'node:fs/promises';
import {
  type ActionDraft,
  type ArtifactRecord,
  buildOutputDir,
  checkArtifact,
  DifferRegistry,
  ensureDir,
  fileSha256,
  Kernel,
  type LocalActionRunner,
  plannedArtifactPath,
  type ResourceDiffer,
  readArtifacts,
  recordArtifact,
  usableArtifact,
} from '@agentship/core';
import { describe, expect, it } from 'vitest';
import { createHarness, testManifest } from './kernel-helpers.js';

/**
 * Actions that happen on this machine rather than in a store.
 *
 * A build is the one release step whose effect is a local file, so the store can never be
 * asked "did it land?". These tests pin the answer Agentship uses instead: the artifact
 * register plus a re-read of the bytes. Everything else about a local action — approvals,
 * journaling, ordering, resumption — must behave exactly like a store action, and that is
 * what the rest of these assertions check.
 */
function fakeBuildDiffer(): ResourceDiffer {
  return {
    store: 'apple',
    resource: 'zz-fake-build',
    async plan(input): Promise<readonly ActionDraft[]> {
      const version = input.manifest.release.version;
      const buildNumber = input.manifest.release.buildNumber as string;
      const existing = await usableArtifact(input.repoRoot, 'apple', { version, buildNumber });
      if (existing !== undefined) return [];
      return [
        {
          kind: 'build',
          target: `ios/${version}`,
          operation: 'buildArtifact',
          summary: `Build ${version} (${buildNumber})`,
          diff: [{ path: 'artifacts.apple', after: `${version} (${buildNumber})` }],
          local: {
            kind: 'build',
            payload: {
              destination: plannedArtifactPath(
                input.repoRoot,
                'apple',
                'ipa',
                version,
                buildNumber,
              ),
              version,
              buildNumber,
            },
          },
        },
      ];
    },
  };
}

/** A runner that writes a file and records it, exactly as the real one does. */
function fakeBuildRunner(options: { fail?: boolean; onRun?: () => void } = {}): LocalActionRunner {
  return async ({ op, repoRoot, dryRun }) => {
    options.onRun?.();
    if (dryRun) return { ok: true, changed: false, detail: 'would build' };
    if (options.fail === true) {
      return { ok: false, changed: false, errorCode: 'BUILD_FAILED', errorMessage: 'nope' };
    }
    const payload = op.payload as { destination: string; version: string; buildNumber: string };
    await ensureDir(buildOutputDir(repoRoot, 'apple'));
    await writeFile(payload.destination, `binary for ${payload.version}`);
    const record: ArtifactRecord = {
      store: 'apple',
      path: payload.destination,
      kind: 'ipa',
      sha256: await fileSha256(payload.destination),
      sizeBytes: (await readFile(payload.destination)).length,
      version: payload.version,
      buildNumber: payload.buildNumber,
      builder: 'test',
      builtAt: new Date().toISOString(),
    };
    await recordArtifact(repoRoot, record);
    return { ok: true, changed: true, detail: record.path };
  };
}

async function buildHarness(options: { fail?: boolean; onRun?: () => void } = {}) {
  const base = await createHarness({ stores: ['apple'] });
  const registry = new DifferRegistry().register(fakeBuildDiffer());
  const kernel = new Kernel({
    repoRoot: base.repoRoot,
    adapters: base.adapters,
    context: base.context,
    registry,
    localRunners: new Map([['build', fakeBuildRunner(options)]]),
  });
  return { ...base, kernel };
}

describe('local actions', () => {
  it('runs the build, records the artifact, and then plans nothing', async () => {
    let runs = 0;
    const harness = await buildHarness({ onRun: () => (runs += 1) });
    try {
      const plan = await harness.kernel.plan();
      expect(plan.actions.map((action) => action.kind)).toEqual(['build']);
      expect(plan.actions[0]?.classification).toBe('auto');
      expect(plan.actions[0]?.op).toBeUndefined();

      const applied = await harness.kernel.apply({ planId: plan.planId });
      expect(applied.ok).toBe(true);
      expect(runs).toBe(1);

      // Convergence: the artifact exists and hashes correctly, so no build is planned.
      expect((await harness.kernel.plan()).actions).toEqual([]);
      const register = await readArtifacts(harness.repoRoot);
      expect(register.artifacts.apple?.version).toBe('1.1.0');
    } finally {
      await harness.cleanup();
    }
  });

  it('plans the build again when the artifact was edited after it was recorded', async () => {
    const harness = await buildHarness();
    try {
      const plan = await harness.kernel.plan();
      await harness.kernel.apply({ planId: plan.planId });
      const record = (await readArtifacts(harness.repoRoot)).artifacts.apple as ArtifactRecord;

      await writeFile(record.path, 'something else entirely');
      const check = await checkArtifact(record);
      expect(check.valid).toBe(false);
      expect(check.reason).toBe('size_changed');

      // Identity is content here too: different bytes means the build has to happen again.
      expect((await harness.kernel.plan()).actions.map((a) => a.kind)).toEqual(['build']);
    } finally {
      await harness.cleanup();
    }
  });

  it('reports a failed build as an outcome and resumes into a retry', async () => {
    let attempts = 0;
    const failing = { fail: true, onRun: () => (attempts += 1) };
    const harness = await buildHarness(failing);
    try {
      const plan = await harness.kernel.plan();
      const applied = await harness.kernel.apply({ planId: plan.planId });
      expect(applied.ok).toBe(false);
      expect(applied.outcomes[0]?.status).toBe('failed');
      expect(applied.outcomes[0]?.errorMessage).toBe('nope');
      expect(attempts).toBe(1);

      // Nothing was recorded, so the action is still there for a resume to retry.
      expect((await readArtifacts(harness.repoRoot)).artifacts.apple).toBeUndefined();
      failing.fail = false;
      const resumed = await harness.kernel.resume();
      expect(resumed.ok).toBe(true);
      expect(attempts).toBe(2);
    } finally {
      await harness.cleanup();
    }
  });

  it('compiles nothing under a dry run', async () => {
    let runs = 0;
    const harness = await buildHarness({ onRun: () => (runs += 1) });
    try {
      const plan = await harness.kernel.plan();
      const local = await harness.kernel.apply({ planId: plan.planId, dryRun: 'local' });
      expect(local.outcomes[0]?.status).toBe('done');
      expect(runs).toBe(0);

      const server = await harness.kernel.apply({ planId: plan.planId, dryRun: 'server' });
      expect(server.outcomes[0]?.detail).toContain('would build');
      expect((await readArtifacts(harness.repoRoot)).artifacts.apple).toBeUndefined();
    } finally {
      await harness.cleanup();
    }
  });

  it('journals a local action like any other, so a crash leaves an orphan intent', async () => {
    const harness = await buildHarness();
    try {
      const plan = await harness.kernel.plan();
      await expect(
        harness.kernel.apply({
          planId: plan.planId,
          chaos: (point) => {
            if (point === 'after_intent') throw new Error('killed');
          },
        }),
      ).rejects.toThrow('killed');

      const journal = await readFile(`${harness.repoRoot}/.agentship/state/journal.jsonl`, 'utf8');
      expect(journal).toContain('"type":"intent"');
      expect(journal).not.toContain('"type":"result"');

      // Resume re-derives from the filesystem, not from the journal.
      const resumed = await harness.kernel.resume();
      expect(resumed.ok).toBe(true);
      expect(resumed.warnings.join(' ')).toContain('Interrupted action');
    } finally {
      await harness.cleanup();
    }
  });

  it('refuses a draft that is both a store op and a local op', async () => {
    const harness = await createHarness({ stores: ['apple'] });
    try {
      const registry = new DifferRegistry().register({
        store: 'apple',
        resource: 'confused',
        plan: () => [
          {
            kind: 'build',
            target: 'both',
            operation: 'buildArtifact',
            summary: 'two ways to execute',
            diff: [],
            local: { kind: 'build', payload: {} },
            op: { op: 'set_metadata', changes: { locales: [] } },
          },
        ],
      });
      const kernel = new Kernel({
        repoRoot: harness.repoRoot,
        adapters: harness.adapters,
        context: harness.context,
        registry,
      });
      await expect(kernel.plan()).rejects.toThrow(/exactly one way to execute/);
    } finally {
      await harness.cleanup();
    }
  });

  it('fails an action whose local runner is not registered, instead of skipping it', async () => {
    const harness = await createHarness({ stores: ['apple'] });
    try {
      const kernel = new Kernel({
        repoRoot: harness.repoRoot,
        adapters: harness.adapters,
        context: harness.context,
        registry: new DifferRegistry().register(fakeBuildDiffer()),
        // No runners: a plan that cannot execute must say so loudly.
      });
      const plan = await kernel.plan();
      const applied = await kernel.apply({ planId: plan.planId });
      expect(applied.ok).toBe(false);
      expect(applied.outcomes[0]?.errorMessage).toContain('No runner is registered');
    } finally {
      await harness.cleanup();
    }
  });
});

describe('the artifact register', () => {
  it('is not fooled by a same-size file with different bytes', async () => {
    const harness = await buildHarness();
    try {
      const plan = await harness.kernel.plan();
      await harness.kernel.apply({ planId: plan.planId });
      const record = (await readArtifacts(harness.repoRoot)).artifacts.apple as ArtifactRecord;
      const original = await readFile(record.path);
      await writeFile(record.path, Buffer.alloc(original.length, 0x41));

      const check = await checkArtifact(record);
      expect(check.valid).toBe(false);
      expect(check.reason).toBe('hash_changed');
    } finally {
      await harness.cleanup();
    }
  });

  it('only offers an artifact that matches the version and build number asked for', async () => {
    const harness = await buildHarness();
    try {
      await harness.kernel.apply({ planId: (await harness.kernel.plan()).planId });
      const manifest = testManifest({ stores: ['apple'] });
      expect(
        await usableArtifact(harness.repoRoot, 'apple', {
          version: manifest.release.version,
          buildNumber: manifest.release.buildNumber as string,
        }),
      ).toBeDefined();
      expect(await usableArtifact(harness.repoRoot, 'apple', { version: '9.9.9' })).toBeUndefined();
      expect(
        await usableArtifact(harness.repoRoot, 'apple', { buildNumber: '999' }),
      ).toBeUndefined();
    } finally {
      await harness.cleanup();
    }
  });

  /**
   * The artifact hash proves the *file* is untouched; it says nothing about the project.
   * Replacing an app icon and leaving the build number alone satisfies every other check,
   * which is how a release can go out carrying the previous binary.
   */
  it('refuses an artifact whose source tree has moved on, and one that never recorded it', async () => {
    const harness = await buildHarness();
    try {
      await harness.kernel.apply({ planId: (await harness.kernel.plan()).planId });
      const manifest = testManifest({ stores: ['apple'] });
      const wanted = {
        version: manifest.release.version,
        buildNumber: manifest.release.buildNumber as string,
      };
      const record = (await readArtifacts(harness.repoRoot)).artifacts.apple as ArtifactRecord;

      // The fake runner records no fingerprint, which is also what an artifact built by an
      // earlier Agentship looks like: unknown inputs, so never reusable.
      expect(record.inputsDigest).toBeUndefined();
      expect(
        await usableArtifact(harness.repoRoot, 'apple', { ...wanted, inputsDigest: 'abc123' }),
      ).toBeUndefined();

      await recordArtifact(harness.repoRoot, { ...record, inputsDigest: 'abc123' });
      expect(
        await usableArtifact(harness.repoRoot, 'apple', { ...wanted, inputsDigest: 'abc123' }),
      ).toBeDefined();
      // The icon changed: same artifact bytes, same version, different project.
      expect(
        await usableArtifact(harness.repoRoot, 'apple', { ...wanted, inputsDigest: 'def456' }),
      ).toBeUndefined();
      // A caller that only wants to know where the binary is still gets it.
      expect(await usableArtifact(harness.repoRoot, 'apple', wanted)).toBeDefined();
    } finally {
      await harness.cleanup();
    }
  });

  it('derives the artifact path from the release, so an upload can be planned first', () => {
    const path = plannedArtifactPath('/repo', 'apple', 'ipa', '1.2.3', '45');
    expect(path).toBe('/repo/.agentship/build/apple/apple-1.2.3-45.ipa');
    expect(plannedArtifactPath('/repo', 'apple', 'ipa', '1.2.3', '45')).toBe(path);
  });
});
