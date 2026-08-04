import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ActionDraft,
  type AgentshipManifest,
  createLogger,
  createMockState,
  ManifestSchema,
  MockStoreAdapter,
  type MockStoreState,
  type RemoteAppState,
  type ResourceDiffer,
  type Store,
} from '@agentship/core';

/**
 * Running one differ against one snapshot.
 *
 * Differs are pure functions of (manifest, snapshot), so they can be tested exactly as they
 * are used: build a store state, build a manifest, ask what should change. The snapshot
 * comes from the mock adapter rather than from a literal, so the tests are written against
 * the same shape the kernel really sees.
 */
export async function stateOf(
  store: Store,
  overrides: Partial<MockStoreState> = {},
): Promise<RemoteAppState> {
  const adapter = new MockStoreAdapter({ store, state: createMockState(overrides) });
  return adapter.getAppState(
    { profile: 'default', logger: createLogger({ level: 'silent', sinks: [] }) },
    { store, id: 'app-1' },
  );
}

export function manifestFor(overrides: Record<string, unknown> = {}): AgentshipManifest {
  return ManifestSchema.parse({
    version: 1,
    app: { name: 'Mock App' },
    stores: {
      apple: { bundleId: 'com.example.mock', appId: 'app-1' },
      google: { packageName: 'com.example.mock' },
    },
    release: { version: '1.1.0', buildNumber: '42', track: 'internal_testing' },
    metadata: {
      primaryLocale: 'en-US',
      locales: { 'en-US': { name: 'Mock App', description: 'Fresh new description.' } },
    },
    ...overrides,
  });
}

export interface DifferRun {
  readonly drafts: readonly ActionDraft[];
  readonly repoRoot: string;
  cleanup(): Promise<void>;
}

export async function runDiffer(
  differ: ResourceDiffer,
  manifest: AgentshipManifest,
  state: RemoteAppState,
): Promise<DifferRun> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'agentship-differ-'));
  const drafts = await differ.plan({ store: differ.store, manifest, state, repoRoot });
  return {
    drafts: [...drafts],
    repoRoot,
    cleanup: () => rm(repoRoot, { recursive: true, force: true }),
  };
}

/** The single draft a differ produced, for the common one-action case. */
export function only(drafts: readonly ActionDraft[]): ActionDraft {
  if (drafts.length !== 1) {
    throw new Error(
      `expected exactly one draft, got ${drafts.length}: ${drafts.map((d) => d.kind).join(', ')}`,
    );
  }
  return drafts[0] as ActionDraft;
}
