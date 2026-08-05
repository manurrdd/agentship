import type {
  PendingStatus,
  ReleasePlan,
  RemoteAppState,
  RemoteProductOffer,
  RemoteProductPrice,
} from '@agentship/core';
import { describe, expect, it } from 'vitest';
import { planReadiness, summarizeState } from '../src/summaries.js';

/**
 * The projections that keep responses readable: fifty identical offers are one decision,
 * and readiness is the plan re-arranged around "what stops the submission", blockers first.
 */
function stateWith(overrides: Partial<RemoteAppState>): RemoteAppState {
  return {
    store: 'apple',
    ref: { store: 'apple', id: 'app-1' },
    capturedAt: '2026-08-05T00:00:00.000Z',
    app: { ref: { store: 'apple', id: 'app-1' }, name: 'Mock App', platforms: ['ios'] },
    versions: [],
    localizations: [],
    images: [],
    builds: [],
    testerGroups: [],
    tracks: [],
    products: [],
    gaps: [],
    pending: [],
    ...overrides,
  };
}

const TERRITORIES = Array.from({ length: 50 }, (_, i) => `T${String(i).padStart(2, '0')}`);

describe('summarizing products in full detail', () => {
  it('aggregates identical offers across territories into one entry with a count', () => {
    const offers: RemoteProductOffer[] = TERRITORIES.map((territory, index) => ({
      id: `offer-${index}`,
      kind: 'introductory',
      mode: 'free_trial',
      duration: 'ONE_WEEK',
      periods: 1,
      territory,
    }));
    const state = stateWith({
      products: [
        { id: 'p-1', productId: 'com.acme.pro', kind: 'auto_renewable_subscription', offers },
      ],
    });

    const summary = summarizeState(state, 'full');
    const products = summary['products'] as { offers: Record<string, unknown>[] }[];
    const aggregated = products[0]?.offers ?? [];
    // Fifty identical offers are one commercial decision, not fifty lines.
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0]).toMatchObject({
      kind: 'introductory',
      mode: 'free_trial',
      duration: 'ONE_WEEK',
      periods: 1,
      territories: 50,
    });
    // Too many territories to be information: the list is omitted, the count stays.
    expect(aggregated[0]?.['territoryList']).toBeUndefined();
  });

  it('keeps a short territory list and separates genuinely different offers', () => {
    const offers: RemoteProductOffer[] = [
      {
        id: 'o-1',
        kind: 'introductory',
        mode: 'free_trial',
        duration: 'ONE_WEEK',
        periods: 1,
        territory: 'USA',
      },
      {
        id: 'o-2',
        kind: 'introductory',
        mode: 'free_trial',
        duration: 'ONE_WEEK',
        periods: 1,
        territory: 'ESP',
      },
      {
        id: 'o-3',
        kind: 'introductory',
        mode: 'pay_as_you_go',
        duration: 'ONE_MONTH',
        periods: 3,
        territory: 'USA',
      },
    ];
    const state = stateWith({
      products: [
        { id: 'p-1', productId: 'com.acme.pro', kind: 'auto_renewable_subscription', offers },
      ],
    });
    const products = summarizeState(state, 'full')['products'] as {
      offers: Record<string, unknown>[];
    }[];
    const aggregated = products[0]?.offers ?? [];
    expect(aggregated).toHaveLength(2);
    const trial = aggregated.find((entry) => entry['mode'] === 'free_trial');
    expect(trial).toMatchObject({ territories: 2, territoryList: ['ESP', 'USA'] });
  });

  it('collapses long per-territory price lists into count, base and range', () => {
    const prices: RemoteProductPrice[] = TERRITORIES.map((territory, index) => ({
      territory,
      price: (1 + index * 0.5).toFixed(2),
    }));
    prices.push({ territory: 'USA', price: '9.99' });
    const state = stateWith({
      pricing: { free: false, amount: '9.99', baseTerritory: 'USA' },
      products: [{ id: 'p-1', productId: 'com.acme.pro', kind: 'consumable', prices }],
    });
    const products = summarizeState(state, 'full')['products'] as {
      prices: Record<string, unknown>;
    }[];
    const summarized = products[0]?.prices;
    expect(summarized).toMatchObject({
      territories: 51,
      base: { territory: 'USA', price: '9.99' },
      range: { min: { price: '1.00' }, max: { price: '25.50' } },
    });
  });

  it('leaves short price lists verbatim', () => {
    const prices: RemoteProductPrice[] = [{ territory: 'USA', price: '0.99' }];
    const state = stateWith({
      products: [{ id: 'p-1', productId: 'com.acme.coins', kind: 'consumable', prices }],
    });
    const products = summarizeState(state, 'full')['products'] as { prices: unknown }[];
    expect(products[0]?.prices).toEqual(prices);
  });
});

