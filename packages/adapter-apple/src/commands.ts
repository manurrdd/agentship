/**
 * Everything Agentship knows about the `asc` command line, in one file.
 *
 * This is deliberate: `asc` is a young project with a single dominant author, so a version
 * bump has to be auditable by reading one table rather than by grepping the package. The
 * mappings below were verified against **asc 3.4.1**, the version pinned in
 * `tools.lock.json`, by reading `--help` of each subcommand on that exact binary.
 *
 * Rules this file enforces:
 *
 * - **No `asc web ...`.** Those subcommands drive an unofficial Apple ID web session.
 *   Anything only reachable that way is classified `agent_browser` or `human_only` and
 *   emitted as a pending operation instead. See `capabilities.ts`.
 * - **No `asc auth ...`.** Agentship owns the credentials; the backend receives them per
 *   invocation through the environment and never persists a login.
 * - **No secrets in argv.** Process arguments are world-readable through `ps`. The private
 *   key travels as a file path; the shared runner refuses arguments that look secret.
 *
 * | Contract operation      | asc command                                                |
 * |-------------------------|------------------------------------------------------------|
 * | version                 | `--version`                                                  |
 * | checkAuth               | `apps list --limit 1`                                        |
 * | listApps                | `apps list --paginate`                                       |
 * | getAppState             | `apps view`, `versions list`, `localizations list`,          |
 * |                         | `screenshots list`, `builds list`, `testflight groups list`, |
 * |                         | `pricing current`, `pricing availability view`,              |
 * |                         | `iap list`, `subscriptions list`, `phased-release view`      |
 * | setMetadata             | `localizations create/update`, `versions update`             |
 * | syncScreenshots         | `screenshots upload --skip-existing`, `screenshots delete`   |
 * | uploadBuild             | `builds upload --wait`, `builds info`                        |
 * | distributeToTesters     | `builds add-groups`                                          |
 * | manageTesterGroups      | `testflight groups create/edit/add-testers/remove-testers`   |
 * | setPricing              | `pricing schedule create`, `pricing availability edit`       |
 * | submitForReview         | `review submissions-create/items-add/submissions-submit`     |
 * | getSubmissionStatus     | `review submissions-get`                                     |
 * | setPhasedRelease        | `versions phased-release view/create/update/delete`          |
 * | listProducts            | `iap list`, `subscriptions list`                             |
 * | getProductState         | `iap list`/`subscriptions list` (to locate the product), then |
 * |                         | `iap pricing schedules view`,                                 |
 * |                         | `subscriptions pricing prices list`, `offers introductory list`|
 * | createProduct           | `iap create`, `subscriptions groups create`,                  |
 * |                         | `subscriptions create`, `iap versions localizations create`   |
 * | updateProduct           | `iap update`, `subscriptions update`                          |
 * | setProductPricing       | `iap pricing schedules create`,                               |
 * |                         | `subscriptions pricing prices set`, `... availability edit`   |
 * | setProductOffers        | `subscriptions offers introductory create`,                   |
 * |                         | `iap offer-codes create`                                      |
 * | contentRating           | `age-rating view/edit`                                        |
 */

import type { ScreenshotDevice } from '@agentship/core';

/** Appended to every invocation: JSON on stdout is the only output Agentship parses. */
const JSON_OUTPUT: readonly string[] = ['--output', 'json'];

function flag(name: string, value: string | undefined): string[] {
  return value === undefined || value === '' ? [] : [name, value];
}

function boolFlag(name: string, value: boolean | undefined): string[] {
  return value === true ? [name] : [];
}

/** Apple platform token accepted by `--platform`. */
export type AscPlatform = 'IOS' | 'MAC_OS' | 'TV_OS' | 'VISION_OS';

/**
 * Apple display sizes Agentship targets.
 *
 * `asc screenshots sizes` lists a much larger matrix; its own help states that one iPhone
 * set (`IPHONE_65`) and one iPad set (`IPAD_PRO_3GEN_129`) are enough for a typical iOS
 * submission, which is the pair Agentship maps its neutral `phone`/`tablet_10` onto.
 */
export const APPLE_DEVICE_TYPES: Readonly<Partial<Record<ScreenshotDevice, string>>> = {
  phone: 'IPHONE_65',
  tablet_10: 'IPAD_PRO_3GEN_129',
  tv: 'APPLE_TV',
  watch: 'APPLE_WATCH_ULTRA',
  desktop: 'APP_DESKTOP',
  vision: 'APPLE_VISION_PRO',
};

