import {
  generateDataSafetyCsv,
  pendingOf,
  projectionSummaryLine,
  projectPrivacy,
  renderPending,
} from '@agentship/catalog';
import type {
  ActionDraft,
  DiffEntry,
  DifferInput,
  PendingField,
  ResourceDiffer,
} from '@agentship/core';
import { DATA_SAFETY_ARCHIVE, declarationHash, lastArchivedDeclaration } from '@agentship/core';

/**
 * `google/privacy` — the Data Safety declaration and the App content pending it belongs to.
 *
 * Data Safety is the one privacy surface with a real API, and it has an unusual shape:
 * `applications.dataSafety` accepts an update and offers **no way to read the declaration
 * back** (verified against the pinned `gpc`, whose own `data-safety get` refuses with that
 * reason). Convergence therefore cannot be decided against a snapshot. It is decided against
 * the copy Agentship archived after the last apply — an honest record of Agentship's own writes,
 * never a claim about the store, which is exactly what the diff says.
 *
 * The rest of the App content section — target audience, ads, news, financial features — has
 * no API at all and stays a catalog entry, filled in with the same projection so the console
 * and the manifest can be compared side by side.
 *
 * The double gate is the same as Apple's: nothing is drafted while the declaration is a
 * draft, and what is drafted is still `needs_approval`.
 */
export function googlePrivacyDiffer(): ResourceDiffer {
  return {
    store: 'google',
    resource: 'privacy',
    async plan(input: DifferInput): Promise<readonly ActionDraft[]> {
      const privacy = input.manifest.privacy;
      if (privacy === undefined || privacy.dataPractices.length === 0) return [];

      const projection = projectPrivacy('google', privacy);

      if (privacy.declarationStatus !== 'confirmed') {
        return [
          {
            kind: 'confirm_privacy',
            target: 'data-safety',
            operation: 'dataSafety',
            summary: 'Confirm the Data Safety declaration before Agentship sends it to Play',
            diff: projection.practices.map((practice) => ({
              path: `privacy.${practice.dataType}`,
              after: `${practice.category}: ${practice.purposes.join(', ')}`,
              ...(practice.evidence === undefined ? {} : { note: practice.evidence }),
            })),
            needsInput: ['privacy.declarationStatus'],
            riskNotes: [
              'Agentship proposed this from the SDKs and permissions in the repository. Google holds the developer responsible for the answers, and an inaccurate Data Safety form is grounds for removal.',
              'Read it with the user, correct the manifest, then set privacy.declarationStatus to "confirmed".',
            ],
          },
        ];
      }

      if (projection.questions.length > 0) {
        return [
          {
            kind: 'answer_privacy_questions',
            target: 'data-safety',
            operation: 'dataSafety',
            summary: `${projection.questions.length} privacy question(s) have no answer Play accepts`,
            diff: projection.questions.map((question, index) => ({
              path: `privacy.questions[${index}]`,
              after: question,
            })),
            needsInput: ['privacy.dataPractices'],
          },
        ];
      }

      const { csv, summary } = generateDataSafetyCsv(projection);
      const applied = await lastArchivedDeclaration(input.repoRoot, DATA_SAFETY_ARCHIVE);
      const hash = declarationHash(csv);
      const drafts: ActionDraft[] = [];

      if (applied?.sha256 !== hash) {
        const diff: DiffEntry[] = summary.map((line, index) => ({
          path: `dataSafety[${index}]`,
          ...(applied?.summary[index] === undefined ? {} : { before: applied.summary[index] }),
          after: line,
        }));
        drafts.push({
          kind: 'set_data_safety',
          target: 'data-safety',
          operation: 'dataSafety',
          summary: `Apply the Data Safety declaration (${summary.length} row(s)) to Google Play`,
          diff,
          op: { op: 'set_data_safety', declaration: { csv, summary } },
          riskNotes: [
            'This publishes the Data safety section customers read on the store page.',
            applied === undefined
              ? 'Agentship has applied no Data Safety declaration to this project before. Play exposes no way to read the current one, so it cannot tell whether the console already holds something different — check the console before approving.'
              : `Compared against what Agentship applied on ${applied.appliedAt}. Play has no API to read the live declaration, so a change made in the console is invisible here.`,
          ],
        });
      }

      drafts.push(appContentDraft(input, projection));
      return drafts;
    },
  };
}

function appContentDraft(
  input: DifferInput,
  projection: ReturnType<typeof projectPrivacy>,
): ActionDraft {
  const analysis = input.analysis;
  const adsSdks = analysis?.sdks.filter((sdk) => sdk.categories.includes('ads')) ?? [];
  const fields: PendingField[] = projection.practices.map((practice) => ({
    name: `dataType_${practice.dataType}`,
    label: `${practice.category} — ${practice.types.join(', ')}`,
    required: true,
    proposedValue: `Collected: yes. Shared: ${practice.shared ? 'yes' : 'no'}. Purposes: ${practice.purposes.join(', ')}.`,
    ...(practice.evidence === undefined
      ? {}
      : {
          rationale: `${practice.evidence}.${practice.note === undefined ? '' : ` ${practice.note}`}`,
        }),
  }));

  const pending = pendingOf(
    renderPending('google:app-content', {
      context: {
        'privacy.summary': projectionSummaryLine(projection),
        'privacy.adsAnswer':
          adsSdks.length > 0
            ? `Yes — ${adsSdks.map((sdk) => sdk.name).join(', ')} was found in the project`
            : 'No advertising SDK was found in the project',
        ...(input.manifest.metadata.locales['en-US']?.privacyPolicyUrl === undefined
          ? {}
          : {
              'manifest.metadata.locales.en-US.privacyPolicyUrl':
                input.manifest.metadata.locales['en-US'].privacyPolicyUrl,
            }),
      },
      extraFields: fields,
      extraSteps: [
        `Agentship's mapping to Play's Data safety categories was last checked on ${projection.mappingVerified}; if the console shows a category that is not listed here, stop and report it.`,
      ],
    }),
  );

  return {
    kind: 'declare_app_content',
    target: 'app-content',
    operation: 'appContentDeclarations',
    summary: 'Complete the App content declarations in Play Console',
    diff: projection.practices.map((practice) => ({
      path: `appContent.${practice.dataType}`,
      after: `${practice.category} / ${practice.types.join(', ')}`,
      ...(practice.evidence === undefined ? {} : { note: practice.evidence }),
    })),
    pending,
    dependsOn: [{ kind: 'set_data_safety', target: 'data-safety', optional: true }],
    riskNotes: [
      'Play refuses a production release while any App content section is incomplete, and the target-audience answer decides which policies the app is held to.',
    ],
  };
}
