import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  type AdapterContext,
  AgentshipError,
  type AppRef,
  type BuildArtifact,
  type BuildRef,
  ERROR_CODES,
  ensureDir,
  type MetadataChanges,
  type OperationId,
  type OpResult,
  optional,
  type PhasedReleaseAction,
  type PricingSchedule,
  type ReleaseTrack,
  type ScreenshotPlan,
  type SubmissionRef,
  type SubmissionSpec,
  type SubmissionStatus,
  type TesterGroupChanges,
  tmpDir,
  type VersionSpec,
} from '@agentship/core';
import type { AppleClient } from './client.js';
import { APPLE_DEVICE_TYPES, ascCommands, hasAppInfoText, hasVersionText } from './commands.js';
import { attrString, type JsonApiResource, parseLooseObject } from './jsonapi.js';
import {
  isTestFlightTrack,
  toAscPlatform,
  toAscReleaseType,
  toBuildState,
  toSubmissionState,
  trackForBetaGroup,
  UNSUPPORTED_DEVICES,
} from './mapping.js';
import { getAppleAppState, pickTargetVersion } from './state.js';

/** Default budget for a build upload plus App Store Connect processing. */
export const DEFAULT_PROCESSING_TIMEOUT_MS = 30 * 60_000;
const UPLOAD_POLL_SECONDS = 30;

function result(
  operation: OperationId,
  fields: Partial<OpResult> & { changed: boolean; dryRun: boolean },
): OpResult {
  return {
    ok: true,
    store: 'apple',
    operation,
    ...fields,
  };
}

/** Version an operation should address, resolved once so every call agrees on the target. */
async function resolveVersion(
  client: AppleClient,
  context: AdapterContext,
  ref: AppRef,
  hint: { versionId?: string; version?: string },
): Promise<{ id: string; version: string }> {
  if (hint.versionId !== undefined) return { id: hint.versionId, version: hint.version ?? '' };

  const platform = toAscPlatform(ref.platform);
  const resources = await client.list(
    context,
    ascCommands.versionsList(ref.id, { platform, limit: 20 }),
  );
  const versions = resources.map((resource) => ({
    id: resource.id,
    version: attrString(resource, 'versionString') ?? '',
    state: attrString(resource, 'appStoreState') ?? attrString(resource, 'appVersionState') ?? '',
  }));

  const wanted =
    hint.version === undefined
      ? undefined
      : versions.find((candidate) => candidate.version === hint.version);
  if (wanted !== undefined) return wanted;

  const editable = versions.find(
    (candidate) =>
      candidate.state === 'PREPARE_FOR_SUBMISSION' ||
      candidate.state === 'DEVELOPER_REJECTED' ||
      candidate.state === 'REJECTED' ||
      candidate.state === 'METADATA_REJECTED',
  );
  if (editable !== undefined) return editable;

  throw new AgentshipError(
    ERROR_CODES.PLAN_CONFLICT,
    hint.version === undefined
      ? 'This app has no editable App Store version; every version is already submitted or published.'
      : `This app has no App Store version ${hint.version}.`,
    {
      store: 'apple',
      details: { appId: ref.id, requested: hint.version, seen: versions.map((v) => v.version) },
      remediation: {
        summary:
          'Create the version first (Agentship does this as part of a release plan), or target an existing editable one.',
      },
    },
  );
}

// --- version ------------------------------------------------------------------------

/**
 * Makes the requested App Store version exist and be editable.
 *
 * Idempotent by construction: the version list is read first, so a version that is already
 * there is reported as `changed: false` and never re-created — the property a resumed plan
 * depends on. A version that exists but is no longer editable is a conflict, not something
 * to work around: only a human can decide to withdraw a submission.
 */
