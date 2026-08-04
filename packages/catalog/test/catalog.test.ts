import { AgentshipError, STORES } from '@agentship/core';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_ROOTS,
  catalogEntries,
  catalogEntry,
  checkPath,
  loadCatalog,
  renderCatalogPending,
  renderStoreCatalog,
} from '../src/index.js';

/**
 * The catalog is product, not documentation: it is what an agent reads before touching a
 * user's store console. So it is checked like code — every entry valid, every template legal,
 * every verification either a registered check or an explicit manual checklist, and every
 * entry dated.
 */
const TEMPLATE = /\{\{\s*([^}]*?)\s*\}\}/g;

describe('the console catalog', () => {
  it('loads and validates every entry in both stores', () => {
    const entries = loadCatalog();
    expect(entries.length).toBeGreaterThanOrEqual(16);
    for (const store of STORES) {
      expect(catalogEntries(store).length).toBeGreaterThan(0);
    }
  });

  it('keeps the ids the engine and the tests already depend on', () => {
    const ids = new Set(loadCatalog().map((entry) => entry.id));
    for (const id of [
      'apple:create-app-record',
      'apple:app-privacy',
      'apple:agreements-tax-banking',
      'apple:resolution-center',
      'apple:release-version',
      'google:create-app',
      'google:first-release',
      'google:content-rating',
      'google:app-content',
      'google:pricing-and-countries',
      'google:account-and-payments',
      'google:managed-publishing',
    ]) {
      expect(ids, `${id} disappeared from the catalog`).toContain(id);
    }
  });

  it('dates every entry, so a stale instruction is visible', () => {
    for (const entry of loadCatalog()) {
      expect(entry.lastVerified, entry.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(entry.lastVerified))).toBe(false);
    }
  });

  it('only reads the allowed context roots in field and parameter templates', () => {
    for (const entry of loadCatalog()) {
      const templates = [
        ...entry.steps.flatMap((step) =>
          step.fields
            .map((field) => field.value)
            .filter((value): value is string => value !== undefined),
        ),
        ...(entry.verify.kind === 'api' ? Object.values(entry.verify.params ?? {}) : []),
      ];
      for (const template of templates) {
        for (const match of template.matchAll(TEMPLATE)) {
          const path = checkPath(match[1] as string);
          expect(ALLOWED_ROOTS, `${entry.id}: ${path}`).toContain(path.split('.')[0]);
        }
      }
    }
  });

  it('never interpolates a value into an instruction, only a field label', () => {
    for (const entry of loadCatalog()) {
      for (const step of entry.steps) {
        for (const match of step.instruction.matchAll(TEMPLATE)) {
          const expression = (match[1] as string).trim();
          expect(expression.startsWith('field:'), `${entry.id}: ${expression}`).toBe(true);
          const name = expression.slice('field:'.length);
          expect(
            step.fields.map((field) => field.name),
            `${entry.id}: instruction references an undeclared field`,
          ).toContain(name);
        }
      }
    }
  });

  it('explains why a human is required for every human_only entry', () => {
    for (const entry of loadCatalog().filter((candidate) => candidate.class === 'human_only')) {
      expect(entry.humanReason, entry.id).toBeDefined();
    }
  });

  it('never asks the operator to hand a secret to the agent', () => {
    const forbidden = [
      /paste (?:the |your )?password/i,
      /give (?:me|us|the agent) (?:the |your )?password/i,
      /two-factor code (?:here|to)/i,
    ];
    for (const entry of loadCatalog()) {
      const text = [
        entry.reason,
        entry.humanReason ?? '',
        ...entry.steps.map((step) => step.instruction),
        entry.notes ?? '',
      ].join('\n');
      for (const pattern of forbidden) {
        expect(pattern.test(text), `${entry.id} matches ${String(pattern)}`).toBe(false);
      }
      for (const field of entry.steps.flatMap((step) => step.fields)) {
        expect(/password|2fa|secret key|private key/i.test(field.label), `${entry.id}`).toBe(false);
      }
    }
  });

  it('gives a manual verification a concrete checklist rather than a promise', () => {
    for (const entry of loadCatalog()) {
      if (entry.verify.kind !== 'manual') continue;
      expect(entry.verify.checklist.length, entry.id).toBeGreaterThan(0);
      for (const item of entry.verify.checklist) expect(item.length).toBeGreaterThan(10);
    }
  });
});

describe('rendering a catalog entry', () => {
  const context = {
    'manifest.app.name': 'Lumo',
    'manifest.metadata.primaryLocale': 'en-US',
    'manifest.stores.apple.bundleId': 'com.acme.lumo',
  };

  it('fills the fields it can and names the ones it cannot', () => {
    const rendered = renderCatalogPending(catalogEntry('apple:create-app-record'), { context });
    const byName = new Map(rendered.fields?.map((field) => [field.name, field]) ?? []);
    expect(byName.get('name')?.proposedValue).toBe('Lumo');
    expect(byName.get('bundleId')?.proposedValue).toBe('com.acme.lumo');
    // The SKU has no template: Agentship has nothing to propose, so it proposes nothing.
    expect(byName.get('sku')?.proposedValue).toBeUndefined();
    expect(rendered.missing).toEqual([]);
  });

  it('proposes nothing at all when the value is missing, and says which path', () => {
    const rendered = renderCatalogPending(catalogEntry('apple:create-app-record'), { context: {} });
    const name = rendered.fields?.find((field) => field.name === 'name');
    expect(name?.proposedValue).toBeUndefined();
    expect(rendered.missing).toContain('manifest.app.name');
    expect(rendered.notes).toContain('manifest.app.name');
  });

  it('renders instructions with labels, never with the values', () => {
    const rendered = renderCatalogPending(catalogEntry('google:create-app'), {
      context: { 'manifest.stores.google.packageName': 'com.acme.lumo' },
    });
    const steps = (rendered.steps ?? []).join('\n');
    expect(steps).toContain('“Package name”');
    expect(steps).not.toContain('com.acme.lumo');
  });

  it('folds preconditions and cautions into the steps an operator reads', () => {
    const rendered = renderCatalogPending(catalogEntry('google:create-app'));
    const steps = (rendered.steps ?? []).join('\n');
    expect(steps).toContain('Before you start:');
    expect(steps).toContain('CAUTION');
  });

  it('spells out a manual check as a step, so nothing looks automatically verified', () => {
    const rendered = renderCatalogPending(catalogEntry('apple:app-privacy'));
    expect(rendered.verification?.check).toBeUndefined();
    expect((rendered.steps ?? []).join('\n')).toContain('Agentship cannot check this from any API');
  });

  it('renders a whole store itinerary from the manifest alone', () => {
    const rendered = renderStoreCatalog(['google'], { context });
    expect(rendered.map((entry) => entry.id)).toContain('google:create-app');
    for (const entry of rendered) expect(entry.status).toBe('open');
  });

  it('refuses a template that reaches outside the allowed roots', () => {
    expect(() => checkPath('credentials.applePrivateKey')).toThrow(AgentshipError);
    expect(() => checkPath('manifest.credentials.profile')).toThrow(AgentshipError);
    expect(() => checkPath('process.env.HOME')).toThrow(AgentshipError);
  });
});