describe('readiness', () => {
  function planWith(overrides: Partial<ReleasePlan>): ReleasePlan {
    return {
      schemaVersion: 2,
      planId: 'plan-x',
      createdAt: '2026-08-05T00:00:00.000Z',
      agentshipVersion: '0.0.0',
      stores: ['apple'],
      actions: [],
      pending: [],
      snapshots: {},
      approvalsRequired: [],
      warnings: [],
      findings: [],
      ...overrides,
    };
  }

  it('lists blockers before warnings, per store', () => {
    const plan = planWith({
      actions: [
        {
          id: 'build:app:aaaa',
          store: 'apple',
          resource: 'build',
          kind: 'build',
          target: 'app',
          operation: 'buildArtifact',
          classification: 'auto',
          summary: 'Build the app',
          diff: [],
          dependsOn: [],
          blockedBy: [],
          riskNotes: [],
          local: { kind: 'build', payload: {} },
        },
        {
          id: 'set_metadata:en-US:bbbb',
          store: 'apple',
          resource: 'metadata',
          kind: 'set_metadata',
          target: 'en-US',
          operation: 'setMetadata',
          classification: 'needs_input',
          summary: 'Write the en-US listing',
          diff: [],
          dependsOn: [],
          blockedBy: [],
          riskNotes: [],
          needsInput: ['metadata.locales.en-US.description'],
        },
      ],
      pending: [
        {
          id: 'apple:app-privacy',
          store: 'apple',
          category: 'privacy',
          title: 'Declare App Privacy',
          reason: 'No API.',
          actionClass: 'agent_browser',
          status: 'open',
          blocking: ['submit_for_review:1.0.0:cccc'],
        },
      ],
      findings: [
        {
          code: 'GENERIC_USAGE_DESCRIPTION',
          severity: 'warning',
          message: 'A purpose string is vague.',
          remediation: 'Rewrite it.',
        },
        {
          code: 'TRACKING_WITHOUT_ATT',
          severity: 'error',
          message: 'Tracking without ATT.',
          remediation: 'Add NSUserTrackingUsageDescription.',
        },
      ],
    });

    const readiness = planReadiness(plan);
    const items = readiness['apple'] ?? [];
    expect(items.length).toBe(5);
    const severities = items.map((item) => item.severity);
    // Blockers first, always: the first warning comes after the last blocker.
    expect(severities.indexOf('warning')).toBeGreaterThan(severities.lastIndexOf('blocking') - 1);
    expect(severities.slice(0, severities.indexOf('warning'))).not.toContain('warning');
    expect(items.filter((item) => item.severity === 'blocking').map((item) => item.source)).toEqual(
      expect.arrayContaining(['manifest', 'console', 'privacy']),
    );
    for (const item of items) {
      expect(item.summary.length).toBeGreaterThan(0);
      expect(item.remediation.length).toBeGreaterThan(0);
    }
  });

  it('honours fresher pending statuses than the stored plan', () => {
    const plan = planWith({
      pending: [
        {
          id: 'apple:app-privacy',
          store: 'apple',
          category: 'privacy',
          title: 'Declare App Privacy',
          reason: 'No API.',
          actionClass: 'agent_browser',
          status: 'open',
          blocking: ['submit_for_review:1.0.0:cccc'],
        },
      ],
    });
    const statuses = new Map<string, PendingStatus>([['apple:app-privacy', 'verified']]);
    expect(planReadiness(plan, statuses)['apple']).toEqual([]);
    expect(planReadiness(plan)['apple']).toHaveLength(1);
  });
});
