import { z } from 'zod';
import type { AppAnalysis, PrivacyDataType } from '../analysis.js';
import type { AgentshipManifest } from './manifest.js';

/**
 * The neutral privacy model: what the app collects, why, and how sure Agentship is.
 *
 * Both stores ask the same underlying questions in incompatible vocabularies, so Agentship
 * keeps one store-neutral declaration in the manifest and projects it (in `@agentship/catalog`)
 * onto Apple's App Privacy categories and Google's Data Safety form. Keeping the model here,
 * in the kernel, is what lets the manifest be the single place a user confirms an answer.
 *
 * Two rules run through everything below.
 *
 * **Agentship proposes; the user declares.** Every practice carries a `source`: `inferred`
 * means Agentship derived it from an SDK or a permission, `declared` means the user said so.
 * A proposal is never treated as an answer — the differs refuse to act until
 * `declarationStatus` is `confirmed`, and the store action is still `needs_approval` on top
 * of that.
 *
 * **Conservative in one direction only.** Where the evidence is ambiguous the proposal
 * over-reports rather than under-reports, and says it is unsure. Declaring a collection that
 * does not happen costs the user a conversation; failing to declare one that does is a
 * policy violation.
 */
export const PRIVACY_PURPOSES = [
  'app_functionality',
  'analytics',
  'advertising',
  'personalization',
  'developer_communications',
  'fraud_prevention',
  'account_management',
  'other',
] as const;

export type PrivacyPurpose = (typeof PRIVACY_PURPOSES)[number];

export const PRIVACY_DATA_TYPES: readonly PrivacyDataType[] = [
  'contact_info',
  'identifiers',
  'usage_data',
  'diagnostics',
  'purchases',
  'location',
  'user_content',
  'contacts',
  'search_history',
  'browsing_history',
  'financial_info',
  'health',
  'sensitive_info',
  'other',
];

export const DataPracticeSchema = z
  .object({
    dataType: z.enum(PRIVACY_DATA_TYPES as [PrivacyDataType, ...PrivacyDataType[]]),
    /** False declares explicitly that this data type is *not* collected. */
    collected: z.boolean().default(true),
    purposes: z.array(z.enum(PRIVACY_PURPOSES)).min(1),
    /** Whether the data is tied to the user's identity or account. */
    linkedToUser: z.boolean().default(false),
    /** Whether it is used to track the user across other companies' apps and sites. */
    tracking: z.boolean().default(false),
    /** Whether it is shared with third parties (Google asks this separately from collection). */
    shared: z.boolean().default(false),
    /** `inferred` — Agentship derived it; `declared` — the user said so. */
    source: z.enum(['inferred', 'declared']).default('inferred'),
    /** Why Agentship believes this, in one line the user can judge. */
    evidence: z.string().optional(),
  })
  .strict();

export const PrivacySchema = z
  .object({
    /**
     * `draft` until the user has read the whole declaration and said it is right.
     *
     * This is the first of the two gates: a differ may not emit a privacy action while the
     * declaration is a draft, however complete it looks. Confirming content is not the same
     * as approving a submission, so the action it eventually emits is still
     * `needs_approval`.
     */
    declarationStatus: z.enum(['draft', 'confirmed']).default('draft'),
    dataPractices: z.array(DataPracticeSchema).default([]),
    /** Set when the user confirmed, so a later analysis change can be reported as drift. */
    confirmedFrom: z
      .string()
      .regex(/^[0-9a-f]{8,64}$/, 'confirmedFrom must be a fingerprint of the signals')
      .optional(),
  })
  .strict();

export type DataPractice = z.infer<typeof DataPracticeSchema>;
export type PrivacyDeclaration = z.infer<typeof PrivacySchema>;

/**
 * Purposes an SDK category implies.
 *
 * Deliberately coarse and deliberately documented: these are the assumptions the proposal
 * rests on, and the reason every proposed practice carries its evidence string. An SDK that
 * *can* do something is not proof that the app does — which is why nothing here reaches a
 * store without the user confirming it.
 */
const PURPOSE_BY_CATEGORY: Readonly<Record<string, readonly PrivacyPurpose[]>> = {
  ads: ['advertising'],
  analytics: ['analytics'],
  tracking: ['advertising', 'analytics'],
  crash: ['app_functionality'],
  push: ['app_functionality', 'developer_communications'],
  auth: ['account_management', 'app_functionality'],
  purchases: ['app_functionality'],
  storage: ['app_functionality'],
  maps: ['app_functionality'],
  media: ['app_functionality'],
  support: ['developer_communications'],
  other: ['app_functionality'],
};

