import type { Store } from '@agentship/core';

/**
 * Credentials Agentship holds, per store.
 *
 * Both stores issue machine credentials that a human must create by hand in a web console
 * (Apple: a team API key; Google: a service account invited into Play Console). Neither can
 * be created through an API, which is why {@link SetupFlow} exists: Agentship guides, the
 * human clicks, Agentship stores and uses the result.
 */

export interface AppleCredentials {
  readonly store: 'apple';
  /** App Store Connect key id, 10 uppercase alphanumerics, shown next to the key. */
  readonly keyId: string;
  /** Issuer id of the team, a UUID shown above the key list. */
  readonly issuerId: string;
  /** Contents of the `AuthKey_<keyId>.p8` file: a PEM-encoded EC P-256 private key. */
  readonly privateKeyPem: string;
  /** Label the user gave the key in App Store Connect, for recognition only. */
  readonly keyName?: string;
}

export interface GoogleCredentials {
  readonly store: 'google';
  /** The service-account JSON, verbatim as downloaded from Google Cloud. */
  readonly serviceAccountJson: string;
  /** `client_email` from that JSON — the address that must be invited in Play Console. */
  readonly clientEmail: string;
  /** `project_id` from that JSON. */
  readonly projectId: string;
}

export type Credentials = AppleCredentials | GoogleCredentials;

export type CredentialsFor<S extends Store> = S extends 'apple'
  ? AppleCredentials
  : GoogleCredentials;

/** Where a credential came from. `env` always wins, so CI can override a developer keyring. */
export type CredentialSource = 'env' | 'keyring' | 'none';

/** What is known about a profile without unlocking any secret. */
export interface ProfileSummary {
  readonly profile: string;
  readonly apple?: {
    readonly keyId: string;
    readonly issuerId: string;
    readonly updatedAt: string;
  };
  readonly google?: {
    readonly clientEmail: string;
    readonly projectId: string;
    readonly updatedAt: string;
  };
}
