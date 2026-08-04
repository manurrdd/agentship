import {
  AgentshipError,
  clearRegisteredSecrets,
  ERROR_CODES,
  redactString,
  redactValue,
  registerSecret,
  scrubStrings,
} from '@agentship/core';
import { fail, serialize } from '@agentship/mcp';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Secrets. Each attack here leaked an unredacted secret once; each test
 * pins the fix so a regression re-opens the leak loudly.
 */

const PEM_CANARY = [
  '-----BEGIN PRIVATE KEY-----',
  'MIGTCANARYCANARYCANARYCANARYCANARYCANARYCANARYCANARYCANARYCANARY',
  '-----END PRIVATE KEY-----',
].join('\n');

afterEach(() => {
  clearRegisteredSecrets();
});

describe('redactValue key rule catches camelCase secret keys', () => {
  it('redacts the real KeystoreSecret / credential field names, whatever the value', () => {
    const out = redactValue({
      storePassword: 'a-plain-password',
      keyPassword: 'another-plain-one',
      keystorePassword: 'S3cr3tK3yst0reP@ss',
      privateKeyPem: 'plain',
      serviceAccountJson: 'plain',
      clientSecret: 'plain',
      refreshToken: 'plain',
      // Non-secret siblings must survive so logs stay useful.
      keyAlias: 'upload',
      appId: 'com.example.app',
    }) as Record<string, unknown>;

    for (const key of [
      'storePassword',
      'keyPassword',
      'keystorePassword',
      'privateKeyPem',
      'serviceAccountJson',
      'clientSecret',
      'refreshToken',
    ]) {
      expect(out[key], key).toBe('[REDACTED]');
    }
    expect(out['keyAlias']).toBe('upload');
    expect(out['appId']).toBe('com.example.app');
  });
});

describe('registerSecret covers realistic keystore passwords', () => {
  it('scrubs a registered 6-character secret from free text', () => {
    // keytool refuses store passwords under six characters, so six is the real floor.
    registerSecret('abc123');
    expect(redactString('gradle printed the password abc123 to stdout')).toBe(
      'gradle printed the password [REDACTED] to stdout',
    );
  });

  it('still ignores a genuinely tiny literal that would mangle unrelated text', () => {
    registerSecret('ab');
    expect(redactString('ab cd ef')).toBe('ab cd ef');
  });
});

describe('MCP tool responses redact secret-shaped strings at the boundary', () => {
  it('scrubs a PEM that surfaced in a build error, without clobbering status fields', () => {
    // The shape of the Finding-3 leak: a build tool echoes key material into stdout, which
    // reaches an error's evidence and, from there, the agent's context.
    const error = new AgentshipError(ERROR_CODES.BUILD_FAILED, 'the build failed', {
      details: { evidence: [`> signingConfig ${PEM_CANARY}`] },
    });
    const text = fail(error).content[0]?.text ?? '';
    expect(text).not.toContain('CANARY');
    expect(text).toContain('[REDACTED:PEM]');
  });

  it('scrubs a secret carried in the message of an unexpected (non-Agentship) error', () => {
    const text = fail(new Error(`unexpected ${PEM_CANARY}`)).content[0]?.text ?? '';
    expect(text).not.toContain('CANARY');
    expect(text).toContain('[REDACTED:PEM]');
  });

  it('leaves a non-secret status value under a secret-named key intact', () => {
    // `currentCredentials: "none"` legitimately trips the key-name rule; the boundary uses
    // string-scrubbing only, so a status like this must survive verbatim.
    const { text } = serialize({ currentCredentials: 'none', profile: 'default' });
    expect(text).toContain('"currentCredentials": "none"');
  });

  it('registered literals are scrubbed even when they have no secret shape', () => {
    registerSecret('unshaped-keystore-password');
    const { text } = serialize({ log: 'password is unshaped-keystore-password here' });
    expect(text).not.toContain('unshaped-keystore-password');
  });
});

describe('scrubStrings drops the key rule but keeps string scrubbing', () => {
  it('does not wholesale-redact by key name', () => {
    const out = scrubStrings({ credentials: 'none' }) as Record<string, unknown>;
    expect(out['credentials']).toBe('none');
  });

  it('still removes a secret shape found in any value', () => {
    const out = scrubStrings({ note: `key ${PEM_CANARY}` }) as Record<string, unknown>;
    expect(out['note']).toBe('key [REDACTED:PEM]');
  });
});
