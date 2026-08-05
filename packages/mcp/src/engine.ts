import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { APPLE_VERIFIERS, appleDiffers, createAppleAdapter } from '@agentship/adapter-apple';
import { createGoogleAdapter, GOOGLE_VERIFIERS, googleDiffers } from '@agentship/adapter-google';
import { BUILD_LOCAL_KIND, BUILD_VERIFIERS, buildDiffer, buildRunner } from '@agentship/build';
import {
  type AdapterContext,
  createLogger,
  createMockState,
  DEFAULT_PROFILE,
  DIR_MODE,
  DifferRegistry,
  FILE_MODE,
  Kernel,
  type LocalActionRunner,
  type Logger,
  type LogSink,
  loadManifest,
  logsDir,
  MockStoreAdapter,
  mockVerifiers,
  type PendingVerifierMap,
  STORES,
  type Store,
  type StoreAdapter,
} from '@agentship/core';

/**
 * Wiring the engine for one project.
 *
 * The MCP layer owns no publishing logic: it builds a {@link Kernel} with the store
 * adapters and the differ registry, and then does nothing but translate. Adapters are
 * created once per project and reused, because the mock keeps its store state in memory
 * and a session that re-created it on every call would forget everything it just did.
 *
 * `AGENTSHIP_MOCK_STORES=1` swaps both adapters for the in-memory mock. That is how the
 * end-to-end flow is exercised — by tests and by a human trying the agent conversation —
 * without an Apple or Google account.
 */
export function mockStoresEnabled(): boolean {
  return process.env['AGENTSHIP_MOCK_STORES'] === '1';
}

export type AdapterFactory = (
  repoRoot: string,
) => ReadonlyMap<Store, StoreAdapter> | Promise<ReadonlyMap<Store, StoreAdapter>>;

function realAdapters(): ReadonlyMap<Store, StoreAdapter> {
  return new Map<Store, StoreAdapter>([
    ['apple', createAppleAdapter()],
    ['google', createGoogleAdapter()],
  ]);
}

function mockAdapters(): ReadonlyMap<Store, StoreAdapter> {
  return new Map<Store, StoreAdapter>(
    STORES.map((store) => [store, new MockStoreAdapter({ store, state: createMockState() })]),
  );
}

export function defaultAdapterFactory(): AdapterFactory {
  return () => (mockStoresEnabled() ? mockAdapters() : realAdapters());
}

/**
 * Every differ the engine plans with.
 *
 * This is the single extension point of the whole system: the MCP layer has no publishing
 * logic, so adding a resource to a release means adding a differ here and nothing else. The
 * three groups are deliberate — the build differ is store-neutral (both stores need an
 * artifact), and each store's differs own the parts of its own model.
 */
export function createRegistry(): DifferRegistry {
  const registry = new DifferRegistry();
  for (const store of STORES) registry.register(buildDiffer(store));
  for (const differ of appleDiffers()) registry.register(differ);
  for (const differ of googleDiffers()) registry.register(differ);
  return registry;
}

/**
 * Verifiers for console work, keyed by the check a pending operation declares.
 *
 * All of them, always. A verifier is a pure function of the neutral snapshot (plus, for the
 * build's keystore check, the project on disk), so it means the same thing whichever adapter
 * produced that snapshot — and the console catalog names real check ids, so a mock session
 * that registered only the mock's own checks could never demonstrate the verify step of a
 * first release. The mock's extra `mock:*` entries answer questions the mock alone models;
 * they sit alongside rather than instead.
 */
export function createVerifiers(mocked: boolean): PendingVerifierMap {
  const shared = [...APPLE_VERIFIERS, ...GOOGLE_VERIFIERS, ...BUILD_VERIFIERS];
  return new Map(mocked ? [...shared, ...mockVerifiers] : shared);
}

