import {
  AgentshipError,
  DEFAULT_PROFILE,
  ERROR_CODES,
  getLogger,
  type Logger,
  readUserConfig,
  registerSecret,
  type Store,
  updateUserConfig,
} from '@agentship/core';
import { appleFromEnv, envConfigured, googleFromEnv } from './env.js';
import { keyringDelete, keyringGet, keyringSet } from './keyring.js';
import type {
  AppleCredentials,
  CredentialSource,
  Credentials,
  CredentialsFor,
  GoogleCredentials,
  ProfileSummary,
} from './types.js';
import {
  assertAppleCredentials,
  assertGoogleCredentials,
  assertProfileName,
  parseServiceAccountJson,
} from './validate.js';

/**
 * The credential store.
 *
 * Secrets live in the OS keyring under `agentship` / `<store>:<profile>`; everything
 * non-secret that Agentship needs to reason about a profile (which key id, which service
 * account, when it was stored) lives in `~/.agentship/config.json`. That split is what makes
 * `listProfiles` and `doctor` work without unlocking anything, and it is why the config
 * file can be inspected — or synced — without leaking credentials.
 */

export interface CredentialOptions {
  readonly profile?: string;
  readonly logger?: Logger;
}

function resolveProfile(profile: string | undefined): string {
  const name = profile ?? DEFAULT_PROFILE;
  assertProfileName(name);
  return name;
}

/** Validates and stores a credential, then records its non-secret metadata. */
export async function setCredentials(
  credentials: Credentials,
  options: CredentialOptions = {},
): Promise<void> {
  const profile = resolveProfile(options.profile);
  const updatedAt = new Date().toISOString();

  if (credentials.store === 'apple') {
    assertAppleCredentials(credentials);
    registerSecret(credentials.privateKeyPem);
    await keyringSet(
      'apple',
      profile,
      JSON.stringify({
        keyId: credentials.keyId,
        issuerId: credentials.issuerId,
        privateKeyPem: credentials.privateKeyPem.trim(),
        ...(credentials.keyName === undefined ? {} : { keyName: credentials.keyName }),
      }),
    );
    await updateUserConfig((config) => ({
      ...config,
      profiles: {
        ...config.profiles,
        [profile]: {
          ...config.profiles[profile],
          apple: {
            keyId: credentials.keyId,
            issuerId: credentials.issuerId,
            ...(credentials.keyName === undefined ? {} : { keyName: credentials.keyName }),
            updatedAt,
          },
        },
      },
    }));
    return;
  }

  assertGoogleCredentials(credentials);
  registerSecret(credentials.serviceAccountJson);
  await keyringSet('google', profile, credentials.serviceAccountJson);
  await updateUserConfig((config) => ({
    ...config,
    profiles: {
      ...config.profiles,
      [profile]: {
        ...config.profiles[profile],
        google: {
          clientEmail: credentials.clientEmail,
          projectId: credentials.projectId,
          updatedAt,
        },
      },
    },
  }));
}

/**
 * Loads a credential, preferring the environment over the keyring.
 *
 * The precedence is fixed and reported: an operator who exports credentials in a shell or a
 * CI job must get exactly those, and must be told when they shadow something stored.
 */
export async function getCredentials<S extends Store>(
  store: S,
  options: CredentialOptions = {},
): Promise<CredentialsFor<S>> {
  const profile = resolveProfile(options.profile);
  const logger = options.logger ?? getLogger();

  if (envConfigured(store)) {
    const fromEnv =
      store === 'apple'
        ? ((await appleFromEnv()) as Credentials | undefined)
        : ((await googleFromEnv()) as Credentials | undefined);
    if (fromEnv !== undefined) {
      if ((await keyringGet(store, profile).catch(() => undefined)) !== undefined) {
        logger.warn('environment credentials take precedence over the stored ones', {
          store,
          profile,
        });
      }
      return fromEnv as CredentialsFor<S>;
    }
  }

  const raw = await keyringGet(store, profile);
  if (raw === undefined) {
    const config = await readUserConfig();
    if (profile !== DEFAULT_PROFILE && config.profiles[profile] === undefined) {
      throw new AgentshipError(
        ERROR_CODES.AUTH_PROFILE_NOT_FOUND,
        `There is no credential profile named "${profile}".`,
        {
          store,
          details: { profile, known: Object.keys(config.profiles) },
          remediation: { summary: 'Use one of the configured profiles, or create this one.' },
        },
      );
    }
    throw new AgentshipError(
      ERROR_CODES.AUTH_MISSING_CREDENTIALS,
      `No ${store === 'apple' ? 'App Store Connect' : 'Google Play'} credentials are configured for profile "${profile}".`,
      {
        store,
        details: { profile },
        remediation: {
          summary:
            store === 'apple'
              ? 'Create an App Store Connect API key and store it with Agentship.'
              : 'Create a Google service account, invite it in Play Console, and store its JSON key with Agentship.',
        },
      },
    );
  }

  return (
    store === 'apple' ? parseStoredApple(raw, profile) : parseStoredGoogle(raw, profile)
  ) as CredentialsFor<S>;
}

