import { createPrivateKey } from 'node:crypto';
import { AgentshipError, ERROR_CODES } from '@agentship/core';
import type { AppleCredentials, GoogleCredentials } from './types.js';

/**
 * Shallow validation of credential material.
 *
 * "Shallow" means structural: Agentship checks that a `.p8` really is an EC P-256 private key
 * and that a service-account JSON really is one, without contacting Apple or Google. The
 * point is to fail in the second the user pastes the wrong file, instead of failing later
 * inside a store call with an opaque backend error.
 */

/** App Store Connect key ids are 10 uppercase alphanumerics. */
const APPLE_KEY_ID = /^[A-Z0-9]{10}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalid(message: string, store: 'apple' | 'google', remediation: string): AgentshipError {
  return new AgentshipError(ERROR_CODES.AUTH_INVALID_CREDENTIALS, message, {
    store,
    remediation: { summary: remediation },
  });
}

/**
 * Verifies that the pasted text is an EC P-256 private key.
 *
 * App Store Connect keys are always ES256; a user who pastes the `.cer`, an RSA key or a
 * truncated copy is caught here rather than by a JWT signature rejection much later.
 */
export function assertApplePrivateKey(pem: string): void {
  const trimmed = pem.trim();
  if (!trimmed.includes('BEGIN PRIVATE KEY')) {
    throw invalid(
      'That does not look like an App Store Connect key file: no PEM private key block found.',
      'apple',
      'Paste the whole contents of the AuthKey_<KEYID>.p8 file you downloaded from App Store Connect.',
    );
  }
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey(trimmed);
  } catch (cause) {
    throw AgentshipError.from(
      ERROR_CODES.AUTH_INVALID_CREDENTIALS,
      'The App Store Connect private key could not be parsed.',
      cause,
      {
        store: 'apple',
        remediation: {
          summary:
            'Re-download the .p8 file; it can only be downloaded once, so generate a new key if lost.',
        },
      },
    );
  }
  if (key.asymmetricKeyType !== 'ec') {
    throw invalid(
      `The App Store Connect key must be an EC key, but this one is ${key.asymmetricKeyType ?? 'of an unknown type'}.`,
      'apple',
      'Use the .p8 file from App Store Connect > Users and Access > Integrations > App Store Connect API.',
    );
  }
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (curve !== 'prime256v1') {
    throw invalid(
      `The App Store Connect key must use the P-256 curve, but this one uses ${curve ?? 'an unknown curve'}.`,
      'apple',
      'Download the key again from App Store Connect; Apple always issues ES256 (P-256) keys.',
    );
  }
}

export function assertAppleKeyId(keyId: string): void {
  if (!APPLE_KEY_ID.test(keyId)) {
    throw invalid(
      `"${keyId}" is not a valid App Store Connect key id (expected 10 uppercase letters or digits).`,
      'apple',
      'Copy the KEY ID column from App Store Connect > Users and Access > Integrations.',
    );
  }
}

export function assertAppleIssuerId(issuerId: string): void {
  if (!UUID.test(issuerId)) {
    throw invalid(
      `"${issuerId}" is not a valid issuer id (expected a UUID).`,
      'apple',
      'Copy the Issuer ID shown above the key list in App Store Connect > Users and Access > Integrations.',
    );
  }
}

export function assertAppleCredentials(credentials: AppleCredentials): void {
  assertAppleKeyId(credentials.keyId);
  assertAppleIssuerId(credentials.issuerId);
  assertApplePrivateKey(credentials.privateKeyPem);
}

interface ServiceAccountJson {
  readonly type?: string;
  readonly project_id?: string;
  readonly client_email?: string;
  readonly private_key?: string;
}

/**
 * Verifies that the pasted text is a Google service-account key file and returns the
 * non-secret fields Agentship stores as metadata.
 */
export function parseServiceAccountJson(json: string): {
  clientEmail: string;
  projectId: string;
} {
  let parsed: ServiceAccountJson;
  try {
    parsed = JSON.parse(json) as ServiceAccountJson;
  } catch (cause) {
    throw AgentshipError.from(
      ERROR_CODES.AUTH_INVALID_CREDENTIALS,
      'The Google service-account credential is not valid JSON.',
      cause,
      {
        store: 'google',
        remediation: {
          summary:
            'Paste the whole .json key file downloaded from Google Cloud > IAM > Service accounts > Keys.',
        },
      },
    );
  }
  if (parsed.type !== 'service_account') {
    throw invalid(
      `The Google credential declares type "${parsed.type ?? 'none'}", but a service account key is required.`,
      'google',
      'Create a key of type JSON on a service account, not an OAuth client or an API key.',
    );
  }
  if (typeof parsed.client_email !== 'string' || !parsed.client_email.includes('@')) {
    throw invalid(
      'The Google service-account JSON has no usable client_email.',
      'google',
      'Re-download the key file; do not edit it.',
    );
  }
  if (typeof parsed.project_id !== 'string' || parsed.project_id === '') {
    throw invalid(
      'The Google service-account JSON has no project_id.',
      'google',
      'Re-download the key file; do not edit it.',
    );
  }
  if (typeof parsed.private_key !== 'string' || !parsed.private_key.includes('PRIVATE KEY')) {
    throw invalid(
      'The Google service-account JSON contains no private key.',
      'google',
      'Download a new JSON key: the file must include the private_key field.',
    );
  }
  return { clientEmail: parsed.client_email, projectId: parsed.project_id };
}

export function assertGoogleCredentials(credentials: GoogleCredentials): void {
  const { clientEmail, projectId } = parseServiceAccountJson(credentials.serviceAccountJson);
  if (credentials.clientEmail !== clientEmail || credentials.projectId !== projectId) {
    throw invalid(
      'The Google credential metadata does not match the service-account JSON it was derived from.',
      'google',
      'Store the credential again from the original JSON file.',
    );
  }
}

/** Profile names become filesystem and keyring identifiers, so keep them boring. */
const PROFILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function assertProfileName(profile: string): void {
  if (!PROFILE_NAME.test(profile)) {
    throw new AgentshipError(
      ERROR_CODES.AUTH_INVALID_CREDENTIALS,
      `"${profile}" is not a valid profile name (letters, digits, dot, dash and underscore; up to 64 characters).`,
      {
        remediation: { summary: 'Pick a simple name such as `default`, `work` or `client-acme`.' },
      },
    );
  }
}
