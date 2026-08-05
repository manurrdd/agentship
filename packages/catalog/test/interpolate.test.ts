import { AgentshipError, ManifestSchema, NEEDS_INPUT } from '@agentship/core';
import { describe, expect, it } from 'vitest';
import { catalogContext, renderInstruction, resolveTemplate } from '../src/index.js';

/**
 * The three cases the plan asks to prove: a value that is there, a value that is not, and a
 * variable that must never be readable.
 */
describe('template interpolation', () => {
  const context = { 'manifest.app.name': 'Lumo', 'analysis.bundleId': 'com.acme.lumo' };

  it('substitutes a value that is present', () => {
    const result = resolveTemplate('Call the app {{manifest.app.name}}', context);
    expect(result.text).toBe('Call the app Lumo');
    expect(result.missing).toEqual([]);
  });

  it('states a missing value instead of guessing one', () => {
    const result = resolveTemplate('SKU: {{manifest.stores.apple.appId}}', context);
    expect(result.text).toBe('SKU: <needs_input: manifest.stores.apple.appId>');
    expect(result.missing).toEqual(['manifest.stores.apple.appId']);
  });

  it('reports each missing path once, in template order', () => {
    const result = resolveTemplate('{{manifest.a}} {{manifest.b}} {{manifest.a}}', {});
    expect(result.missing).toEqual(['manifest.a', 'manifest.b']);
  });

  it('refuses a root that is not project data', () => {
    expect(() => resolveTemplate('{{env.HOME}}', context)).toThrow(AgentshipError);
    expect(() => resolveTemplate('{{credentials.p8}}', context)).toThrow(AgentshipError);
  });

  it('refuses a path that names a secret even under an allowed root', () => {
    expect(() => resolveTemplate('{{manifest.credentials.profile}}', context)).toThrow(
      AgentshipError,
    );
    expect(() => resolveTemplate('{{analysis.privateKey}}', context)).toThrow(AgentshipError);
  });

  it('refuses anything that is not a dotted identifier', () => {
    for (const bad of ['{{ }}', '{{a b}}', '{{a["b"]}}', '{{a()}}', '{{__proto__.x}}']) {
      expect(() => resolveTemplate(bad, context), bad).toThrow(AgentshipError);
    }
  });
});

describe('instruction rendering', () => {
  const fields = [{ name: 'sku', label: 'SKU' }];

  it('renders a field reference as the label, in quotes', () => {
    expect(renderInstruction('Type {{field:sku}} here', fields)).toBe('Type “SKU” here');
  });

  it('refuses to put a value into an instruction', () => {
    expect(() => renderInstruction('Type {{manifest.app.name}}', fields)).toThrow(AgentshipError);
  });

  it('refuses a reference to a field the step does not declare', () => {
    expect(() => renderInstruction('Type {{field:price}}', fields)).toThrow(AgentshipError);
  });
});

describe('the context a template may see', () => {
  const manifest = ManifestSchema.parse({
    version: 1,
    app: { name: 'Lumo' },
    credentials: { profile: 'work' },
    stores: { apple: { bundleId: 'com.acme.lumo' } },
    release: { version: '1.0.0', track: 'internal_testing' },
    metadata: {
      primaryLocale: 'en-US',
      locales: { 'en-US': { name: 'Lumo', description: NEEDS_INPUT } },
    },
  });

  it('flattens the manifest into dotted paths', () => {
    const context = catalogContext({ manifest });
    expect(context['manifest.app.name']).toBe('Lumo');
    expect(context['manifest.stores.apple.bundleId']).toBe('com.acme.lumo');
  });

  it('drops needs_input sentinels rather than rendering them into a console form', () => {
    const context = catalogContext({ manifest });
    expect(context['manifest.metadata.locales.en-US.description']).toBeUndefined();
  });

  it('carries the credential profile name but no template can reach it', () => {
    const context = catalogContext({ manifest });
    // The value is in the flattened map — dropping it there would be security theatre —
    // but `checkPath` refuses every path that could name it.
    expect(context['manifest.credentials.profile']).toBe('work');
    expect(() => resolveTemplate('{{manifest.credentials.profile}}', context)).toThrow(
      AgentshipError,
    );
  });
});
