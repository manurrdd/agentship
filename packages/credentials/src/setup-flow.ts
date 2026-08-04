import type { ActionClass, Store } from '@agentship/core';
import {
  assertAppleIssuerId,
  assertAppleKeyId,
  assertApplePrivateKey,
  parseServiceAccountJson,
} from './validate.js';

/**
 * Guided credential setup, expressed as data.
 *
 * Neither Apple nor Google exposes an API to create the credentials Agentship needs, and both
 * gate the flow behind 2FA — so every console step is `human_only` by definition, not by
 * choice. What Agentship can do is remove all the guesswork: exact URLs, exact clicks, the
 * minimum role to grant, and per-field validation of whatever is pasted back.
 *
 * This is a data structure rather than printed prose because its consumer is an agent
 * (`agentship_configure_auth`), which turns it into a conversation. There is no
 * terminal UI in Agentship.
 */

export type SetupFieldKind =
  | 'apple_key_id'
  | 'apple_issuer_id'
  | 'apple_p8'
  | 'apple_key_name'
  | 'google_sa_json';

export interface SetupField {
  /** Machine name; matches the credential property it fills. */
  readonly name: string;
  readonly label: string;
  readonly kind: SetupFieldKind;
  readonly required: boolean;
  /** True when the value must never be echoed back or logged. */
  readonly secret: boolean;
  /** True when the value is a file's contents rather than a single line. */
  readonly multiline: boolean;
  readonly example?: string;
  readonly help?: string;
}

export interface SetupStep {
  readonly id: string;
  readonly title: string;
  readonly actionClass: ActionClass;
  /** Ordered, imperative instructions. One action per entry. */
  readonly instructions: readonly string[];
  readonly consoleUrl?: string;
  /** Values the user brings back from this step. */
  readonly collects?: readonly SetupField[];
  /** Warnings that change the outcome if ignored. */
  readonly warnings?: readonly string[];
}

export interface SetupTroubleshooting {
  readonly problem: string;
  readonly fix: string;
}

export interface SetupFlow {
  readonly store: Store;
  readonly title: string;
  readonly summary: string;
  /** Rough wall-clock time for someone who has the required account access. */
  readonly estimatedMinutes: number;
  /** What must already be true before starting. */
  readonly prerequisites: readonly string[];
  readonly steps: readonly SetupStep[];
  /** What the user has once the flow completes. */
  readonly result: string;
  readonly troubleshooting: readonly SetupTroubleshooting[];
  /** Date the console instructions were last checked against the real UI (ISO date). */
  readonly lastVerified: string;
}

/** Console UIs drift; this is the date these instructions were last checked. */
const LAST_VERIFIED = '2026-08-03';