export interface ListOptions {
  readonly limit?: number;
  readonly paginate?: boolean;
}

function listFlags(options: ListOptions | undefined): string[] {
  return [
    ...flag('--limit', options?.limit === undefined ? undefined : String(options.limit)),
    ...boolFlag('--paginate', options?.paginate),
  ];
}

export const ascCommands = {
  version: (): string[] => ['--version'],

  appsList: (options?: ListOptions & { bundleId?: string }): string[] => [
    'apps',
    'list',
    ...flag('--bundle-id', options?.bundleId),
    ...listFlags(options),
    ...JSON_OUTPUT,
  ],

  appView: (appId: string): string[] => ['apps', 'view', '--id', appId, ...JSON_OUTPUT],

  versionsList: (appId: string, options?: ListOptions & { platform?: AscPlatform }): string[] => [
    'versions',
    'list',
    '--app',
    appId,
    ...flag('--platform', options?.platform),
    ...listFlags(options),
    ...JSON_OUTPUT,
  ],

  versionCreate: (
    appId: string,
    version: string,
    options?: { platform?: AscPlatform; copyright?: string; releaseType?: string },
  ): string[] => [
    'versions',
    'create',
    '--app',
    appId,
    '--version',
    version,
    ...flag('--platform', options?.platform),
    ...flag('--copyright', options?.copyright),
    ...flag('--release-type', options?.releaseType),
    ...JSON_OUTPUT,
  ],

  versionUpdate: (
    versionId: string,
    options: { copyright?: string; releaseType?: string; earliestReleaseDate?: string },
  ): string[] => [
    'versions',
    'update',
    '--version-id',
    versionId,
    ...flag('--copyright', options.copyright),
    ...flag('--release-type', options.releaseType),
    ...flag('--earliest-release-date', options.earliestReleaseDate),
    ...JSON_OUTPUT,
  ],

  versionAttachBuild: (versionId: string, buildId: string): string[] => [
    'versions',
    'attach-build',
    '--version-id',
    versionId,
    '--build-id',
    buildId,
    ...JSON_OUTPUT,
  ],

  /** `--type version` is the default; app-info localizations hold name/subtitle/privacy URLs. */
  localizationsList: (
    target: { versionId: string } | { appId: string },
    options?: ListOptions,
  ): string[] => [
    'localizations',
    'list',
    ...('versionId' in target
      ? ['--version', target.versionId]
      : ['--app', target.appId, '--type', 'app-info']),
    ...listFlags(options),
    ...JSON_OUTPUT,
  ],

  localizationCreate: (versionId: string, locale: string, fields: VersionTextFields): string[] => [
    'localizations',
    'create',
    '--version',
    versionId,
    '--locale',
    locale,
    ...versionTextFlags(fields),
    ...JSON_OUTPUT,
  ],

  localizationUpdate: (versionId: string, locale: string, fields: VersionTextFields): string[] => [
    'localizations',
    'update',
    '--version',
    versionId,
    '--locale',
    locale,
    ...versionTextFlags(fields),
    ...JSON_OUTPUT,
  ],

  appInfoLocalizationUpdate: (
    appId: string,
    locale: string,
    fields: AppInfoTextFields,
  ): string[] => [
    'localizations',
    'update',
    '--type',
    'app-info',
    '--app',
    appId,
    '--locale',
    locale,
    ...flag('--name', fields.name),
    ...flag('--subtitle', fields.subtitle),
    ...flag('--privacy-policy-url', fields.privacyPolicyUrl),
    ...JSON_OUTPUT,
  ],

  screenshotsList: (versionLocalizationId: string): string[] => [
    'screenshots',
    'list',
    '--version-localization',
    versionLocalizationId,
    ...JSON_OUTPUT,
  ],

  /**
   * `--skip-existing` compares the MD5 App Store Connect recorded for each screenshot with
   * the local file's, which is what makes a re-run a no-op. Agentship additionally computes
   * SHA-256 itself so a plan hash covers the exact bytes; MD5 here is only the store's own
   * de-duplication key, never a trust decision.
   */
  screenshotsUpload: (options: {
    versionLocalizationId: string;
    path: string;
    deviceType: string;
    replace?: boolean;
    dryRun?: boolean;
  }): string[] => [
    'screenshots',
    'upload',
    '--version-localization',
    options.versionLocalizationId,
    '--path',
    options.path,
    '--device-type',
    options.deviceType,
    '--skip-existing',
    ...boolFlag('--replace', options.replace),
    ...boolFlag('--dry-run', options.dryRun),
    ...JSON_OUTPUT,
  ],

  screenshotDelete: (screenshotId: string): string[] => [
    'screenshots',
    'delete',
    '--id',
    screenshotId,
    '--confirm',
    ...JSON_OUTPUT,
  ],

  buildsList: (
    appId: string,
    options?: ListOptions & { platform?: AscPlatform; version?: string; buildNumber?: string },
  ): string[] => [
    'builds',
    'list',
    '--app',
    appId,
    ...flag('--platform', options?.platform),
    ...flag('--version', options?.version),
    ...flag('--build-number', options?.buildNumber),
    ...listFlags(options),
    ...JSON_OUTPUT,
  ],

  buildInfo: (appId: string, buildNumber: string, platform?: AscPlatform): string[] => [
    'builds',
    'info',
    '--app',
    appId,
    '--build-number',
    buildNumber,
    ...flag('--platform', platform),
    ...JSON_OUTPUT,
  ],

  /**
   * Uses Apple's supported Build Upload API through `asc`; Transporter is never invoked.
   * `--wait` polls until App Store Connect finishes processing the binary.
   */
  buildUpload: (options: {
    appId: string;
    artifactPath: string;
    kind: 'ipa' | 'pkg';
    version?: string;
    buildNumber?: string;
    platform?: AscPlatform;
    testNotes?: string;
    testNotesLocale?: string;
    pollIntervalSeconds?: number;
    wait?: boolean;
    dryRun?: boolean;
  }): string[] => [
    'builds',
    'upload',
    '--app',
    options.appId,
    options.kind === 'ipa' ? '--ipa' : '--pkg',
    options.artifactPath,
    ...flag('--version', options.version),
    ...flag('--build-number', options.buildNumber),
    ...flag('--platform', options.platform),
    ...flag('--test-notes', options.testNotes),
    ...flag('--locale', options.testNotes === undefined ? undefined : options.testNotesLocale),
    ...(options.wait === false ? [] : ['--wait']),
    ...flag(
      '--poll-interval',
      options.pollIntervalSeconds === undefined ? undefined : `${options.pollIntervalSeconds}s`,
    ),
    ...boolFlag('--dry-run', options.dryRun),
    ...JSON_OUTPUT,
  ],

  buildAddGroups: (options: {
    buildId: string;
    groups: readonly string[];
    submitForBetaReview?: boolean;
    skipInternal?: boolean;
  }): string[] => [
    'builds',
    'add-groups',
    '--build-id',
    options.buildId,
    '--group',
    options.groups.join(','),
    ...boolFlag('--skip-internal', options.skipInternal),
    ...(options.submitForBetaReview === true ? ['--submit', '--confirm'] : []),
    ...JSON_OUTPUT,
  ],

  testflightGroupsList: (appId: string, options?: ListOptions): string[] => [
    'testflight',
    'groups',
    'list',
    '--app',
    appId,
    ...listFlags(options),
    ...JSON_OUTPUT,
  ],

  testflightGroupCreate: (appId: string, name: string, internal: boolean): string[] => [
    'testflight',
    'groups',
    'create',
    '--app',
    appId,
    '--name',
    name,
    ...boolFlag('--internal', internal),
    ...JSON_OUTPUT,
  ],

  testflightGroupEdit: (options: {
    groupId: string;
    name?: string;
    publicLinkEnabled?: boolean;
  }): string[] => [
    'testflight',
    'groups',
    'edit',
    '--id',
    options.groupId,
    ...flag('--name', options.name),
    ...boolFlag('--public-link-enabled', options.publicLinkEnabled),
    ...JSON_OUTPUT,
  ],

  testflightGroupAddTesters: (groupId: string, emails: readonly string[]): string[] => [
    'testflight',
    'groups',
    'add-testers',
    '--group',
    groupId,
    '--email',
    emails.join(','),
    ...JSON_OUTPUT,
  ],

  /** Removal is by tester id, so callers resolve ids through `testflightTestersList` first. */
  testflightGroupRemoveTesters: (groupId: string, testerIds: readonly string[]): string[] => [
    'testflight',
    'groups',
    'remove-testers',
    '--group',
    groupId,
    '--tester',
    testerIds.join(','),
    '--confirm',
    ...JSON_OUTPUT,
  ],

  testflightTestersList: (
    appId: string,
    options?: ListOptions & { groupId?: string },
  ): string[] => [
    'testflight',
    'testers',
    'list',
    '--app',
    appId,
    ...flag('--group', options?.groupId),
    ...listFlags(options),
    ...JSON_OUTPUT,
  ],

  pricingCurrent: (appId: string): string[] => [
    'pricing',
    'current',
    '--app',
    appId,
    ...JSON_OUTPUT,
  ],

  pricingScheduleCreate: (options: {
    appId: string;
    free?: boolean;
    price?: string;
    baseTerritory?: string;
    startDate?: string;
  }): string[] => [
    'pricing',
    'schedule',
    'create',
    '--app',
    options.appId,
    ...boolFlag('--free', options.free),
    ...flag('--price', options.free === true ? undefined : options.price),
    ...flag('--base-territory', options.baseTerritory),
    ...flag('--start-date', options.startDate),
    ...JSON_OUTPUT,
  ],

  pricingAvailabilityView: (appId: string): string[] => [
    'pricing',
    'availability',
    'view',
    '--app',
    appId,
    ...JSON_OUTPUT,
  ],

  pricingAvailabilityEdit: (options: {
    appId: string;
    territories?: readonly string[];
    allTerritories?: boolean;
    availableInNewTerritories?: boolean;
  }): string[] => [
    'pricing',
    'availability',
    'edit',
    '--app',
    options.appId,
    ...(options.allTerritories === true
      ? ['--all-territories']
      : flag('--territory', options.territories?.join(','))),
    '--available',
    'true',
    ...(options.availableInNewTerritories === undefined
      ? []
      : ['--available-in-new-territories', String(options.availableInNewTerritories)]),
    ...JSON_OUTPUT,
  ],

  phasedReleaseView: (versionId: string): string[] => [
    'versions',
    'phased-release',
    'view',
    '--version-id',
    versionId,
    ...JSON_OUTPUT,
  ],

  phasedReleaseCreate: (versionId: string, state: 'INACTIVE' | 'ACTIVE'): string[] => [
    'versions',
    'phased-release',
    'create',
    '--version-id',
    versionId,
    '--state',
    state,
    ...JSON_OUTPUT,
  ],

  phasedReleaseUpdate: (id: string, state: 'ACTIVE' | 'PAUSED' | 'COMPLETE'): string[] => [
    'versions',
    'phased-release',
    'update',
    '--id',
    id,
    '--state',
    state,
    ...JSON_OUTPUT,
  ],

  phasedReleaseDelete: (id: string): string[] => [
    'versions',
    'phased-release',
    'delete',
    '--id',
    id,
    '--confirm',
    ...JSON_OUTPUT,
  ],

  reviewSubmissionsCreate: (appId: string, platform: AscPlatform): string[] => [
    'review',
    'submissions-create',
    '--app',
    appId,
    '--platform',
    platform,
    ...JSON_OUTPUT,
  ],

  reviewSubmissionsList: (appId: string, options?: ListOptions): string[] => [
    'review',
    'submissions-list',
    '--app',
    appId,
    ...listFlags(options),
    ...JSON_OUTPUT,
  ],

  reviewItemsAdd: (submissionId: string, itemType: string, itemId: string): string[] => [
    'review',
    'items-add',
    '--submission',
    submissionId,
    '--item-type',
    itemType,
    '--item-id',
    itemId,
    ...JSON_OUTPUT,
  ],

  reviewSubmissionsSubmit: (submissionId: string): string[] => [
    'review',
    'submissions-submit',
    '--id',
    submissionId,
    '--confirm',
    ...JSON_OUTPUT,
  ],

  reviewSubmissionsGet: (submissionId: string): string[] => [
    'review',
    'submissions-get',
    '--id',
    submissionId,
    '--include',
    'items',
    ...JSON_OUTPUT,
  ],

  iapList: (appId: string, options?: ListOptions): string[] => [
    'iap',
    'list',
    '--app',
    appId,
    ...listFlags(options),
    ...JSON_OUTPUT,
  ],

  subscriptionsList: (appId: string, options?: ListOptions): string[] => [
    'subscriptions',
    'list',
    '--app',
    appId,
    ...listFlags(options),
    ...JSON_OUTPUT,
  ],

  // --- monetisation writes --------------------------------------------------------
  //
  // Apple's model has two shapes, and the commands follow them rather than flattening
  // them: `iap *` for consumables, non-consumables and non-renewing subscriptions, and
  // `subscriptions *` for auto-renewable ones, which live inside a group.

  iapCreate: (options: {
    appId: string;
    productId: string;
    referenceName: string;
    type: 'CONSUMABLE' | 'NON_CONSUMABLE' | 'NON_RENEWING_SUBSCRIPTION';
    familySharable?: boolean;
  }): string[] => [
    'iap',
    'create',
    '--app',
    options.appId,
    '--type',
    options.type,
    '--ref-name',
    options.referenceName,
    '--product-id',
    options.productId,
    ...boolFlag('--family-sharable', options.familySharable),
    ...JSON_OUTPUT,
  ],

  iapUpdate: (options: {
    iapId: string;
    referenceName?: string;
    familySharable?: boolean;
  }): string[] => [
    'iap',
    'update',
    '--id',
    options.iapId,
    ...flag('--ref-name', options.referenceName),
    ...boolFlag('--family-sharable', options.familySharable),
    ...JSON_OUTPUT,
  ],

  iapPricingSummary: (options: { appId?: string; iapId?: string }): string[] => [
    'iap',
    'pricing',
    'summary',
    ...flag('--app', options.appId),
    ...flag('--iap-id', options.iapId),
    ...JSON_OUTPUT,
  ],

  iapPricePointsList: (options: {
    iapId: string;
    appId?: string;
    territory?: string;
    price?: string;
  }): string[] => [
    'iap',
    'pricing',
    'price-points',
    'list',
    '--iap-id',
    options.iapId,
    ...flag('--app', options.appId),
    ...flag('--territory', options.territory),
    ...flag('--price', options.price),
    ...JSON_OUTPUT,
  ],

  /**
   * Creating a price schedule is how an IAP is priced; Apple has no "set the price" call.
   * `--price` lets `asc` resolve the nearest price point, which is exactly the number the
   * user has already approved in the diff.
   */
  iapPriceScheduleCreate: (options: {
    iapId: string;
    appId?: string;
    baseTerritory: string;
    price?: string;
    pricePointId?: string;
    startDate?: string;
  }): string[] => [
    'iap',
    'pricing',
    'schedules',
    'create',
    '--iap-id',
    options.iapId,
    ...flag('--app', options.appId),
    '--base-territory',
    options.baseTerritory,
    ...(options.pricePointId === undefined
      ? flag('--price', options.price)
      : ['--prices', options.pricePointId]),
    ...flag('--start-date', options.startDate),
    ...JSON_OUTPUT,
  ],

  iapPricingScheduleView: (iapId: string, appId?: string): string[] => [
    'iap',
    'pricing',
    'schedules',
    'view',
    '--iap-id',
    iapId,
    ...flag('--app', appId),
    ...JSON_OUTPUT,
  ],

  iapAvailabilitySet: (options: {
    iapId: string;
    appId?: string;
    territories: readonly string[];
  }): string[] => [
    'iap',
    'pricing',
    'availability',
    'set',
    '--iap-id',
    options.iapId,
    ...flag('--app', options.appId),
    '--territories',
    options.territories.join(','),
    ...JSON_OUTPUT,
  ],

  // Scoped by --iap-id only; asc 3.4.1 exposes no --app on this subcommand.
  iapVersionsList: (iapId: string): string[] => [
    'iap',
    'versions',
    'list',
    '--iap-id',
    iapId,
    ...JSON_OUTPUT,
  ],

  iapVersionLocalizationCreate: (options: {
    versionId: string;
    locale: string;
    name: string;
    description?: string;
  }): string[] => [
    'iap',
    'versions',
    'localizations',
    'create',
    '--version-id',
    options.versionId,
    '--locale',
    options.locale,
    '--name',
    options.name,
    ...flag('--description', options.description),
    ...JSON_OUTPUT,
  ],

  iapOfferCodeCreate: (options: {
    iapId: string;
    appId?: string;
    name: string;
    prices: string;
  }): string[] => [
    'iap',
    'offer-codes',
    'create',
    '--iap-id',
    options.iapId,
    ...flag('--app', options.appId),
    '--name',
    options.name,
    '--prices',
    options.prices,
    ...JSON_OUTPUT,
  ],

  subscriptionGroupsList: (appId: string, options?: ListOptions): string[] => [
    'subscriptions',
    'groups',
    'list',
    '--app',
    appId,
    ...listFlags(options),
    ...JSON_OUTPUT,
  ],

  subscriptionGroupCreate: (appId: string, referenceName: string): string[] => [
    'subscriptions',
    'groups',
    'create',
    '--app',
    appId,
    '--reference-name',
    referenceName,
    ...JSON_OUTPUT,
  ],

  subscriptionCreate: (options: {
    groupId: string;
    productId: string;
    referenceName: string;
    period: AscSubscriptionPeriod;
    familySharable?: boolean;
  }): string[] => [
    'subscriptions',
    'create',
    '--group-id',
    options.groupId,
    '--reference-name',
    options.referenceName,
    '--product-id',
    options.productId,
    '--subscription-period',
    options.period,
    ...boolFlag('--family-sharable', options.familySharable),
    ...JSON_OUTPUT,
  ],

  // Same flag spelling as `subscriptions view`: --id, and no --app.
  subscriptionUpdate: (options: {
    subscriptionId: string;
    referenceName?: string;
    period?: AscSubscriptionPeriod;
  }): string[] => [
    'subscriptions',
    'update',
    '--id',
    options.subscriptionId,
    ...flag('--reference-name', options.referenceName),
    ...flag('--subscription-period', options.period),
    ...JSON_OUTPUT,
  ],

  subscriptionPricesList: (subscriptionId: string, appId?: string): string[] => [
    'subscriptions',
    'pricing',
    'prices',
    'list',
    '--subscription-id',
    subscriptionId,
    ...flag('--app', appId),
    ...JSON_OUTPUT,
  ],

  /**
   * `--preserved` is what keeps existing subscribers on the price they signed up at. It is
   * never inferred: the manifest has to ask for it, because the alternative changes what
   * real customers are charged.
   */
  subscriptionPriceSet: (options: {
    subscriptionId: string;
    appId?: string;
    territory?: string;
    price?: string;
    pricePointId?: string;
    startDate?: string;
    preserved?: boolean;
  }): string[] => [
    'subscriptions',
    'pricing',
    'prices',
    'set',
    '--subscription-id',
    options.subscriptionId,
    ...flag('--app', options.appId),
    ...flag('--territory', options.territory),
    ...(options.pricePointId === undefined
      ? flag('--price', options.price)
      : ['--price-point', options.pricePointId]),
    ...flag('--start-date', options.startDate),
    ...boolFlag('--preserved', options.preserved),
    ...JSON_OUTPUT,
  ],

  subscriptionPricePointsList: (options: {
    subscriptionId: string;
    appId?: string;
    territory?: string;
    price?: string;
  }): string[] => [
    'subscriptions',
    'pricing',
    'price-points',
    'list',
    '--subscription-id',
    options.subscriptionId,
    ...flag('--app', options.appId),
    ...flag('--territory', options.territory),
    ...flag('--price', options.price),
    ...JSON_OUTPUT,
  ],

  subscriptionAvailabilityEdit: (options: {
    subscriptionId: string;
    appId?: string;
    territories: readonly string[];
  }): string[] => [
    'subscriptions',
    'pricing',
    'availability',
    'edit',
    '--subscription-id',
    options.subscriptionId,
    ...flag('--app', options.appId),
    '--territories',
    options.territories.join(','),
    ...JSON_OUTPUT,
  ],

  subscriptionIntroductoryOffersList: (subscriptionId: string, appId?: string): string[] => [
    'subscriptions',
    'offers',
    'introductory',
    'list',
    '--subscription-id',
    subscriptionId,
    ...flag('--app', appId),
    ...JSON_OUTPUT,
  ],

  subscriptionIntroductoryOfferCreate: (options: {
    subscriptionId: string;
    appId?: string;
    duration: AscOfferDuration;
    mode: AscOfferMode;
    numberOfPeriods: number;
    territory?: string;
    allTerritories?: boolean;
  }): string[] => [
    'subscriptions',
    'offers',
    'introductory',
    'create',
    '--subscription-id',
    options.subscriptionId,
    ...flag('--app', options.appId),
    '--offer-duration',
    options.duration,
    '--offer-mode',
    options.mode,
    '--number-of-periods',
    String(options.numberOfPeriods),
    ...(options.allTerritories === true
      ? ['--all-territories']
      : flag('--territory', options.territory)),
    ...JSON_OUTPUT,
  ],

  ageRatingView: (appId: string): string[] => [
    'age-rating',
    'view',
    '--app',
    appId,
    ...JSON_OUTPUT,
  ],

  /**
   * `--all-none` sets every answer to its safe default in one call, which is the only way to
   * make an age rating edit deterministic: without it, a partial edit leaves whatever the
   * previous questionnaire said in the untouched fields.
   */
  ageRatingEdit: (options: {
    appId: string;
    allNone?: boolean;
    answers: Readonly<Record<string, string | boolean>>;
  }): string[] => [
    'age-rating',
    'edit',
    '--app',
    options.appId,
    ...boolFlag('--all-none', options.allNone),
    ...Object.entries(options.answers)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([key, value]) => [`--${key}`, String(value)]),
    ...JSON_OUTPUT,
  ],
} as const;

