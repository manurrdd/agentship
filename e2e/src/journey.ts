import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { createAgentshipServer } from '@agentship/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * The end-to-end harness: one agent, one repository, one pair of stores.
 *
 * Every scenario in this suite is a *journey* — the whole conversation an agent has with
 * Agentship, from analysing a repository to a converged store — driven through the real MCP
 * protocol against the in-memory stores. The unit and contract suites inside each package
 * prove the pieces; this one proves that the pieces, wired the way a user gets them, take
 * an app from a directory on disk to a release.
 *
 * Two properties of the harness carry most of its value:
 *
 * - **The repository is real.** Scenarios start from the analyzer fixtures, so the manifest
 *   under test is the one `agentship_analyze` writes, not one a test author hand-tuned.
 * - **The process can die.** {@link Journey.kill} throws away the server, the session and
 *   every kernel cached inside it, and brings a new one up on the same directory. The store
 *   adapters survive, because a store does not forget when a client crashes. That asymmetry
 *   is what makes the kill matrix a test of the journal rather than of memory.
 */
export type FixtureName =
  | 'flutter-app'
  | 'react-native-app'
  | 'expo-app'
  | 'ios-native-app'
  | 'android-native-app'
  | 'privacy-app';

const FIXTURES = fileURLToPath(new URL('../../packages/analyzer/test/fixtures/', import.meta.url));

export interface JourneyOptions {
  readonly stores?: readonly Store[];
  /** Analyzer fixture copied into the repository before anything runs. */
  readonly fixture?: FixtureName;
  /** Desired state to write. Omit to leave the project without one (`agentship_analyze` writes it). */
  readonly manifest?: AgentshipManifest;
  readonly state?: (store: Store) => Partial<MockStoreState>;
  readonly processingTicks?: number;
  /** Pre-built artifacts the release manifests point at. Defaults to true. */
  readonly artifacts?: boolean;
}

export interface CallResult {
  readonly isError: boolean;
  readonly text: string;
  readonly payload: Record<string, unknown>;
}

export interface PlanAction {
  readonly id: string;
  readonly classification: string;
  readonly kind: string;
  readonly summary: string;
  readonly store: string;
}

export interface PlanView {
  readonly planId: string;
  readonly actions: readonly PlanAction[];
  readonly approvalsRequired: readonly string[];
  readonly warnings: readonly string[];
}

export interface Outcome {
  readonly actionId: string;
  readonly status: string;
  readonly detail?: string;
  readonly errorMessage?: string;
}

/** One tool call, kept so a failing scenario prints the conversation that produced it. */
export interface TranscriptEntry {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly ok: boolean;
  readonly summary: string;
}

export class Journey {
  readonly repoRoot: string;
  readonly home: string;
  readonly adapters: ReadonlyMap<Store, MockStoreAdapter>;
  readonly transcript: TranscriptEntry[] = [];
  #client: Client;
  #server: McpServer;
  /** How many times the process was killed and brought back up. */
  #restarts = 0;

  private constructor(
    repoRoot: string,
    home: string,
    adapters: ReadonlyMap<Store, MockStoreAdapter>,
    client: Client,
    server: McpServer,
  ) {
    this.repoRoot = repoRoot;
    this.home = home;
    this.adapters = adapters;
    this.#client = client;
    this.#server = server;
  }

