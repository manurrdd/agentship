#!/usr/bin/env tsx
/**
 * Maintenance script — regenerates `packages/toolchain/tools.lock.json`.
 *
 * Run by the Agentship team, never by users and never at install time. For every managed
 * tool and every supported platform it:
 *
 *   1. resolves a GitHub release (latest by default, or a pinned tag),
 *   2. downloads the asset in full,
 *   3. computes its SHA-256 locally,
 *   4. cross-checks that digest against the `checksums.txt` the project publishes, and
 *   5. aborts the whole run if any digest or size disagrees.
 *
 * The published `checksums.txt` is used only as a second opinion at authoring time. At
 * install time Agentship trusts exclusively the digests embedded in the lockfile, which ship
 * inside the npm package: a release that is rewritten after the fact fails verification on
 * every user machine instead of being silently accepted.
 *
 * Usage:
 *   pnpm update-tools-lock                 # latest release of every tool
 *   pnpm update-tools-lock --tool asc      # only one tool
 *   pnpm update-tools-lock --asc 3.4.1 --gpc v0.9.93   # pinned tags
 */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCKFILE_PATH = join(REPO_ROOT, 'packages', 'toolchain', 'tools.lock.json');

/** Platforms Agentship supports in v1. Windows is deliberately excluded. */
const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'] as const;
type PlatformKey = (typeof PLATFORMS)[number];

interface ToolSource {
  readonly repo: string;
  readonly description: string;
  readonly license: string;
  /** Matches the checksums asset in the release. */
  readonly checksumsAsset: RegExp;
  /** Matches the binary asset for each platform. */
  readonly assets: Record<PlatformKey, RegExp>;
}

const SOURCES: Record<string, ToolSource> = {
  asc: {
    repo: 'rorkai/App-Store-Connect-CLI',
    description: 'App Store Connect CLI',
    license: 'MIT',
    checksumsAsset: /_checksums\.txt$/,
    assets: {
      'darwin-arm64': /_macOS_arm64$/,
      'darwin-x64': /_macOS_amd64$/,
      'linux-x64': /_linux_amd64$/,
      'linux-arm64': /_linux_arm64$/,
    },
  },
  gpc: {
    repo: 'yasserstudio/gpc',
    description: 'Google Play Console CLI',
    license: 'MIT',
    checksumsAsset: /^checksums\.txt$/,
    assets: {
      'darwin-arm64': /-darwin-arm64$/,
      'darwin-x64': /-darwin-x64$/,
      'linux-x64': /-linux-x64$/,
      'linux-arm64': /-linux-arm64$/,
    },
  },
};

interface ReleaseAsset {
  readonly name: string;
  readonly size: number;
  readonly browser_download_url: string;
}

interface Release {
  readonly tag_name: string;
  readonly assets: readonly ReleaseAsset[];
  readonly published_at: string;
}

function parseArgs(argv: readonly string[]): { tools: string[]; tags: Record<string, string> } {
  const tools: string[] = [];
  const tags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tool') {
      const value = argv[++i];
      if (value !== undefined) tools.push(value);
    } else if (arg?.startsWith('--') && argv[i + 1] !== undefined) {
      const name = arg.slice(2);
      if (name in SOURCES) tags[name] = argv[++i] as string;
    }
  }
  return { tools: tools.length > 0 ? tools : Object.keys(SOURCES), tags };
}

