import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractAndroid, RepoFs } from '@agentship/analyzer';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Area 3 — a repository is untrusted input. These reproduce the attacks a hostile repo used
 * to win: reading a file outside the checkout through a directory symlink, and two regular
 * expressions that backtracked catastrophically on crafted content.
 */

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

describe('directory-symlink escape', () => {
  it('refuses to read a fixed path through a symlinked directory component', async () => {
    const outside = await tempDir('agentship-secret-');
    await mkdir(join(outside, 'Runner'), { recursive: true });
    await writeFile(join(outside, 'Runner', 'Info.plist'), 'CANARY_OUTSIDE_THE_REPO');

    const repo = await tempDir('agentship-repo-');
    // `ios` is a directory symlink to the secret tree: `ios/Runner/Info.plist` is lexically
    // inside the repo but the OS would follow the link on the intermediate component.
    await symlink(outside, join(repo, 'ios'), 'dir');

    const fs = await RepoFs.open(repo);
    expect(await fs.readText('ios/Runner/Info.plist')).toBeUndefined();
    expect(fs.skipped.some((s) => s.reason === 'symlink')).toBe(true);
  });
});

/** Builds a minimal Android module under a temp repo and returns the repo root. */
async function androidRepo(options: {
  buildGradle: string;
  manifest: string;
  strings?: string;
}): Promise<string> {
  const repo = await tempDir('agentship-android-');
  const moduleDir = join(repo, 'android', 'app');
  const resDir = join(moduleDir, 'src', 'main', 'res', 'values');
  await mkdir(resDir, { recursive: true });
  await writeFile(join(moduleDir, 'build.gradle'), options.buildGradle);
  await writeFile(join(moduleDir, 'src', 'main', 'AndroidManifest.xml'), options.manifest);
  if (options.strings !== undefined) await writeFile(join(resDir, 'strings.xml'), options.strings);
  return repo;
}

describe('ReDoS in Gradle value parsing', () => {
  it('parses a build.gradle whose key is padded with kilobytes of whitespace, fast', async () => {
    const repo = await androidRepo({
      // A legitimate key followed by a long whitespace run and no closing literal — the input
      // that used to backtrack catastrophically and freeze the single-threaded analyzer.
      buildGradle: `com.android.application\napplicationId${' '.repeat(50_000)}\n`,
      manifest: '<manifest><application/></manifest>',
    });
    const fs = await RepoFs.open(repo);
    const started = Date.now();
    const extraction = await extractAndroid(fs, '.');
    expect(Date.now() - started).toBeLessThan(2_000);
    // No literal survives the padding, so no package name is read (the parse returns, fast).
    expect(extraction?.packageName).toBeUndefined();
  });

  it('still reads a normal applicationId', async () => {
    const repo = await androidRepo({
      buildGradle: 'com.android.application\napplicationId "com.example.app"\n',
      manifest: '<manifest><application/></manifest>',
    });
    const fs = await RepoFs.open(repo);
    const extraction = await extractAndroid(fs, '.');
    expect(extraction?.packageName?.value).toBe('com.example.app');
  });
});

describe('regex injection via android:label', () => {
  it('does not backtrack catastrophically on a hostile @string reference', async () => {
    // `android:label` is repository-controlled; before the fix it was spliced unescaped into a
    // `new RegExp` run against the repo's own strings.xml, so this label injected a
    // catastrophic pattern.
    const repo = await androidRepo({
      buildGradle: 'com.android.application\n',
      manifest: '<manifest><application android:label="@string/((((.*)*)*)*)!"/></manifest>',
      strings: `<resources>${'<string name="x">y</string>'.repeat(40)}${'a'.repeat(40)}</resources>`,
    });
    const fs = await RepoFs.open(repo);
    const started = Date.now();
    await extractAndroid(fs, '.');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('still resolves a normal @string label literally', async () => {
    const repo = await androidRepo({
      buildGradle: 'com.android.application\n',
      manifest: '<manifest><application android:label="@string/app_name"/></manifest>',
      strings: '<resources><string name="app_name">Example</string></resources>',
    });
    const fs = await RepoFs.open(repo);
    const extraction = await extractAndroid(fs, '.');
    expect(extraction.appName?.value).toBe('Example');
  });
});