function parseStoredApple(raw: string, profile: string): AppleCredentials {
  let parsed: Partial<AppleCredentials>;
  try {
    parsed = JSON.parse(raw) as Partial<AppleCredentials>;
  } catch (cause) {
    throw AgentshipError.from(
      ERROR_CODES.AUTH_INVALID_CREDENTIALS,
      `The stored Apple credential for profile "${profile}" is unreadable.`,
      cause,
      { store: 'apple', remediation: { summary: 'Store the App Store Connect key again.' } },
    );
  }
  const credentials: AppleCredentials = {
    store: 'apple',
    keyId: parsed.keyId ?? '',
    issuerId: parsed.issuerId ?? '',
    privateKeyPem: parsed.privateKeyPem ?? '',
    ...(parsed.keyName === undefined ? {} : { keyName: parsed.keyName }),
  };
  assertAppleCredentials(credentials);
  registerSecret(credentials.privateKeyPem);
  return credentials;
}

function parseStoredGoogle(raw: string, profile: string): GoogleCredentials {
  try {
    const { clientEmail, projectId } = parseServiceAccountJson(raw);
    registerSecret(raw);
    return { store: 'google', serviceAccountJson: raw, clientEmail, projectId };
  } catch (cause) {
    if (AgentshipError.is(cause)) throw cause;
    throw AgentshipError.from(
      ERROR_CODES.AUTH_INVALID_CREDENTIALS,
      `The stored Google credential for profile "${profile}" is unreadable.`,
      cause,
      { store: 'google', remediation: { summary: 'Store the service-account JSON again.' } },
    );
  }
}

/** Where a credential would come from, without materialising any secret material. */
export async function credentialSource(
  store: Store,
  options: CredentialOptions = {},
): Promise<CredentialSource> {
  const profile = resolveProfile(options.profile);
  if (envConfigured(store)) return 'env';
  const raw = await keyringGet(store, profile).catch(() => undefined);
  return raw === undefined ? 'none' : 'keyring';
}

/** Removes a stored credential and its metadata. Returns true when something was removed. */
export async function deleteCredentials(
  store: Store,
  options: CredentialOptions = {},
): Promise<boolean> {
  const profile = resolveProfile(options.profile);
  const removed = await keyringDelete(store, profile);
  await updateUserConfig((config) => {
    const existing = config.profiles[profile];
    if (existing === undefined) return config;
    const { [store]: _dropped, ...rest } = existing;
    const profiles = { ...config.profiles };
    if (Object.keys(rest).length === 0) delete profiles[profile];
    else profiles[profile] = rest;
    return { ...config, profiles };
  });
  return removed;
}

/** Lists configured profiles from the non-secret metadata; never unlocks the keyring. */
export async function listProfiles(): Promise<ProfileSummary[]> {
  const config = await readUserConfig();
  return Object.entries(config.profiles)
    .map(([profile, meta]) => ({
      profile,
      ...(meta.apple === undefined
        ? {}
        : {
            apple: {
              keyId: meta.apple.keyId,
              issuerId: meta.apple.issuerId,
              updatedAt: meta.apple.updatedAt,
            },
          }),
      ...(meta.google === undefined
        ? {}
        : {
            google: {
              clientEmail: meta.google.clientEmail,
              projectId: meta.google.projectId,
              updatedAt: meta.google.updatedAt,
            },
          }),
    }))
    .sort((a, b) => a.profile.localeCompare(b.profile));
}
