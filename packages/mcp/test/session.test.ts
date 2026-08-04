import { afterEach, describe, expect, it } from 'vitest';
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
    const pendingList = await harness.call('agentship_pending', { action: 'list' });
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
    expect(verified.payload['verified']).toBe(true);

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

  it('refuses to work without a project and says how to fix it', async () => {
    harness = await createMcpHarness();
    const result = await harness.call('agentship_plan', {});
    expect(result.isError).toBe(true);
    const error = result.payload['error'] as { code: string; remediation?: { summary: string } };
    expect(error.code).toBe('CONFIG_NOT_FOUND');
    expect(error.remediation?.summary).toContain('agentship_analyze');
  });
});
