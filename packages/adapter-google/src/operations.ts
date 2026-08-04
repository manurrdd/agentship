import {
  type AdapterContext,
  AgentshipError,
  type AppRef,
  type BuildArtifact,
  type BuildRef,
  ERROR_CODES,
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
} from '@agentship/core';
import { GOOGLE_PENDING_OPERATIONS } from './capabilities.js';
import type { GoogleClient } from './client.js';
import { type CommitFlags, GOOGLE_TRACKS, gpcCommands } from './commands.js';
import {
  imageSyncResultSchema,
  listingListSchema,
  releaseResultSchema,
  releaseStatusListSchema,
  testersSchema,
  toVersionState,
  unwrapList,
} from './schema.js';
import { mergeListing, type StagedListing, withImageTree, withListingTree } from './staging.js';

/** Default budget for an AAB upload plus Play-side processing. */
export const DEFAULT_PROCESSING_TIMEOUT_MS = 30 * 60_000;

function result(
  operation: OperationId,
  fields: Partial<OpResult> & { changed: boolean; dryRun: boolean },
): OpResult {
  return { ok: true, store: 'google', operation, ...fields };
}

/** Native Play track name for a neutral track, defaulting to the internal test track. */
export function googleTrack(track: ReleaseTrack | undefined): string {
  return GOOGLE_TRACKS[track ?? 'internal_testing'];
}

// --- metadata -----------------------------------------------------------------------

/**
 * Pushes the store listing for every locale in one Play edit.
 *
 * The listing is read first and the plan merged over it. That is not an optimisation: `gpc
 * listings push` reads a missing file in a language directory as an empty string and sends
 * it, so pushing only the fields a plan mentions would blank the app's description. Merging
 * makes the operation genuinely declarative — what the plan states is applied, what it does
 * not mention is preserved.
 *
 * Release notes are a separate resource on Google (they belong to a track's release, not to
 * the listing), so a plan that sets `whatsNew` produces one extra edit per locale. Those
 * are reported as their own transactions by {@link applyGoogleBatch}.
 */
export async function setGoogleMetadata(
  client: GoogleClient,
  context: AdapterContext,
  ref: AppRef,
  changes: MetadataChanges,
  commit: CommitFlags = {},
): Promise<OpResult> {
  const dryRun = context.dryRun === true;
  const warnings: string[] = [];
  const packageName = ref.id;

  for (const locale of changes.locales) {
    if (locale.subtitle !== undefined) {
      warnings.push(`${locale.locale}: Google Play has no subtitle; field ignored.`);
    }
    if (locale.keywords !== undefined) {
      warnings.push(
        `${locale.locale}: Google Play has no keyword field; discovery is driven by the listing text. Field ignored.`,
      );
    }
    if (locale.promotionalText !== undefined) {
      warnings.push(`${locale.locale}: Google Play has no promotional text; field ignored.`);
    }
    if (locale.marketingUrl !== undefined || locale.supportUrl !== undefined) {
      warnings.push(
        `${locale.locale}: Google Play takes the website and support contact from the app's contact details, not from the listing. Fields ignored.`,
      );
    }
    if (locale.privacyPolicyUrl !== undefined) {
      warnings.push(
        `${locale.locale}: the Google Play privacy policy URL is set under App content in Play Console, not through the API. Field ignored.`,
      );
    }
  }

  const current = listingListSchema.parse(
    unwrapList(await client.json(context, gpcCommands.listingsGet(packageName)), 'listings'),
  );
  const currentByLocale = new Map(current.map((listing) => [listing.language, listing]));

  const listingChanges = changes.locales.filter(
    (locale) =>
      locale.name !== undefined ||
      locale.shortDescription !== undefined ||
      locale.description !== undefined ||
      locale.videoUrl !== undefined,
  );

  let changed = false;
  const actions: string[] = [];

  if (listingChanges.length > 0) {
    const staged: StagedListing[] = listingChanges.map((locale) =>
      mergeListing(locale, currentByLocale.get(locale.locale) ?? {}),
    );
    await withListingTree(staged, async (directory) => {
      const args = gpcCommands.listingsPush(packageName, directory, commit);
      actions.push(`listings push (${staged.map((l) => l.language).join(', ')})`);
      if (!dryRun) {
        await client.run(context, args);
        changed = true;
      }
    });
  }

  const track = googleTrack('production');
  for (const locale of changes.locales) {
    if (locale.whatsNew === undefined) continue;
    actions.push(`release notes ${locale.locale}`);
    if (!dryRun) {
      await client.run(
        context,
        gpcCommands.releaseNotesSet(packageName, track, locale.locale, locale.whatsNew),
      );
      changed = true;
    }
  }

  return result('setMetadata', {
    changed,
    dryRun,
    ...(warnings.length === 0 ? {} : { warnings }),
    details: { actions, locales: changes.locales.map((locale) => locale.locale) },
  });
}

