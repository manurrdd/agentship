import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, ManifestSchema, saveManifest } from '@agentship/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createAgentshipServer } from '../src/server.js';

/**
 * Against the real stores, with real credentials.
 *
 * Gated twice over, and the second gate is the one that matters: `AGENTSHIP_E2E_APPLE=1` /
 * `AGENTSHIP_E2E_GOOGLE=1` turn the tests on, and the scenarios themselves stop well short of
 * anything irreversible. TestFlight and the internal test track are the ceiling. Nothing
 * here submits for review, nothing touches production, and nothing approves an action that
 * would.
 *
 * That is not caution for its own sake: a test that can submit an app for review can also
 * do it by accident, on someone's real account, in a CI run nobody was watching. The
 * approvals in these tests are therefore filtered by classification, never taken wholesale
 * from `approvalsRequired`.
 *
 *     AGENTSHIP_E2E_APPLE=1 AGENTSHIP_E2E_TEST_BUNDLE_ID=com.you.app \
 *     AGENTSHIP_E2E_TEST_APP_ID=123456789 pnpm vitest run packages/mcp/test/real-store.e2e.test.ts
 */
const appleEnabled =
  process.env['AGENTSHIP_E2E_APPLE'] === '1' &&
  process.env['AGENTSHIP_E2E_TEST_BUNDLE_ID'] !== undefined &&
  process.env['AGENTSHIP_E2E_TEST_APP_ID'] !== undefined;
const googleEnabled =
  process.env['AGENTSHIP_E2E_GOOGLE'] === '1' &&
  process.env['AGENTSHIP_E2E_TEST_PACKAGE'] !== undefined;

interface RealSession {
  call(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  readonly repoRoot: string;
  cleanup(): Promise<void>;
}

/** A real MCP session against the real adapters — no mock in sight. */
async function realSession(manifest: unknown): Promise<RealSession> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'agentship-e2e-store-'));
  await saveManifest(repoRoot, ManifestSchema.parse(manifest));
  const { server } = createAgentshipServer({
    logger: createLogger({ level: 'silent', sinks: [] }),
  });
  const client = new Client({ name: 'agentship-e2e', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    repoRoot,
    async call(name, args = {}) {
      const result = (await client.callTool({ name, arguments: args })) as {
        content: { text?: string }[];
      };
      return JSON.parse(result.content.map((entry) => entry.text ?? '').join('')) as Record<
        string,
        unknown
      >;
    },
    async cleanup() {
      await client.close();
      await server.close();
      await rm(repoRoot, { recursive: true, force: true });
    },
  };
}

interface PlanShape {
  readonly planId: string;
  readonly actions: {
    id: string;
    kind: string;
    classification: string;
    operation: string;
  }[];
}

/**
 * Approvals for everything except what would reach users.
 *
 * The filter is by operation, not by a hand-written id list, so a new differ cannot
 * accidentally slip a submission into a run that was only meant to reach TestFlight.
 */
const FORBIDDEN_IN_E2E = new Set([
  'submitForReview',
  'setPricing',
  'appPricing',
  'setPhasedRelease',
  'releaseVersion',
  'privacyLabels',
  'dataSafety',
  // Money and declarations. A product an E2E run created has no price
  // and therefore cannot be sold; a rating or a Data Safety form it wrote would be a public
  // statement about somebody's real app.
  'setProductPricing',
  'setProductOffers',
  'createProduct',
  'updateProduct',
  'contentRating',
]);

function safeApprovals(plan: PlanShape): string[] {
  return plan.actions
    .filter(
      (action) =>
        action.classification === 'needs_approval' && !FORBIDDEN_IN_E2E.has(action.operation),
    )
    .map((action) => action.id);
}