export async function ensureAppleVersion(
  client: AppleClient,
  context: AdapterContext,
  ref: AppRef,
  spec: VersionSpec,
): Promise<OpResult> {
  const dryRun = context.dryRun === true;
  const platform = toAscPlatform(spec.platform ?? ref.platform);
  const resources = await client.list(
    context,
    ascCommands.versionsList(ref.id, { platform, limit: 50 }),
  );
  const existing = resources
    .map((resource) => ({
      id: resource.id,
      version: attrString(resource, 'versionString') ?? '',
      state: attrString(resource, 'appStoreState') ?? attrString(resource, 'appVersionState') ?? '',
    }))
    .find((candidate) => candidate.version === spec.version);

  const releaseType = toAscReleaseType(spec.releaseStrategy);
  if (existing !== undefined) {
    if (!EDITABLE_VERSION_STATES.has(existing.state)) {
      throw new AgentshipError(
        ERROR_CODES.STORE_CONFLICT,
        `App Store version ${spec.version} is ${existing.state}; it cannot be edited.`,
        {
          store: 'apple',
          details: { appId: ref.id, versionId: existing.id, state: existing.state },
          remediation: {
            summary:
              'Wait for the review to finish, or withdraw the submission in App Store Connect — that is a human decision Agentship will not take.',
          },
        },
      );
    }
    const wantsUpdate = releaseType !== undefined || spec.copyright !== undefined;
    if (wantsUpdate && !dryRun) {
      await client.run(
        context,
        ascCommands.versionUpdate(existing.id, {
          ...optional('releaseType', releaseType),
          ...optional('copyright', spec.copyright),
          ...optional(
            'earliestReleaseDate',
            spec.releaseStrategy === 'scheduled' ? spec.scheduledReleaseDate : undefined,
          ),
        }),
      );
    }
    return result('ensureVersion', {
      changed: wantsUpdate && !dryRun,
      dryRun,
      details: { versionId: existing.id, reused: true },
    });
  }

  if (dryRun) {
    return result('ensureVersion', {
      changed: false,
      dryRun,
      details: { version: spec.version, wouldCreate: true },
    });
  }
  const created = await client.one(
    context,
    ascCommands.versionCreate(ref.id, spec.version, {
      ...optional('platform', platform),
      ...optional('copyright', spec.copyright),
      ...optional('releaseType', releaseType),
    }),
  );
  return result('ensureVersion', {
    changed: true,
    dryRun,
    details: { versionId: created?.id ?? spec.version, created: true },
  });
}

/** App Store states in which a version still accepts edits. */
const EDITABLE_VERSION_STATES: ReadonlySet<string> = new Set([
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
]);

// --- metadata -----------------------------------------------------------------------

