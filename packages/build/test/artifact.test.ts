import { ERROR_CODES } from '@agentship/core';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectAab, inspectIpa, verifyArtifact } from '../src/artifact.js';
import { listZipEntries, readZipFile } from '../src/zip.js';
import { makeAab, makeIpa, makeZip, type Scratch, scratch } from './helpers.js';

/**
 * What Agentship claims to know about an artifact, and what it refuses to guess.
 *
 * The point of these tests is not that a zip can be read; it is that a build which exits
 * zero is not believed. An `.ipa` whose `Info.plist` disagrees with the release is rejected
 * before it can be uploaded, and an `.aab` — whose metadata Agentship deliberately does not
 * decode — comes back with that stated rather than assumed.
 */
describe('reading archives', () => {
  let space: Scratch | undefined;
  afterEach(async () => {
    await space?.cleanup();
    space = undefined;
  });

  it('reads a deflated entry out of a zip without unpacking it', async () => {
    space = await scratch();
    const path = await space.file(
      'sample.zip',
      makeZip([
        { name: 'a.txt', contents: 'x'.repeat(5_000) },
        { name: 'nested/b.txt', contents: 'stored verbatim', store: true },
      ]),
    );
    const entries = await listZipEntries(path);
    expect(entries.map((entry) => entry.name)).toEqual(['a.txt', 'nested/b.txt']);

    const deflated = await readZipFile(path, (name) => name === 'a.txt');
    expect(deflated?.contents.toString('utf8')).toBe('x'.repeat(5_000));
    const stored = await readZipFile(path, (name) => name === 'nested/b.txt');
    expect(stored?.contents.toString('utf8')).toBe('stored verbatim');
  });

  it('reads bundle id, version and build number out of an .ipa', async () => {
    space = await scratch();
    const path = await space.file(
      'app.ipa',
      makeIpa({ bundleId: 'com.example.app', version: '2.1.0', buildNumber: '77' }),
    );
    await expect(inspectIpa(path)).resolves.toEqual({
      bundleId: 'com.example.app',
      version: '2.1.0',
      buildNumber: '77',
      unverified: [],
    });
  });

  it('rejects an .ipa with no application payload', async () => {
    space = await scratch();
    const path = await space.file('broken.ipa', makeZip([{ name: 'README', contents: 'nope' }]));
    await expect(inspectIpa(path)).rejects.toMatchObject({
      code: ERROR_CODES.BUILD_ARTIFACT_INVALID,
    });
  });

  it('confirms an .aab structurally and says what it did not read', async () => {
    space = await scratch();
    const path = await space.file('app.aab', makeAab());
    const inspection = await inspectAab(path);
    expect(inspection.version).toBeUndefined();
    expect(inspection.unverified.join(' ')).toContain('versionCode');
  });

  it('rejects an .aab that is only a zip', async () => {
    space = await scratch();
    const path = await space.file('fake.aab', makeZip([{ name: 'classes.dex', contents: 'x' }]));
    await expect(inspectAab(path)).rejects.toMatchObject({
      code: ERROR_CODES.BUILD_ARTIFACT_INVALID,
    });
  });
});

describe('verifying a built artifact', () => {
  let space: Scratch | undefined;
  afterEach(async () => {
    await space?.cleanup();
    space = undefined;
  });

  const expectation = {
    store: 'apple' as const,
    kind: 'ipa' as const,
    version: '2.1.0',
    buildNumber: '77',
    bundleId: 'com.example.app',
    builder: 'ios-xcodebuild',
  };

  it('records path, size and hash when the artifact matches the release', async () => {
    space = await scratch();
    const path = await space.file(
      'app.ipa',
      makeIpa({ bundleId: 'com.example.app', version: '2.1.0', buildNumber: '77' }),
    );
    const record = await verifyArtifact(path, expectation);
    expect(record).toMatchObject({
      store: 'apple',
      kind: 'ipa',
      version: '2.1.0',
      buildNumber: '77',
      bundleId: 'com.example.app',
    });
    expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.sizeBytes).toBeGreaterThan(0);
  });

  it('refuses an artifact whose version contradicts the release', async () => {
    space = await scratch();
    const path = await space.file(
      'app.ipa',
      // The project hard-codes 1.0.0 in its Info.plist and ignored the injected setting.
      makeIpa({ bundleId: 'com.example.app', version: '1.0.0', buildNumber: '77' }),
    );
    await expect(verifyArtifact(path, expectation)).rejects.toMatchObject({
      code: ERROR_CODES.BUILD_ARTIFACT_INVALID,
      message: expect.stringContaining('marketing version'),
    });
  });

  it('refuses an artifact built for another bundle identifier', async () => {
    space = await scratch();
    const path = await space.file(
      'app.ipa',
      makeIpa({ bundleId: 'com.example.other', version: '2.1.0', buildNumber: '77' }),
    );
    await expect(verifyArtifact(path, expectation)).rejects.toMatchObject({
      message: expect.stringContaining('bundle identifier'),
    });
  });

  it('refuses an empty file instead of recording it', async () => {
    space = await scratch();
    const path = await space.file('app.ipa', '');
    await expect(verifyArtifact(path, expectation)).rejects.toMatchObject({
      message: expect.stringContaining('empty'),
    });
  });

  it('takes the requested version for an .aab and marks it unverified', async () => {
    space = await scratch();
    const path = await space.file('app.aab', makeAab());
    const record = await verifyArtifact(path, {
      store: 'google',
      kind: 'aab',
      version: '2.1.0',
      buildNumber: '77',
      builder: 'android-gradle',
    });
    expect(record.version).toBe('2.1.0');
    expect(record.unverified?.join(' ')).toContain('versionCode');
  });
});