const APPLE_FLOW: SetupFlow = {
  store: 'apple',
  title: 'Create an App Store Connect API key',
  summary:
    'Agentship authenticates to Apple with a team API key: a .p8 private key plus its Key ID and the team Issuer ID. Apple only issues these in the App Store Connect web UI, behind two-factor authentication, so a human has to create it once.',
  estimatedMinutes: 5,
  prerequisites: [
    'An Apple Developer Program membership (99 USD/year) that is active.',
    'An App Store Connect user with the Account Holder or Admin role — only those roles can create team API keys.',
    'Access to the two-factor device of that Apple Account.',
  ],
  steps: [
    {
      id: 'apple.signin',
      title: 'Sign in to App Store Connect',
      actionClass: 'human_only',
      consoleUrl: 'https://appstoreconnect.apple.com/access/integrations/api',
      instructions: [
        'Open App Store Connect and sign in with the Account Holder or Admin user.',
        'Complete two-factor authentication when prompted.',
        'Go to Users and Access, then the Integrations tab, then App Store Connect API.',
      ],
      warnings: [
        'Two-factor authentication cannot be automated, and Agentship never asks for an Apple password.',
      ],
    },
    {
      id: 'apple.issuer',
      title: 'Copy the Issuer ID',
      actionClass: 'human_only',
      consoleUrl: 'https://appstoreconnect.apple.com/access/integrations/api',
      instructions: [
        'On the Team Keys tab, find the Issuer ID shown above the key list.',
        'Copy it. It is a UUID and it is the same for every key of the team.',
      ],
      collects: [
        {
          name: 'issuerId',
          label: 'Issuer ID',
          kind: 'apple_issuer_id',
          required: true,
          secret: false,
          multiline: false,
          example: '69a6de70-03db-47e3-e053-5b8c7c11a4d1',
        },
      ],
    },
    {
      id: 'apple.generate',
      title: 'Generate a team key for Agentship',
      actionClass: 'human_only',
      consoleUrl: 'https://appstoreconnect.apple.com/access/integrations/api',
      instructions: [
        'Select Team Keys and click the plus button to generate a new key.',
        'Name it "Agentship" so it is recognisable later.',
        'Choose the App Manager access role.',
        'Click Generate.',
      ],
      collects: [
        {
          name: 'keyName',
          label: 'Key name',
          kind: 'apple_key_name',
          required: false,
          secret: false,
          multiline: false,
          example: 'Agentship',
        },
      ],
      warnings: [
        'App Manager is enough to manage apps, builds, TestFlight and metadata. Admin is broader than Agentship needs; Developer is not enough to edit App Store metadata.',
      ],
    },
    {
      id: 'apple.download',
      title: 'Download the private key and copy the Key ID',
      actionClass: 'human_only',
      consoleUrl: 'https://appstoreconnect.apple.com/access/integrations/api',
      instructions: [
        'Click Download API Key next to the new key.',
        'Save the AuthKey_<KEYID>.p8 file somewhere you control.',
        'Copy the KEY ID value shown in the table.',
      ],
      collects: [
        {
          name: 'keyId',
          label: 'Key ID',
          kind: 'apple_key_id',
          required: true,
          secret: false,
          multiline: false,
          example: 'ABCD1234EF',
        },
        {
          name: 'privateKeyPem',
          label: 'Contents of the .p8 file',
          kind: 'apple_p8',
          required: true,
          secret: true,
          multiline: true,
          help: 'Paste the whole file, including the BEGIN and END lines.',
        },
      ],
      warnings: [
        'Apple allows the .p8 file to be downloaded only once. If it is lost, the key must be revoked and a new one generated.',
      ],
    },
    {
      id: 'apple.store',
      title: 'Store the credential in Agentship',
      actionClass: 'auto',
      instructions: [
        'Agentship validates the key (it must be an EC P-256 key), stores it in the OS keyring, and keeps only the Key ID and Issuer ID as plain metadata.',
        'The .p8 file downloaded from Apple can now be deleted from disk.',
      ],
    },
  ],
  result:
    'Agentship can read and write App Store Connect on behalf of the team, without ever holding an Apple Account password.',
  troubleshooting: [
    {
      problem: 'The Team Keys tab shows no plus button.',
      fix: 'The signed-in user is not Account Holder or Admin. Ask one of them to create the key, or to change your role.',
    },
    {
      problem: 'The .p8 file was lost.',
      fix: 'Revoke the key in App Store Connect and generate a new one; Apple never offers the same file twice.',
    },
    {
      problem: 'Requests fail with "not authorized" after setup.',
      fix: 'The key was created with too narrow a role. Generate a new key with the App Manager role.',
    },
  ],
  lastVerified: LAST_VERIFIED,
};

