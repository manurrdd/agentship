import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppRef } from '@agentship/core';
import { DATA_SAFETY_ARCHIVE, lastArchivedDeclaration } from '@agentship/core';
import { describe, expect, it } from 'vitest';
import { GoogleAdapter } from '../src/index.js';
import { currencyFor, fromMoney, toMoney } from '../src/monetization.js';
import {
  fakeRunner,
  fixture,
  type Route,
  testContext,
  versionRoute,
  withGoogleEnvironment,
} from './harness.js';

/**
 * The monetisation surface of the Google backend, exercised offline.
 *
 * Play takes whole documents rather than flags, so most of what matters here is *what the
 * JSON says* — which is why several routes read the staged file back and assert on its
 * contents rather than on the command line.
 */
const APP: AppRef = { store: 'google', id: 'com.agentship.demo', bundleId: 'com.agentship.demo' };

function adapter(routes: readonly Route[]): {
  adapter: GoogleAdapter;
  runner: ReturnType<typeof fakeRunner>;
} {
  const runner = fakeRunner([versionRoute(), ...routes]);
  return { adapter: new GoogleAdapter({ runner: runner.runner }), runner };
}

/** Reads the `--file` argument of an invocation, which is how every Play write travels. */
async function stagedDocument(args: readonly string[]): Promise<Record<string, unknown>> {
  const index = args.indexOf('--file');
  return JSON.parse(await readFile(args[index + 1] as string, 'utf8')) as Record<string, unknown>;
}

describe('money', () => {
  it('round-trips a price without ever passing through a float', () => {
    expect(toMoney('4.99', 'USD')).toEqual({ currencyCode: 'USD', units: '4', nanos: 990000000 });
    expect(fromMoney({ currencyCode: 'USD', units: '4', nanos: 990000000 })).toBe('4.99');
    expect(toMoney('750', 'JPY')).toEqual({ currencyCode: 'JPY', units: '750', nanos: 0 });
  });

  it('refuses a territory it has no currency for, rather than guessing one', () => {
    expect(() => currencyFor('ZZ')).toThrow(/which currency/);
  });
});

describe('reading a product', () => {
  it('reads a subscription base plan with its regional prices', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google } = adapter([
        { match: 'subscriptions get', stdout: await fixture('subscription-get.json') },
      ]);
      const product = await google.getProductState(
        testContext(),
        APP,
        'com.agentship.demo.pro.monthly',
        'auto_renewable_subscription',
      );
      expect(product?.groupId).toBe('monthly');
      expect(product?.period).toBe('one_month');
      expect(product?.prices).toEqual([{ territory: 'US', price: '4.99', currency: 'USD' }]);
      expect(product?.displayName).toBe('Lumo Pro');
    });
  });

  it('reads a one-time product priced in micros', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google } = adapter([
        { match: 'iap get', stdout: await fixture('iap-get.json') },
      ]);
      const product = await google.getProductState(
        testContext(),
        APP,
        'com.agentship.demo.pro',
        'non_consumable',
      );
      expect(product?.prices).toEqual([{ territory: 'US', price: '9.99', currency: 'USD' }]);
    });
  });
});