/** Data types that are never merely functional: collecting them is a decision. */
const SENSITIVE_TYPES: ReadonlySet<PrivacyDataType> = new Set<PrivacyDataType>([
  'health',
  'financial_info',
  'sensitive_info',
  'contacts',
  'location',
]);

export interface PrivacyProposal {
  readonly declaration: PrivacyDeclaration;
  /**
   * Questions Agentship refuses to answer for the user, each one about a specific practice.
   * These become `needs_input` rather than a guessed value.
   */
  readonly questions: readonly string[];
  /** Fingerprint of the signals the proposal was derived from. */
  readonly fingerprint: string;
}

/** Stable, order-independent fingerprint of an analysis' privacy signals. */
export function privacySignalFingerprint(analysis: AppAnalysis): string {
  const parts = analysis.privacySignals
    .map((signal) => `${signal.dataType}:${[...signal.sdkIds].sort().join('+')}`)
    .sort();
  let hash = 0x811c9dc5;
  for (const char of parts.join('|')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Builds a privacy proposal from an analysis.
 *
 * The output is a `draft` declaration: complete enough for the user to read line by line,
 * never complete enough to submit. Anything the evidence cannot settle — whether data is
 * linked to an identity, whether an advertising SDK is configured to track — comes back as a
 * question rather than as a default.
 */
export function proposePrivacy(analysis: AppAnalysis): PrivacyProposal {
  const questions: string[] = [];
  const practices: DataPractice[] = [];
  const categories = new Set(analysis.sdks.flatMap((sdk) => sdk.categories));
  const hasAds = categories.has('ads') || categories.has('tracking');
  const hasAuth = categories.has('auth');

  for (const signal of analysis.privacySignals) {
    const sdkCategories = analysis.sdks
      .filter((sdk) => signal.sdkIds.includes(sdk.id))
      .flatMap((sdk) => sdk.categories);
    const purposes = new Set<PrivacyPurpose>();
    for (const category of sdkCategories) {
      for (const purpose of PURPOSE_BY_CATEGORY[category] ?? ['app_functionality']) {
        purposes.add(purpose);
      }
    }
    if (purposes.size === 0) purposes.add('app_functionality');

    // Identifiers next to an advertising SDK is the combination both stores treat as
    // tracking. It is also the one users get wrong most often, so it is asked about rather
    // than assumed either way.
    const maybeTracking =
      hasAds && (signal.dataType === 'identifiers' || purposes.has('advertising'));
    if (maybeTracking) {
      questions.push(
        `Does the app use ${signal.dataType.replace(/_/g, ' ')} to track users across other companies' apps and websites? An advertising SDK is present, which usually means yes, but only you know how it is configured.`,
      );
    }
    if (SENSITIVE_TYPES.has(signal.dataType)) {
      questions.push(
        `Is ${signal.dataType.replace(/_/g, ' ')} really collected and sent off the device, or only used locally? ${signal.reason}.`,
      );
    }

    practices.push({
      dataType: signal.dataType,
      collected: true,
      purposes: [...purposes].sort(),
      // An account SDK is what makes data identifiable; without one, assume it is not, and
      // say so in the evidence so the user can correct it.
      linkedToUser: hasAuth,
      tracking: maybeTracking,
      shared: sdkCategories.includes('ads') || sdkCategories.includes('analytics'),
      source: 'inferred',
      evidence: signal.reason,
    });
  }

  practices.sort((a, b) => a.dataType.localeCompare(b.dataType));
  return {
    declaration: { declarationStatus: 'draft', dataPractices: practices },
    questions: [...new Set(questions)],
    fingerprint: privacySignalFingerprint(analysis),
  };
}

export interface PrivacyFinding {
  /** Stable code, so an agent can react without parsing the message. */
  readonly code: string;
  readonly severity: 'warning' | 'error';
  readonly message: string;
  /** What to do about it, phrased for an agent to relay. */
  readonly remediation: string;
}

/**
 * Checks a manifest's privacy declaration against what the repository shows.
 *
 * These are warnings on a plan, not blockers — except where a store itself blocks, which is
 * the case for a missing iOS usage description: Apple rejects a build that requests a
 * permission without one, so it is reported as an error and named as such.
 */
export function privacyLint(
  manifest: AgentshipManifest,
  analysis: AppAnalysis | undefined,
): readonly PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];
  const privacy = manifest.privacy;

  const declaredTypes = new Set(
    (privacy?.dataPractices ?? []).map((practice) => practice.dataType),
  );
  const policyUrl = Object.values(manifest.metadata.locales).some(
    (locale) => locale.privacyPolicyUrl !== undefined,
  );

  if (analysis !== undefined) {
    for (const permission of analysis.permissions.ios) {
      const description = permission.usageDescription?.value;
      if (description === undefined || description.trim() === '') {
        findings.push({
          code: 'MISSING_USAGE_DESCRIPTION',
          severity: 'error',
          message: `${permission.key} is declared without a purpose string. App Review rejects a build that asks for a permission without explaining why.`,
          remediation: `Add a human-readable ${permission.key} to Info.plist describing why the app needs it.`,
        });
        continue;
      }
      if (description.trim().length < 15 || /^(we need|required|for the app)/i.test(description)) {
        findings.push({
          code: 'GENERIC_USAGE_DESCRIPTION',
          severity: 'warning',
          message: `${permission.key} has a purpose string ("${description.trim().slice(0, 60)}") that does not say what the data is used for.`,
          remediation:
            'Rewrite it to name the feature that needs the permission; reviewers reject vague strings.',
        });
      }
    }

    for (const signal of analysis.privacySignals) {
      if (!declaredTypes.has(signal.dataType)) {
        findings.push({
          code: 'UNDECLARED_DATA_TYPE',
          severity: 'warning',
          message: `The repository suggests ${signal.dataType.replace(/_/g, ' ')} is collected (${signal.reason}) but the manifest declares nothing about it.`,
          remediation:
            'Run the privacy proposal again and confirm the declaration, or declare explicitly that this data type is not collected.',
        });
      }
    }

    const adsSdks = analysis.sdks.filter((sdk) => sdk.categories.includes('ads'));
    const declaresAdvertising = (privacy?.dataPractices ?? []).some((practice) =>
      practice.purposes.includes('advertising'),
    );
    if (adsSdks.length > 0 && !declaresAdvertising) {
      findings.push({
        code: 'ADS_WITHOUT_DECLARATION',
        severity: 'warning',
        message: `${adsSdks.map((sdk) => sdk.name).join(', ')} is present but no data practice declares an advertising purpose.`,
        remediation:
          'Either declare the advertising purpose, or confirm with the user that the SDK is present but unused.',
      });
    }

    const tracking = (privacy?.dataPractices ?? []).some((practice) => practice.tracking);
    const hasAtt = analysis.permissions.ios.some(
      (permission) => permission.key === 'NSUserTrackingUsageDescription',
    );
    if (tracking && !hasAtt && analysis.platforms.includes('ios')) {
      findings.push({
        code: 'TRACKING_WITHOUT_ATT',
        severity: 'error',
        message:
          'The declaration says data is used for tracking, but the app declares no NSUserTrackingUsageDescription. Apple requires App Tracking Transparency for tracking.',
        remediation:
          'Add NSUserTrackingUsageDescription and request permission before tracking, or correct the declaration.',
      });
    }

    const fingerprint = privacySignalFingerprint(analysis);
    if (
      privacy?.declarationStatus === 'confirmed' &&
      privacy.confirmedFrom !== undefined &&
      privacy.confirmedFrom !== fingerprint
    ) {
      findings.push({
        code: 'PRIVACY_DECLARATION_DRIFT',
        severity: 'warning',
        message:
          'The code has changed since the privacy declaration was confirmed: the SDKs and permissions no longer produce the signals it was based on.',
        remediation:
          'Re-run the proposal, show the user what changed, and confirm again before applying any privacy action.',
      });
    }
  }

  if (declaredTypes.size > 0 && !policyUrl) {
    findings.push({
      code: 'MISSING_PRIVACY_POLICY_URL',
      severity: 'warning',
      message:
        'The app declares data collection but no locale carries a privacy policy URL. Google requires one for every app; Apple requires one for any app that collects data.',
      remediation:
        'Add metadata.locales.<locale>.privacyPolicyUrl pointing at a page that actually resolves.',
    });
  }

  return findings;
}
