import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateDataSafetyCsv, projectPrivacy, validateDataSafetyCsv } from '@agentship/catalog';
import {
  archiveDeclaration,
  DATA_SAFETY_ARCHIVE,
  type MockProduct,
  type MockStoreState,
} from '@agentship/core';
import { afterEach, describe, expect, it } from 'vitest';
import { manifestFor, stateOf } from '../../adapter-apple/test/differ-helpers.js';
import { googlePrivacyDiffer, googleProductsDiffer } from '../src/differs/index.js';

/**
 * The Google halves of monetisation and privacy.
 *
 * Two Play-specific properties are what these prove. Product actions must stay *out* of the
 * shared release edit, because Play's monetisation endpoints are not part of an edit at all;
 * and Data Safety convergence must be decided against Agentship's own archive, because Play
 * has no endpoint to read the declaration back.
 */
const PRACTICES = [
  {
    dataType: 'identifiers',
    collected: true,
    purposes: ['advertising'],
    linkedToUser: false,
    tracking: true,
    shared: true,
    source: 'inferred',
    evidence: 'Google AdMob typically collects this data',
  },
];

function oneTimeProduct(overrides: Partial<MockProduct> = {}): Partial<MockStoreState> {
  const product: MockProduct = {
    id: 'p-1',
    productId: 'com.acme.lumo.coins',
    kind: 'consumable',
    referenceName: 'coins',
    displayName: 'Coins',
    prices: new Map([['US', '0.99']]),
    offers: [],
    state: 'active',
    ...overrides,
  };
  return { products: new Map([[product.productId, product]]) };
}

const consumable = {
  id: 'coins',
  type: 'consumable',
  google: { productId: 'com.acme.lumo.coins' },
  names: { 'en-US': { displayName: 'Coins' } },
  price: { base: '0.99', baseTerritory: 'US', strategy: 'manual' },
};

describe('google/products', () => {
  let repoRoot: string | undefined;
  afterEach(async () => {
    if (repoRoot !== undefined) await rm(repoRoot, { recursive: true, force: true });
    repoRoot = undefined;
  });

  it('creates and prices a one-time product outside the shared release edit', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'agentship-google-differ-'));
    const drafts = await googleProductsDiffer().plan({
      store: 'google',
      manifest: manifestFor({ monetization: { products: [consumable] } }),
      state: await stateOf('google'),
      repoRoot,
    });
    expect(drafts.map((draft) => draft.kind)).toEqual(['create_product', 'set_product_pricing']);
    // Nothing here may claim membership of the Play edit: these endpoints are not edits.
    for (const draft of drafts) {
      const kinds = (draft.dependsOn ?? []).map((key) => key.kind);
      expect(kinds).not.toContain('set_metadata');
      expect(kinds).not.toContain('upload_build');
      expect(kinds).not.toContain('submit_for_review');
    }
  });

  it('converges once Play already holds the product at that price', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'agentship-google-differ-'));
    const drafts = await googleProductsDiffer().plan({
      store: 'google',
      manifest: manifestFor({ monetization: { products: [consumable] } }),
      state: await stateOf('google', oneTimeProduct()),
      repoRoot,
    });
    expect(drafts).toEqual([]);
  });

  it('reports an undeclared Play product without offering to delete it', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'agentship-google-differ-'));
    const drafts = await googleProductsDiffer().plan({
      store: 'google',
      manifest: manifestFor({ monetization: { products: [] } }),
      state: await stateOf('google', oneTimeProduct()),
      repoRoot,
    });
    const drift = drafts.find((draft) => draft.kind === 'review_product_drift');
    expect(drift?.op).toBeUndefined();
    expect(drift?.diff[0]?.note).toContain('never deletes');
  });
});

describe('google/privacy', () => {
  let repoRoot: string | undefined;
  afterEach(async () => {
    if (repoRoot !== undefined) await rm(repoRoot, { recursive: true, force: true });
    repoRoot = undefined;
  });

  async function plan(privacy: Record<string, unknown>, root: string) {
    return googlePrivacyDiffer().plan({
      store: 'google',
      manifest: manifestFor({ privacy }),
      state: await stateOf('google'),
      repoRoot: root,
    });
  }

  it('drafts nothing executable while the declaration is a draft', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'agentship-google-differ-'));
    const drafts = await plan({ declarationStatus: 'draft', dataPractices: PRACTICES }, repoRoot);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.kind).toBe('confirm_privacy');
    expect(drafts[0]?.op).toBeUndefined();
  });

  it('generates a valid CSV once the declaration is confirmed', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'agentship-google-differ-'));
    const drafts = await plan(
      { declarationStatus: 'confirmed', dataPractices: PRACTICES },
      repoRoot,
    );
    const apply = drafts.find((draft) => draft.kind === 'set_data_safety');
    const op = apply?.op as { op: 'set_data_safety'; declaration: { csv: string } } | undefined;
    expect(op?.op).toBe('set_data_safety');
    expect(validateDataSafetyCsv(op?.declaration.csv ?? '').errors).toEqual([]);
    // Play has no read-back, so the diff has to say what it is comparing against.
    expect(apply?.riskNotes?.join(' ')).toContain('no way to read');
  });

  it('stops proposing the declaration once it has been applied', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'agentship-google-differ-'));
    const { csv, summary } = generateDataSafetyCsv(
      projectPrivacy('google', {
        declarationStatus: 'confirmed',
        // biome-ignore lint/suspicious/noExplicitAny: the schema's parsed shape, inline for the fixture.
        dataPractices: PRACTICES as any,
      }),
    );
    await archiveDeclaration({
      repoRoot,
      kind: DATA_SAFETY_ARCHIVE,
      document: csv,
      summary,
    });
    const drafts = await plan(
      { declarationStatus: 'confirmed', dataPractices: PRACTICES },
      repoRoot,
    );
    expect(drafts.some((draft) => draft.kind === 'set_data_safety')).toBe(false);
    // The App content console step stays: it covers questions no API answers.
    expect(drafts.some((draft) => draft.kind === 'declare_app_content')).toBe(true);
  });

  it('refuses to generate a declaration Play has no words for', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'agentship-google-differ-'));
    const drafts = await plan(
      {
        declarationStatus: 'confirmed',
        dataPractices: [{ dataType: 'usage_data', collected: true, purposes: ['other'] }],
      },
      repoRoot,
    );
    expect(drafts.map((draft) => draft.kind)).toEqual(['answer_privacy_questions']);
    expect(drafts[0]?.op).toBeUndefined();
  });
});
