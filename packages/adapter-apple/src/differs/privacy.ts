import {
  pendingOf,
  projectionSummaryLine,
  projectPrivacy,
  renderPending,
} from '@agentship/catalog';
import type {
  ActionDraft,
  AgeRatingDeclaration,
  DiffEntry,
  DifferInput,
  PendingField,
  ResourceDiffer,
} from '@agentship/core';

/**
 * `apple/privacy` — the App Privacy declaration and the age rating.
 *
 * Two halves with opposite shapes, which is the whole point of separating them.
 *
 * **App Privacy has no API.** Verified against the 4.4.1 App Store Connect OpenAPI
 * specification: there is no data-use resource. So the declaration can only ever be console
 * work, and what Agentship contributes is the content — the neutral declaration projected onto
 * Apple's categories, one field per data type, with the evidence behind each one. The review
 * differ already blocks the submission on the resulting pending, which is what makes this
 * more than advice.
 *
 * **Age rating does have an API** (`ageRatingDeclarations`), so it is a real action — and
 * still `needs_approval`, because the answers are the developer's statement about their own
 * app's content, not a fact Agentship read anywhere.
 *
 * Both halves sit behind the same **double gate**. Nothing is drafted while
 * `privacy.declarationStatus` is `draft`: confirming the content is the user's act, and it
 * is separate from approving the submission that follows. A plan therefore cannot reach the
 * store with a declaration the user has not read, even if every approval were granted.
 */
export function applePrivacyDiffer(): ResourceDiffer {
  return {
    store: 'apple',
    resource: 'privacy',
    plan(input: DifferInput): readonly ActionDraft[] {
      const privacy = input.manifest.privacy;
      if (privacy === undefined || privacy.dataPractices.length === 0) return [];

      const projection = projectPrivacy('apple', privacy);
      const drafts: ActionDraft[] = [];

      // Gate one: the content has to be confirmed. A draft declaration is a proposal, and a
      // proposal is not something to send to a store.
      if (privacy.declarationStatus !== 'confirmed') {
        drafts.push({
          kind: 'confirm_privacy',
          target: 'app-privacy',
          operation: 'privacyLabels',
          summary: 'Confirm the App Privacy declaration before Agentship proposes it to Apple',
          diff: projection.practices.map((practice) => ({
            path: `privacy.${practice.dataType}`,
            after: `${practice.category}: ${practice.purposes.join(', ')}`,
            ...(practice.evidence === undefined ? {} : { note: practice.evidence }),
          })),
          needsInput: ['privacy.declarationStatus'],
          riskNotes: [
            'Agentship proposed this from the SDKs and permissions in the repository. Only the user knows what the app really collects, and an inaccurate App Privacy declaration is a policy violation.',
            'Read it with them, correct the manifest, then set privacy.declarationStatus to "confirmed".',
          ],
        });
        return drafts;
      }

      if (projection.questions.length > 0) {
        drafts.push({
          kind: 'answer_privacy_questions',
          target: 'app-privacy',
          operation: 'privacyLabels',
          summary: `${projection.questions.length} privacy question(s) have no answer Apple accepts`,
          diff: projection.questions.map((question, index) => ({
            path: `privacy.questions[${index}]`,
            after: question,
          })),
          needsInput: ['privacy.dataPractices'],
        });
        return drafts;
      }

      drafts.push(appPrivacyDraft(input, projection));
      const ageRating = ageRatingDraft(input);
      if (ageRating !== undefined) drafts.push(ageRating);
      return drafts;
    },
  };
}

