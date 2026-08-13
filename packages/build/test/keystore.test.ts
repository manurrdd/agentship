import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManifestSchema } from '@agentship/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectKeystore } from '../src/keystore.js';

describe('detecting project-owned Android signing', () => {
  let root: string;
  let previousHome: string | undefined;
  let previousService: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agentship-signing-detect-'));
    previousHome = process.env['AGENTSHIP_HOME'];
    previousService = process.env['AGENTSHIP_KEYRING_SERVICE'];
    process.env['AGENTSHIP_HOME'] = root;
    process.env['AGENTSHIP_KEYRING_SERVICE'] = `agentship-test-signing-${process.pid}`;
    await mkdir(join(root, 'android', 'app'), { recursive: true });
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env['AGENTSHIP_HOME'];
    else process.env['AGENTSHIP_HOME'] = previousHome;
    if (previousService === undefined) delete process.env['AGENTSHIP_KEYRING_SERVICE'];
    else process.env['AGENTSHIP_KEYRING_SERVICE'] = previousService;
    await rm(root, { recursive: true, force: true });
  });

  const manifest = ManifestSchema.parse({
    version: 1,
    app: { name: 'Example' },
    stores: { google: { packageName: 'com.example.app' } },
    release: { version: '1.0.0', buildNumber: '1', track: 'internal_testing' },
    metadata: { primaryLocale: 'en-US', locales: { 'en-US': { name: 'Example' } } },
  });

  it('does not call a Flutter signing block usable when its key.properties is absent', async () => {
    await writeFile(
      join(root, 'android', 'app', 'build.gradle.kts'),
      `val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("key.properties")
signingConfigs {
  create("release") {
    keyAlias = keystoreProperties["keyAlias"] as String
    storeFile = file(keystoreProperties["storeFile"] as String)
  }
}`,
    );
    const state = await detectKeystore(root, 'com.example.app', manifest);
    expect(state.origin).toBe('missing');
    expect(state.detail).toContain('No upload keystore');
  });

  it('recognises the same setup once the project key.properties exists', async () => {
    await writeFile(join(root, 'android', 'key.properties'), 'storeFile=/tmp/upload.jks\n');
    const state = await detectKeystore(root, 'com.example.app', manifest);
    expect(state.origin).toBe('project');
  });
});