describe('writing a product', () => {
  it('creates a subscription with its base plan and no prices at all', async () => {
    await withGoogleEnvironment(async () => {
      let document: Record<string, unknown> | undefined;
      const { adapter: google } = adapter([
        {
          match: 'subscriptions get',
          exitCode: 1,
          stderr: 'Error [API_NOT_FOUND]: no such subscription',
        },
        {
          match: 'subscriptions create',
          stdout: '{"productId":"com.agentship.demo.pro.yearly"}',
          inspect: async (invocation) => {
            document = await stagedDocument(invocation.args);
          },
        },
      ]);
      await google.createProduct(testContext(), APP, {
        productId: 'com.agentship.demo.pro.yearly',
        kind: 'auto_renewable_subscription',
        referenceName: 'pro_yearly',
        group: 'yearly',
        period: 'one_year',
        localizations: [{ locale: 'en-US', displayName: 'Lumo Pro', description: 'Yearly.' }],
      });
      const basePlans = document?.['basePlans'] as {
        basePlanId: string;
        autoRenewingBasePlanType: { billingPeriodDuration: string };
        regionalConfigs: unknown[];
      }[];
      expect(basePlans[0]?.basePlanId).toBe('yearly');
      expect(basePlans[0]?.autoRenewingBasePlanType.billingPeriodDuration).toBe('P1Y');
      // Creation carries no price: pricing is a separate approval, so a half-applied plan
      // cannot leave something purchasable at a number nobody agreed to.
      expect(basePlans[0]?.regionalConfigs).toEqual([]);
    });
  });

  it('prices a one-time product with exactly the regions decided, in micros', async () => {
    await withGoogleEnvironment(async () => {
      let document: Record<string, unknown> | undefined;
      const { adapter: google } = adapter([
        { match: 'iap get', stdout: await fixture('iap-get.json') },
        {
          match: 'iap update',
          stdout: '{"sku":"com.agentship.demo.pro"}',
          inspect: async (invocation) => {
            document = await stagedDocument(invocation.args);
          },
        },
      ]);
      await google.setProductPricing(testContext(), APP, {
        productId: 'com.agentship.demo.pro',
        kind: 'non_consumable',
        basePrice: '12.99',
        // Written in Apple's alpha-3 form: one manifest has to serve both stores, so the
        // adapter canonicalises rather than passing the code straight through.
        baseTerritory: 'USA',
        territories: { GB: '11.99', IN: '199', ESP: '10.99' },
      });
      // Each region in its own currency. This assertion used to read `currency: 'USD'` for
      // every entry, which is what the adapter really sent: a manifest saying `IN: 199`
      // meant ₹199 and Play was told 199 US dollars.
      expect(document?.['prices']).toEqual({
        ES: { priceMicros: '10990000', currency: 'EUR' },
        GB: { priceMicros: '11990000', currency: 'GBP' },
        IN: { priceMicros: '199000000', currency: 'INR' },
        US: { priceMicros: '12990000', currency: 'USD' },
      });
      // The base territory is one region among the rest, never a second entry for the same
      // country under the other code system.
      expect(Object.keys(document?.['prices'] as object)).toHaveLength(4);
      // Play takes the whole resource: the listing it already had survives the update.
      expect(document?.['listings']).toMatchObject({ 'en-US': { title: 'Pro' } });
    });
  });

  it('says a subscription price change does not move existing subscribers', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google } = adapter([
        { match: 'subscriptions get', stdout: await fixture('subscription-get.json') },
        { match: 'subscriptions update', stdout: '{"productId":"com.agentship.demo.pro.monthly"}' },
      ]);
      const result = await google.setProductPricing(testContext(), APP, {
        productId: 'com.agentship.demo.pro.monthly',
        kind: 'auto_renewable_subscription',
        basePrice: '5.99',
        baseTerritory: 'US',
        preserveExistingSubscribers: true,
      });
      expect(result.warnings?.join(' ')).toContain('price migration');
    });
  });
});

describe('price conversion', () => {
  it('reports Play’s own table as a proposal', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google, runner } = adapter([
        { match: 'pricing convert', stdout: await fixture('pricing-convert.json') },
      ]);
      const conversion = await google.convertPrice(testContext(), APP, '4.99', 'US');
      expect(conversion.unavailable).toBeUndefined();
      expect(conversion.prices).toEqual([
        { territory: 'GB', price: '4.49', currency: 'GBP' },
        { territory: 'JP', price: '750.00', currency: 'JPY' },
      ]);
      expect(
        runner.commands().some((command) => command.includes('--from USD --amount 4.99')),
      ).toBe(true);
    });
  });

  it('reports unavailable rather than approximating when Play will not answer', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google } = adapter([
        { match: 'pricing convert', exitCode: 1, stderr: 'Error: unavailable' },
      ]);
      const conversion = await google.convertPrice(testContext(), APP, '4.99', 'US');
      expect(conversion.unavailable).toBe(true);
      expect(conversion.prices).toEqual([]);
    });
  });
});

describe('data safety', () => {
  it('hands the CSV over and archives exactly what was applied', async () => {
    await withGoogleEnvironment(async () => {
      const repoRoot = await mkdtemp(join(tmpdir(), 'agentship-ds-'));
      try {
        let sent: string | undefined;
        const { adapter: google, runner } = adapter([
          {
            match: 'data-safety update',
            stdout: '{"ok":true}',
            inspect: async (invocation) => {
              const index = invocation.args.indexOf('--file');
              sent = await readFile(invocation.args[index + 1] as string, 'utf8');
            },
          },
        ]);
        const csv = 'data_type,data_category\nName,Personal info\n';
        const result = await google.applyBatch({ ...testContext(), cwd: repoRoot }, APP, [
          { op: 'set_data_safety', declaration: { csv, summary: ['Personal info / Name'] } },
        ]);
        expect(result.ok).toBe(true);
        expect(sent).toBe(csv);
        expect(runner.commands().some((command) => command.includes('data-safety update'))).toBe(
          true,
        );

        // The adapter itself archives nothing: the applied copy is project state, so the
        // kernel writes it after the op lands and every adapter — mock included — produces
        // it identically. See `packages/mcp/test/privacy.test.ts` for that half.
        expect(await lastArchivedDeclaration(repoRoot, DATA_SAFETY_ARCHIVE)).toBeUndefined();
      } finally {
        await rm(repoRoot, { recursive: true, force: true });
      }
    });
  });

  it('refuses an age-rating op, which is IARC console work on Play', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google } = adapter([]);
      const result = await google.applyBatch(testContext(), APP, [
        { op: 'set_age_rating', declaration: { answers: {} } },
      ]);
      expect(result.ok).toBe(false);
      expect(result.results[0]?.errorMessage).toContain('IARC');
    });
  });
});
