import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertAppleIssuerId,
  assertAppleKeyId,
  assertApplePrivateKey,
  assertProfileName,
  parseServiceAccountJson,
} from '../src/index.js';
import { applePrivateKeyPem, rsaPrivateKeyPem, serviceAccountJson } from './helpers.js';

describe('Apple key validation', () => {
  it('accepts a real EC P-256 key', () => {
    expect(() => assertApplePrivateKey(applePrivateKeyPem())).not.toThrow();
  });

  it('rejects an RSA key, which Apple never issues', () => {
    expect(() => assertApplePrivateKey(rsaPrivateKeyPem())).toThrowError(/EC key/);
  });

  it('rejects a key on the wrong curve', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => assertApplePrivateKey(pem)).toThrowError(/P-256/);
  });

  it('rejects a certificate or any other pasted file', () => {
    expect(() =>
      assertApplePrivateKey('-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----'),
    ).toThrowError(/does not look like/);
    expect(() => assertApplePrivateKey('')).toThrowError(/does not look like/);
  });

  it('rejects a truncated key', () => {
    const pem = applePrivateKeyPem();
    expect(() => assertApplePrivateKey(pem.slice(0, pem.length / 2))).toThrow();
  });

  it('accepts a key with surrounding whitespace', () => {
    expect(() => assertApplePrivateKey(`\n  ${applePrivateKeyPem()}  \n`)).not.toThrow();
  });
});

describe('Apple identifier validation', () => {
  it('accepts well-formed identifiers', () => {
    expect(() => assertAppleKeyId('ABCD1234EF')).not.toThrow();
    expect(() => assertAppleIssuerId('69a6de70-03db-47e3-e053-5b8c7c11a4d1')).not.toThrow();
  });

  it('rejects malformed identifiers with an actionable message', () => {
    expect(() => assertAppleKeyId('abcd1234ef')).toThrowError(/10 uppercase/);
    expect(() => assertAppleKeyId('ABC')).toThrow();
    expect(() => assertAppleIssuerId('not-a-uuid')).toThrowError(/UUID/);
  });
});

describe('Google service-account validation', () => {
  it('extracts the non-secret fields from a valid key file', () => {
    expect(parseServiceAccountJson(serviceAccountJson())).toEqual({
      clientEmail: 'agentship-publisher@agentship-test.iam.gserviceaccount.com',
      projectId: 'agentship-test',
    });
  });

  it('rejects a non-service-account credential', () => {
    expect(() =>
      parseServiceAccountJson(serviceAccountJson({ type: 'authorized_user' })),
    ).toThrowError(/service account key is required/);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseServiceAccountJson('{ nope')).toThrowError(/not valid JSON/);
  });

  it('rejects a key file with fields stripped out', () => {
    expect(() =>
      parseServiceAccountJson(serviceAccountJson({ private_key: undefined })),
    ).toThrowError(/no private key/);
    expect(() =>
      parseServiceAccountJson(serviceAccountJson({ client_email: undefined })),
    ).toThrowError(/client_email/);
    expect(() =>
      parseServiceAccountJson(serviceAccountJson({ project_id: undefined })),
    ).toThrowError(/project_id/);
  });
});

describe('profile names', () => {
  it('accepts simple names', () => {
    for (const name of ['default', 'work', 'client-acme', 'a.b_c']) {
      expect(() => assertProfileName(name)).not.toThrow();
    }
  });

  it('rejects names that could escape the keyring or the filesystem', () => {
    for (const name of ['', '../etc', 'a/b', 'a b', '.hidden', 'x'.repeat(65)]) {
      expect(() => assertProfileName(name), name).toThrow();
    }
  });
});
