/**
 * Everything Agentship knows about the `gpc` command line, in one file.
 *
 * Verified against **gpc 0.9.93**, the version pinned in `tools.lock.json`, by reading
 * `--help` of each subcommand on that exact binary.
 *
 * Rules this file enforces:
 *
 * - **No `gpc auth ...`.** `gpc auth login` writes a persistent profile and `gpc auth
 *   status` will happily fall back to whatever Application Default Credentials exist on the
 *   machine — on a developer laptop that is usually a personal `gcloud` login. Agentship
 *   supplies the service account per invocation instead; see `environment.ts`.
 * - **Globals first.** `--app`, `--output` and the non-interactive switches are program
 *   level options, so they are placed before the subcommand where their meaning is
 *   unambiguous.
 * - **No secrets in argv.** The service account reaches `gpc` as a file path in
 *   `GPC_SERVICE_ACCOUNT`, never as JSON on the command line.
 *
 * | Contract operation      | gpc command                                                  |
 * |-------------------------|--------------------------------------------------------------|
 * | version                 | `--version`                                                   |
 * | checkAuth               | `tracks list`                                                 |
 * | listApps                | *(no API — see `capabilities.ts`)*                            |
 * | getAppState             | `apps info`, `tracks list`, `releases status`,                |
 * |                         | `listings get`, `listings images list`, `bundles list`,       |
 * |                         | `testers list`, `iap list`, `subscriptions list`              |
 * | setMetadata             | `listings push`, `releases notes set`                         |
 * | syncScreenshots         | `listings images sync`                                        |
 * | uploadBuild             | `releases upload`, `bundles find`                             |
 * | distributeToTesters     | `releases assign`                                             |
 * | manageTesterGroups      | `testers list/add/remove`                                     |
 * | setPricing              | *(no API — see `capabilities.ts`)*                            |
 * | submitForReview         | `releases assign` committed without `--changes-not-sent-for-review` |
 * | getSubmissionStatus     | `releases status` *(best effort)*                             |
 * | setPhasedRelease        | `releases rollout increase/halt/resume/complete`              |
 * | listProducts            | `iap list`, `subscriptions list`                              |
 * | getProductState         | `iap get`, `subscriptions get`, `subscriptions offers list`   |
 * | createProduct           | `iap create --file`, `subscriptions create --file`            |
 * | updateProduct           | `iap update --file`, `subscriptions update --file`            |
 * | setProductPricing       | *(the same update: on Play a price is a field of the product)*|
 * | setProductOffers        | `subscriptions offers create --file`                          |
 * | convertPrice            | `pricing convert`                                             |
 * | dataSafety              | `data-safety update --file` *(write-only; no GET exists)*     |
 */

import type { ImageSlot, ReleaseTrack, ScreenshotDevice } from '@agentship/core';

/** Native Play track names, keyed by the neutral track. */
export const GOOGLE_TRACKS: Readonly<Record<ReleaseTrack, string>> = {
  internal_testing: 'internal',
  closed_testing: 'alpha',
  open_testing: 'beta',
  production: 'production',
};

/** Reverse of {@link GOOGLE_TRACKS}; unknown custom tracks stay unmapped on purpose. */
export const TRACK_BY_GOOGLE_NAME: Readonly<Record<string, ReleaseTrack>> = {
  internal: 'internal_testing',
  alpha: 'closed_testing',
  beta: 'open_testing',
  production: 'production',
};

/** Play image types Agentship targets, keyed by the neutral device family. */
export const GOOGLE_SCREENSHOT_TYPES: Readonly<Partial<Record<ScreenshotDevice, string>>> = {
  phone: 'phoneScreenshots',
  tablet_7: 'sevenInchScreenshots',
  tablet_10: 'tenInchScreenshots',
  tv: 'tvScreenshots',
  watch: 'wearScreenshots',
};

/** Play image types for the non-screenshot slots, which are not per-device. */
export const GOOGLE_SLOT_TYPES: Readonly<Partial<Record<ImageSlot, string>>> = {
  app_icon: 'icon',
  feature_graphic: 'featureGraphic',
  tv_banner: 'tvBanner',
};

