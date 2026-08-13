import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentshipError, createLogger, saveManifest } from '@agentship/core';
import { afterEach, describe, expect, it } from 'vitest';
import { testManifest } from '../../core/test/kernel-helpers.js';
import { Session } from '../src/session.js';
import { AGENTSHIP_TOOL_NAMES } from '../src/tools/index.js';
import { actionsOf, createMcpHarness, type McpHarness, outcomesOf } from './helpers.js';

/**
 * The vertical slice, driven exclusively through MCP.
 *
 * Everything here goes through a protocol client: if these pass, an agent that speaks MCP
 * and nothing else can take an app from "look at this repo" to "submitted", including the
 * parts that need a human.
 */
describe('agentship MCP session', () => {
  let harness: McpHarness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('exposes exactly the frozen tool catalog', async () => {
    harness = await createMcpHarness();
    const { tools } = await harness.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...AGENTSHIP_TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(200);
      expect(tool.inputSchema).toBeDefined();
    }
  });

  it('runs plan → approve → apply and reaches the desired state', async () => {
    harness = await createMcpHarness({ stores: ['apple'] });

    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    expect(planned.isError).toBe(false);
    const plan = planned.payload['plan'] as { planId: string; approvalsRequired: string[] };
    const actions = actionsOf(planned.payload);
    // The manifest targets a TestFlight track, so there is no App Store submission here:
    // the version is created, its text set, and the build uploaded.
    expect(actions.map((action) => action.kind).sort()).toEqual(
      ['ensure_version', 'set_metadata', 'upload_build'].sort(),
    );

    // Applying with no approvals is legitimate: everything `auto` runs, everything that
    // needs a human comes back withheld — and nothing approval-gated is touched.
    const withheld = await harness.call('agentship_apply', { planId: plan.planId });
    expect(withheld.isError).toBe(false);
    const withheldOutcomes = outcomesOf(withheld.payload);
    for (const id of plan.approvalsRequired) {
      expect(withheldOutcomes.find((outcome) => outcome.actionId === id)?.status).toBe(
        'needs_approval',
      );
    }
    expect(harness.adapters.get('apple')?.effects.metadataWrites).toBe(0);
    expect(harness.adapters.get('apple')?.effects.submits).toBe(0);

    // The upload changed the store, so the fresh plan carries new ids: approve against
    // those, never against the ones from before the run.
    const fresh = withheld.payload['plan'] as { planId: string; approvalsRequired: string[] };

    const applied = await harness.call('agentship_apply', {
      planId: fresh.planId,
      approvals: fresh.approvalsRequired,
    });
    expect(applied.payload['ok']).toBe(true);
    const statuses = new Set(outcomesOf(applied.payload).map((outcome) => outcome.status));
    expect(statuses.has('done')).toBe(true);

    // Converged: replanning finds nothing left to do.
    const after = await harness.call('agentship_plan', {});
    expect(actionsOf(after.payload)).toHaveLength(0);
    expect(after.payload['nextStep']).toContain('Nothing to do');
  });

  it('reports needs_input instead of inventing manifest values', async () => {
    harness = await createMcpHarness({ stores: ['apple'] });
    const { writeFile } = await import('node:fs/promises');
    const { manifestPath } = await import('@agentship/core');
    const path = manifestPath(harness.repoRoot);
    const { readFile } = await import('node:fs/promises');
    const yaml = await readFile(path, 'utf8');
    await writeFile(path, yaml.replace('Fresh new description.', '<needs_input>'));

    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const metadata = actionsOf(planned.payload).find((action) => action.kind === 'set_metadata');
    expect(metadata?.classification).toBe('needs_input');
    const plan = planned.payload['plan'] as { planId: string };
    const applied = await harness.call('agentship_apply', { planId: plan.planId });
    const outcome = outcomesOf(applied.payload).find(
      (entry) => entry.actionId === (metadata?.id as string),
    );
    expect(outcome?.status).toBe('needs_input');
    expect(harness.adapters.get('apple')?.effects.metadataWrites).toBe(0);
  });

  it('rejects an approval that does not match the current plan', async () => {
    harness = await createMcpHarness({ stores: ['apple'] });
    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const plan = planned.payload['plan'] as { planId: string; approvalsRequired: string[] };
    const forged = `${(plan.approvalsRequired[0] as string).slice(0, -4)}0000`;

    const applied = await harness.call('agentship_apply', {
      planId: plan.planId,
      approvals: [forged],
    });
    expect(applied.payload['staleApprovals']).toEqual([forged]);
    const outcomes = outcomesOf(applied.payload);
    expect(outcomes.some((outcome) => outcome.status === 'needs_approval')).toBe(true);
    expect(harness.adapters.get('apple')?.effects.metadataWrites).toBe(0);
  });

  it('surfaces console-only work through agentship_pending and unblocks after verifying', async () => {
    harness = await createMcpHarness({
      stores: ['google'],
      state: () => ({ contentRatingDone: false }),
    });

    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const snapshotsBeforeList = harness.adapters.get('google')?.effects.snapshots ?? 0;
    const pendingList = await harness.call('agentship_pending', { action: 'list' });
    // Listing is local by default: an ordinary itinerary must not pay for a slow store
    // snapshot or hang behind the store CLI. Reconciliation is explicit and batched.
    expect(harness.adapters.get('google')?.effects.snapshots).toBe(snapshotsBeforeList);
    expect((pendingList.payload['refreshAvailable'] as string[]).length).toBeGreaterThan(0);
    await harness.call('agentship_pending', { action: 'list', refresh: true });
    expect(harness.adapters.get('google')?.effects.snapshots).toBeGreaterThan(snapshotsBeforeList);
    const operations = pendingList.payload['pending'] as {
      id: string;
      status: string;
      actionClass: string;
      blocking?: string[];
    }[];
    const contentRating = operations.find((operation) => operation.id.includes('content-rating'));
    expect(contentRating).toBeDefined();
    expect(contentRating?.blocking?.length).toBeGreaterThan(0);

    const plan = planned.payload['plan'] as { planId: string; approvalsRequired: string[] };
    const blockedRun = await harness.call('agentship_apply', {
      planId: plan.planId,
      approvals: plan.approvalsRequired,
    });
    const submitOutcome = outcomesOf(blockedRun.payload).find((outcome) =>
      outcome.actionId.startsWith('submit_for_review'),
    );
    expect(submitOutcome?.status).toBe('blocked');

    // The console work happens, the store reflects it, and verification promotes it.
    const adapter = harness.adapters.get('google');
    if (adapter !== undefined) adapter.state.contentRatingDone = true;
    await harness.call('agentship_pending', {
      action: 'complete',
      id: contentRating?.id as string,
      notes: 'IARC questionnaire submitted',
    });
    const verified = await harness.call('agentship_pending', {
      action: 'verify',
      id: contentRating?.id as string,
    });
    expect((verified.payload['verifications'] as { verified: boolean }[])[0]?.verified).toBe(true);

    const resumed = await harness.call('agentship_resume', {});
    const remaining = resumed.payload['plan'] as { approvalsRequired: string[] };
    const finished = await harness.call('agentship_apply', {
      planId: (resumed.payload['planId'] ?? '') as string,
      approvals: remaining.approvalsRequired,
    });
    expect(finished.payload['ok']).toBe(true);
    expect(adapter?.effects.submits).toBe(1);
  });

  it('resumes after an interruption without repeating a non-idempotent operation', async () => {
    harness = await createMcpHarness({ stores: ['apple'] });
    const adapter = harness.adapters.get('apple');
    // The upload lands in the store and *then* the connection dies: the write-ahead case.
    adapter?.injectFailure({ operation: 'uploadBuild', phase: 'after' });

    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const plan = planned.payload['plan'] as { planId: string; approvalsRequired: string[] };
    const failed = await harness.call('agentship_apply', {
      planId: plan.planId,
      approvals: plan.approvalsRequired,
    });
    expect(failed.payload['ok']).toBe(false);
    expect(adapter?.effects.uploads).toBe(1);

    const resumed = await harness.call('agentship_resume', {});
    const nextPlan = resumed.payload['plan'] as {
      actions: { kind: string }[];
      approvalsRequired: string[];
    };
    expect(nextPlan.actions.some((action) => action.kind === 'upload_build')).toBe(false);

    const finished = await harness.call('agentship_apply', {
      planId: resumed.payload['planId'] as string,
      approvals: nextPlan.approvalsRequired,
    });
    expect(finished.payload['ok']).toBe(true);
    expect(adapter?.effects.uploads).toBe(1);
  });

  it('rehearses with a dry run without executing or approving anything', async () => {
    harness = await createMcpHarness({ stores: ['apple'] });
    const rehearsed = await harness.call('agentship_plan', {
      projectDir: harness.repoRoot,
      dryRunLevel: 'local',
    });
    const dryRun = rehearsed.payload['dryRun'] as {
      outcomes: { status: string }[];
      ok: boolean;
    };
    expect(dryRun.outcomes.some((outcome) => outcome.status === 'needs_approval')).toBe(true);
    expect(harness.adapters.get('apple')?.effects.metadataWrites).toBe(0);
  });

  it('reports progress to a client that asked for it, and works for one that did not', async () => {
    harness = await createMcpHarness({ stores: ['apple'] });
    const notifications: { message?: string }[] = [];
    const result = await harness.client.callTool(
      { name: 'agentship_plan', arguments: { projectDir: harness.repoRoot } },
      undefined,
      {
        onprogress: (progress) => {
          notifications.push(progress as { message?: string });
        },
      },
    );
    expect((result as { isError?: boolean }).isError ?? false).toBe(false);
    expect(notifications.length).toBeGreaterThan(0);

    // Without a progress token the same call still succeeds; progress is a courtesy.
    const plain = await harness.call('agentship_plan', {});
    expect(plain.isError).toBe(false);
  });

  it('reports what this machine can build without compiling anything', async () => {
    harness = await createMcpHarness({ stores: ['apple'] });
    const status = await harness.call('agentship_build', { projectDir: harness.repoRoot });
    expect(status.isError).toBe(false);

    const support = status.payload['support'] as { platform: string; status: string }[];
    expect(support.map((entry) => entry.platform)).toEqual(['ios']);
    // A scratch directory is not an app, so the honest answer is that it cannot be built —
    // with the way around it, never a silent failure later.
    expect(support[0]?.status).not.toBe('supported');
    expect(status.payload['nextStep']).toContain('artifact');

    // "status" is a read: nothing was written to the artifact register.
    expect(status.payload['artifacts']).toEqual({});
  });

  /**
   * An itinerary is only useful if it lists work that is actually left.
   *
   * Console work is finished in a browser, so Agentship never observes it happening — the
   * store is the only witness. An explicit refreshed list closes stale entries in one batch;
   * the ordinary list remains local so merely viewing the itinerary never hangs on a store.
   */
  it('closes pending work the store already shows as done when listing with refresh', async () => {
    harness = await createMcpHarness({
      stores: ['google'],
      state: () => ({ contentRatingDone: false }),
    });
    await harness.call('agentship_plan', { projectDir: harness.repoRoot });

    const before = await harness.call('agentship_pending', { action: 'list' });
    const open = (before.payload['pending'] as { id: string; status: string }[]).find((operation) =>
      operation.id.includes('content-rating'),
    );
    expect(open?.status).toBe('open');

    // The user does it in the console; nobody tells Agentship.
    const adapter = harness.adapters.get('google');
    if (adapter !== undefined) adapter.state.contentRatingDone = true;

    const after = await harness.call('agentship_pending', { action: 'list', refresh: true });
    const closed = (after.payload['pending'] as { id: string; status: string }[]).find(
      (operation) => operation.id.includes('content-rating'),
    );
    expect(closed?.status).toBe('verified');
    expect((after.payload['counts'] as { open: number }).open).toBeLessThan(
      (before.payload['counts'] as { open: number }).open,
    );
  });

  /**
   * `list`, `get` and `verify` have to agree about which operations exist.
   *
   * The first-release itinerary comes from the catalog, not from a plan — nothing has been
   * planned yet, because the app record a plan needs is what the itinerary is telling the
   * user to create. `list` showed that step and `get` explained it, but `verify` answered
   * `PLAN_NOT_FOUND`, so the one thing the user had just been told to do was the one thing
   * they could not confirm having done.
   */
  it('verifies a first-release step the catalog knows and no plan has emitted', async () => {
    harness = await createMcpHarness({ stores: ['apple'] });
    const id = 'apple:create-app-record';

    const listed = await harness.call('agentship_pending', {
      action: 'list',
      projectDir: harness.repoRoot,
    });
    expect((listed.payload['pending'] as { id: string }[]).map((o) => o.id)).toContain(id);
    expect((await harness.call('agentship_pending', { action: 'get', id })).isError).toBe(false);

    const verified = await harness.call('agentship_pending', { action: 'verify', id });
    expect(verified.isError).toBe(false);
    const results = verified.payload['verifications'] as { id: string; verified: boolean }[];
    expect(results[0]?.id).toBe(id);
    expect(results[0]?.verified).toBe(true);
  });

  it('refuses to work without a project and says how to fix it', async () => {
    harness = await createMcpHarness();
    const result = await harness.call('agentship_plan', {});
    expect(result.isError).toBe(true);
    const error = result.payload['error'] as { code: string; remediation?: { summary: string } };
    expect(error.code).toBe('CONFIG_NOT_FOUND');
    expect(error.remediation?.summary).toContain('agentship_analyze');
  });
});