export async function setAppleMetadata(
  client: AppleClient,
  context: AdapterContext,
  ref: AppRef,
  changes: MetadataChanges,
): Promise<OpResult> {
  const dryRun = context.dryRun === true;
  const warnings: string[] = [];
  const target = await resolveVersion(client, context, ref, {
    ...(changes.versionId === undefined ? {} : { versionId: changes.versionId }),
    ...(changes.version === undefined ? {} : { version: changes.version }),
  });

  // Which locales already exist decides create-versus-update; asking once keeps the
  // operation idempotent without a per-locale probe.
  const existing = new Set(
    (
      await client.list(
        context,
        ascCommands.localizationsList({ versionId: target.id }, { paginate: true }),
      )
    )
      .map((resource) => attrString(resource, 'locale'))
      .filter((locale): locale is string => locale !== undefined),
  );

  const planned: string[] = [];
  let changed = false;

  for (const locale of changes.locales) {
    if (locale.shortDescription !== undefined) {
      warnings.push(`${locale.locale}: the App Store has no short description; field ignored.`);
    }
    if (locale.videoUrl !== undefined) {
      warnings.push(`${locale.locale}: the App Store has no listing video URL; field ignored.`);
    }

    const versionFields = {
      ...pick(locale, 'description'),
      ...pick(locale, 'keywords'),
      ...pick(locale, 'whatsNew'),
      ...pick(locale, 'promotionalText'),
      ...pick(locale, 'marketingUrl'),
      ...pick(locale, 'supportUrl'),
    };
    const appInfoFields = {
      ...pick(locale, 'name'),
      ...pick(locale, 'subtitle'),
      ...pick(locale, 'privacyPolicyUrl'),
    };

    if (hasVersionText(versionFields)) {
      const args = existing.has(locale.locale)
        ? ascCommands.localizationUpdate(target.id, locale.locale, versionFields)
        : ascCommands.localizationCreate(target.id, locale.locale, versionFields);
      planned.push(args.slice(0, 2).join(' '));
      if (!dryRun) {
        await client.run(context, args);
        changed = true;
      }
    }
    if (hasAppInfoText(appInfoFields)) {
      const args = ascCommands.appInfoLocalizationUpdate(ref.id, locale.locale, appInfoFields);
      planned.push('localizations update --type app-info');
      if (!dryRun) {
        await client.run(context, args);
        changed = true;
      }
    }
  }

  const releaseType = toAscReleaseType(changes.releaseStrategy);
  if (changes.copyright !== undefined || releaseType !== undefined) {
    const args = ascCommands.versionUpdate(target.id, {
      ...(changes.copyright === undefined ? {} : { copyright: changes.copyright }),
      ...(releaseType === undefined ? {} : { releaseType }),
      ...(changes.scheduledReleaseDate === undefined
        ? {}
        : { earliestReleaseDate: changes.scheduledReleaseDate }),
    });
    planned.push('versions update');
    if (!dryRun) {
      await client.run(context, args);
      changed = true;
    }
  }

  return result('setMetadata', {
    changed,
    dryRun,
    ...(warnings.length === 0 ? {} : { warnings }),
    details: { versionId: target.id, locales: changes.locales.map((l) => l.locale), planned },
  });
}

function pick<T extends object, K extends keyof T>(source: T, key: K): Pick<T, K> | object {
  return source[key] === undefined ? {} : ({ [key]: source[key] } as Pick<T, K>);
}

// --- screenshots --------------------------------------------------------------------

/**
 * Uploading screenshots idempotently.
 *
 * `asc screenshots upload` takes a *directory* and, with `--skip-existing`, leaves alone
 * every file whose MD5 App Store Connect already recorded. Agentship's plan is a list of
 * files that may live anywhere, so each set is staged into a private directory before the
 * upload.
 *
 * Copies, not symlinks. Staging by link is cheaper and was the original design, but neither
 * CLI handles it: `asc` refuses a symlinked screenshot outright, and `gpc` silently skips
 * the links and then reports success — an upload that changed nothing while claiming it had.
 * Doubling the I/O is a small price for an operation that means what it says.
 *
 * The staging directory lives under `AGENTSHIP_HOME` (0700) and is removed in a `finally`.
 */
