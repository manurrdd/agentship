import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AdapterContext,
  type AgentshipManifest,
  createLogger,
  createMockState,
  DifferRegistry,
  Kernel,
  ManifestSchema,
  MockStoreAdapter,
  type MockStoreState,
  metadataDiffer,
  mockVerifiers,
  releaseDiffer,
  type Store,
  saveManifest,
} from '@agentship/core';

/**
 * Harness for kernel tests: a scratch repo with a manifest, mock adapters, and a kernel
 * wired to the two reference differs — the setup the rest of the suite reuses.
 */
export function testContext(): AdapterContext {
  return { profile: 'default', logger: createLogger({ level: 'silent', sinks: [] }) };
}

export interface ManifestOverrides {
  readonly stores?: readonly Store[];
  readonly description?: string;
  readonly version?: string;
  readonly buildNumber?: string;
  readonly track?: 'internal_testing' | 'closed_testing' | 'open_testing' | 'production';
  readonly withArtifacts?: boolean;
}

export function testManifest(overrides: ManifestOverrides = {}): AgentshipManifest {
  const stores = overrides.stores ?? ['apple'];
  const withArtifacts = overrides.withArtifacts ?? true;
  return ManifestSchema.parse({
    version: 1,
    app: { name: 'Mock App' },
    stores: {
      ...(stores.includes('apple')
        ? { apple: { bundleId: 'com.example.mock', appId: 'app-1' } }
        : {}),
      ...(stores.includes('google') ? { google: { packageName: 'com.example.mock' } } : {}),
    },
    release: {
      version: overrides.version ?? '1.1.0',
      buildNumber: overrides.buildNumber ?? '42',
      track: overrides.track ?? 'internal_testing',
      ...(withArtifacts
        ? {
            artifacts: {
              ...(stores.includes('apple')
                ? { apple: { path: 'artifacts/app.ipa', kind: 'ipa' } }
                : {}),
              ...(stores.includes('google')
                ? { google: { path: 'artifacts/app.aab', kind: 'aab' } }
                : {}),
            },
          }
        : {}),
    },
    metadata: {
      primaryLocale: 'en-US',
      locales: {
        'en-US': {
          name: 'Mock App',
          description: overrides.description ?? 'Fresh new description.',
        },
      },
    },
  });
}

export interface Harness {
  readonly repoRoot: string;
  readonly kernel: Kernel;
  readonly adapters: ReadonlyMap<Store, MockStoreAdapter>;
  readonly context: AdapterContext;
  cleanup(): Promise<void>;
}

export interface HarnessOptions {
  readonly stores?: readonly Store[];
  readonly manifest?: AgentshipManifest;
  readonly state?: (store: Store) => Partial<MockStoreState>;
  readonly processingTicks?: number;
}

/**
 * The pre-built artifacts `testManifest` points at.
 *
 * They only have to exist: the build differ's question is "is there an artifact this release
 * could publish?", and a user-supplied one is taken at its word. Tests that exercise the
 * build itself write real archives instead.
 */
export async function writeArtifacts(repoRoot: string): Promise<void> {
  const dir = join(repoRoot, 'artifacts');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'app.ipa'), 'not a real archive');
  await writeFile(join(dir, 'app.aab'), 'not a real archive');
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const stores = options.stores ?? ['apple'];
  const repoRoot = await mkdtemp(join(tmpdir(), 'agentship-kernel-'));
  await saveManifest(repoRoot, options.manifest ?? testManifest({ stores }));
  await writeArtifacts(repoRoot);

  const registry = new DifferRegistry();
  const adapters = new Map<Store, MockStoreAdapter>();
  for (const store of stores) {
    registry.register(metadataDiffer(store)).register(releaseDiffer(store));
    adapters.set(
      store,
      new MockStoreAdapter({
        store,
        state: createMockState(options.state?.(store) ?? {}),
        ...(options.processingTicks === undefined
          ? {}
          : { processingTicks: options.processingTicks }),
      }),
    );
  }

  const context = testContext();
  const kernel = new Kernel({
    repoRoot,
    adapters,
    context,
    registry,
    verifiers: mockVerifiers,
  });
  return {
    repoRoot,
    kernel,
    adapters,
    context,
    cleanup: () => rm(repoRoot, { recursive: true, force: true }),
  };
}