function appPrivacyDraft(
  input: DifferInput,
  projection: ReturnType<typeof projectPrivacy>,
): ActionDraft {
  // One console field per data type: the catalog owns the form, the projection fills the
  // rows, and nothing about the app's own text is ever concatenated into an instruction.
  const fields: PendingField[] = projection.practices.map((practice) => ({
    name: `dataType_${practice.dataType}`,
    label: `${practice.category} — ${practice.types.join(', ')}`,
    required: true,
    proposedValue: `Purposes: ${practice.purposes.join(', ')}. Linked to the user: ${
      practice.linkedToUser ? 'yes' : 'no'
    }. Used for tracking: ${practice.tracking ? 'yes' : 'no'}.`,
    ...(practice.evidence === undefined
      ? {}
      : {
          rationale: `${practice.evidence}.${practice.note === undefined ? '' : ` ${practice.note}`}`,
        }),
  }));

  const pending = pendingOf(
    renderPending('apple:app-privacy', {
      context: { 'privacy.summary': projectionSummaryLine(projection) },
      extraFields: fields,
      extraSteps: [
        `Agentship's mapping to Apple's categories was last checked on ${projection.mappingVerified}; if App Store Connect shows a category that is not listed here, stop and report it.`,
      ],
      extraNotes: `Projected from ${projection.practices.length} declared data practice(s).`,
    }),
  );

  const diff: DiffEntry[] = projection.practices.map((practice) => ({
    path: `appPrivacy.${practice.dataType}`,
    after: `${practice.category} / ${practice.types.join(', ')} — ${practice.purposes.join(', ')}`,
    ...(practice.evidence === undefined ? {} : { note: practice.evidence }),
  }));

  return {
    kind: 'declare_app_privacy',
    target: 'app-privacy',
    operation: 'privacyLabels',
    summary: `Declare App Privacy for ${projection.practices.length} data type(s) in App Store Connect`,
    diff,
    pending,
    riskNotes: [
      'App Privacy answers are visible on the product page and are a legal declaration. Apple refuses a submission until they are published.',
      `The manifest declaration was confirmed by the user${input.manifest.privacy?.confirmedFrom === undefined ? '' : ` against signal fingerprint ${input.manifest.privacy.confirmedFrom}`}.`,
    ],
  };
}

/**
 * The age rating questionnaire, proposed conservatively.
 *
 * Everything starts at Apple's safe default, and only what the repository actually shows is
 * raised: an advertising SDK means the app contains advertising, and nothing else can be
 * inferred from static analysis. Apple's remaining questions — violence, gambling, mature
 * themes — are about content no analyzer can see, so they stay at NONE and the risk note
 * says so out loud rather than letting a silent default look like an answer.
 */
function ageRatingDraft(input: DifferInput): ActionDraft | undefined {
  // No analysis means no evidence of advertising, which is the safe default anyway.
  const hasAds = input.analysis?.sdks.some((sdk) => sdk.categories.includes('ads')) === true;
  const proposed: Record<string, string | boolean> = {
    advertising: hasAds,
  };

  const current = input.state.ageRating?.answers ?? {};
  const changes: DiffEntry[] = Object.entries(proposed)
    .filter(([key, value]) => current[key] !== value)
    .map(([key, value]) => ({
      path: `ageRating.${key}`,
      ...(current[key] === undefined ? {} : { before: current[key] }),
      after: value,
    }));
  // Nothing to say: either the declaration already matches, or the app has no age rating
  // resource yet and Agentship has nothing to propose beyond the safe defaults.
  if (changes.length === 0) return undefined;

  const declaration: AgeRatingDeclaration = { answers: proposed, allNone: true };
  return {
    kind: 'set_age_rating',
    target: 'age-rating',
    operation: 'contentRating',
    summary: `Set the age rating declaration (advertising: ${hasAds ? 'yes' : 'no'}, everything else at Apple's safe default)`,
    diff: changes,
    op: { op: 'set_age_rating', declaration },
    riskNotes: [
      'Every other question — violence, gambling, mature themes, unrestricted web access — is set to Apple’s safe default because static analysis cannot see app content. If any of them applies, say so before approving: an inaccurate age rating is grounds for removal.',
      ...(hasAds
        ? ['An advertising SDK was found, so the declaration says the app contains advertising.']
        : []),
    ],
  };
}