/** Subscription periods `asc subscriptions create --subscription-period` accepts. */
export type AscSubscriptionPeriod =
  | 'ONE_WEEK'
  | 'ONE_MONTH'
  | 'TWO_MONTHS'
  | 'THREE_MONTHS'
  | 'SIX_MONTHS'
  | 'ONE_YEAR';

/** Offer durations `asc subscriptions offers introductory create --offer-duration` accepts. */
export type AscOfferDuration =
  | 'THREE_DAYS'
  | 'ONE_WEEK'
  | 'TWO_WEEKS'
  | 'ONE_MONTH'
  | 'TWO_MONTHS'
  | 'THREE_MONTHS'
  | 'SIX_MONTHS'
  | 'ONE_YEAR';

export type AscOfferMode = 'PAY_AS_YOU_GO' | 'PAY_UP_FRONT' | 'FREE_TRIAL';

/** Neutral billing periods, in Apple's spelling. */
export const APPLE_PERIODS: Readonly<Record<string, AscSubscriptionPeriod>> = {
  one_week: 'ONE_WEEK',
  one_month: 'ONE_MONTH',
  two_months: 'TWO_MONTHS',
  three_months: 'THREE_MONTHS',
  six_months: 'SIX_MONTHS',
  one_year: 'ONE_YEAR',
};

