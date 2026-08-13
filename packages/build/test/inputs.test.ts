import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fingerprintBuildInputs } from '../src/inputs.js';

/**
 * What "the project has not changed" means, concretely.
 *
 * The failure this guards against is a release that ships the previous binary: an asset is
 * replaced, the build number is left alone, and every other check — version, build number,
 * the artifact's own hash — still passes. The fingerprint is the only thing that can see it.
 */
describe('fingerprinting a build’s inputs', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function project(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'agentship-inputs-'));
    await mkdir(join(dir, 'lib'), { recursive: true });
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, 'pubspec.yaml'), 'name: example\nversion: 1.0.0+1\n');
    await writeFile(join(dir, 'lib', 'main.dart'), 'void main() {}\n');
    await writeFile(join(dir, 'assets', 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return dir;
  }

  it('is stable when nothing changes', async () => {
    const root = await project();
    const first = await fingerprintBuildInputs(root);
    const second = await fingerprintBuildInputs(root);
    expect(first?.digest).toBeDefined();
    expect(second?.digest).toBe(first?.digest);
    expect(first?.files).toBe(3);
  });

  it('changes when an asset is replaced, even at the same size', async () => {
    const root = await project();
    const before = await fingerprintBuildInputs(root);
    await writeFile(join(root, 'assets', 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x00]));
    const after = await fingerprintBuildInputs(root);
    expect(after?.digest).not.toBe(before?.digest);
    expect(after?.bytes).toBe(before?.bytes);
  });

  it('changes when a file is added or removed', async () => {
    const root = await project();
    const before = await fingerprintBuildInputs(root);
    await writeFile(join(root, 'lib', 'extra.dart'), 'void extra() {}\n');
    const added = await fingerprintBuildInputs(root);
    expect(added?.digest).not.toBe(before?.digest);
    await rm(join(root, 'lib', 'extra.dart'));
    expect((await fingerprintBuildInputs(root))?.digest).toBe(before?.digest);
  });

  it('ignores build outputs and dependency caches, so a build does not invalidate itself', async () => {
    const root = await project();
    const before = await fingerprintBuildInputs(root);
    for (const ignored of ['build', '.dart_tool', 'node_modules', 'Pods', '.git', '.agentship']) {
      await mkdir(join(root, ignored), { recursive: true });
      await writeFile(join(root, ignored, 'output.bin'), 'produced by the build');
    }
    expect((await fingerprintBuildInputs(root))?.digest).toBe(before?.digest);
  });

  it('distinguishes the same content at a different path', async () => {
    const root = await project();
    const before = await fingerprintBuildInputs(root);
    await rm(join(root, 'lib', 'main.dart'));
    await writeFile(join(root, 'main.dart'), 'void main() {}\n');
    expect((await fingerprintBuildInputs(root))?.digest).not.toBe(before?.digest);
  });

  it('reports nothing rather than a fingerprint it could not take', async () => {
    expect(await fingerprintBuildInputs('/nonexistent/for/sure')).toBeUndefined();
    dir = await mkdtemp(join(tmpdir(), 'agentship-inputs-'));
    // An empty tree is indistinguishable from one that could not be read; both mean rebuild.
    expect(await fingerprintBuildInputs(dir)).toBeUndefined();
  });
});
