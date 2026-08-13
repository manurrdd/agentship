import { readFile, writeFile } from 'node:fs/promises';
import { Document, parseDocument, parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { AppAnalysis } from '../analysis.js';
import { AgentshipError, ERROR_CODES } from '../errors.js';
import { ensureDir, FILE_MODE, manifestPath, projectDir } from '../paths.js';
import type { Provenanced } from '../types.js';
import { MonetizationSchema } from './monetization.js';
import { PrivacySchema, proposePrivacy } from './privacy.js';

/**
 * The desired-state manifest: `.agentship/agentship.yaml`.
 *
 * This file is the user's declaration of what the stores should look like. It is meant to
 * be versioned in git, so it must never contain secrets — credentials are referenced by
 * profile name only. The kernel diffs it against a {@link import('../store-state.js').RemoteAppState}
 * snapshot; nothing in it is imperative.
 *
 * Two writing conventions tie the manifest to the analyzer:
 *
 * - A value the user still has to provide is the literal {@link NEEDS_INPUT}. It is valid
 *   YAML and valid against the schema, so a generated manifest always loads; differs treat
 *   any section containing it as "not plannable yet" and surface the gap.
 * - A value the analyzer derived (confidence `inferred` or `guess`) carries an
 *   `# inferred` line comment, so a human reviewing the generated file knows which lines
 *   deserve a second look. Comments are convention only: they do not survive a rewrite
 *   and carry no semantics for the kernel.
 */
export const MANIFEST_VERSION = 1;

/** Sentinel for "the user must supply this value"; see the module doc. */
export const NEEDS_INPUT = '<needs_input>';

/** True when `value` is the {@link NEEDS_INPUT} sentinel. */
export function isNeedsInput(value: unknown): value is typeof NEEDS_INPUT {
  return value === NEEDS_INPUT;
}

const NonSentinel = z.string().min(1);

const LocaleMetadataSchema = z
  .object({
    name: NonSentinel.optional(),
    subtitle: NonSentinel.optional(),
    shortDescription: NonSentinel.optional(),
    description: NonSentinel.optional(),
    keywords: NonSentinel.optional(),
    whatsNew: NonSentinel.optional(),
    promotionalText: NonSentinel.optional(),
    marketingUrl: NonSentinel.optional(),
    supportUrl: NonSentinel.optional(),
    privacyPolicyUrl: NonSentinel.optional(),
    videoUrl: NonSentinel.optional(),
  })
  .strict();

const ScreenshotSetSchema = z
  .object({
    locale: NonSentinel,
    device: z.enum(['phone', 'tablet_7', 'tablet_10', 'tv', 'watch', 'desktop', 'vision']),
    slot: z.enum(['screenshots', 'app_icon', 'feature_graphic', 'tv_banner']).optional(),
    /** Repo-relative paths, in display order. */
    files: z.array(NonSentinel),
  })
  .strict();

const TesterGroupSchema = z
  .object({
    name: NonSentinel,
    track: z.enum(['internal_testing', 'closed_testing', 'open_testing', 'production']),
    members: z.array(NonSentinel).optional(),
    publicLink: z.boolean().optional(),
  })
  .strict();

/**
 * A pre-built artifact the user supplies instead of letting Agentship build.
 *
 * `sha256` is optional and, when present, is enforced: it is how a user pins the exact
 * bytes a release may publish. Agentship's own builds do not write here — they record
 * themselves in `.agentship/state/artifacts.json`, which is an output, not a declaration.
 */
const ArtifactSchema = z
  .object({
    /** Absolute, or relative to the repository root. */
    path: NonSentinel,
    kind: z.enum(['ipa', 'pkg', 'aab', 'apk']),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex characters')
      .optional(),
  })
  .strict();

/** Where a build gets its inputs when the analyzer's guesses are not enough. */
const BuildSchema = z
  .object({
    /** Forces a builder instead of deriving one from the repository. */
    framework: z
      .enum(['ios-native', 'android-native', 'react-native', 'expo', 'flutter'])
      .optional(),
    /** Repo-relative directory of the app inside a monorepo. */
    appDir: NonSentinel.optional(),
    ios: z
      .object({
        workspace: NonSentinel.optional(),
        project: NonSentinel.optional(),
        scheme: NonSentinel.optional(),
        configuration: NonSentinel.default('Release'),
        /** Apple Developer team id, when the account belongs to several. */
        teamId: NonSentinel.optional(),
      })
      .strict()
      .optional(),
    android: z
      .object({
        /** Gradle module that produces the app, e.g. `app`. */
        module: NonSentinel.default('app'),
        flavor: NonSentinel.optional(),
        buildType: NonSentinel.default('release'),
        /** Play wants an app bundle; an APK is only useful for side-loading. */
        artifact: z.enum(['aab', 'apk']).default('aab'),
        /**
         * Upload keystore. The password never lives here: it is stored in the OS keyring
         * under this profile, exactly like a store credential.
         */
        keystore: z
          .object({
            path: NonSentinel.optional(),
            alias: NonSentinel.optional(),
            /** Keyring profile holding the keystore and key passwords. */
            credentialProfile: NonSentinel.optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    flutter: z
      .object({
        target: NonSentinel.optional(),
        flavor: NonSentinel.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Information App Review asks for; the credentials themselves stay in the keyring. */
const ReviewSchema = z
  .object({
    notes: NonSentinel.optional(),
    /** Whether the reviewer needs an account to see the app. */
    demoAccountRequired: z.boolean().optional(),
    demoAccountName: NonSentinel.optional(),
    /** Keyring profile holding the demo account password; never the password itself. */
    demoAccountProfile: NonSentinel.optional(),
    contactFirstName: NonSentinel.optional(),
    contactLastName: NonSentinel.optional(),
    contactEmail: NonSentinel.optional(),
    contactPhone: NonSentinel.optional(),
  })
  .strict();

export const ManifestSchema = z
  .object({
    version: z.literal(MANIFEST_VERSION),
    app: z
      .object({
        name: NonSentinel,
      })
      .strict(),
    credentials: z
      .object({
        profile: NonSentinel.default('default'),
      })
      .strict()
      .default({ profile: 'default' }),
    stores: z
      .object({
        apple: z
          .object({
            bundleId: NonSentinel,
            /** App Store Connect app id; unknown until the app record exists. */
            appId: NonSentinel.optional(),
          })
          .strict()
          .optional(),
        google: z
          .object({
            packageName: NonSentinel,
          })
          .strict()
          .optional(),
      })
      .strict()
      .refine((stores) => stores.apple !== undefined || stores.google !== undefined, {
        message: 'At least one store (apple or google) must be declared.',
      }),
    release: z
      .object({
        version: NonSentinel,
        buildNumber: NonSentinel.optional(),
        /**
         * Which audience the release reaches. Required, and deliberately without a default:
         * a track Agentship picked silently is a track nobody ever reads, and the first
         * release of a new app is exactly where the wrong one costs the most — Play burns
         * the version code, and the testers waiting on another track see nothing.
         */
        track: z.enum(['internal_testing', 'closed_testing', 'open_testing', 'production']),
        /**
         * How the version reaches users once it is approved. `manual` is the default
         * because it is the only strategy where a human decides the moment of publication.
         */
        strategy: z.enum(['manual', 'automatic', 'scheduled']).default('manual'),
        /** `YYYY-MM-DD`; only meaningful with `strategy: scheduled`. */
        scheduledDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'scheduledDate must be YYYY-MM-DD')
          .optional(),
        /** Roll the release out gradually (Apple phased release, Google staged rollout). */
        phased: z.boolean().optional(),
        /**
         * Fraction of users the staged rollout should be serving, in `(0, 1]`. Agentship
         * never raises it on its own: moving this number is a decision, so it becomes an
         * action the user approves.
         */
        rollout: z.number().gt(0).max(1).optional(),
        /** Track a live build is promoted from, e.g. `open_testing` → `production`. */
        promoteFrom: z.enum(['internal_testing', 'closed_testing', 'open_testing']).optional(),
        /**
         * Google managed publishing: commit changes but let a human press "Publish" in the
         * console. Agentship stages everything and emits the console step as a pending.
         */
        managedPublishing: z.boolean().optional(),
        /** Pre-built artifact per store, supplied by the user instead of built by Agentship. */
        artifacts: z
          .object({
            apple: ArtifactSchema.optional(),
            google: ArtifactSchema.optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    build: BuildSchema.optional(),
    review: ReviewSchema.optional(),
    metadata: z
      .object({
        primaryLocale: NonSentinel,
        locales: z.record(z.string().min(1), LocaleMetadataSchema),
      })
      .strict(),
    assets: z
      .object({
        screenshots: z.array(ScreenshotSetSchema).default([]),
        /**
         * When true, store images absent from the manifest are deleted. Deletions are
         * irreversible, so the kernel classifies a pruning sync as `needs_approval`.
         */
        prune: z.boolean().optional(),
      })
      .strict()
      .optional(),
    testers: z
      .object({
        groups: z.array(TesterGroupSchema).default([]),
      })
      .strict()
      .optional(),
    pricing: z
      .object({
        free: z.boolean().optional(),
        amount: NonSentinel.optional(),
        baseTerritory: NonSentinel.optional(),
        availability: z
          .object({
            allTerritories: z.boolean().optional(),
            territories: z.array(NonSentinel).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    /**
     * In-app products, subscriptions, prices and offers, declared once for both stores.
     * See `monetization.ts`: the two platforms' models are not isomorphic, so each product
     * carries an explicit projection instead of a guessed one.
     */
    monetization: MonetizationSchema.optional(),
    /**
     * What the app collects, why, and whether the user has confirmed it. See `privacy.ts`:
     * nothing here reaches a store until `declarationStatus` is `confirmed` *and* the
     * resulting action is approved.
     */
    privacy: PrivacySchema.optional(),
  })
  .strict();

export type AgentshipManifest = z.infer<typeof ManifestSchema>;

/**
 * Loads and validates the project manifest.
 *
 * {@link NEEDS_INPUT} sentinels pass validation on purpose — a generated manifest must
 * always load — but every occurrence is reported via {@link manifestGaps} so callers can
 * refuse to plan the affected sections.
 */
export async function loadManifest(repoRoot: string): Promise<AgentshipManifest> {
  const path = manifestPath(repoRoot);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      throw AgentshipError.from(
        ERROR_CODES.CONFIG_NOT_FOUND,
        `No manifest found at ${path}.`,
        cause,
        {
          remediation: {
            summary: 'Generate one with manifestFromAnalysis, or create .agentship/agentship.yaml.',
          },
        },
      );
    }
    throw AgentshipError.from(
      ERROR_CODES.CONFIG_MANIFEST_INVALID,
      `Could not read ${path}.`,
      cause,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (cause) {
    throw AgentshipError.from(
      ERROR_CODES.CONFIG_MANIFEST_INVALID,
      `${path} is not valid YAML.`,
      cause,
    );
  }

  const version = (parsed as { version?: unknown } | null)?.version;
  if (typeof version === 'number' && version !== MANIFEST_VERSION) {
    throw new AgentshipError(
      ERROR_CODES.CONFIG_UNSUPPORTED_VERSION,
      `${path} declares manifest version ${String(version)}, but this Agentship supports ${MANIFEST_VERSION}.`,
      { remediation: { summary: 'Update Agentship, or migrate the manifest.' } },
    );
  }

  const result = ManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = flattenIssues(result.error);
    throw new AgentshipError(
      ERROR_CODES.CONFIG_MANIFEST_INVALID,
      `${path} failed validation: ${describeIssues(issues)}`,
      {
        details: { issues },
        remediation: {
          // The manifest is the user's file. A validation failure is something to show them,
          // not a licence to rewrite their configuration until a plan succeeds.
          summary: `Show the user these fields in ${path} and ask how they should read; do not edit the manifest on their behalf unless they ask for the change.`,
        },
      },
    );
  }
  return result.data;
}

/** Serialises and writes the manifest, creating `.agentship/` if needed. */
export async function saveManifest(repoRoot: string, manifest: AgentshipManifest): Promise<string> {
  const validated = ManifestSchema.parse(manifest);
  await ensureDir(projectDir(repoRoot));
  const path = manifestPath(repoRoot);
  await writeFile(path, stringifyYaml(validated), { mode: FILE_MODE });
  return path;
}

/**
 * Sets one value in the manifest file, preserving every existing comment.
 *
 * Unlike {@link saveManifest}, which serialises a parsed object and therefore drops the
 * `# inferred` / `# needs_input` annotations, this edits the YAML document in place. It is
 * how machine-derived facts — an App Store Connect app id resolved from the bundle id, a
 * value adopted from the store — land in the file with a provenance comment a human can
 * audit, instead of appearing out of nowhere.
 *
 * The result is validated against the schema before it is written, so a bad value can
 * never corrupt the manifest on disk.
 */
export async function setManifestValue(
  repoRoot: string,
  path: readonly (string | number)[],
  value: unknown,
  comment?: string,
): Promise<string> {
  const filePath = manifestPath(repoRoot);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (cause) {
    throw AgentshipError.from(
      ERROR_CODES.CONFIG_NOT_FOUND,
      `No manifest found at ${filePath}.`,
      cause,
    );
  }
  const doc = parseDocument(raw);
  // createNode: a raw scalar cannot carry a comment; a Node can.
  doc.setIn(path, doc.createNode(value));
  if (comment !== undefined) {
    const node = doc.getIn(path, true) as { comment?: string } | undefined;
    if (node !== undefined && typeof node === 'object') node.comment = comment;
  }
  const result = ManifestSchema.safeParse(doc.toJS());
  if (!result.success) {
    throw new AgentshipError(
      ERROR_CODES.CONFIG_MANIFEST_INVALID,
      `Setting ${path.join('.')} would make ${filePath} invalid: ${describeIssues(
        flattenIssues(result.error),
      )}`,
      { details: { issues: flattenIssues(result.error) } },
    );
  }
  await writeFile(filePath, doc.toString(), { mode: FILE_MODE });
  return filePath;
}

/** One field the manifest schema rejected, addressed by its dot path. */
export interface ManifestIssue {
  /** Dot path with array indices, e.g. `privacy.dataPractices[2].purpose`. */
  readonly path: string;
  readonly message: string;
}

/**
 * Flattens a schema failure into a list of `(path, message)` pairs.
 *
 * Zod's tree mirrors the manifest's nesting, and everything that carries a validation
 * failure to an agent has depth limits — the redactor that scrubs tool responses cuts at
 * eight levels. A manifest nests deeply enough to reach that, so the tree arrived as
 * `{"declarationStatus": {"errors": "[truncated]"}}`: the agent was told the file was
 * invalid and given no way to learn why, and could only guess at the manifest — which is
 * both slow and precisely the thing it should not be doing to someone's configuration.
 *
 * A flat list has one level whatever the manifest looks like, so it always arrives whole.
 */
export function flattenIssues(error: z.ZodError): readonly ManifestIssue[] {
  return error.issues
    .map((issue) => ({
      path:
        issue.path.length === 0
          ? '(root)'
          : issue.path
              .map((segment, index) =>
                typeof segment === 'number'
                  ? `[${segment}]`
                  : index === 0
                    ? String(segment)
                    : `.${String(segment)}`,
              )
              .join(''),
      message: issue.message,
    }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.message.localeCompare(b.message));
}

/** Enough issues in the message to act on; `details.issues` always carries all of them. */
const MAX_DESCRIBED_ISSUES = 5;

function describeIssues(issues: readonly ManifestIssue[]): string {
  const shown = issues
    .slice(0, MAX_DESCRIBED_ISSUES)
    .map((issue) => `${issue.path} — ${issue.message}`)
    .join('; ');
  const rest = issues.length - Math.min(issues.length, MAX_DESCRIBED_ISSUES);
  return rest > 0 ? `${shown}; and ${rest} more` : shown;
}

/** One value the user still has to provide before the affected section can be planned. */
export interface ManifestGap {
  /** Dot path inside the manifest, e.g. `metadata.locales.en-US.description`. */
  readonly path: string;
}

/** Every {@link NEEDS_INPUT} occurrence in the manifest, with its dot path. */
export function manifestGaps(manifest: AgentshipManifest): readonly ManifestGap[] {
  const gaps: ManifestGap[] = [];
  walk(manifest, '', gaps);
  return gaps;
}

function walk(value: unknown, path: string, gaps: ManifestGap[]): void {
  if (isNeedsInput(value)) {
    gaps.push({ path });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walk(item, `${path}[${index}]`, gaps);
    });
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      walk(item, path === '' ? key : `${path}.${key}`, gaps);
    }
  }
}

/** Result of generating a manifest from an analysis. */
export interface GeneratedManifest {
  readonly manifest: AgentshipManifest;
  /** YAML text with `# inferred` / `# needs_input` comments; write this, not the object. */
  readonly yaml: string;
  /** Dot paths the user must fill in before the manifest is fully plannable. */
  readonly gaps: readonly ManifestGap[];
}

interface CommentedValue {
  readonly value: string;
  readonly comment?: string;
}

function fromProvenanced(
  source: Provenanced<string> | undefined,
  fallbackComment: string,
): CommentedValue {
  if (source === undefined)
    return { value: NEEDS_INPUT, comment: ` needs_input: ${fallbackComment}` };
  if (source.confidence === 'certain') return { value: source.value };
  const detail = source.detail === undefined ? '' : ` — ${source.detail}`;
  const marker = source.confidence === 'guess' ? ' inferred (guess)' : ' inferred';
  return { value: source.value, comment: `${marker}${detail}` };
}

/**
 * Builds a starter manifest from an {@link AppAnalysis}.
 *
 * Everything the analyzer could not determine appears as the {@link NEEDS_INPUT} sentinel
 * with a `# needs_input` comment; everything it derived (rather than read verbatim) is
 * annotated `# inferred`. The YAML in the result carries those comments; the parsed object
 * carries the same values without them.
 */
export function manifestFromAnalysis(analysis: AppAnalysis): GeneratedManifest {
  const ios = analysis.platforms.includes('ios');
  const android = analysis.platforms.includes('android');

  const name = fromProvenanced(
    analysis.identity.displayName ?? analysis.identity.appName,
    'store-visible app name',
  );
  const bundleId = fromProvenanced(analysis.identity.bundleId, 'Apple bundle identifier');
  const packageName = fromProvenanced(analysis.identity.packageName, 'Android application id');
  const version = fromProvenanced(
    analysis.versions.marketingVersion ?? analysis.versions.versionName,
    'marketing version, e.g. 1.0.0',
  );
  const buildNumber = buildNumberFromAnalysis(analysis);

  const doc = new Document({
    version: MANIFEST_VERSION,
    app: { name: name.value },
    credentials: { profile: 'default' },
    stores: {
      ...(ios ? { apple: { bundleId: bundleId.value } } : {}),
      ...(android ? { google: { packageName: packageName.value } } : {}),
    },
    release: {
      version: version.value,
      // Omitted when the project does not declare one: a build number Agentship invented
      // would be uploaded under that name and burned forever.
      ...(buildNumber === undefined ? {} : { buildNumber: buildNumber.value }),
      track: 'internal_testing',
      strategy: 'manual',
    },
    build: buildSectionFromAnalysis(analysis),
    // A draft, never an answer: `declarationStatus: draft` is what keeps every privacy
    // differ silent until the user has read this section and said it is right.
    privacy: proposePrivacy(analysis).declaration,
    metadata: {
      primaryLocale: 'en-US',
      locales: {
        'en-US': {
          name: name.value,
          description: NEEDS_INPUT,
        },
      },
    },
  });

  comment(doc, ['app', 'name'], name.comment);
  if (ios) comment(doc, ['stores', 'apple', 'bundleId'], bundleId.comment);
  if (android) comment(doc, ['stores', 'google', 'packageName'], packageName.comment);
  comment(doc, ['release', 'version'], version.comment);
  if (buildNumber !== undefined) comment(doc, ['release', 'buildNumber'], buildNumber.comment);
  comment(
    doc,
    ['release', 'track'],
    ' proposal — the first release goes here: internal_testing, closed_testing, open_testing or production',
  );
  comment(doc, ['metadata', 'primaryLocale'], ' inferred — default');
  comment(
    doc,
    ['privacy', 'declarationStatus'],
    ' inferred — proposed from SDKs and permissions; read it, correct it, then set to "confirmed"',
  );
  comment(
    doc,
    ['metadata', 'locales', 'en-US', 'name'],
    name.comment ?? ' inferred — copied from app.name',
  );
  comment(doc, ['metadata', 'locales', 'en-US', 'description'], ' needs_input: store description');

  const yaml = `${doc.toString()}${optionalSections(analysis)}`;
  const manifest = ManifestSchema.parse(parseYaml(yaml));
  return { manifest, yaml, gaps: manifestGaps(manifest) };
}

/** Store listing locales the repository already has text for, e.g. `fastlane/metadata/es-ES/`. */
function listingLocales(analysis: AppAnalysis): string[] {
  const locales = new Set<string>();
  for (const file of analysis.assets.listingFiles) {
    // `fastlane/metadata/<locale>/x.txt` and `fastlane/metadata/android/<locale>/x.txt`.
    const match = /fastlane\/metadata\/(?:android\/)?([a-z]{2}(?:-[A-Za-z]{2,4})?)\//.exec(file);
    if (match?.[1] !== undefined) locales.add(match[1]);
  }
  return [...locales].sort();
}

/**
 * The sections Agentship understands but will not write for anyone, listed as comments.
 *
 * A generated manifest is also the only documentation an agent reads: a section that is not
 * in the file does not exist as far as the next tool call is concerned. Leaving pricing,
 * reviewer details and monetisation out entirely is what makes an agent conclude Agentship
 * cannot do them and go and do them by hand — while the schema, the differs and both
 * adapters have supported them all along.
 *
 * Comments rather than values, because every one of them is a decision: what the app costs,
 * whose phone number reaches review, which products exist. Proposing `free: true` would be
 * inventing an answer to a question about someone's money.
 */
function optionalSections(analysis: AppAnalysis): string {
  const extraLocales = listingLocales(analysis).filter((locale) => locale !== 'en-US');
  const localesNote =
    extraLocales.length === 0
      ? '#   metadata.locales takes one entry per store listing language; only en-US is declared above.'
      : `#   metadata.locales takes one entry per store listing language. This repository has\n#   listing text for: ${extraLocales.join(', ')} — add them here to publish those listings.`;

  return `
# Sections Agentship also reads, none of them filled in for you — each is a decision.
# Delete this block once you know it is there.
#
# pricing:                    # what the app itself costs, and where it is sold
#   free: true
#   availability:
#     allTerritories: true
#
# review:                     # what App Store review needs to reach a human
#   contactFirstName: ""
#   contactLastName: ""
#   contactEmail: ""
#   contactPhone: ""          # App Store Connect refuses review details without it
#   demoAccountRequired: false
#   notes: ""
#
# monetization:               # in-app purchases and subscriptions, both stores at once
#   products:
#     - id: pro-monthly
#       type: subscription
#       period: P1M
#       apple: { productId: com.example.pro.monthly, group: Pro }
#       google: { productId: pro_monthly, basePlan: monthly }
#       names:
#         en-US: { displayName: Pro, description: Everything unlocked. }
#       price: { base: "4.99", baseTerritory: US, strategy: convert }
#
${localesNote}
`;
}

/**
 * The build number the project already declares, if it declares one.
 *
 * Flutter writes it after the `+` in `pubspec.yaml`, Expo under `expo.ios.buildNumber` and
 * `expo.android.versionCode`, native projects in `CFBundleVersion` and `versionCode`. The
 * analyzer reads all of those, so asking the user for a number their own project states is
 * a question with a knowable answer — and the one that stopped a build in practice.
 *
 * Android's `versionCode` is an integer and Apple's `CFBundleVersion` a string; the manifest
 * carries one string, so the integer is stringified. Absent from the project means absent
 * here: {@link missingBuildInput} then says so, rather than a number being invented.
 */
function buildNumberFromAnalysis(analysis: AppAnalysis): CommentedValue | undefined {
  const { buildNumber, versionCode } = analysis.versions;
  const source: Provenanced<string> | undefined =
    buildNumber ??
    (versionCode === undefined ? undefined : { ...versionCode, value: String(versionCode.value) });
  if (source === undefined) return undefined;
  const commented = fromProvenanced(source, 'build number');
  return commented.value === NEEDS_INPUT ? undefined : commented;
}

/**
 * The `build` section the analyzer can fill in.
 *
 * Only facts go in: the scheme and the module are read from the project files, so getting
 * them wrong would break the build loudly rather than publish something wrong. Anything the
 * analyzer merely guessed is left out — a build that stops and asks is better than one that
 * archives the wrong scheme.
 */
function buildSectionFromAnalysis(analysis: AppAnalysis): Record<string, unknown> {
  const { ios, android, appDir } = analysis.buildHints;
  const framework = analysis.framework.framework;
  return {
    ...(framework === 'unknown' ? {} : { framework }),
    ...(appDir === '.' ? {} : { appDir }),
    ...(ios === undefined
      ? {}
      : {
          ios: {
            ...(ios.workspace === undefined ? {} : { workspace: ios.workspace }),
            ...(ios.project === undefined ? {} : { project: ios.project }),
            // One scheme is unambiguous; several are a choice only the user can make.
            ...(ios.schemes.length === 1 ? { scheme: ios.schemes[0] } : {}),
            configuration: 'Release',
          },
        }),
    ...(android === undefined
      ? {}
      : {
          android: {
            module: android.module ?? 'app',
            ...(android.flavors.length === 1 ? { flavor: android.flavors[0] } : {}),
            buildType: 'release',
            artifact: 'aab',
          },
        }),
  };
}

function comment(doc: Document, path: readonly string[], text: string | undefined): void {
  if (text === undefined) return;
  const node = doc.getIn(path, true) as { comment?: string } | undefined;
  if (node !== undefined) node.comment = text;
}

/** Generates the manifest from an analysis and writes it to `.agentship/agentship.yaml`. */
export async function writeGeneratedManifest(
  repoRoot: string,
  analysis: AppAnalysis,
): Promise<GeneratedManifest & { readonly path: string }> {
  const generated = manifestFromAnalysis(analysis);
  await ensureDir(projectDir(repoRoot));
  const path = manifestPath(repoRoot);
  await writeFile(path, generated.yaml, { mode: FILE_MODE });
  return { ...generated, path };
}