/** Every Play image type, for enumerating a snapshot. */
export const ALL_GOOGLE_IMAGE_TYPES: readonly string[] = [
  ...Object.values(GOOGLE_SCREENSHOT_TYPES),
  ...Object.values(GOOGLE_SLOT_TYPES),
];

function flag(name: string, value: string | undefined): string[] {
  return value === undefined || value === '' ? [] : [name, value];
}

function boolFlag(name: string, value: boolean | undefined): string[] {
  return value === true ? [name] : [];
}

/**
 * Options every invocation carries.
 *
 * `--no-interactive` and `--yes` matter for correctness, not ergonomics: several `gpc`
 * subcommands prompt for a missing value, and a prompt with no terminal attached would
 * hang the MCP server rather than fail.
 */
export function globalFlags(options: { packageName?: string }): string[] {
  return [
    ...flag('--app', options.packageName),
    '--output',
    'json',
    '--no-interactive',
    '--no-color',
    '--yes',
  ];
}

/**
 * How a mutating command commits its Play edit.
 *
 * Google's API commits an edit *and* sends the app to review in one step. Two switches
 * change that, and both matter:
 *
 * - `--changes-not-sent-for-review` commits without submitting. Required for an app whose
 *   previous submission was rejected, and the only way to stage changes without publishing.
 * - `--error-if-in-review` refuses to commit when a review is already running, instead of
 *   silently cancelling it. Agentship defaults this **on**: cancelling someone's live review
 *   as a side effect of a metadata edit is exactly the kind of surprise the engine exists
 *   to prevent, so it becomes a classified error the user can act on.
 */
export interface CommitFlags {
  readonly withoutReview?: boolean;
  /** Set to `false` only when the caller has explicitly approved cancelling a review. */
  readonly errorIfInReview?: boolean;
}

export function commitFlags(options: CommitFlags = {}): string[] {
  return [
    ...boolFlag('--changes-not-sent-for-review', options.withoutReview),
    ...(options.errorIfInReview === false ? [] : ['--error-if-in-review']),
  ];
}

export interface ReleaseOptions extends CommitFlags {
  readonly track: string;
  /** `completed`, `inProgress`, `draft` or `halted`. */
  readonly status?: string;
  /** Percentage 1–100; `gpc` converts it to the API's `userFraction`. */
  readonly rolloutPercent?: number;
  readonly releaseName?: string;
  readonly notesDir?: string;
  readonly mappingFile?: string;
  readonly validateOnly?: boolean;
  readonly timeoutMs?: number;
  readonly retainVersionCodes?: readonly string[];
}

function releaseFlags(options: ReleaseOptions): string[] {
  return [
    '--track',
    options.track,
    ...flag('--status', options.status),
    ...flag(
      '--rollout',
      options.rolloutPercent === undefined ? undefined : String(options.rolloutPercent),
    ),
    ...flag('--name', options.releaseName),
    ...flag('--notes-dir', options.notesDir),
    ...flag('--mapping', options.mappingFile),
    ...flag('--retain-version-codes', options.retainVersionCodes?.join(',')),
    ...boolFlag('--validate-only', options.validateOnly),
    ...commitFlags(options),
  ];
}

