import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AgentshipError,
  ERROR_CODES,
  type PrivacyDataType,
  type SdkCategory,
} from '@agentship/core';

/**
 * Coverage as data.
 *
 * Which SDKs matter, and which platform requirements are in force, change far more often
 * than the code that reasons about them. Both live in `data/*.json` so a policy update is a
 * reviewed data change with a `lastVerified` date, not a code change.
 */

export type Ecosystem = 'npm' | 'pub' | 'pod' | 'gradle';

export interface SdkCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly categories: readonly SdkCategory[];
  readonly privacy: readonly PrivacyDataType[];
  readonly implications: readonly string[];
  readonly match: Readonly<Record<Ecosystem, readonly string[]>>;
}

interface SdkCatalogFile {
  readonly schemaVersion: number;
  readonly lastVerified: string;
  readonly sdks: readonly SdkCatalogEntry[];
}

export interface TargetSdkRequirement {
  readonly apiLevel: number;
  readonly androidVersion: string;
  readonly effectiveFrom: string;
  readonly appliesTo: string;
}

interface AndroidRequirementsFile {
  readonly schemaVersion: number;
  readonly lastVerified: string;
  readonly targetSdkRequirements: readonly TargetSdkRequirement[];
}

function loadData<T>(name: string): T {
  const path = fileURLToPath(new URL(`../data/${name}`, import.meta.url));
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (cause) {
    throw AgentshipError.from(
      ERROR_CODES.CONFIG_NOT_FOUND,
      `The analyzer data file ${name} is missing or unreadable at ${path}.`,
      cause,
    );
  }
}

let sdkCatalog: SdkCatalogFile | undefined;
let androidRequirements: AndroidRequirementsFile | undefined;

export function loadSdkCatalog(): readonly SdkCatalogEntry[] {
  sdkCatalog ??= loadData<SdkCatalogFile>('sdk-catalog.json');
  return sdkCatalog.sdks;
}

export function sdkCatalogLastVerified(): string {
  sdkCatalog ??= loadData<SdkCatalogFile>('sdk-catalog.json');
  return sdkCatalog.lastVerified;
}

export function loadAndroidRequirements(): AndroidRequirementsFile {
  androidRequirements ??= loadData<AndroidRequirementsFile>('android-requirements.json');
  return androidRequirements;
}

/**
 * Highest `targetSdk` Google already requires, given a reference date.
 *
 * Only announced levels are in the table; nothing is extrapolated, so a project is never
 * warned about a requirement that does not exist yet.
 */
export function requiredTargetSdk(now: Date = new Date()): TargetSdkRequirement | undefined {
  const effective = loadAndroidRequirements()
    .targetSdkRequirements.filter((entry) => Date.parse(entry.effectiveFrom) <= now.getTime())
    .sort((a, b) => b.apiLevel - a.apiLevel);
  return effective[0];
}
