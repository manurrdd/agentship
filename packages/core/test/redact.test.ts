import { afterEach, describe, expect, it } from 'vitest';
import {
  clearRegisteredSecrets,
  looksSecret,
  redactString,
  redactValue,
  registerSecret,
} from '../src/redact.js';

/**
 * Canary secrets: every test asserts these exact strings never survive redaction.
 * They are shaped like the real material Agentship handles.
 */
const P8_CANARY = [
  '-----BEGIN PRIVATE KEY-----',
  'MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQgCANARYCANARYCANA',
  'RYCANARYCANARYCANARYCANARYCANARYhRANDANRANDANRANDANRANDANRANDANRA',
  '-----END PRIVATE KEY-----',
].join('\n');

const JWT_CANARY =
  'eyJhbGciOiJFUzI1NiIsImtpZCI6IkFCQ0QxMjM0In0.eyJpc3MiOiJpc3N1ZXIifQ.CANARYSIGNATURExyz-_09';

const SA_JSON_CANARY = JSON.stringify({
  type: 'service_account',
  project_id: 'agentship-test',
  private_key_id: 'CANARYKEYID0123456789',
  private_key: '-----BEGIN PRIVATE KEY-----\\nCANARYSAKEYMATERIAL\\n-----END PRIVATE KEY-----\\n',
  client_email: 'agentship@agentship-test.iam.gserviceaccount.com',
});

afterEach(() => {
  clearRegisteredSecrets();
});

describe('redactString', () => {
  it('removes PEM private keys entirely', () => {
    const out = redactString(`before ${P8_CANARY} after`);
    expect(out).toContain('[REDACTED:PEM]');
    expect(out).not.toContain('CANARY');
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('removes JWTs minted from the Apple key', () => {
    const out = redactString(`Authorization header used ${JWT_CANARY} once`);
    expect(out).not.toContain('CANARYSIGNATURE');
    expect(out).toContain('[REDACTED:JWT]');
  });

  it('removes key material from a service-account JSON blob', () => {
    const out = redactString(SA_JSON_CANARY);
    expect(out).not.toContain('CANARYSAKEYMATERIAL');
    expect(out).not.toContain('CANARYKEYID');
    // Non-secret fields survive so the log stays useful.
    expect(out).toContain('agentship-test');
  });

  it('removes Authorization headers with and without the Bearer prefix', () => {
    expect(redactString('Authorization: Bearer abc.def.ghi')).toBe('Authorization: [REDACTED]');
    expect(redactString('authorization=CANARYTOKEN')).toBe('authorization=[REDACTED]');
  });

  it('removes secret-looking key/value pairs from command lines', () => {
    const out = redactString('gpc --api-key=CANARYVALUE --app com.example');
    expect(out).not.toContain('CANARYVALUE');
    expect(out).toContain('--app com.example');
  });

  it('removes Google API keys', () => {
    const key = `AIza${'C'.repeat(35)}`;
    expect(redactString(`key ${key} end`)).not.toContain(key);
  });

  it('removes literals registered at runtime', () => {
    registerSecret('super-secret-passphrase');
    expect(redactString('value is super-secret-passphrase!')).toBe('value is [REDACTED]!');
  });

  it('ignores registered literals that are too short to scrub safely', () => {
    registerSecret('abc');
    expect(redactString('abc def')).toBe('abc def');
  });

  it('leaves ordinary text untouched', () => {
    const text = 'Uploading build 42 for com.example.app to TestFlight';
    expect(redactString(text)).toBe(text);
  });
});

describe('looksSecret', () => {
  it('flags secret material and accepts ordinary arguments', () => {
    expect(looksSecret(P8_CANARY)).toBe(true);
    expect(looksSecret(JWT_CANARY)).toBe(true);
    expect(looksSecret('--json')).toBe(false);
    expect(looksSecret('com.example.app')).toBe(false);
  });
});

describe('redactValue', () => {
  it('redacts values under secret-looking keys whatever their content', () => {
    const out = redactValue({ privateKey: 'plain', password: 'plain', appId: 'keep' }) as Record<
      string,
      unknown
    >;
    expect(out['privateKey']).toBe('[REDACTED]');
    expect(out['password']).toBe('[REDACTED]');
    expect(out['appId']).toBe('keep');
  });

  it('redacts nested strings and preserves structure', () => {
    const out = redactValue({ a: { b: [`x ${JWT_CANARY}`] } }) as { a: { b: string[] } };
    expect(out.a.b[0]).toBe('x [REDACTED:JWT]');
  });

  it('handles cycles and depth without throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic['self'] = cyclic;
    expect(() => JSON.stringify(redactValue(cyclic))).not.toThrow();
    expect((redactValue(cyclic) as Record<string, unknown>)['self']).toBe('[circular]');
  });

  it('serialises errors with a redacted message and stack', () => {
    const err = new Error(`boom ${JWT_CANARY}`);
    const out = redactValue(err) as Record<string, unknown>;
    expect(out['message']).toBe('boom [REDACTED:JWT]');
    expect(JSON.stringify(out)).not.toContain('CANARYSIGNATURE');
  });

  it('never leaks a registered literal, however deeply nested', () => {
    registerSecret('CANARY-DEEP-VALUE');
    const out = redactValue({ level1: { level2: { level3: ['CANARY-DEEP-VALUE'] } } });
    expect(JSON.stringify(out)).not.toContain('CANARY-DEEP-VALUE');
  });
});