// --- images -------------------------------------------------------------------------

/**
 * Syncs listing images in one Play edit.
 *
 * `gpc listings images sync` compares the SHA-256 Play recorded for each published image
 * with the local file's, and uploads only what differs — the same digest Agentship's plan
 * carries, which is why a re-run of an unchanged plan performs no writes at all.
 */
export async function syncGoogleImages(
  client: GoogleClient,
  context: AdapterContext,
  ref: AppRef,
  plan: ScreenshotPlan,
  commit: CommitFlags = {},
): Promise<OpResult> {
  const dryRun = context.dryRun === true;

  return withImageTree(plan.sets, async (staged) => {
    if (plan.sets.length === staged.skipped.length) {
      return result('syncScreenshots', {
        changed: false,
        dryRun,
        ...(staged.skipped.length === 0 ? {} : { warnings: [...staged.skipped] }),
      });
    }
    const args = [
      ...gpcCommands.imagesSync(ref.id, staged.directory, {
        ...commit,
        ...optional('prune', plan.prune),
      }),
      ...(dryRun ? ['--dry-run'] : []),
    ];
    const raw = await client.json(context, args, { timeoutMs: 15 * 60_000 });
    const report = imageSyncResultSchema.parse(raw);
    return result('syncScreenshots', {
      changed: !dryRun && (report.uploaded ?? 0) + (report.deleted ?? 0) > 0,
      dryRun,
      ...(staged.skipped.length === 0 ? {} : { warnings: [...staged.skipped] }),
      details: {
        uploaded: report.uploaded ?? 0,
        skipped: report.skipped ?? 0,
        deleted: report.deleted ?? 0,
      },
    });
  });
}

// --- builds -------------------------------------------------------------------------

export async function uploadGoogleBuild(
  client: GoogleClient,
  context: AdapterContext,
  ref: AppRef,
  artifact: BuildArtifact,
  options: CommitFlags & { track?: ReleaseTrack; status?: string } = {},
): Promise<BuildRef> {
  if (artifact.kind !== 'aab' && artifact.kind !== 'apk') {
    throw new AgentshipError(
      ERROR_CODES.STORE_VALIDATION_FAILED,
      `Google Play accepts .aab and .apk artifacts, not ${artifact.kind}.`,
      { store: 'google', details: { kind: artifact.kind } },
    );
  }
  const dryRun = context.dryRun === true;
  const processingTimeout = artifact.processingTimeoutMs ?? DEFAULT_PROCESSING_TIMEOUT_MS;

  const args = gpcCommands.releasesUpload(ref.id, artifact.path, {
    // Translated, never forwarded: `options.track` is a neutral track and `gpc` takes the
    // native Play name. Spreading the caller's options wholesale here would send
    // `--track internal_testing`, which Play would create as a custom track.
    track: googleTrack(options.track),
    // A build is uploaded as a draft unless the caller says otherwise: uploading is not
    // publishing, and Play would otherwise roll it out to the track's testers immediately.
    status: options.status ?? 'draft',
    ...optional('mappingFile', artifact.mappingFile),
    ...optional('withoutReview', options.withoutReview),
    ...optional('errorIfInReview', options.errorIfInReview),
    // A dry run must not commit anything, but it should still get Play's own verdict:
    // `--validate-only` uploads, validates server-side, and discards the edit.
    ...(dryRun ? { validateOnly: true } : {}),
    timeoutMs: processingTimeout,
  });

  const report = releaseResultSchema.parse(
    await client.json(context, args, { timeoutMs: processingTimeout + 60_000 }),
  );
  const versionCode =
    report.versionCode === undefined ? artifact.buildNumber : String(report.versionCode);

  if (versionCode === undefined) {
    throw new AgentshipError(
      ERROR_CODES.TOOL_INVALID_OUTPUT,
      'gpc releases upload did not report the version code it uploaded.',
      { store: 'google', details: { packageName: ref.id } },
    );
  }

  return {
    store: 'google',
    id: versionCode,
    buildNumber: versionCode,
    ...optional('version', artifact.version),
    state: dryRun ? 'unknown' : 'valid',
  };
}