const GOOGLE_FLOW: SetupFlow = {
  store: 'google',
  title: 'Create a Google Play service account',
  summary:
    'Agentship authenticates to Google Play with a service account: a JSON key created in Google Cloud, then invited into Play Console with the permissions it needs. Neither the key nor the invitation can be created through an API.',
  estimatedMinutes: 12,
  prerequisites: [
    'A Google Play Developer account (25 USD one-off) with identity verification completed.',
    'Play Console access with the Admin (account owner) role, which is required to invite users.',
    'A Google Cloud project you can administer, or permission to create one.',
  ],
  steps: [
    {
      id: 'google.project',
      title: 'Choose or create a Google Cloud project',
      actionClass: 'human_only',
      consoleUrl: 'https://console.cloud.google.com/projectcreate',
      instructions: [
        'Open the Google Cloud console and sign in with the account that administers Play.',
        'Create a project (for example "agentship-publishing") or select an existing one.',
        'Note the project id: it appears in the service-account JSON later.',
      ],
    },
    {
      id: 'google.api',
      title: 'Enable the Google Play Android Developer API',
      actionClass: 'human_only',
      consoleUrl: 'https://console.cloud.google.com/apis/library/androidpublisher.googleapis.com',
      instructions: [
        'Open the API library page for the Google Play Android Developer API.',
        'Confirm the correct project is selected.',
        'Click Enable.',
      ],
      warnings: [
        'Without this API enabled, every Play call fails with a permission error that does not mention the API.',
      ],
    },
    {
      id: 'google.service-account',
      title: 'Create the service account and its JSON key',
      actionClass: 'human_only',
      consoleUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
      instructions: [
        'Go to IAM and admin, then Service accounts, then Create service account.',
        'Name it "agentship-publisher" and create it.',
        'Do not grant it any project-level role: its permissions come from Play Console, not from Google Cloud.',
        'Open the new service account, go to the Keys tab, and choose Add key, then Create new key, type JSON.',
        'Save the downloaded .json file.',
      ],
      collects: [
        {
          name: 'serviceAccountJson',
          label: 'Contents of the service-account .json file',
          kind: 'google_sa_json',
          required: true,
          secret: true,
          multiline: true,
          help: 'Paste the whole file. Agentship reads client_email and project_id from it.',
        },
      ],
      warnings: [
        'The JSON key is a full credential. Treat the downloaded file like a password and delete it once Agentship has stored it.',
      ],
    },
    {
      id: 'google.invite',
      title: 'Invite the service account into Play Console',
      actionClass: 'human_only',
      consoleUrl: 'https://play.google.com/console/developers/users-and-permissions',
      instructions: [
        'Open Play Console, then Users and permissions, then Invite new users.',
        'Paste the client_email value from the JSON file as the email address.',
        'Grant, at account or app level: View app information, Manage store presence, Manage production releases, Manage testing track releases, and Manage testers.',
        'Send the invitation. Service accounts are accepted immediately; there is no email to confirm.',
      ],
      warnings: [
        'Grant app-level access rather than account-level whenever the service account only needs to publish specific apps.',
        'Permission changes can take a few minutes to take effect across the Play API.',
      ],
    },
    {
      id: 'google.store',
      title: 'Store the credential in Agentship',
      actionClass: 'auto',
      instructions: [
        'Agentship validates the JSON (it must be a service-account key), stores it in the OS keyring, and keeps only client_email and project_id as plain metadata.',
        'The .json file downloaded from Google Cloud can now be deleted from disk.',
      ],
    },
  ],
  result:
    'Agentship can manage Play Console releases, tracks and store listings for the apps the service account was granted.',
  troubleshooting: [
    {
      problem: 'Play API calls return "The current user has insufficient permissions".',
      fix: 'The service account was not invited in Play Console, or lacks the release permissions. Re-check the Users and permissions entry for its client_email.',
    },
    {
      problem: 'Play API calls fail even though permissions look right.',
      fix: 'The Google Play Android Developer API is not enabled in the project that owns the service account.',
    },
    {
      problem: 'A new personal Google Play account cannot reach production.',
      fix: 'Google requires 12 testers for 14 continuous days on a closed track before a personal account can publish to production. Plan for it; it cannot be bypassed.',
    },
  ],
  lastVerified: LAST_VERIFIED,
};

/** Returns the declarative setup flow for a store. */
export function setupFlow(store: Store): SetupFlow {
  return store === 'apple' ? APPLE_FLOW : GOOGLE_FLOW;
}

export function setupFlows(): readonly SetupFlow[] {
  return [APPLE_FLOW, GOOGLE_FLOW];
}

export type FieldValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/**
 * Validates one collected value, so an agent can correct the user immediately instead of
 * after a failed store call.
 */
export function validateSetupValue(kind: SetupFieldKind, value: string): FieldValidation {
  try {
    switch (kind) {
      case 'apple_key_id':
        assertAppleKeyId(value);
        break;
      case 'apple_issuer_id':
        assertAppleIssuerId(value);
        break;
      case 'apple_p8':
        assertApplePrivateKey(value);
        break;
      case 'google_sa_json':
        parseServiceAccountJson(value);
        break;
      case 'apple_key_name':
        if (value.trim() === '') return { ok: false, message: 'The key name cannot be empty.' };
        break;
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
