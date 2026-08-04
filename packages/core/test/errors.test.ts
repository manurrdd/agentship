import { describe, expect, it } from 'vitest';
import { AgentshipError, ERROR_CODES, errorFamily } from '../src/errors.js';

describe('AgentshipError', () => {
  it('derives the family from the code', () => {
    expect(errorFamily(ERROR_CODES.AUTH_MISSING_CREDENTIALS)).toBe('AUTH');
    expect(new AgentshipError(ERROR_CODES.TOOL_CHECKSUM_MISMATCH, 'x').family).toBe('TOOL');
  });

  it('marks transient store failures retryable by default', () => {
    expect(new AgentshipError(ERROR_CODES.STORE_RATE_LIMITED, 'x').retryable).toBe(true);
    expect(new AgentshipError(ERROR_CODES.STORE_VALIDATION_FAILED, 'x').retryable).toBe(false);
  });

  it('lets the thrower override retryability', () => {
    expect(
      new AgentshipError(ERROR_CODES.STORE_VALIDATION_FAILED, 'x', { retryable: true }).retryable,
    ).toBe(true);
  });

  it('serialises to a structured, agent-facing shape', () => {
    const err = new AgentshipError(ERROR_CODES.AUTH_KEYRING_UNAVAILABLE, 'no keyring', {
      store: 'apple',
      remediation: { summary: 'Use environment variables', docsUrl: 'https://example.test' },
      details: { platform: 'linux' },
    });
    expect(err.toJSON()).toEqual({
      name: 'AgentshipError',
      code: 'AUTH_KEYRING_UNAVAILABLE',
      message: 'no keyring',
      retryable: false,
      store: 'apple',
      remediation: { summary: 'Use environment variables', docsUrl: 'https://example.test' },
      details: { platform: 'linux' },
    });
  });

  it('keeps the original cause when wrapping', () => {
    const cause = new Error('underlying');
    const err = AgentshipError.from(ERROR_CODES.CONFIG_INVALID, 'bad config', cause);
    expect(err.cause).toBe(cause);
    expect(AgentshipError.is(err)).toBe(true);
  });

  it('does not double-wrap an AgentshipError', () => {
    const inner = new AgentshipError(ERROR_CODES.PLAN_NOT_FOUND, 'nope');
    expect(AgentshipError.from(ERROR_CODES.CONFIG_INVALID, 'ignored', inner)).toBe(inner);
  });

  it('has no duplicate codes in the catalog', () => {
    const values = Object.values(ERROR_CODES);
    expect(new Set(values).size).toBe(values.length);
  });

  it('keeps every code inside a declared family', () => {
    const families = new Set(['AUTH', 'TOOL', 'BUILD', 'STORE', 'ANALYZE', 'PLAN', 'CONFIG']);
    for (const [key, value] of Object.entries(ERROR_CODES)) {
      expect(key).toBe(value);
      expect(families.has(errorFamily(value))).toBe(true);
    }
  });
});