// --- tracks and testers ---------------------------------------------------------------

export async function distributeGoogleBuild(
  client: GoogleClient,
  context: AdapterContext,
  ref: AppRef,
  build: BuildRef,
  groups: readonly string[],
  track: ReleaseTrack | undefined,
  commit: CommitFlags = {},
  userFraction?: number,
): Promise<OpResult> {
  const dryRun = context.dryRun === true;
  const warnings: string[] = [];
  const target = googleTrack(track);
  // A fraction below 1 makes the release a staged rollout; Play models that as the
  // release's status rather than as a separate call.
  const percent = toPercent(userFraction);
  const staged = percent !== undefined && percent < 100;

  // Play distributes to whoever the *track* lists, not to a group chosen per release, so
  // naming groups here means "make sure these are on the track" plus "put the build there".
  if (groups.length > 0 && !dryRun) {
    await client.run(context, gpcCommands.testersAdd(ref.id, target, groups, commit));
  }

  if (!dryRun) {
    await client.run(
      context,
      gpcCommands.releasesAssign(ref.id, build.buildNumber, {
        track: target,
        status: staged ? 'inProgress' : 'completed',
        ...(staged ? { rolloutPercent: percent } : {}),
        ...commit,
      }),
    );
  }

  if (groups.some((group) => !group.includes('@'))) {
    warnings.push(
      'Google Play takes Google Group e-mail addresses as testers, not group names. Entries without an "@" were sent unchanged and may be rejected.',
    );
  }

  return result('distributeToTesters', {
    changed: !dryRun,
    dryRun,
    ...(warnings.length === 0 ? {} : { warnings }),
    details: {
      track: target,
      versionCode: build.buildNumber,
      groups,
      ...(staged ? { rolloutPercent: percent } : {}),
    },
  });
}

export async function manageGoogleTesterGroups(
  client: GoogleClient,
  context: AdapterContext,
  ref: AppRef,
  changes: TesterGroupChanges,
  commit: CommitFlags = {},
): Promise<OpResult> {
  const dryRun = context.dryRun === true;
  const warnings: string[] = [];
  const actions: string[] = [];
  let changed = false;

  for (const spec of changes.groups) {
    const track = googleTrack(spec.track);
    if (spec.track === 'production') {
      warnings.push('Google Play has no testers on the production track; group skipped.');
      continue;
    }
    if (spec.publicLink !== undefined) {
      warnings.push(
        `${spec.name}: Google Play opt-in links are configured in Play Console, not through the API; setting ignored.`,
      );
    }

    const current = testersSchema.safeParse(
      await client.json(context, gpcCommands.testersList(ref.id, track)),
    );
    const existing = new Set(current.success ? (current.data.googleGroups ?? []) : []);
    const wanted = spec.members ?? [];

    const toAdd = wanted.filter((email) => !existing.has(email));
    if (toAdd.length > 0) {
      actions.push(`add ${toAdd.length} group(s) to ${track}`);
      if (!dryRun) {
        await client.run(context, gpcCommands.testersAdd(ref.id, track, toAdd, commit));
        changed = true;
      }
    }

    if (spec.pruneMembers === true) {
      const toRemove = [...existing].filter((email) => !wanted.includes(email));
      if (toRemove.length > 0) {
        actions.push(`remove ${toRemove.length} group(s) from ${track}`);
        if (!dryRun) {
          await client.run(context, gpcCommands.testersRemove(ref.id, track, toRemove, commit));
          changed = true;
        }
      }
    }
  }

  if (changes.prune === true) {
    warnings.push(
      'Google Play tester groups are the Google Groups attached to a track; Agentship does not remove them wholesale. Use pruneMembers per track instead.',
    );
  }

  return result('manageTesterGroups', {
    changed,
    dryRun,
    ...(warnings.length === 0 ? {} : { warnings }),
    details: { actions },
  });
}

