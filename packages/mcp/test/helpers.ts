import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentshipManifest,
  createLogger,
  createMockState,
  MockStoreAdapter,
  type MockStoreState,
  type Store,
  type StoreAdapter,
  saveManifest,
} from '@agentship/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { testManifest, writeArtifacts } from '../../core/test/kernel-helpers.js';
import { createAgentshipServer } from '../src/server.js';

/**
 * A real MCP session against the mock stores.
 *
 * The tests drive the server through an actual protocol client — `listTools`, `callTool`,
 * JSON payloads — rather than calling the handlers directly, because the contract this
 * plan delivers is the protocol surface, not the functions behind it.
 */
export interface McpHarness {
  readonly client: Client;
  readonly repoRoot: string;
  readonly home: string;
  readonly adapters: ReadonlyMap<Store, MockStoreAdapter>;
  call(name: string, args?: Record<string, unknown>): Promise<CallResult>;
  cleanup(): Promise<void>;
}

export interface CallResult {
  readonly isError: boolean;
  readonly text: string;
  readonly payload: Record<string, unknown>;
}

export interface HarnessOptions {
  readonly stores?: readonly Store[];
  readonly manifest?: AgentshipManifest;
  readonly state?: (store: Store) => Partial<MockStoreState>;
  readonly processingTicks?: number;
  /** Skip writing a manifest, to exercise the "project not set up yet" paths. */
  readonly withoutManifest?: boolean;
}

export async function createMcpHarness(options: HarnessOptions = {}): Promise<McpHarness> {
  const stores = options.stores ?? ['apple'];
  const repoRoot = await mkdtemp(join(tmpdir(), 'agentship-mcp-repo-'));
  const home = await mkdtemp(join(tmpdir(), 'agentship-mcp-home-'));
  process.env['AGENTSHIP_HOME'] = home;

  if (options.withoutManifest !== true) {
    await saveManifest(repoRoot, options.manifest ?? testManifest({ stores }));
    await writeArtifacts(repoRoot);
  }

  const adapters = new Map<Store, MockStoreAdapter>();
  for (const store of stores) {
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

  const { server } = createAgentshipServer({
    logger: createLogger({ level: 'silent', sinks: [] }),
    adapterFactory: () => adapters as ReadonlyMap<Store, StoreAdapter>,
  });
  const client = new Client({ name: 'agentship-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    repoRoot,
    home,
    adapters,
    async call(name, args = {}) {
      const result = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { type: string; text?: string }[];
      };
      const text = result.content.map((entry) => entry.text ?? '').join('');
      return {
        isError: result.isError === true,
        text,
        payload: JSON.parse(text) as Record<string, unknown>,
      };
    },
    async cleanup() {
      await client.close();
      await server.close();
      await rm(repoRoot, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    },
  };
}

/** Every action of a plan payload, typed loosely for assertions. */
export interface PlanAction {
  readonly id: string;
  readonly classification: string;
  readonly kind: string;
  readonly summary: string;
  readonly store: string;
}

export function actionsOf(payload: Record<string, unknown>): PlanAction[] {
  const plan = payload['plan'] as { actions?: PlanAction[] } | undefined;
  return plan?.actions ?? [];
}

export function outcomesOf(
  payload: Record<string, unknown>,
): { actionId: string; status: string }[] {
  return (payload['outcomes'] ?? []) as { actionId: string; status: string }[];
}
