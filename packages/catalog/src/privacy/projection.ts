import type { DataPractice, PrivacyDeclaration, Store } from '@agentship/core';
import { mapDataType, mapPurpose, privacyMapping } from './mapping.js';

/**
 * Projecting the neutral privacy declaration onto one store's vocabulary.
 *
 * Pure functions over the mapping tables: same declaration, same projection, every time.
 * What they never do is fill a hole. A practice whose data type or purpose has no equivalent
 * in the target store comes back in `questions`, and every caller — the Data Safety CSV
 * generator, the App Privacy console entry — refuses to produce a declaration while any
 * question is open.
 */
export interface ProjectedPractice {
  readonly dataType: DataPractice['dataType'];
  /** The store's category, e.g. `Contact Info` (Apple) or `Personal info` (Google). */
  readonly category: string;
  /** The store's data types inside that category. */
  readonly types: readonly string[];
  /** The store's purpose labels. */
  readonly purposes: readonly string[];
  readonly collected: boolean;
  readonly linkedToUser: boolean;
  readonly tracking: boolean;
  readonly shared: boolean;
  /** Why Agentship believes this, carried through so the console entry can show it. */
  readonly evidence?: string;
  /** Where the projection is a proposal rather than a translation. */
  readonly note?: string;
}

export interface PrivacyProjection {
  readonly store: Store;
  readonly practices: readonly ProjectedPractice[];
  /** Things only the user can answer. A non-empty list blocks every privacy action. */
  readonly questions: readonly string[];
  /** Date the mapping table was last checked against the store's documentation. */
  readonly mappingVerified: string;
}

export function projectPrivacy(store: Store, declaration: PrivacyDeclaration): PrivacyProjection {
  const questions: string[] = [];
  const practices: ProjectedPractice[] = [];

  for (const practice of [...declaration.dataPractices].sort((a, b) =>
    a.dataType.localeCompare(b.dataType),
  )) {
    if (!practice.collected) continue;
    const mapped = mapDataType(store, practice.dataType);
    if (mapped === undefined) {
      questions.push(
        `The ${store} taxonomy has no entry for "${practice.dataType}". Say which of its data types this is, or remove the practice.`,
      );
      continue;
    }
    const purposes: string[] = [];
    for (const purpose of practice.purposes) {
      const label = mapPurpose(store, purpose);
      if (label.label === undefined) {
        questions.push(`${practice.dataType}: ${label.unmappedReason as string}`);
        continue;
      }
      if (!purposes.includes(label.label)) purposes.push(label.label);
    }
    if (purposes.length === 0) {
      questions.push(
        `${practice.dataType} has no purpose that ${store} understands; the declaration cannot be generated.`,
      );
      continue;
    }
    practices.push({
      dataType: practice.dataType,
      category: mapped.category,
      types: mapped.types,
      purposes: purposes.sort(),
      collected: practice.collected,
      linkedToUser: practice.linkedToUser,
      tracking: practice.tracking,
      shared: practice.shared,
      ...(practice.evidence === undefined ? {} : { evidence: practice.evidence }),
      ...(mapped.note === undefined ? {} : { note: mapped.note }),
    });
  }

  return {
    store,
    practices,
    questions: [...new Set(questions)],
    mappingVerified: privacyMapping(store).lastVerified,
  };
}

/** One line per practice, for a diff, a note or a console field. */
export function summarizeProjection(projection: PrivacyProjection): readonly string[] {
  return projection.practices.map(
    (practice) =>
      `${practice.category} / ${practice.types.join(', ')} — purposes: ${practice.purposes.join(', ')}; ${
        practice.linkedToUser ? 'linked to the user' : 'not linked to the user'
      }; ${practice.tracking ? 'used for tracking' : 'not used for tracking'}${
        practice.shared ? '; shared with third parties' : ''
      }`,
  );
}

/** A single scalar the catalog can interpolate into a console field. */
export function projectionSummaryLine(projection: PrivacyProjection): string {
  if (projection.practices.length === 0) return 'No data collection declared.';
  return summarizeProjection(projection).join(' | ');
}