// --- pricing ---------------------------------------------------------------------------

/**
 * Google prices in-app products, not the app.
 *
 * The app's price, its free-or-paid status and the countries it sells in are console-only —
 * and free-to-paid is irreversible — so this returns the instructions rather than pretending
 * to have applied anything.
 */
export async function setGooglePricing(
  _client: GoogleClient,
  context: AdapterContext,
  _ref: AppRef,
  schedule: PricingSchedule,
): Promise<OpResult> {
  const pending = GOOGLE_PENDING_OPERATIONS.filter(
    (operation) => operation.id === 'google:pricing-and-countries',
  ).map((operation) => ({
    ...operation,
    fields: [
      {
        name: 'price',
        label: 'App price',
        required: true,
        proposedValue: schedule.free === true ? 'Free' : (schedule.amount ?? ''),
        rationale: 'Taken from the manifest.',
      },
      ...(schedule.availability?.territories === undefined
        ? []
        : [
            {
              name: 'countries',
              label: 'Countries / regions',
              required: true,
              proposedValue: schedule.availability.territories.join(', '),
            },
          ]),
    ],
  }));

  return result('setPricing', {
    changed: false,
    dryRun: context.dryRun === true,
    warnings: [
      'Google Play does not expose the app price or its country availability through the API; Agentship emitted the console steps instead.',
    ],
    pending,
  });
}

// --- review ------------------------------------------------------------------------------

/**
 * Submitting on Google is committing an edit.
 *
 * There is no submission resource: a Play edit that commits without
 * `--changes-not-sent-for-review` *is* the submission. The returned reference is therefore
 * synthetic — it identifies the track and version Agentship committed, which is the only
 * handle the platform leaves behind.
 */
export async function submitGoogleForReview(
  client: GoogleClient,
  context: AdapterContext,
  ref: AppRef,
  submission: SubmissionSpec,
): Promise<SubmissionRef> {
  const track = googleTrack(submission.track ?? 'production');
  const versionCode = submission.buildNumber;
  if (versionCode === undefined) {
    throw new AgentshipError(
      ERROR_CODES.PLAN_INPUT_REQUIRED,
      'Google Play submits a specific version code to a track; none was given.',
      {
        store: 'google',
        details: { packageName: ref.id, track },
        remediation: {
          summary: 'Upload a build first, or name the version code to promote.',
        },
      },
    );
  }

  if (context.dryRun === true) {
    return { store: 'google', id: `dry-run:${track}:${versionCode}`, synthetic: true };
  }

  await client.run(
    context,
    gpcCommands.releasesAssign(ref.id, versionCode, {
      track,
      // `draft` is how Play expresses "approved but held for manual release".
      status: submission.holdForDeveloperRelease === true ? 'draft' : 'completed',
      ...optional('withoutReview', submission.withoutReview),
    }),
  );

  return {
    store: 'google',
    id: `${track}:${versionCode}`,
    synthetic: true,
    submittedAt: new Date().toISOString(),
  };
}

/**
 * Best-effort review status.
 *
 * Google publishes no endpoint for it. What can be observed is the release's own status on
 * the track, which says whether the version is live but not whether a review is running —
 * so the answer is always `inferred`, and says why. The one direct signal Play gives is an
 * error on commit (`changes already in review`), and Agentship will not perform a write to
 * read a status.
 */
