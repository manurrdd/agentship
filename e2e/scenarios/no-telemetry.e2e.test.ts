import { readdir, readFile } from 'node:fs/promises';
import { type AddressInfo, connect, createServer } from 'node:net';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Journey } from '../src/journey.js';
import { releaseManifest } from '../src/manifests.js';
import { isLoopback, recordNetwork } from '../src/network.js';

/**
 * Agentship reports nothing to anyone.
 *
 * Two independent checks, because either one alone could be fooled. The first watches the
 * process: a full release journey runs with every outbound connection recorded, and the
 * recording has to be empty — no ping, no "anonymous usage", not even a DNS lookup. The
 * second reads the product: every URL that ships is either a store, a console page a user
 * is sent to, or a pinned toolchain artifact, so a new destination cannot be introduced
 * without this test naming it.
 */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Where Agentship is allowed to go, and why. */
const ALLOWED_HOSTS: Record<string, string> = {
  'appstoreconnect.apple.com': 'App Store Connect: the API and the console',
  'api.appstoreconnect.apple.com': 'App Store Connect API',
  'developer.apple.com': 'Apple developer account and documentation the user is sent to',
  'play.google.com': 'Play Console and Play Store pages',
  'androidpublisher.googleapis.com': 'Play Developer API',
  'console.cloud.google.com': 'Google Cloud console, for the service account a user creates',
  'support.google.com': 'Play policy pages the user is sent to',
  'developers.google.com': 'Play developer documentation the user is sent to',
  'github.com': 'pinned releases of the managed binaries (asc, gpc)',
  'api.github.com': 'release metadata, used only by the lockfile updater',
  'docs.flutter.dev': 'Flutter documentation the user is sent to',
  'acme.example': 'the example privacy policy URL used by fixtures and tests',
};

describe('no telemetry: nothing is reported to anyone', () => {
  let journey: Journey | undefined;
  afterEach(async () => {
    await journey?.cleanup();
    journey = undefined;
  });

  it('opens no outbound connection during a complete release journey', async () => {
    const recording = recordNetwork();
    try {
      journey = await Journey.start({
        stores: ['apple', 'google'],
        fixture: 'flutter-app',
        manifest: releaseManifest({ stores: ['apple', 'google'], track: 'internal_testing' }),
      });

      // The whole conversation: understand, check the machine, look at the stores, plan,
      // apply, handle console work, recover.
      await journey.analyze();
      await journey.call('agentship_setup_status', { projectDir: journey.repoRoot });
      await journey.call('agentship_store_status', { projectDir: journey.repoRoot });
      await journey.driveToConvergence();
      await journey.pending('list');
      await journey.kill();
      await journey.resume();
      await journey.call('agentship_doctor', {});

      const external = recording.destinations.filter(
        (destination) => !isLoopback(destination.host),
      );
      expect(
        external,
        `Agentship contacted: ${external.map((entry) => `${entry.via}:${entry.host}`).join(', ')}`,
      ).toEqual([]);
    } finally {
      recording.stop();
    }
  });

  it('records a connection when there is one, so an empty recording means something', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const recording = recordNetwork();
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () => {
          socket.end();
          resolve();
        });
        socket.on('error', reject);
      });
      expect(recording.destinations.map((destination) => destination.port)).toContain(port);
    } finally {
      recording.stop();
      server.close();
    }
  });

  it('ships no URL outside the stores, their consoles and the pinned toolchain', async () => {
    const hosts = new Map<string, string[]>();
    for (const file of await shippedFiles()) {
      const text = await readFile(file, 'utf8');
      for (const match of text.matchAll(/https?:\/\/([a-zA-Z0-9._-]+)/g)) {
        const host = match[1] as string;
        if (isLoopback(host) || host.endsWith('.example.com') || host === 'example.com') continue;
        hosts.set(host, [...(hosts.get(host) ?? []), file.slice(REPO_ROOT.length)]);
      }
    }

    for (const [host, files] of hosts) {
      expect(
        Object.keys(ALLOWED_HOSTS),
        `${host} appears in ${files[0]} and is not a store, a console or the toolchain`,
      ).toContain(host);
    }
    // The stores themselves must still be there: an empty sweep would pass vacuously.
    expect([...hosts.keys()]).toEqual(
      expect.arrayContaining(['appstoreconnect.apple.com', 'play.google.com', 'github.com']),
    );
  });

  it('runs no install script when the package is installed', async () => {
    const files = ['package.json', 'packages/cli/package.json', 'e2e/package.json'];
    for (const relative of files) {
      const manifest = JSON.parse(await readFile(join(REPO_ROOT, relative), 'utf8')) as {
        scripts?: Record<string, string>;
      };
      for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
        expect(manifest.scripts?.[hook], `${relative} declares ${hook}`).toBeUndefined();
      }
    }
  });
});

/**
 * Everything that reaches a user's machine: the sources that get bundled, the runtime data,
 * the skills and the toolchain lockfile. Tests and fixtures are excluded — they never ship.
 */
async function shippedFiles(): Promise<string[]> {
  const roots = [join(REPO_ROOT, 'packages'), join(REPO_ROOT, 'scripts')];
  const collected: string[] = [];
  const keep = new Set(['.ts', '.yaml', '.yml', '.json', '.md']);

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', 'test', 'fixtures'].includes(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (keep.has(extname(entry.name))) collected.push(full);
    }
  }

  for (const root of roots) await walk(root);
  return collected;
}