export async function syncAppleScreenshots(
  client: AppleClient,
  context: AdapterContext,
  ref: AppRef,
  plan: ScreenshotPlan,
): Promise<OpResult> {
  const dryRun = context.dryRun === true;
  const warnings: string[] = [];
  const target = await resolveVersion(client, context, ref, {
    ...(plan.versionId === undefined ? {} : { versionId: plan.versionId }),
    ...(plan.version === undefined ? {} : { version: plan.version }),
  });

  const localizations = await client.list(
    context,
    ascCommands.localizationsList({ versionId: target.id }, { paginate: true }),
  );
  const localizationByLocale = new Map<string, string>();
  for (const resource of localizations) {
    const locale = attrString(resource, 'locale');
    if (locale !== undefined) localizationByLocale.set(locale, resource.id);
  }

  const uploaded: string[] = [];
  let changed = false;

  for (const set of plan.sets) {
    const slot = set.slot ?? 'screenshots';
    if (slot !== 'screenshots') {
      warnings.push(
        `${set.locale}/${set.device}: the App Store takes the ${slot.replace('_', ' ')} from the app binary, not from the listing; set skipped.`,
      );
      continue;
    }
    if (UNSUPPORTED_DEVICES.includes(set.device)) {
      warnings.push(`${set.locale}: the App Store has no ${set.device} display size; set skipped.`);
      continue;
    }
    const deviceType = APPLE_DEVICE_TYPES[set.device];
    if (deviceType === undefined) {
      warnings.push(`${set.locale}: no App Store display size maps to ${set.device}; set skipped.`);
      continue;
    }
    const localizationId = localizationByLocale.get(set.locale);
    if (localizationId === undefined) {
      warnings.push(
        `${set.locale}: the version has no localization for this locale, so its screenshots were skipped. Set the metadata for this locale first.`,
      );
      continue;
    }

    await withStagedSet(set.assets, async (directory) => {
      const args = ascCommands.screenshotsUpload({
        versionLocalizationId: localizationId,
        path: directory,
        deviceType,
        ...(plan.prune === true ? { replace: true } : {}),
        ...(dryRun ? { dryRun: true } : {}),
      });
      const stdout = await client.run(context, args, { timeoutMs: 15 * 60_000 });
      const report = parseLooseObject(stdout);
      const uploadedCount =
        typeof report?.['uploaded'] === 'number' ? report['uploaded'] : undefined;
      if (!dryRun && uploadedCount !== 0) changed = true;
      uploaded.push(`${set.locale}/${deviceType}: ${set.assets.length} file(s)`);
    });
  }

  return result('syncScreenshots', {
    changed,
    dryRun,
    ...(warnings.length === 0 ? {} : { warnings }),
    details: { versionId: target.id, sets: uploaded },
  });
}

/**
 * Presents a set of files as one self-contained directory.
 *
 * Ordering matters to the store, and `asc` sorts by file name, so each link is prefixed
 * with its index. Ties in `order` fall back to the source path, which makes the result
 * deterministic for the same plan. These must be regular files: `asc screenshots upload`
 * explicitly refuses symlinks, even when they point at readable PNGs.
 */