/**
 * Which project a call with no arguments is about.
 *
 * The session only remembers a project for as long as the server process lives, so an agent
 * whose context was compacted — or that simply comes back the next day — used to be told
 * "no project directory is set" for a repository sitting right next to the working
 * directory. Recovering from that is mechanical, so the session does it, but only where
 * there is nothing to guess.
 */
describe('resolving the project when the session has forgotten it', () => {
  const silent = createLogger({ level: 'silent', sinks: [] });
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function tree(projects: readonly string[]): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'agentship-cwd-'));
    dirs.push(root);
    for (const project of projects) {
      await mkdir(join(root, project), { recursive: true });
      await saveManifest(join(root, project), testManifest({ stores: ['apple'] }));
    }
    return root;
  }

  it('adopts an initialised project at the working directory', async () => {
    const root = await tree(['.']);
    await expect(
      new Session({ logger: silent, workingDirectory: root }).requireProject(),
    ).resolves.toBe(root);
  });

  it('adopts the single project below the working directory', async () => {
    const root = await tree(['app']);
    await expect(
      new Session({ logger: silent, workingDirectory: root }).requireProject(),
    ).resolves.toBe(join(root, 'app'));
  });

  it('refuses to choose between several, and names them', async () => {
    const root = await tree(['ios-app', 'android-app']);
    const error = await new Session({ logger: silent, workingDirectory: root })
      .requireProject()
      .catch((cause: unknown) => cause);
    expect(AgentshipError.is(error)).toBe(true);
    expect((error as AgentshipError).code).toBe('CONFIG_NOT_FOUND');
    expect((error as AgentshipError).details?.['candidates']).toHaveLength(2);
  });

  it('never adopts a directory that is not an Agentship project', async () => {
    const root = await tree([]);
    await mkdir(join(root, 'some-repo'), { recursive: true });
    await expect(
      new Session({ logger: silent, workingDirectory: root }).requireProject(),
    ).rejects.toMatchObject({ code: 'CONFIG_NOT_FOUND' });
  });
});