/** Neutral product types, in Apple's `asc iap create --type` spelling. */
export const APPLE_IAP_TYPES: Readonly<
  Record<string, 'CONSUMABLE' | 'NON_CONSUMABLE' | 'NON_RENEWING_SUBSCRIPTION'>
> = {
  consumable: 'CONSUMABLE',
  non_consumable: 'NON_CONSUMABLE',
  non_renewing_subscription: 'NON_RENEWING_SUBSCRIPTION',
};

/** Neutral offer modes, in Apple's spelling. */
export const APPLE_OFFER_MODES: Readonly<Record<string, AscOfferMode>> = {
  free_trial: 'FREE_TRIAL',
  pay_as_you_go: 'PAY_AS_YOU_GO',
  pay_up_front: 'PAY_UP_FRONT',
};

export interface VersionTextFields {
  readonly description?: string;
  readonly keywords?: string;
  readonly whatsNew?: string;
  readonly promotionalText?: string;
  readonly marketingUrl?: string;
  readonly supportUrl?: string;
}

export interface AppInfoTextFields {
  readonly name?: string;
  readonly subtitle?: string;
  readonly privacyPolicyUrl?: string;
}

function versionTextFlags(fields: VersionTextFields): string[] {
  return [
    ...flag('--description', fields.description),
    ...flag('--keywords', fields.keywords),
    ...flag('--whats-new', fields.whatsNew),
    ...flag('--promotional-text', fields.promotionalText),
    ...flag('--marketing-url', fields.marketingUrl),
    ...flag('--support-url', fields.supportUrl),
  ];
}

/** True when a field of {@link VersionTextFields} is set. */
export function hasVersionText(fields: VersionTextFields): boolean {
  return versionTextFlags(fields).length > 0;
}

/** True when a field of {@link AppInfoTextFields} is set. */
export function hasAppInfoText(fields: AppInfoTextFields): boolean {
  return (
    fields.name !== undefined ||
    fields.subtitle !== undefined ||
    fields.privacyPolicyUrl !== undefined
  );
}