describe.skipIf(!appleEnabled)('App Store Connect, for real, up to TestFlight', () => {
  it(
    'reads the app, plans a release, and stops before the submission',
    async () => {
      const session = await realSession({
        version: 1,
        app: { name: 'Agentship E2E' },
        stores: {
          apple: {
            bundleId: process.env['AGENTSHIP_E2E_TEST_BUNDLE_ID'],
            appId: process.env['AGENTSHIP_E2E_TEST_APP_ID'],
          },
        },
        // An internal TestFlight track: no differ drafts a review submission for it at all.
        release: {
          version: process.env['AGENTSHIP_E2E_TEST_VERSION'] ?? '0.0.1',
          buildNumber: process.env['AGENTSHIP_E2E_TEST_BUILD'] ?? '1',
          track: 'internal_testing',
        },
        metadata: {
          primaryLocale: 'en-US',
          locales: { 'en-US': { name: 'Agentship E2E' } },
        },
      });
      try {
        const status = await session.call('agentship_store_status', {
          projectDir: session.repoRoot,
          store: 'apple',
        });
        console.log(
          'apple snapshot:',
          JSON.stringify(status['snapshots'], null, 2).slice(0, 2_000),
        );

        const planned = await session.call('agentship_plan', { projectDir: session.repoRoot });
        const plan = planned['plan'] as PlanShape;
        console.log(
          'apple plan:',
          plan.actions.map((action) => `${action.kind} [${action.classification}]`),
        );
        // The guarantee this test exists to prove, before anything is applied.
        expect(plan.actions.some((action) => action.operation === 'submitForReview')).toBe(false);

        const applied = await session.call('agentship_apply', {
          planId: plan.planId,
          approvals: safeApprovals(plan),
        });
        console.log('apple outcomes:', JSON.stringify(applied['counts']));
        expect(applied['ok']).toBe(true);
      } finally {
        await session.cleanup();
      }
    },
    60 * 60_000,
  );
});

describe.skipIf(!googleEnabled)('Google Play, for real, up to the internal track', () => {
  it(
    'reads the app and plans a release to the internal track only',
    async () => {
      const session = await realSession({
        version: 1,
        app: { name: 'Agentship E2E' },
        stores: { google: { packageName: process.env['AGENTSHIP_E2E_TEST_PACKAGE'] } },
        release: {
          version: process.env['AGENTSHIP_E2E_TEST_VERSION'] ?? '0.0.1',
          buildNumber: process.env['AGENTSHIP_E2E_TEST_BUILD'] ?? '1',
          track: 'internal_testing',
        },
        metadata: { primaryLocale: 'en-US', locales: { 'en-US': { name: 'Agentship E2E' } } },
      });
      try {
        const status = await session.call('agentship_store_status', {
          projectDir: session.repoRoot,
          store: 'google',
        });
        console.log(
          'google snapshot:',
          JSON.stringify(status['snapshots'], null, 2).slice(0, 2_000),
        );

        const planned = await session.call('agentship_plan', { projectDir: session.repoRoot });
        const plan = planned['plan'] as PlanShape;
        console.log(
          'google plan:',
          plan.actions.map((action) => `${action.kind} [${action.classification}]`),
        );
        // On Play a commit *is* the submission, so the only safe ceiling is a testing track.
        for (const action of plan.actions) {
          expect(action.kind).not.toBe('promote_release');
        }

        const applied = await session.call('agentship_apply', {
          planId: plan.planId,
          approvals: safeApprovals(plan),
        });
        console.log('google outcomes:', JSON.stringify(applied['counts']));
      } finally {
        await session.cleanup();
      }
    },
    60 * 60_000,
  );
});

/**
 * Creating a real in-app purchase, on a real account.
 *
 * Gated a third time (`AGENTSHIP_E2E_PRODUCTS=1`) because it is the only scenario here that
 * *creates* something rather than reading or staging one. Even so it stops at the product:
 * `setProductPricing` stays in the forbidden set, so the run proves the product was created
 * and left with no price — which is also the state in which it cannot be sold.
 *
 * A product cannot be deleted once customers could see it, so the test never cleans up; the
 * product id is supplied by the operator and is expected to be a throwaway on a test app.
 */
const productsEnabled = process.env['AGENTSHIP_E2E_PRODUCTS'] === '1';

