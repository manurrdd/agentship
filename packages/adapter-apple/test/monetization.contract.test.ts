import type { AppRef } from '@agentship/core';
import { describe, expect, it } from 'vitest';
import { AppleAdapter } from '../src/index.js';
import {
  fakeRunner,
  fixture,
  type Route,
  testContext,
  versionRoute,
  withAppleEnvironment,
} from './harness.js';

/**
 * The monetisation surface of the Apple backend, exercised offline.
 *
 * As with the rest of the contract tests, everything runs for real except the process: the
 * command table builds the argv, the credentials materialise and are removed, the JSON is
 * parsed and mapped. What is asserted is the thing a reviewer would check by hand — that the
 * right `asc` subcommand was invoked with the right flags, and that no price reached the
 * store that the caller had not decided on.
 */
const APP: AppRef = { store: 'apple', id: '1234567890', bundleId: 'com.agentship.demo' };

function adapter(routes: readonly Route[]): {
  adapter: AppleAdapter;
  runner: ReturnType<typeof fakeRunner>;
} {
  const runner = fakeRunner([versionRoute(), ...routes]);
  return { adapter: new AppleAdapter({ runner: runner.runner }), runner };
}

describe('reading a product', () => {
  it('reads a subscription with its prices and introductory offers', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple, runner } = adapter([
        { match: 'subscriptions list', stdout: await fixture('subscriptions-list.json') },
        {
          match: 'subscriptions pricing prices list',
          stdout: await fixture('subscription-prices.json'),
        },
        {
          match: 'subscriptions offers introductory list',
          stdout: await fixture('subscription-intro-offers.json'),
        },
      ]);
      const product = await apple.getProductState(
        testContext(),
        APP,
        'com.agentship.demo.pro.monthly',
        'auto_renewable_subscription',
      );
      expect(product?.groupId).toBe('group-pro');
      expect(product?.period).toBe('ONE_MONTH');
      expect(product?.prices).toEqual([
        { territory: 'USA', price: '4.99', currency: 'USD', pricePointId: 'pp-usa-499' },
      ]);
      expect(product?.offers).toEqual([
        {
          id: 'intro-1',
          kind: 'introductory',
          mode: 'free_trial',
          duration: 'ONE_MONTH',
          periods: 1,
        },
      ]);
      expect(runner.commands().some((command) => command.startsWith('web'))).toBe(false);
    });
  });

  it('answers `undefined` for a product App Store Connect does not have', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple } = adapter([{ match: 'iap list', stdout: '{"data":[]}' }]);
      const product = await apple.getProductState(
        testContext(),
        APP,
        'com.agentship.demo.missing',
        'consumable',
      );
      expect(product).toBeUndefined();
    });
  });
});

describe('creating a product', () => {
  it('creates an in-app purchase and its version localization', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple, runner } = adapter([
        { match: 'iap list', stdout: '{"data":[]}' },
        { match: 'iap create', stdout: await fixture('iap-created.json') },
        {
          match: 'iap versions list',
          stdout: '{"data":[{"type":"inAppPurchaseVersions","id":"iapv-1","attributes":{}}]}',
        },
        {
          match: 'iap versions localizations create',
          stdout: '{"data":{"type":"x","id":"loc-1"}}',
        },
      ]);
      const result = await apple.createProduct(testContext(), APP, {
        productId: 'com.agentship.demo.coins',
        kind: 'consumable',
        referenceName: 'coins',
        localizations: [{ locale: 'en-US', displayName: 'Coins', description: 'A pile of coins.' }],
      });
      expect(result.changed).toBe(true);
      const commands = runner.commands();
      expect(
        commands.some((command) =>
          command.includes('iap create --app 1234567890 --type CONSUMABLE'),
        ),
      ).toBe(true);
      expect(commands.some((command) => command.includes('versions localizations create'))).toBe(
        true,
      );
    });
  });

  it('is a no-op when the product already exists', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple, runner } = adapter([
        { match: 'iap list', stdout: await fixture('iap-list.json') },
      ]);
      const result = await apple.createProduct(testContext(), APP, {
        productId: 'com.agentship.demo.pro',
        kind: 'non_consumable',
        referenceName: 'pro',
      });
      expect(result.changed).toBe(false);
      expect(runner.commands().some((command) => command.includes('iap create'))).toBe(false);
    });
  });

  it('reuses an existing subscription group instead of creating a twin', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple, runner } = adapter([
        { match: 'subscriptions list', stdout: '{"data":[]}' },
        { match: 'subscriptions groups list', stdout: await fixture('subscription-groups.json') },
        {
          match: 'subscriptions create',
          stdout: '{"data":{"type":"subscriptions","id":"sub-new","attributes":{}}}',
        },
      ]);
      await apple.createProduct(testContext(), APP, {
        productId: 'com.agentship.demo.pro.yearly',
        kind: 'auto_renewable_subscription',
        referenceName: 'pro_yearly',
        group: 'Pro',
        period: 'one_year',
      });
      const commands = runner.commands();
      expect(commands.some((command) => command.includes('subscriptions groups create'))).toBe(
        false,
      );
      expect(
        commands.some(
          (command) =>
            command.includes('subscriptions create --group-id group-pro') &&
            command.includes('--subscription-period ONE_YEAR'),
        ),
      ).toBe(true);
    });
  });
});