export const gpcCommands = {
  version: (): string[] => ['--version'],

  appInfo: (packageName: string): string[] => [
    ...globalFlags({ packageName }),
    'apps',
    'info',
    packageName,
  ],

  tracksList: (packageName: string): string[] => [
    ...globalFlags({ packageName }),
    'tracks',
    'list',
  ],

  releasesStatus: (packageName: string, track?: string): string[] => [
    ...globalFlags({ packageName }),
    'releases',
    'status',
    ...flag('--track', track),
  ],

  listingsGet: (packageName: string, language?: string): string[] => [
    ...globalFlags({ packageName }),
    'listings',
    'get',
    ...flag('--lang', language),
  ],

  /** Pushes every language directory found under `dir` inside a single Play edit. */
  listingsPush: (
    packageName: string,
    dir: string,
    options: CommitFlags & { force?: boolean } = {},
  ): string[] => [
    ...globalFlags({ packageName }),
    'listings',
    'push',
    '--dir',
    dir,
    ...boolFlag('--force', options.force),
    ...commitFlags(options),
  ],

  imagesList: (packageName: string, language: string, imageType: string): string[] => [
    ...globalFlags({ packageName }),
    'listings',
    'images',
    'list',
    '--lang',
    language,
    '--type',
    imageType,
  ],

  /**
   * Uploads only the images whose SHA-256 differs from what Play already holds, inside a
   * single edit. `--delete` additionally removes remote images the local tree does not
   * contain and forces the display order to match.
   */
  imagesSync: (
    packageName: string,
    dir: string,
    options: CommitFlags & { language?: string; imageType?: string; prune?: boolean } = {},
  ): string[] => [
    ...globalFlags({ packageName }),
    'listings',
    'images',
    'sync',
    '--dir',
    dir,
    ...flag('--lang', options.language),
    ...flag('--type', options.imageType),
    ...boolFlag('--delete', options.prune),
    ...commitFlags(options),
  ],

  releaseNotesGet: (packageName: string, track: string, language: string): string[] => [
    ...globalFlags({ packageName }),
    'releases',
    'notes',
    'get',
    '--track',
    track,
    '--lang',
    language,
  ],

  releaseNotesSet: (
    packageName: string,
    track: string,
    language: string,
    notes: string,
  ): string[] => [
    ...globalFlags({ packageName }),
    'releases',
    'notes',
    'set',
    '--track',
    track,
    '--lang',
    language,
    '--notes',
    notes,
  ],

  /** Uploads the artifact, waits for Play to finish processing it, and assigns the track. */
  releasesUpload: (packageName: string, file: string, options: ReleaseOptions): string[] => [
    ...globalFlags({ packageName }),
    'releases',
    'upload',
    file,
    ...releaseFlags(options),
    ...flag('--timeout', options.timeoutMs === undefined ? undefined : String(options.timeoutMs)),
  ],

  /** Puts an already-uploaded version code on a track without re-uploading it. */
  releasesAssign: (packageName: string, versionCode: string, options: ReleaseOptions): string[] => [
    ...globalFlags({ packageName }),
    'releases',
    'assign',
    versionCode,
    ...releaseFlags({ ...options, validateOnly: false }),
  ],

  rollout: (
    packageName: string,
    action: 'increase' | 'halt' | 'resume' | 'complete',
    options: CommitFlags & { track: string; toPercent?: number },
  ): string[] => [
    ...globalFlags({ packageName }),
    'releases',
    'rollout',
    action,
    '--track',
    options.track,
    ...flag(
      '--to',
      action === 'increase' && options.toPercent !== undefined
        ? String(options.toPercent)
        : undefined,
    ),
    ...commitFlags(options),
  ],

  bundlesList: (packageName: string): string[] => [
    ...globalFlags({ packageName }),
    'bundles',
    'list',
  ],

  bundlesFind: (packageName: string, versionCode: string): string[] => [
    ...globalFlags({ packageName }),
    'bundles',
    'find',
    '--version-code',
    versionCode,
  ],

  bundlesWait: (
    packageName: string,
    versionCode: string,
    options: { timeoutSeconds?: number; intervalSeconds?: number } = {},
  ): string[] => [
    ...globalFlags({ packageName }),
    'bundles',
    'wait',
    '--version-code',
    versionCode,
    ...flag(
      '--timeout',
      options.timeoutSeconds === undefined ? undefined : String(options.timeoutSeconds),
    ),
    ...flag(
      '--interval',
      options.intervalSeconds === undefined ? undefined : String(options.intervalSeconds),
    ),
  ],

  testersList: (packageName: string, track: string): string[] => [
    ...globalFlags({ packageName }),
    'testers',
    'list',
    '--track',
    track,
  ],

  testersAdd: (
    packageName: string,
    track: string,
    emails: readonly string[],
    options: CommitFlags = {},
  ): string[] => [
    ...globalFlags({ packageName }),
    'testers',
    'add',
    ...emails,
    '--track',
    track,
    ...commitFlags(options),
  ],

  testersRemove: (
    packageName: string,
    track: string,
    emails: readonly string[],
    options: CommitFlags = {},
  ): string[] => [
    ...globalFlags({ packageName }),
    'testers',
    'remove',
    ...emails,
    '--track',
    track,
    ...commitFlags(options),
  ],

  iapList: (packageName: string): string[] => [...globalFlags({ packageName }), 'iap', 'list'],

  subscriptionsList: (packageName: string): string[] => [
    ...globalFlags({ packageName }),
    'subscriptions',
    'list',
  ],

  // --- monetisation ------------------------------------------------------------------
  //
  // Play takes a whole product document rather than a set of flags, so every write here is
  // "write a JSON file, hand over its path". That is also why prices need no separate call:
  // on Play a price *is* a field of the product.

  iapGet: (packageName: string, sku: string): string[] => [
    ...globalFlags({ packageName }),
    'iap',
    'get',
    sku,
  ],

  iapCreate: (packageName: string, file: string): string[] => [
    ...globalFlags({ packageName }),
    'iap',
    'create',
    '--file',
    file,
  ],

  iapUpdate: (packageName: string, sku: string, file: string): string[] => [
    ...globalFlags({ packageName }),
    'iap',
    'update',
    sku,
    '--file',
    file,
  ],

  subscriptionGet: (packageName: string, productId: string): string[] => [
    ...globalFlags({ packageName }),
    'subscriptions',
    'get',
    productId,
  ],

  subscriptionCreate: (
    packageName: string,
    file: string,
    options: { activate?: boolean } = {},
  ): string[] => [
    ...globalFlags({ packageName }),
    'subscriptions',
    'create',
    '--file',
    file,
    ...boolFlag('--activate', options.activate),
  ],

  subscriptionUpdate: (packageName: string, productId: string, file: string): string[] => [
    ...globalFlags({ packageName }),
    'subscriptions',
    'update',
    productId,
    '--file',
    file,
  ],

  subscriptionOffersList: (
    packageName: string,
    productId: string,
    basePlanId: string,
  ): string[] => [
    ...globalFlags({ packageName }),
    'subscriptions',
    'offers',
    'list',
    productId,
    basePlanId,
  ],

  subscriptionOfferCreate: (packageName: string, file: string): string[] => [
    ...globalFlags({ packageName }),
    'subscriptions',
    'offers',
    'create',
    '--file',
    file,
  ],

  /** Play's own regional conversion table for a base price — a proposal, never a decision. */
  pricingConvert: (packageName: string, currency: string, amount: string): string[] => [
    ...globalFlags({ packageName }),
    'pricing',
    'convert',
    '--from',
    currency,
    '--amount',
    amount,
  ],

  /**
   * Data Safety is write-only on Play: `gpc data-safety get` and `export` both refuse,
   * because the Play Developer API has no GET for the declaration. Agentship's own archive in
   * `.agentship/state/` is therefore the only thing a diff can compare against.
   */
  dataSafetyUpdate: (packageName: string, file: string): string[] => [
    ...globalFlags({ packageName }),
    'data-safety',
    'update',
    '--file',
    file,
  ],
} as const;

/** Neutral billing periods, as the ISO 8601 durations Play's base plans use. */
export const GOOGLE_BILLING_PERIODS: Readonly<Record<string, string>> = {
  one_week: 'P1W',
  one_month: 'P1M',
  two_months: 'P2M',
  three_months: 'P3M',
  six_months: 'P6M',
  one_year: 'P1Y',
};

/** Neutral product types, as Play's `purchaseType` for one-time products. */
export const GOOGLE_PURCHASE_TYPES: Readonly<Record<string, string>> = {
  consumable: 'managedUser',
  non_consumable: 'managedUser',
  non_renewing_subscription: 'managedUser',
};

/** Fastlane-format file names `gpc listings push` reads, keyed by the field they carry. */
export const LISTING_FILES = {
  title: 'title.txt',
  shortDescription: 'short_description.txt',
  fullDescription: 'full_description.txt',
  video: 'video.txt',
} as const;