describe.skipIf(!productsEnabled || !appleEnabled)('App Store Connect: a real test product', () => {
  it(
    'creates the declared in-app purchase and leaves it unpriced',
    async () => {
      const productId =
        process.env['AGENTSHIP_E2E_TEST_PRODUCT'] ??
        `${process.env['AGENTSHIP_E2E_TEST_BUNDLE_ID']}.agentshipe2e`;
      const session = await realSession({
        version: 1,
        app: { name: 'Agentship E2E' },
        stores: {
          apple: {
            bundleId: process.env['AGENTSHIP_E2E_TEST_BUNDLE_ID'],
            appId: process.env['AGENTSHIP_E2E_TEST_APP_ID'],
          },
        },
        release: { version: '0.0.1', track: 'internal_testing' },
        metadata: { primaryLocale: 'en-US', locales: { 'en-US': { name: 'Agentship E2E' } } },
        monetization: {
          products: [
            {
              id: 'agentship_e2e',
              type: 'consumable',
              apple: { productId },
              names: { 'en-US': { displayName: 'Agentship E2E' } },
              price: { base: '0.99', baseTerritory: 'US', strategy: 'manual' },
            },
          ],
        },
      });
      try {
        const planned = await session.call('agentship_plan', { projectDir: session.repoRoot });
        const plan = planned['plan'] as PlanShape;
        console.log(
          'apple product plan:',
          plan.actions.map((action) => `${action.kind} [${action.classification}]`),
        );
        const create = plan.actions.find((action) => action.kind === 'create_product');
        expect(create?.classification).toBe('needs_approval');

        const applied = await session.call('agentship_apply', {
          planId: plan.planId,
          approvals: create === undefined ? [] : [create.id],
        });
        console.log('apple product outcomes:', JSON.stringify(applied['counts']));

        // Re-planning must no longer offer to create it: that is convergence against a real
        // store rather than against the mock.
        const again = await session.call('agentship_plan', { projectDir: session.repoRoot });
        const second = again['plan'] as PlanShape;
        expect(second.actions.some((action) => action.kind === 'create_product')).toBe(false);
      } finally {
        await session.cleanup();
      }
    },
    60 * 60_000,
  );
});

describe.skipIf(!productsEnabled || !googleEnabled)('Google Play: a real test product', () => {
  it(
    'creates the declared one-time product and leaves it unpriced',
    async () => {
      const productId = process.env['AGENTSHIP_E2E_TEST_PRODUCT'] ?? 'agentship_e2e';
      const session = await realSession({
        version: 1,
        app: { name: 'Agentship E2E' },
        stores: { google: { packageName: process.env['AGENTSHIP_E2E_TEST_PACKAGE'] } },
        release: { version: '0.0.1', track: 'internal_testing' },
        metadata: { primaryLocale: 'en-US', locales: { 'en-US': { name: 'Agentship E2E' } } },
        monetization: {
          products: [
            {
              id: 'agentship_e2e',
              type: 'consumable',
              google: { productId },
              names: { 'en-US': { displayName: 'Agentship E2E' } },
              price: { base: '0.99', baseTerritory: 'US', strategy: 'manual' },
            },
          ],
        },
      });
      try {
        const planned = await session.call('agentship_plan', { projectDir: session.repoRoot });
        const plan = planned['plan'] as PlanShape;
        console.log(
          'google product plan:',
          plan.actions.map((action) => `${action.kind} [${action.classification}]`),
        );
        const create = plan.actions.find((action) => action.kind === 'create_product');
        expect(create?.classification).toBe('needs_approval');

        const applied = await session.call('agentship_apply', {
          planId: plan.planId,
          approvals: create === undefined ? [] : [create.id],
        });
        console.log('google product outcomes:', JSON.stringify(applied['counts']));

        const again = await session.call('agentship_plan', { projectDir: session.repoRoot });
        const second = again['plan'] as PlanShape;
        expect(second.actions.some((action) => action.kind === 'create_product')).toBe(false);
      } finally {
        await session.cleanup();
      }
    },
    60 * 60_000,
  );
});