describe('pricing a product', () => {
  it('sets one subscription price per territory, exactly as decided', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple, runner } = adapter([
        { match: 'subscriptions list', stdout: await fixture('subscriptions-list.json') },
        { match: 'subscriptions pricing prices set', stdout: '{"data":{"type":"x","id":"p1"}}' },
        { match: 'subscriptions pricing prices set', stdout: '{"data":{"type":"x","id":"p2"}}' },
      ]);
      const result = await apple.setProductPricing(testContext(), APP, {
        productId: 'com.agentship.demo.pro.monthly',
        kind: 'auto_renewable_subscription',
        basePrice: '4.99',
        baseTerritory: 'US',
        territories: { GB: '4.49' },
        preserveExistingSubscribers: true,
      });
      expect(result.changed).toBe(true);
      const sets = runner.commands().filter((command) => command.includes('pricing prices set'));
      expect(sets).toHaveLength(2);
      // Every territory carries its own approved number; nothing is derived here.
      expect(sets.some((command) => command.includes('--territory GB --price 4.49'))).toBe(true);
      expect(sets.every((command) => command.includes('--preserved'))).toBe(true);
    });
  });

  it('creates one price schedule for an in-app purchase', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple, runner } = adapter([
        { match: 'iap list', stdout: await fixture('iap-list.json') },
        { match: 'iap pricing schedules create', stdout: '{"data":{"type":"x","id":"sched-1"}}' },
      ]);
      await apple.setProductPricing(testContext(), APP, {
        productId: 'com.agentship.demo.pro',
        kind: 'non_consumable',
        basePrice: '9.99',
        baseTerritory: 'USA',
      });
      expect(
        runner
          .commands()
          .some((command) =>
            command.includes(
              'iap pricing schedules create --iap-id iap-1 --app 1234567890 --base-territory USA --price 9.99',
            ),
          ),
      ).toBe(true);
    });
  });

  it('refuses to price a product that does not exist', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple } = adapter([{ match: 'iap list', stdout: '{"data":[]}' }]);
      await expect(
        apple.setProductPricing(testContext(), APP, {
          productId: 'com.agentship.demo.ghost',
          kind: 'consumable',
          basePrice: '1.99',
          baseTerritory: 'US',
        }),
      ).rejects.toThrow(/does not exist|No product/);
    });
  });
});

describe('offers', () => {
  it('creates only the introductory offers the store is missing', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple, runner } = adapter([
        { match: 'subscriptions list', stdout: await fixture('subscriptions-list.json') },
        {
          match: 'subscriptions offers introductory list',
          stdout: await fixture('subscription-intro-offers.json'),
        },
      ]);
      // The store already has a one-month free trial; asking for the same one changes nothing.
      const result = await apple.setProductOffers(testContext(), APP, {
        productId: 'com.agentship.demo.pro.monthly',
        kind: 'auto_renewable_subscription',
        offers: [
          {
            id: 'trial',
            kind: 'introductory',
            mode: 'free_trial',
            duration: 'one_month',
            periods: 1,
          },
        ],
      });
      expect(result.changed).toBe(false);
      expect(
        runner.commands().some((command) => command.includes('offers introductory create')),
      ).toBe(false);
    });
  });

  it('says out loud that it does not create promotional offers', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple } = adapter([
        { match: 'subscriptions list', stdout: await fixture('subscriptions-list.json') },
        { match: 'subscriptions offers introductory list', stdout: '{"data":[]}' },
      ]);
      const result = await apple.setProductOffers(testContext(), APP, {
        productId: 'com.agentship.demo.pro.monthly',
        kind: 'auto_renewable_subscription',
        offers: [
          {
            id: 'spring',
            kind: 'promotional',
            mode: 'pay_up_front',
            duration: 'one_month',
            periods: 1,
          },
        ],
      });
      expect(result.warnings?.join(' ')).toContain('marketing decision');
    });
  });
});

describe('age rating', () => {
  it('writes a declaration that is a function of the answers alone', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple, runner } = adapter([
        {
          match: 'age-rating edit',
          stdout: '{"data":{"type":"ageRatingDeclarations","id":"ard-1"}}',
        },
      ]);
      const result = await apple.applyBatch(testContext(), APP, [
        { op: 'set_age_rating', declaration: { answers: { advertising: true }, allNone: true } },
      ]);
      expect(result.ok).toBe(true);
      const command = runner.commands().find((entry) => entry.includes('age-rating edit'));
      // `--all-none` first: without it the edit inherits whatever the last questionnaire left
      // in the fields it does not mention, and two identical plans could rate differently.
      expect(command).toContain('--all-none');
      expect(command).toContain('--advertising true');
    });
  });

  it('refuses a Data Safety op, which is a Google concept', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple } = adapter([]);
      const result = await apple.applyBatch(testContext(), APP, [
        { op: 'set_data_safety', declaration: { csv: 'a,b\n', summary: [] } },
      ]);
      expect(result.ok).toBe(false);
      expect(result.results[0]?.errorMessage).toContain('Data Safety');
    });
  });
});