  static async start(options: JourneyOptions = {}): Promise<Journey> {
    const stores = options.stores ?? ['apple'];
    const repoRoot = await mkdtemp(join(tmpdir(), 'agentship-e2e-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'agentship-e2e-home-'));
    process.env['AGENTSHIP_HOME'] = home;

    if (options.fixture !== undefined) {
      await cp(join(FIXTURES, options.fixture), repoRoot, { recursive: true, force: true });
    }
    if (options.manifest !== undefined) await saveManifest(repoRoot, options.manifest);
    if (options.artifacts !== false) {
      const dir = join(repoRoot, 'artifacts');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'app.ipa'), 'not a real archive');
      await writeFile(join(dir, 'app.aab'), 'not a real archive');
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

    const { client, server } = await connect(adapters);
    return new Journey(repoRoot, home, adapters, client, server);
  }

  get restarts(): number {
    return this.#restarts;
  }

  adapter(store: Store): MockStoreAdapter {
    const adapter = this.adapters.get(store);
    if (adapter === undefined) throw new Error(`the journey has no ${store} adapter`);
    return adapter;
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
    const result = (await this.#client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { type: string; text?: string }[];
    };
    const text = result.content.map((entry) => entry.text ?? '').join('');
    const payload = JSON.parse(text) as Record<string, unknown>;
    this.transcript.push({
      tool: name,
      args,
      ok: result.isError !== true,
      summary: summarize(payload),
    });
    return { isError: result.isError === true, text, payload };
  }

  /**
   * The process dies and comes back.
   *
   * Nothing is handed over: the new session re-reads the journal and the manifest from
   * disk and re-captures store state, which is exactly what `agentship_resume` promises.
   */
  async kill(): Promise<void> {
    await this.#client.close();
    await this.#server.close();
    this.#restarts += 1;
    const { client, server } = await connect(this.adapters);
    this.#client = client;
    this.#server = server;
    this.transcript.push({ tool: '<process killed>', args: {}, ok: true, summary: 'restarted' });
  }

  async analyze(): Promise<CallResult> {
    return this.call('agentship_analyze', { projectDir: this.repoRoot });
  }

  async plan(args: Record<string, unknown> = {}): Promise<PlanView> {
    const planned = await this.call('agentship_plan', { projectDir: this.repoRoot, ...args });
    return planOf(planned.payload);
  }

  /** Apply, approving exactly the ids the plan asked for — the agent loop after the user says yes. */
  async apply(
    plan: PlanView,
    approvals: readonly string[] = plan.approvalsRequired,
    extra: Record<string, unknown> = {},
  ) {
    const applied = await this.call('agentship_apply', {
      planId: plan.planId,
      approvals: [...approvals],
      ...extra,
    });
    return {
      ok: applied.payload['ok'] === true,
      outcomes: outcomesOf(applied.payload),
      plan: planOf(applied.payload),
      emittedPending: (applied.payload['emittedPending'] ?? []) as { id: string }[],
      payload: applied.payload,
    };
  }

  async resume(approvals: readonly string[] = []) {
    const resumed = await this.call('agentship_resume', {
      projectDir: this.repoRoot,
      approvals: [...approvals],
    });
    return {
      ok: resumed.payload['ok'] === true,
      outcomes: outcomesOf(resumed.payload),
      plan: planOf(resumed.payload),
      payload: resumed.payload,
    };
  }

  /**
   * Plan → approve → apply, until the plan empties or a round executes nothing.
   *
   * A round that executes nothing is not a failure: it is what "everything left is
   * withheld on purpose" looks like — console work that only re-emits a pending
   * operation, a value the user has not provided, a store that keeps refusing. The result
   * carries the plan that was left, so a scenario can say which of the two it expected.
   */
  async driveToConvergence(
    rounds = 10,
  ): Promise<{ rounds: number; converged: boolean; remaining: PlanView }> {
    let plan = await this.plan();
    for (let round = 1; round <= rounds; round += 1) {
      if (plan.actions.length === 0) return { rounds: round, converged: true, remaining: plan };
      const applied = await this.apply(plan);
      if (!applied.outcomes.some((outcome) => outcome.status === 'done')) {
        return { rounds: round, converged: false, remaining: applied.plan };
      }
      plan = await this.plan();
    }
    return { rounds, converged: plan.actions.length === 0, remaining: plan };
  }

  async pending(action: string, args: Record<string, unknown> = {}): Promise<CallResult> {
    return this.call('agentship_pending', { projectDir: this.repoRoot, action, ...args });
  }

  /** The conversation so far, for a failure message. */
  render(): string {
    return this.transcript
      .map(
        (entry, index) =>
          `${index + 1}. ${entry.tool} ${entry.ok ? '' : '(error) '}${entry.summary}`,
      )
      .join('\n');
  }

  async cleanup(): Promise<void> {
    await this.#client.close();
    await this.#server.close();
    await rm(this.repoRoot, { recursive: true, force: true });
    await rm(this.home, { recursive: true, force: true });
  }
}

async function connect(
  adapters: ReadonlyMap<Store, MockStoreAdapter>,
): Promise<{ client: Client; server: McpServer }> {
  const { server } = createAgentshipServer({
    logger: createLogger({ level: 'silent', sinks: [] }),
    adapterFactory: () => adapters as ReadonlyMap<Store, StoreAdapter>,
  });
  const client = new Client({ name: 'agentship-e2e', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

export function planOf(payload: Record<string, unknown>): PlanView {
  const plan = (payload['plan'] ?? {}) as Partial<PlanView>;
  return {
    planId: plan.planId ?? '',
    actions: plan.actions ?? [],
    approvalsRequired: plan.approvalsRequired ?? [],
    warnings: plan.warnings ?? [],
  };
}

export function outcomesOf(payload: Record<string, unknown>): Outcome[] {
  return (payload['outcomes'] ?? []) as Outcome[];
}

export function kindsOf(plan: PlanView): string[] {
  return plan.actions.map((action) => action.kind);
}

/** A one-line shape of a tool payload: enough to follow a failing journey, never a dump. */
function summarize(payload: Record<string, unknown>): string {
  const plan = payload['plan'] as
    | { actions?: unknown[]; approvalsRequired?: unknown[] }
    | undefined;
  const parts: string[] = [];
  if (plan?.actions !== undefined) {
    parts.push(`${plan.actions.length} actions, ${plan.approvalsRequired?.length ?? 0} approvals`);
  }
  const outcomes = payload['outcomes'] as { status: string }[] | undefined;
  if (outcomes !== undefined) {
    const counts = new Map<string, number>();
    for (const outcome of outcomes)
      counts.set(outcome.status, (counts.get(outcome.status) ?? 0) + 1);
    parts.push([...counts].map(([status, count]) => `${count} ${status}`).join(', '));
  }
  const error = payload['error'] as { code?: string } | undefined;
  if (error?.code !== undefined) parts.push(error.code);
  return parts.join(' | ');
}