async function withStagedSet(
  assets: readonly { path: string; sha256: string; order?: number }[],
  fn: (directory: string) => Promise<void>,
): Promise<void> {
  const root = await ensureDir(join(tmpDir(), 'screenshots'));
  const directory = await mkdtemp(join(root, 's-'));
  try {
    const ordered = [...assets].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.path.localeCompare(b.path),
    );
    for (const [index, asset] of ordered.entries()) {
      const name = `${String(index).padStart(3, '0')}-${basename(asset.path)}`;
      await copyFile(asset.path, join(directory, name));
    }
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

// --- builds -------------------------------------------------------------------------

export async function uploadAppleBuild(
  client: AppleClient,
  context: AdapterContext,
  ref: AppRef,
  artifact: BuildArtifact,
): Promise<BuildRef> {
  if (artifact.kind !== 'ipa' && artifact.kind !== 'pkg') {
    throw new AgentshipError(
      ERROR_CODES.STORE_VALIDATION_FAILED,
      `The App Store accepts .ipa and .pkg artifacts, not ${artifact.kind}.`,
      { store: 'apple', details: { kind: artifact.kind } },
    );
  }
  const dryRun = context.dryRun === true;
  const processingTimeout = artifact.processingTimeoutMs ?? DEFAULT_PROCESSING_TIMEOUT_MS;

  const args = ascCommands.buildUpload({
    appId: ref.id,
    artifactPath: artifact.path,
    kind: artifact.kind,
    ...(artifact.version === undefined ? {} : { version: artifact.version }),
    ...(artifact.buildNumber === undefined ? {} : { buildNumber: artifact.buildNumber }),
    platform: toAscPlatform(ref.platform),
    ...(artifact.whatToTest === undefined
      ? {}
      : { testNotes: artifact.whatToTest, testNotesLocale: 'en-US' }),
    pollIntervalSeconds: UPLOAD_POLL_SECONDS,
    wait: !dryRun,
    ...(dryRun ? { dryRun: true } : {}),
  });

  // The tool needs slightly longer than the processing budget it is given, so that a store
  // that is merely slow surfaces as "still processing" rather than as a killed subprocess.
  const stdout = await client.run(context, args, { timeoutMs: processingTimeout + 60_000 });
  const report = parseLooseObject(stdout);
  const buildNumber =
    artifact.buildNumber ?? readString(report, 'buildNumber') ?? readString(report, 'version');

  if (dryRun) {
    return {
      store: 'apple',
      id: readString(report, 'buildId') ?? 'dry-run',
      buildNumber: buildNumber ?? '',
      ...optional('version', artifact.version),
      state: 'unknown',
    };
  }

  if (buildNumber === undefined) {
    throw new AgentshipError(
      ERROR_CODES.TOOL_INVALID_OUTPUT,
      'asc builds upload did not report which build number it created.',
      { store: 'apple', details: { appId: ref.id } },
    );
  }

  // The upload report is `asc`'s own shape; the authoritative answer comes from the API.
  const resource = await client.one(
    context,
    ascCommands.buildInfo(ref.id, buildNumber, toAscPlatform(ref.platform)),
  );
  return toBuildRef(resource, buildNumber, artifact.version);
}

function toBuildRef(
  resource: JsonApiResource | undefined,
  buildNumber: string,
  version: string | undefined,
): BuildRef {
  return {
    store: 'apple',
    id: resource?.id ?? buildNumber,
    buildNumber: attrString(resource, 'version') ?? buildNumber,
    ...optional('version', version),
    state: toBuildState(
      attrString(resource, 'processingState'),
      resource?.attributes?.['expired'] === true,
    ),
    ...optional('uploadedAt', attrString(resource, 'uploadedDate')),
  };
}

function readString(report: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = report?.[key];
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

// --- testers ------------------------------------------------------------------------

export async function distributeAppleBuild(
  client: AppleClient,
  context: AdapterContext,
  ref: AppRef,
  build: BuildRef,
  groups: readonly string[],
  track: ReleaseTrack | undefined,
): Promise<OpResult> {
  const dryRun = context.dryRun === true;
  if (groups.length === 0) {
    return result('distributeToTesters', {
      changed: false,
      dryRun,
      warnings: ['No tester groups were given, so nothing was distributed.'],
    });
  }

  const resolved = await resolveGroups(client, context, ref, groups);
  // Adding an external group triggers Apple's beta app review; internal groups never do.
  // `--submit --confirm` is what makes that submission happen instead of leaving the build
  // attached but undistributed, and it only makes sense outside the internal track.
  const external = track !== undefined && track !== 'internal_testing';

  if (!dryRun) {
    await client.run(
      context,
      ascCommands.buildAddGroups({
        buildId: build.id,
        groups: resolved.ids,
        submitForBetaReview: external,
      }),
    );
  }

  return result('distributeToTesters', {
    changed: !dryRun,
    dryRun,
    ...(resolved.missing.length === 0
      ? {}
      : { warnings: [`Unknown tester groups: ${resolved.missing.join(', ')}.`] }),
    details: {
      buildId: build.id,
      groups: resolved.ids,
      submittedForBetaReview: external && !dryRun,
    },
  });
}

async function resolveGroups(
  client: AppleClient,
  context: AdapterContext,
  ref: AppRef,
  wanted: readonly string[],
): Promise<{ ids: string[]; missing: string[] }> {
  const resources = await client.list(
    context,
    ascCommands.testflightGroupsList(ref.id, { paginate: true }),
  );
  const byName = new Map<string, string>();
  const ids = new Set<string>();
  for (const resource of resources) {
    ids.add(resource.id);
    const name = attrString(resource, 'name');
    if (name !== undefined) byName.set(name, resource.id);
  }
  const found: string[] = [];
  const missing: string[] = [];
  for (const entry of wanted) {
    const id = ids.has(entry) ? entry : byName.get(entry);
    if (id === undefined) missing.push(entry);
    else found.push(id);
  }
  if (found.length === 0) {
    throw new AgentshipError(
      ERROR_CODES.STORE_NOT_FOUND,
      `None of the requested TestFlight groups exist: ${wanted.join(', ')}.`,
      {
        store: 'apple',
        details: { requested: wanted, available: [...byName.keys()] },
        remediation: { summary: 'Create the groups first, or use one of the existing names.' },
      },
    );
  }
  return { ids: found, missing };
}

export async function manageAppleTesterGroups(
  client: AppleClient,
  context: AdapterContext,
  ref: AppRef,
  changes: TesterGroupChanges,
): Promise<OpResult> {
  const dryRun = context.dryRun === true;
  const warnings: string[] = [];
  const actions: string[] = [];
  let changed = false;

  const existing = await client.list(
    context,
    ascCommands.testflightGroupsList(ref.id, { paginate: true }),
  );
  const byName = new Map<string, JsonApiResource>();
  for (const resource of existing) {
    const name = attrString(resource, 'name');
    if (name !== undefined) byName.set(name, resource);
  }

  for (const spec of changes.groups) {
    let group = byName.get(spec.name);
    const internal = spec.track === 'internal_testing';

    if (group === undefined) {
      actions.push(`create ${spec.name}`);
      if (!dryRun) {
        const created = await client.one(
          context,
          ascCommands.testflightGroupCreate(ref.id, spec.name, internal),
        );
        if (created === undefined) {
          throw new AgentshipError(
            ERROR_CODES.TOOL_INVALID_OUTPUT,
            `asc did not return the TestFlight group it created for "${spec.name}".`,
            { store: 'apple', details: { group: spec.name } },
          );
        }
        group = created;
        changed = true;
      }
    } else {
      const currentTrack = trackForBetaGroup({
        ...(typeof group.attributes?.['isInternalGroup'] === 'boolean'
          ? { isInternal: group.attributes['isInternalGroup'] }
          : {}),
        hasPublicLink: attrString(group, 'publicLink') !== undefined,
      });
      if (currentTrack !== spec.track && internal !== (currentTrack === 'internal_testing')) {
        // Apple fixes internal-versus-external at creation time.
        warnings.push(
          `${spec.name} is an ${currentTrack === 'internal_testing' ? 'internal' : 'external'} group and cannot be converted; delete and re-create it to change that.`,
        );
      }
    }

    if (spec.publicLink !== undefined && group !== undefined) {
      actions.push(`public link ${spec.name}`);
      if (!dryRun) {
        await client.run(
          context,
          ascCommands.testflightGroupEdit({
            groupId: group.id,
            publicLinkEnabled: spec.publicLink,
          }),
        );
        changed = true;
      }
    }

    if (spec.members !== undefined && spec.members.length > 0 && group !== undefined) {
      actions.push(`add ${spec.members.length} tester(s) to ${spec.name}`);
      if (!dryRun) {
        await client.run(context, ascCommands.testflightGroupAddTesters(group.id, spec.members));
        changed = true;
      }
    }

    if (spec.pruneMembers === true && group !== undefined) {
      const stale = await staleTesters(client, context, ref, group.id, spec.members ?? []);
      if (stale.length > 0) {
        actions.push(`remove ${stale.length} tester(s) from ${spec.name}`);
        if (!dryRun) {
          await client.run(context, ascCommands.testflightGroupRemoveTesters(group.id, stale));
          changed = true;
        }
      }
    }
  }

  if (changes.prune === true) {
    // Deleting a group revokes access for everyone in it, so Agentship reports the extra
    // groups and lets the user decide rather than removing them as a side effect.
    const wanted = new Set(changes.groups.map((group) => group.name));
    const extra = [...byName.keys()].filter((name) => !wanted.has(name));
    if (extra.length > 0) {
      warnings.push(
        `These TestFlight groups exist but are not in the manifest: ${extra.join(', ')}. Agentship does not delete tester groups automatically.`,
      );
    }
  }

  return result('manageTesterGroups', {
    changed,
    dryRun,
    ...(warnings.length === 0 ? {} : { warnings }),
    details: { actions },
  });
}

/** Testers in the group that the desired membership does not mention. */
async function staleTesters(
  client: AppleClient,
  context: AdapterContext,
  ref: AppRef,
  groupId: string,
  wanted: readonly string[],
): Promise<string[]> {
  const keep = new Set(wanted.map((email) => email.trim().toLowerCase()));
  const testers = await client.list(
    context,
    ascCommands.testflightTestersList(ref.id, { groupId, paginate: true }),
  );
  return testers
    .filter((tester) => {
      const email = attrString(tester, 'email');
      return email !== undefined && !keep.has(email.toLowerCase());
    })
    .map((tester) => tester.id);
}

// --- pricing ------------------------------------------------------------------------

export async function setApplePricing(
  client: AppleClient,
  context: AdapterContext,
  ref: AppRef,
  schedule: PricingSchedule,
): Promise<OpResult> {
  const dryRun = context.dryRun === true;
  const actions: string[] = [];
  let changed = false;

  if (schedule.free === true || schedule.amount !== undefined) {
    actions.push('pricing schedule create');
    if (!dryRun) {
      await client.run(
        context,
        ascCommands.pricingScheduleCreate({
          appId: ref.id,
          ...(schedule.free === undefined ? {} : { free: schedule.free }),
          ...(schedule.amount === undefined ? {} : { price: schedule.amount }),
          ...(schedule.baseTerritory === undefined
            ? {}
            : { baseTerritory: schedule.baseTerritory }),
          ...(schedule.startDate === undefined ? {} : { startDate: schedule.startDate }),
        }),
      );
      changed = true;
    }
  }

  if (schedule.availability !== undefined) {
    actions.push('pricing availability edit');
    if (!dryRun) {
      await client.run(
        context,
        ascCommands.pricingAvailabilityEdit({
          appId: ref.id,
          ...(schedule.availability.territories === undefined
            ? {}
            : { territories: schedule.availability.territories }),
          ...(schedule.availability.allTerritories === undefined
            ? {}
            : { allTerritories: schedule.availability.allTerritories }),
          ...(schedule.availability.availableInNewTerritories === undefined
            ? {}
            : { availableInNewTerritories: schedule.availability.availableInNewTerritories }),
        }),
      );
      changed = true;
    }
  }

  return result('setPricing', { changed, dryRun, details: { actions } });
}

// --- review -------------------------------------------------------------------------

export async function submitAppleForReview(
  client: AppleClient,
  context: AdapterContext,
  ref: AppRef,
  submission: SubmissionSpec,
): Promise<SubmissionRef> {
  if (submission.track !== undefined && isTestFlightTrack(submission.track)) {
    throw new AgentshipError(
      ERROR_CODES.STORE_UNSUPPORTED_OPERATION,
      'TestFlight builds are submitted for beta review by distributing them to an external group, not through an App Store review submission.',
      { store: 'apple', details: { track: submission.track } },
    );
  }

  const platform = toAscPlatform(ref.platform);
  const target = await resolveVersion(client, context, ref, {
    ...(submission.versionId === undefined ? {} : { versionId: submission.versionId }),
    ...(submission.version === undefined ? {} : { version: submission.version }),
  });

  if (submission.buildNumber !== undefined) {
    const build = await client.one(
      context,
      ascCommands.buildInfo(ref.id, submission.buildNumber, platform),
    );
    if (build === undefined) {
      throw new AgentshipError(
        ERROR_CODES.STORE_NOT_FOUND,
        `Build ${submission.buildNumber} does not exist for this app, so it cannot be attached to version ${target.version}.`,
        { store: 'apple', details: { appId: ref.id, buildNumber: submission.buildNumber } },
      );
    }
    await client.run(context, ascCommands.versionAttachBuild(target.id, build.id));
  }

  if (submission.holdForDeveloperRelease === true) {
    await client.run(context, ascCommands.versionUpdate(target.id, { releaseType: 'MANUAL' }));
  }

  if (context.dryRun === true) {
    return { store: 'apple', id: `dry-run:${target.id}`, synthetic: true };
  }

  const created = await client.one(context, ascCommands.reviewSubmissionsCreate(ref.id, platform));
  if (created === undefined) {
    throw new AgentshipError(
      ERROR_CODES.TOOL_INVALID_OUTPUT,
      'asc did not return the review submission it created.',
      { store: 'apple', details: { appId: ref.id } },
    );
  }
  await client.run(context, ascCommands.reviewItemsAdd(created.id, 'appStoreVersions', target.id));
  await client.run(context, ascCommands.reviewSubmissionsSubmit(created.id));

  return {
    store: 'apple',
    id: created.id,
    synthetic: false,
    submittedAt: new Date().toISOString(),
  };
}

export async function getAppleSubmissionStatus(
  client: AppleClient,
  context: AdapterContext,
  submission: SubmissionRef,
): Promise<SubmissionStatus> {
  const resource = await client.one(context, ascCommands.reviewSubmissionsGet(submission.id));
  if (resource === undefined) {
    return {
      state: 'unknown',
      confidence: 'inferred',
      detail: `App Store Connect returned no submission with id ${submission.id}.`,
    };
  }
  const raw = attrString(resource, 'state');
  return {
    state: toSubmissionState(raw),
    // Apple reports the submission state directly, so this is read, not deduced.
    confidence: 'certain',
    ...optional('detail', raw),
    ...optional('updatedAt', attrString(resource, 'submittedDate')),
  };
}

// --- phased release ------------------------------------------------------------------

export async function setApplePhasedRelease(
  client: AppleClient,
  context: AdapterContext,
  ref: AppRef,
  action: PhasedReleaseAction,
): Promise<OpResult> {
  const dryRun = context.dryRun === true;
  const warnings: string[] = [];
  if (action.userFraction !== undefined) {
    // Apple's phased release follows a fixed 1/2/5/10/20/50/100% schedule over seven days.
    warnings.push(
      'The App Store runs a fixed seven-day phased release schedule; the requested user fraction was ignored.',
    );
  }
  if (action.track !== undefined && action.track !== 'production') {
    throw new AgentshipError(
      ERROR_CODES.STORE_UNSUPPORTED_OPERATION,
      'Phased release applies to the App Store only; TestFlight has no gradual rollout.',
      { store: 'apple', details: { track: action.track } },
    );
  }

  const state = await getAppleAppState(client, context, ref);
  const target =
    action.versionId === undefined
      ? (state.versions.find(
          (version) => version.state === 'pending_release' || version.state === 'live',
        ) ?? pickTargetVersion(state.versions))
      : state.versions.find((version) => version.id === action.versionId);
  if (target === undefined) {
    throw new AgentshipError(
      ERROR_CODES.PLAN_CONFLICT,
      'This app has no version a phased release could apply to.',
      { store: 'apple', details: { appId: ref.id } },
    );
  }

  const current = await client.one(context, ascCommands.phasedReleaseView(target.id));
  let changed = false;

  if (action.action === 'cancel') {
    if (current !== undefined && !dryRun) {
      await client.run(context, ascCommands.phasedReleaseDelete(current.id));
      changed = true;
    }
  } else if (current === undefined) {
    if (action.action !== 'start') {
      throw new AgentshipError(
        ERROR_CODES.PLAN_CONFLICT,
        `Version ${target.version} has no phased release to ${action.action}.`,
        { store: 'apple', details: { versionId: target.id, action: action.action } },
      );
    }
    if (!dryRun) {
      await client.run(context, ascCommands.phasedReleaseCreate(target.id, 'ACTIVE'));
      changed = true;
    }
  } else {
    const state =
      action.action === 'pause' ? 'PAUSED' : action.action === 'complete' ? 'COMPLETE' : 'ACTIVE';
    if (!dryRun) {
      await client.run(context, ascCommands.phasedReleaseUpdate(current.id, state));
      changed = true;
    }
  }

  return result('setPhasedRelease', {
    changed,
    dryRun,
    ...(warnings.length === 0 ? {} : { warnings }),
    details: { versionId: target.id, action: action.action },
  });
}
