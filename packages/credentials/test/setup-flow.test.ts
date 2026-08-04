import { describe, expect, it } from 'vitest';
import { setupFlow, setupFlows, validateSetupValue } from '../src/index.js';
import {
  APPLE_ISSUER_ID,
  APPLE_KEY_ID,
  applePrivateKeyPem,
  serviceAccountJson,
} from './helpers.js';

describe('setup flows', () => {
  it('provides one flow per store', () => {
    expect(setupFlow('apple').store).toBe('apple');
    expect(setupFlow('google').store).toBe('google');
    expect(setupFlows()).toHaveLength(2);
  });

  it('is JSON-serialisable, since an agent consumes it over MCP', () => {
    for (const flow of setupFlows()) {
      expect(JSON.parse(JSON.stringify(flow))).toEqual(flow);
    }
  });

  it('classifies every console step as human_only', () => {
    for (const flow of setupFlows()) {
      for (const step of flow.steps) {
        if (step.consoleUrl !== undefined) {
          expect(step.actionClass, `${step.id}`).toBe('human_only');
        }
      }
    }
  });

  it('ends with the step Agentship performs itself', () => {
    for (const flow of setupFlows()) {
      expect(flow.steps.at(-1)?.actionClass).toBe('auto');
    }
  });

  it('uses unique step ids and https console URLs', () => {
    for (const flow of setupFlows()) {
      const ids = flow.steps.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const step of flow.steps) {
        if (step.consoleUrl !== undefined)
          expect(step.consoleUrl.startsWith('https://')).toBe(true);
      }
    }
  });

  it('gives every step at least one instruction', () => {
    for (const flow of setupFlows()) {
      for (const step of flow.steps) {
        expect(step.instructions.length, step.id).toBeGreaterThan(0);
      }
    }
  });

  it('marks key material as secret and multiline', () => {
    const fields = setupFlows().flatMap((f) => f.steps.flatMap((s) => s.collects ?? []));
    for (const field of fields) {
      const isKeyMaterial = field.kind === 'apple_p8' || field.kind === 'google_sa_json';
      expect(field.secret, field.name).toBe(isKeyMaterial);
      expect(field.multiline, field.name).toBe(isKeyMaterial);
    }
  });

  it('collects everything the credentials need', () => {
    const collected = (store: 'apple' | 'google'): string[] =>
      setupFlow(store)
        .steps.flatMap((s) => s.collects ?? [])
        .filter((f) => f.required)
        .map((f) => f.name);
    expect(collected('apple').sort()).toEqual(['issuerId', 'keyId', 'privateKeyPem']);
    expect(collected('google')).toEqual(['serviceAccountJson']);
  });

  it('records when the console instructions were last checked', () => {
    for (const flow of setupFlows()) {
      expect(flow.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('states the account prerequisites that Agentship cannot satisfy', () => {
    expect(setupFlow('apple').prerequisites.join(' ')).toMatch(/Developer Program/);
    expect(setupFlow('google').prerequisites.join(' ')).toMatch(/Play Developer account/);
  });
});

describe('validateSetupValue', () => {
  it('accepts valid values', () => {
    expect(validateSetupValue('apple_key_id', APPLE_KEY_ID)).toEqual({ ok: true });
    expect(validateSetupValue('apple_issuer_id', APPLE_ISSUER_ID)).toEqual({ ok: true });
    expect(validateSetupValue('apple_p8', applePrivateKeyPem())).toEqual({ ok: true });
    expect(validateSetupValue('google_sa_json', serviceAccountJson())).toEqual({ ok: true });
  });

  it('returns an explanation instead of throwing', () => {
    const result = validateSetupValue('apple_key_id', 'oops');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/10 uppercase/);
  });

  it('does not echo secret material back in the message', () => {
    const result = validateSetupValue(
      'google_sa_json',
      '{"type":"authorized_user","secret":"CANARY"}',
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).not.toContain('CANARY');
  });
});