/** Runners for actions performed on this machine. Exactly one today: the build. */
export function createLocalRunners(): ReadonlyMap<string, LocalActionRunner> {
  return new Map([[BUILD_LOCAL_KIND, buildRunner()]]);
}

/**
 * The server's log sink: `~/.agentship/logs/mcp.log`, and nowhere else.
 *
 * Never stdout — that is the JSON-RPC stream, and one stray byte on it corrupts the
 * session. Records arrive already redacted from the logger; a write that fails is
 * swallowed, because losing a log line must never fail a tool call.
 */
export function mcpFileSink(): LogSink {
  let dir: string | undefined;
  return (record) => {
    try {
      if (dir === undefined) {
        dir = logsDir();
        mkdirSync(dir, { recursive: true, mode: DIR_MODE });
      }
      appendFileSync(join(dir, 'mcp.log'), `${JSON.stringify(record)}\n`, { mode: FILE_MODE });
    } catch {
      // Logging never breaks the server.
    }
  };
}

export function mcpLogger(): Logger {
  return createLogger({ bindings: { component: 'mcp' }, sinks: [mcpFileSink()] });
}

export interface EngineOptions {
  readonly profile?: string;
  readonly logger: Logger;
  readonly adapterFactory?: AdapterFactory;
}

/** Kernels and adapters, cached per project directory for the life of the session. */
export class Engine {
  readonly #adapters = new Map<string, ReadonlyMap<Store, StoreAdapter>>();
  readonly #factory: AdapterFactory;
  readonly #logger: Logger;
  readonly #explicitProfile: string | undefined;

  constructor(options: EngineOptions) {
    this.#factory = options.adapterFactory ?? defaultAdapterFactory();
    this.#logger = options.logger;
    this.#explicitProfile = options.profile;
  }

  /** The session-level profile: the explicit override, or the default. Project-agnostic. */
  get profile(): string {
    return this.#explicitProfile ?? DEFAULT_PROFILE;
  }

  /**
   * The credential profile effective for one project.
   *
   * Precedence: an explicit per-call profile (handled by the tools themselves) beats
   * everything; then a profile the session was constructed with (an operator override);
   * then `credentials.profile` from the project's manifest — which is what lets a
   * repository declare "this app publishes with the work account" and have every tool
   * honour it; then the default. Resolved lazily per project, because the session exists
   * before any project is known.
   */
  async profileFor(repoRoot: string): Promise<string> {
    if (this.#explicitProfile !== undefined) return this.#explicitProfile;
    const manifest = await loadManifest(repoRoot).catch(() => undefined);
    return manifest?.credentials.profile ?? DEFAULT_PROFILE;
  }

  /** The manifest's declared profile, when the project has one. For status reporting. */
  async manifestProfile(repoRoot: string): Promise<string | undefined> {
    const manifest = await loadManifest(repoRoot).catch(() => undefined);
    return manifest?.credentials.profile;
  }

  context(repoRoot: string, profile?: string): AdapterContext {
    return { profile: profile ?? this.profile, logger: this.#logger, cwd: repoRoot };
  }

  async adapters(repoRoot: string): Promise<ReadonlyMap<Store, StoreAdapter>> {
    const cached = this.#adapters.get(repoRoot);
    if (cached !== undefined) return cached;
    const created = await this.#factory(repoRoot);
    this.#adapters.set(repoRoot, created);
    return created;
  }

  async kernel(repoRoot: string): Promise<Kernel> {
    const adapters = await this.adapters(repoRoot);
    // Pending verifiers are adapter-specific: the mock's checks only mean something
    // against the mock, so the real ones are used only when every adapter is real.
    const mocked = [...adapters.values()].every((adapter) => adapter instanceof MockStoreAdapter);
    return new Kernel({
      repoRoot,
      adapters,
      context: this.context(repoRoot, await this.profileFor(repoRoot)),
      registry: createRegistry(),
      verifiers: createVerifiers(mocked),
      localRunners: createLocalRunners(),
    });
  }
}