async function githubJson<T>(url: string): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'agentship-update-tools-lock',
  };
  const token = process.env['GITHUB_TOKEN'];
  if (token !== undefined && token !== '') headers['authorization'] = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} ${response.statusText} for ${url}`);
  }
  return (await response.json()) as T;
}

async function download(url: string): Promise<{ sha256: string; size: number }> {
  const response = await fetch(url, { headers: { 'user-agent': 'agentship-update-tools-lock' } });
  if (!response.ok || response.body === null) {
    throw new Error(`Download failed: ${response.status} ${response.statusText} for ${url}`);
  }
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of response.body) {
    const buffer = chunk as Uint8Array;
    hash.update(buffer);
    size += buffer.byteLength;
  }
  return { sha256: hash.digest('hex'), size };
}

/** Parses the `sha256␠␠filename` format both projects publish. */
function parseChecksums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      map.set(match[2], match[1].toLowerCase());
    }
  }
  return map;
}

interface LockEntry {
  url: string;
  sha256: string;
  size: number;
}

async function buildToolEntry(
  name: string,
  source: ToolSource,
  tag: string | undefined,
): Promise<Record<string, unknown>> {
  const releaseUrl =
    tag === undefined
      ? `https://api.github.com/repos/${source.repo}/releases/latest`
      : `https://api.github.com/repos/${source.repo}/releases/tags/${tag}`;
  const release = await githubJson<Release>(releaseUrl);
  console.log(`\n${name}: release ${release.tag_name} (${release.published_at})`);

  const checksumsAsset = release.assets.find((a) => source.checksumsAsset.test(a.name));
  if (checksumsAsset === undefined) {
    throw new Error(`${name}: release ${release.tag_name} publishes no checksums file`);
  }
  const checksumsText = await fetch(checksumsAsset.browser_download_url).then((r) => r.text());
  const published = parseChecksums(checksumsText);
  if (published.size === 0) {
    throw new Error(`${name}: could not parse ${checksumsAsset.name}`);
  }

  const platforms: Record<string, LockEntry> = {};
  for (const platform of PLATFORMS) {
    const pattern = source.assets[platform];
    const asset = release.assets.find((a) => pattern.test(a.name));
    if (asset === undefined) {
      throw new Error(`${name}: no asset for ${platform} in release ${release.tag_name}`);
    }
    process.stdout.write(`  ${platform.padEnd(13)} ${asset.name} … `);
    const { sha256, size } = await download(asset.browser_download_url);

    const expected = published.get(asset.name);
    if (expected === undefined) {
      throw new Error(`${name}: ${asset.name} is missing from ${checksumsAsset.name}`);
    }
    if (expected !== sha256) {
      throw new Error(
        `${name}: SHA-256 mismatch for ${asset.name}. Published ${expected}, downloaded ${sha256}. ` +
          'Refusing to write the lockfile.',
      );
    }
    if (size !== asset.size) {
      throw new Error(
        `${name}: size mismatch for ${asset.name}. API says ${asset.size}, downloaded ${size}.`,
      );
    }
    console.log(`ok (${sha256.slice(0, 12)}…, ${(size / 1_000_000).toFixed(1)} MB)`);
    platforms[platform] = { url: asset.browser_download_url, sha256, size };
  }

  return {
    version: release.tag_name.replace(/^v/, ''),
    tag: release.tag_name,
    repo: source.repo,
    license: source.license,
    description: source.description,
    checksumsUrl: checksumsAsset.browser_download_url,
    platforms,
  };
}

async function main(): Promise<void> {
  const { tools, tags } = parseArgs(process.argv.slice(2));

  let existing: Record<string, unknown> = {};
  try {
    const { readFile } = await import('node:fs/promises');
    existing = JSON.parse(await readFile(LOCKFILE_PATH, 'utf8')) as Record<string, unknown>;
  } catch {
    // First run: no lockfile yet.
  }

  const toolEntries: Record<string, unknown> = {
    ...((existing['tools'] as Record<string, unknown> | undefined) ?? {}),
  };
  for (const name of tools) {
    const source = SOURCES[name];
    if (source === undefined) throw new Error(`Unknown tool "${name}"`);
    toolEntries[name] = await buildToolEntry(name, source, tags[name]);
  }

  const lockfile = {
    $schema: './tools.lock.schema.json',
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platforms: PLATFORMS,
    tools: toolEntries,
  };
  await writeFile(LOCKFILE_PATH, `${JSON.stringify(lockfile, null, 2)}\n`);
  console.log(`\nWrote ${LOCKFILE_PATH}`);
}

main().catch((error: unknown) => {
  console.error(`\nupdate-tools-lock failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
