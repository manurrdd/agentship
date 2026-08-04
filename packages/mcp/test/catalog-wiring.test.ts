import { createAppleAdapter } from '@agentship/adapter-apple';
import { createGoogleAdapter } from '@agentship/adapter-google';
import { catalogEntries, loadCatalog } from '@agentship/catalog';
import { OPERATION_IDS, STORES } from '@agentship/core';
import { describe, expect, it } from 'vitest';
import { createRegistry, createVerifiers } from '../src/engine.js';

/**
 * Where the console catalog meets the engine.
 *
 * The catalog is data and the engine is code, so nothing but a test keeps them agreeing. Two
 * failures matter and both are silent without this file: an entry naming a verifier nobody
 * registered would report `verified: false` for work that actually landed, and a store whose
 * capability table calls an operation console-only while the catalog has no entry for it
 * would leave the user with "no API for this" and no instructions.
 */
describe('the catalog and the engine', () => {
  const verifiers = createVerifiers(false);

  it('registers a verifier for every check the catalog names', () => {
    for (const entry of loadCatalog()) {
      if (entry.verify.kind !== 'api') continue;
      expect(
        verifiers.has(entry.verify.check),
        `${entry.id} declares check "${entry.verify.check}", which no adapter registers`,
      ).toBe(true);
    }
  });

  it('registers no verifier the catalog never asks for', () => {
    // A stale verifier is dead code that reads like coverage; the mock's own checks are the
    // documented exception, since they answer questions only the mock models.
    const asked = new Set(
      loadCatalog()
        .filter((entry) => entry.verify.kind === 'api')
        .map((entry) => (entry.verify as { check: string }).check),
    );
    // The keystore check belongs to a pending the build package emits, not to a catalog entry.
    asked.add('google:upload-keystore-ready');
    for (const registered of verifiers.keys()) {
      expect(asked.has(registered), `${registered} is registered but nothing asks for it`).toBe(
        true,
      );
    }
  });

  it('has a catalog entry for every operation a store reports as console-only', () => {
    const adapters = {
      apple: createAppleAdapter(),
      google: createGoogleAdapter(),
    };
    // Operations Agentship deliberately handles as an action rather than as a standing catalog
    // entry: each one is emitted by a differ with the context it needs.
    const byAction: ReadonlySet<string> = new Set([
      'releaseVersion',
      'setPricing',
      'appPricing',
      'appAvailability',
      'appContentDeclarations',
      'resolutionCenter',
    ]);
    for (const store of STORES) {
      const capabilities = adapters[store].capabilities();
      const entries = catalogEntries(store);
      for (const operation of OPERATION_IDS) {
        const capability = capabilities[operation];
        if (capability !== 'agent_browser' && capability !== 'human_only') continue;
        if (byAction.has(operation)) continue;
        expect(
          entries.length,
          `${store} reports ${operation} as ${capability} but has no console catalog at all`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('registers every differ the two stores define, with no duplicate resource', () => {
    const registry = createRegistry();
    for (const store of STORES) {
      const resources = registry.forStore(store).map((differ) => differ.resource);
      expect(new Set(resources).size).toBe(resources.length);
      // The plan-06 additions are wired, not merely written.
      expect(resources).toContain('products');
      expect(resources).toContain('privacy');
    }
  });
});