export async function getGoogleSubmissionStatus(
  client: GoogleClient,
  context: AdapterContext,
  ref: AppRef,
  submission: SubmissionRef,
): Promise<SubmissionStatus> {
  const [track, versionCode] = submission.id.replace(/^dry-run:/, '').split(':');
  const releases = releaseStatusListSchema.parse(
    unwrapList(await client.json(context, gpcCommands.releasesStatus(ref.id, track)), 'releases'),
  );
  const release = releases.find((candidate) =>
    versionCode === undefined
      ? true
      : (candidate.versionCodes ?? []).map(String).includes(versionCode),
  );

  if (release === undefined) {
    return {
      state: 'unknown',
      confidence: 'inferred',
      detail: `Google Play shows no release with version code ${versionCode ?? '(unknown)'} on the ${track ?? '(unknown)'} track. Google exposes no review-status API, so Agentship cannot tell whether it is still in review or was never committed.`,
    };
  }

  const state = toVersionState(release.status);
  return {
    state: state === 'live' ? 'completed' : state === 'draft' ? 'not_submitted' : 'in_review',
    // Deduced from the release status, because Google has no review-status endpoint.
    confidence: 'inferred',
    detail: `Release status on the ${release.track} track is "${release.status ?? 'unknown'}". Google Play exposes no review status; check Publishing overview in Play Console for the authoritative answer.`,
  };
}

// --- staged rollout -------------------------------------------------------------------

export async function setGooglePhasedRelease(
  client: GoogleClient,
  context: AdapterContext,
  ref: AppRef,
  action: PhasedReleaseAction,
  commit: CommitFlags = {},
): Promise<OpResult> {
  const dryRun = context.dryRun === true;
  const track = googleTrack(action.track ?? 'production');

  if (action.action === 'cancel') {
    // Play has no "cancel": a rollout is halted, which stops it reaching new users and
    // leaves the release recoverable. Saying so is better than mapping to a delete.
    return applyRollout(client, context, ref, 'halt', track, undefined, commit, dryRun, [
      'Google Play has no way to cancel a staged rollout; it was halted instead, which stops new users receiving the release.',
    ]);
  }

  if (action.action === 'start') {
    const percent = toPercent(action.userFraction);
    if (percent === undefined) {
      throw new AgentshipError(
        ERROR_CODES.PLAN_INPUT_REQUIRED,
        'Starting a staged rollout on Google Play requires the fraction of users to reach.',
        { store: 'google', details: { track } },
      );
    }
    return applyRollout(client, context, ref, 'increase', track, percent, commit, dryRun, []);
  }

  const gpcAction =
    action.action === 'pause' ? 'halt' : action.action === 'resume' ? 'resume' : 'complete';
  return applyRollout(
    client,
    context,
    ref,
    gpcAction,
    track,
    toPercent(action.userFraction),
    commit,
    dryRun,
    [],
  );
}

async function applyRollout(
  client: GoogleClient,
  context: AdapterContext,
  ref: AppRef,
  action: 'increase' | 'halt' | 'resume' | 'complete',
  track: string,
  percent: number | undefined,
  commit: CommitFlags,
  dryRun: boolean,
  warnings: string[],
): Promise<OpResult> {
  if (!dryRun) {
    await client.run(
      context,
      gpcCommands.rollout(ref.id, action, {
        track,
        ...optional('toPercent', percent),
        ...commit,
      }),
    );
  }
  return result('setPhasedRelease', {
    changed: !dryRun,
    dryRun,
    ...(warnings.length === 0 ? {} : { warnings }),
    details: { track, action, ...optional('percent', percent) },
  });
}

/** `gpc` takes a percentage (1–100) where the contract carries a fraction (0–1). */
function toPercent(userFraction: number | undefined): number | undefined {
  if (userFraction === undefined) return undefined;
  const percent = Math.round(userFraction * 100);
  return percent < 1 ? 1 : percent > 100 ? 100 : percent;
}
