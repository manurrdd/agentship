import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GOOGLE_CAPABILITIES, GoogleAdapter } from '../src/index.js';
import {
  fakeRunner,
  fixture,
  flagValue,
  type Route,
  testContext,
  versionRoute,
  withGoogleEnvironment,
} from './harness.js';

const APP = { store: 'google' as const, id: 'com.agentship.demo', platform: 'android' as const };

async function snapshotRoutes(): Promise<Route[]> {
  return [
    versionRoute(),
    { match: 'apps info', stdout: await fixture('app-info.json') },
    { match: 'releases status', stdout: await fixture('releases-status.json') },
    { match: 'listings get', stdout: await fixture('listings-get.json') },
    {
      match: 'images list --lang en-US --type phoneScreenshots',
      stdout: await fixture('images-phone.json'),
    },
    { match: 'images list', stdout: await fixture('images-empty.json') },
    { match: 'bundles list', stdout: await fixture('bundles-list.json') },
    { match: 'testers list --track internal', stdout: await fixture('testers-internal.json') },
    { match: 'testers list', stdout: await fixture('testers-empty.json') },
    { match: 'iap list', stdout: await fixture('iap-list.json') },
    { match: 'subscriptions list', stdout: await fixture('subscriptions-list.json') },
  ];
}

function adapter(routes: readonly Route[]): {
  adapter: GoogleAdapter;
  runner: ReturnType<typeof fakeRunner>;
} {
  const runner = fakeRunner(routes);
  return { adapter: new GoogleAdapter({ runner: runner.runner }), runner };
}

describe('capabilities', () => {
  it('routes everything Google has no API for away from `auto`', () => {
    expect(GOOGLE_CAPABILITIES.createApp).toBe('agent_browser');
    expect(GOOGLE_CAPABILITIES.firstRelease).toBe('agent_browser');
    expect(GOOGLE_CAPABILITIES.contentRating).toBe('agent_browser');
    expect(GOOGLE_CAPABILITIES.appPricing).toBe('agent_browser');
    expect(GOOGLE_CAPABILITIES.appContentDeclarations).toBe('agent_browser');
    expect(GOOGLE_CAPABILITIES.playAppSigning).toBe('agent_browser');
    expect(GOOGLE_CAPABILITIES.agreementsTaxBanking).toBe('human_only');
    expect(GOOGLE_CAPABILITIES.reviewStatus).toBe('unsupported');
  });

  it("admits that Google cannot enumerate a developer account's apps", () => {
    expect(GOOGLE_CAPABILITIES.listApps).toBe('unsupported');
  });

  it('never claims an Apple-only operation', () => {
    expect(GOOGLE_CAPABILITIES.privacyLabels).toBe('unsupported');
    expect(GOOGLE_CAPABILITIES.resolutionCenter).toBe('unsupported');
  });
});

describe('invocation safety', () => {
  it('passes the service account as a path, never as JSON', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google, runner } = adapter(await snapshotRoutes());
      await google.getAppState(testContext(), APP);

      expect(runner.calls.length).toBeGreaterThan(1);
      for (const call of runner.calls) {
        expect(call.args.join(' ')).not.toContain('PRIVATE KEY');
        expect(JSON.stringify(call.env)).not.toContain('PRIVATE KEY');
        expect(call.env['GPC_SERVICE_ACCOUNT']).toMatch(/service-account\.json$/);
      }
    });
  });

  it('redirects every gpc config, cache and data directory into Agentship state', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google, runner } = adapter(await snapshotRoutes());
      await google.getAppState(testContext({ cwd: '/some/user/repo' }), APP);

      const call = runner.calls[0];
      // Otherwise gpc would read ~/.config/gpc/config.json, whose auth entry wins over
      // GPC_SERVICE_ACCOUNT, and could fall through to a developer's personal gcloud ADC.
      expect(call?.env['XDG_CONFIG_HOME']).toMatch(/run\/gpc$/);
      expect(call?.env['XDG_CACHE_HOME']).toMatch(/run\/gpc$/);
      expect(call?.env['XDG_DATA_HOME']).toMatch(/run\/gpc$/);
      expect(call?.env['GOOGLE_APPLICATION_CREDENTIALS']).toBeUndefined();
      // `.gpcrc.json` is found by walking up from the working directory.
      expect(call?.cwd).not.toBe('/some/user/repo');
      expect(call?.cwd).toMatch(/run\/gpc$/);
    });
  });

  it('never invokes gpc auth, and never prompts', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google, runner } = adapter(await snapshotRoutes());
      await google.getAppState(testContext(), APP);
      for (const call of runner.calls) {
        expect(call.args).not.toContain('auth');
        if (call.args.length > 1) {
          expect(call.args).toContain('--no-interactive');
        }
      }
    });
  });
});

describe('version drift', () => {
  it('refuses to run when gpc is not the pinned version', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google } = adapter([versionRoute('1.2.3')]);
      await expect(google.getAppState(testContext(), APP)).rejects.toMatchObject({
        code: 'TOOL_VERSION_DRIFT',
      });
    });
  });
});

describe('checkAuth', () => {
  it('needs a package name, because Google has no account-level endpoint', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google } = adapter([versionRoute()]);
      const result = await google.checkAuth(testContext());
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('no account-level endpoint');
    });
  });

  it('verifies the service account against a real app', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google } = adapter([
        versionRoute(),
        { match: 'tracks list', stdout: '{"tracks":[],"meta":{"count":0}}' },
      ]);
      await expect(google.checkAuth(testContext(), APP)).resolves.toMatchObject({ ok: true });
    });
  });

  it('reports a permission failure with actionable remediation', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google } = adapter([
        versionRoute(),
        {
          match: 'tracks list',
          exitCode: 4,
          stderr:
            'Error [API_FORBIDDEN]: The caller does not have permission\nSuggestion: Invite the service account in Play Console.',
        },
      ]);
      const result = await google.checkAuth(testContext(), APP);
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('API_FORBIDDEN');
    });
  });
});

describe('listApps', () => {
  it('fails honestly instead of returning an empty list', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google } = adapter([versionRoute()]);
      await expect(google.listApps(testContext())).rejects.toMatchObject({
        code: 'STORE_UNSUPPORTED_OPERATION',
      });
    });
  });
});

describe('getAppState', () => {
  it('produces a normalised snapshot with Google-specific gaps declared', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google } = adapter(await snapshotRoutes());
      const state = await google.getAppState(testContext(), APP);

      expect(state.store).toBe('google');
      expect(state.app.bundleId).toBe('com.agentship.demo');
      expect(state.app.primaryLocale).toBe('en-US');

      // Play tracks map onto the neutral names, with the native name preserved.
      expect(state.tracks.map((track) => track.track)).toEqual([
        'production',
        'internal_testing',
        'closed_testing',
      ]);
      expect(state.tracks[0]).toMatchObject({
        state: 'phased_release',
        userFraction: 0.2,
        buildNumbers: ['1042'],
        rawTrack: 'production',
      });
      expect(state.tracks[1]?.state).toBe('live');
      expect(state.tracks[2]?.state).toBe('draft');

      expect(state.localizations[0]).toMatchObject({
        locale: 'en-US',
        name: 'Agentship Demo',
        shortDescription: 'Publish from your agent',
        videoUrl: 'https://youtu.be/abc123',
      });

      // Play reports SHA-256 for published images; it is normalised to lowercase so it can
      // be compared with a locally computed digest.
      expect(state.images[0]).toMatchObject({
        locale: 'en-US',
        device: 'phone',
        slot: 'screenshots',
      });
      expect(state.images[0]?.images[0]?.sha256).toBe(
        'a9f51566bd6705f7ea6ad54bb9deb449f795582d6529a0e22207b8981233ec58',
      );

      expect(state.builds.map((build) => build.buildNumber)).toEqual(['1044', '1043', '1042']);
      expect(state.testerGroups).toEqual([
        expect.objectContaining({
          track: 'internal_testing',
          kind: 'google_groups',
          members: ['qa@agentship.dev'],
        }),
      ]);
      expect(state.products.map((product) => product.productId)).toEqual([
        'com.agentship.demo.pro',
        'com.agentship.demo.pro.monthly',
      ]);
      expect(state.phasedRelease).toMatchObject({ track: 'production', state: 'active' });

      // Pricing is permanently unavailable on Google; it must never look like "free".
      expect(state.pricing).toBeUndefined();
      // The three areas Play has no read for at all. Data Safety is the subtle one: its
      // endpoint accepts an update and offers no GET, so a snapshot must never imply it
      // knows what is declared.
      expect(state.gaps).toEqual([
        expect.objectContaining({ area: 'pricing', kind: 'no_api' }),
        expect.objectContaining({ area: 'dataSafety', kind: 'no_api' }),
        expect.objectContaining({ area: 'ageRating', kind: 'no_api' }),
      ]);
      expect(state.pending.map((operation) => operation.id)).toContain('google:first-release');
    });
  });

  it('records a gap instead of failing when a section is forbidden', async () => {
    await withGoogleEnvironment(async () => {
      const routes = (await snapshotRoutes()).filter((route) => route.match !== 'bundles list');
      const { adapter: google } = adapter([
        ...routes,
        {
          match: 'bundles list',
          exitCode: 4,
          stderr: 'Error [API_FORBIDDEN]: The caller does not have permission',
        },
      ]);
      const state = await google.getAppState(testContext(), APP);
      expect(state.builds).toEqual([]);
      expect(state.gaps).toContainEqual(
        expect.objectContaining({ area: 'builds', kind: 'forbidden' }),
      );
      expect(state.tracks).toHaveLength(3);
    });
  });
});

describe('setMetadata', () => {
  it('merges the plan over the current listing so unmentioned fields survive', async () => {
    await withGoogleEnvironment(async () => {
      let staged: Record<string, Record<string, string>> = {};
      const { adapter: google, runner } = adapter([
        versionRoute(),
        { match: 'listings get', stdout: await fixture('listings-get.json') },
        {
          match: 'listings push',
          stdout: await fixture('listings-push-result.json'),
          inspect: async (invocation) => {
            staged = await readTree(flagValue(invocation.args.join(' '), '--dir') ?? '');
          },
        },
      ]);

      const result = await google.setMetadata(testContext(), APP, {
        locales: [{ locale: 'en-US', description: 'A brand new full description.' }],
      });

      expect(result.ok).toBe(true);
      // Only the description changed, but title and short description are written too:
      // gpc reads a missing file as an empty string and would blank them.
      expect(staged['en-US']).toEqual({
        'title.txt': 'Agentship Demo\n',
        'short_description.txt': 'Publish from your agent\n',
        'full_description.txt': 'A brand new full description.\n',
        'video.txt': 'https://youtu.be/abc123\n',
      });
      // Locales the plan does not mention are not pushed at all.
      expect(Object.keys(staged)).toEqual(['en-US']);
      expect(runner.commands().some((c) => c.includes('--error-if-in-review'))).toBe(true);
    });
  });

  it('warns about every Apple-only field instead of failing', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google } = adapter([
        versionRoute(),
        { match: 'listings get', stdout: await fixture('listings-get.json') },
        { match: 'listings push', stdout: await fixture('listings-push-result.json') },
      ]);
      const result = await google.setMetadata(testContext(), APP, {
        locales: [
          {
            locale: 'en-US',
            name: 'Agentship',
            subtitle: 'Apple only',
            keywords: 'a,b,c',
            promotionalText: 'Apple only',
            marketingUrl: 'https://agentship.dev',
            privacyPolicyUrl: 'https://agentship.dev/privacy',
          },
        ],
      });
      const warnings = result.warnings?.join(' ') ?? '';
      expect(warnings).toContain('subtitle');
      expect(warnings).toContain('keyword');
      expect(warnings).toContain('promotional text');
      expect(warnings).toContain('privacy policy');
    });
  });

  it('sets release notes through the track, not the listing', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google, runner } = adapter([
        versionRoute(),
        { match: 'listings get', stdout: await fixture('listings-get.json') },
        { match: 'releases notes set', stdout: '{"ok":true}' },
      ]);
      await google.setMetadata(testContext(), APP, {
        locales: [{ locale: 'en-US', whatsNew: 'Now with fewer bugs.' }],
      });
      const command = runner.commands().find((c) => c.includes('releases notes set')) ?? '';
      expect(command).toContain('--track production');
      expect(command).toContain('--lang en-US');
    });
  });

  it('performs no writes in a dry run', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google, runner } = adapter([
        versionRoute(),
        { match: 'listings get', stdout: await fixture('listings-get.json') },
      ]);
      const result = await google.setMetadata(testContext({ dryRun: true }), APP, {
        locales: [{ locale: 'en-US', description: 'New.' }],
      });
      expect(result.changed).toBe(false);
      expect(runner.commands().some((c) => c.includes('listings push'))).toBe(false);
    });
  });
});

describe('syncScreenshots', () => {
  it('stages one tree per locale, device and slot and syncs it in a single edit', async () => {
    await withGoogleEnvironment(async () => {
      let staged: string[] = [];
      const { adapter: google, runner } = adapter([
        versionRoute(),
        {
          match: 'images sync',
          stdout: await fixture('images-sync-result.json'),
          inspect: async (invocation) => {
            const dir = flagValue(invocation.args.join(' '), '--dir') ?? '';
            staged = await listTree(dir);
          },
        },
      ]);

      const result = await google.syncScreenshots(testContext(), APP, {
        prune: true,
        sets: [
          {
            locale: 'en-US',
            device: 'phone',
            assets: [
              { path: '/tmp/b.png', sha256: 'b'.repeat(64), order: 1 },
              { path: '/tmp/a.png', sha256: 'a'.repeat(64), order: 0 },
            ],
          },
          { locale: 'en-US', device: 'tablet_10', assets: [] },
          {
            locale: 'en-US',
            device: 'phone',
            slot: 'feature_graphic',
            assets: [{ path: '/tmp/feature.png', sha256: 'c'.repeat(64) }],
          },
          { locale: 'en-US', device: 'vision', assets: [] },
        ],
      });

      expect(staged).toContain('en-US/phoneScreenshots/000-a.png');
      expect(staged).toContain('en-US/phoneScreenshots/001-b.png');
      expect(staged).toContain('en-US/featureGraphic/000-feature.png');
      expect(staged).toContain('en-US/tenInchScreenshots');
      // Google has no vision-device screenshots, so the set is reported, not dropped.
      expect(result.warnings?.join(' ')).toContain('vision');

      const command = runner.commands().find((c) => c.includes('images sync')) ?? '';
      expect(command).toContain('--delete');
      expect(result.details).toMatchObject({ uploaded: 2, skipped: 3 });
      expect(result.changed).toBe(true);
    });
  });

  it('reports no change when everything already matched by digest', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google } = adapter([
        versionRoute(),
        { match: 'images sync', stdout: '{"uploaded":0,"skipped":4,"deleted":0,"total":4}' },
      ]);
      const result = await google.syncScreenshots(testContext(), APP, {
        sets: [
          {
            locale: 'en-US',
            device: 'phone',
            assets: [{ path: '/tmp/a.png', sha256: 'a'.repeat(64) }],
          },
        ],
      });
      expect(result.changed).toBe(false);
    });
  });
});

describe('uploadBuild', () => {
  it('uploads as a draft and validates server-side in a dry run', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google, runner } = adapter([
        versionRoute(),
        { match: 'releases upload', stdout: await fixture('upload-result.json') },
      ]);
      const build = await google.uploadBuild(testContext({ dryRun: true }), APP, {
        path: '/tmp/app.aab',
        kind: 'aab',
        version: '1.4.2',
      });
      const command = runner.commands().find((c) => c.includes('releases upload')) ?? '';
      // `--validate-only` uploads and asks Google to validate, then discards the edit.
      expect(command).toContain('--validate-only');
      // Uploading is not publishing: the release lands as a draft unless asked otherwise.
      expect(command).toContain('--status draft');
      expect(build.buildNumber).toBe('1045');
    });
  });

  it('translates the neutral track into the native Play name', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google, runner } = adapter([
        versionRoute(),
        { match: 'releases upload', stdout: await fixture('upload-result.json') },
      ]);
      const batch = await google.applyBatch(testContext(), APP, [
        { op: 'upload_build', artifact: { path: '/tmp/app.aab', kind: 'aab' } },
      ]);
      expect(batch.ok).toBe(true);
      const command = runner.commands().find((c) => c.includes('releases upload')) ?? '';
      // Never the neutral name: Play would create `internal_testing` as a custom track.
      expect(command).toContain('--track internal');
      expect(command).not.toContain('internal_testing');
    });
  });

  it('rejects an artifact Google cannot accept', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google } = adapter([versionRoute()]);
      await expect(
        google.uploadBuild(testContext(), APP, { path: '/tmp/app.ipa', kind: 'ipa' }),
      ).rejects.toMatchObject({ code: 'STORE_VALIDATION_FAILED' });
    });
  });

  it('surfaces a version code conflict with remediation', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google } = adapter([
        versionRoute(),
        {
          match: 'releases upload',
          exitCode: 4,
          stderr:
            'Error [API_VERSION_CODE_TOO_LOW]: Version code 1042 has already been used\nSuggestion: Increase versionCode.',
        },
      ]);
      await expect(
        google.uploadBuild(testContext(), APP, { path: '/tmp/app.aab', kind: 'aab' }),
      ).rejects.toMatchObject({
        code: 'STORE_VALIDATION_FAILED',
        remediation: { summary: expect.stringContaining('version code higher') },
      });
    });
  });
});

describe('setPricing', () => {
  it('emits console instructions instead of pretending to have applied a price', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google, runner } = adapter([versionRoute()]);
      const result = await google.setPricing(testContext(), APP, {
        amount: '4.99',
        availability: { territories: ['US', 'DE'] },
      });
      expect(result.changed).toBe(false);
      expect(result.pending?.[0]?.id).toBe('google:pricing-and-countries');
      expect(result.pending?.[0]?.fields?.[0]?.proposedValue).toBe('4.99');
      // Nothing was sent to Google at all.
      expect(runner.calls).toHaveLength(0);
    });
  });
});

describe('submitForReview and status', () => {
  it('commits the release and returns a synthetic reference', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google, runner } = adapter([
        versionRoute(),
        { match: 'releases assign', stdout: await fixture('assign-result.json') },
      ]);
      const submission = await google.submitForReview(testContext(), APP, {
        buildNumber: '1045',
        track: 'production',
      });
      // Google has no submission resource: committing the edit is the submission.
      expect(submission).toMatchObject({ store: 'google', synthetic: true, id: 'production:1045' });
      const command = runner.commands().find((c) => c.includes('releases assign')) ?? '';
      expect(command).toContain('--status completed');
      expect(command).not.toContain('--changes-not-sent-for-review');
    });
  });

  it('holds the release as a draft when asked not to publish on approval', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google, runner } = adapter([
        versionRoute(),
        { match: 'releases assign', stdout: await fixture('assign-result.json') },
      ]);
      await google.submitForReview(testContext(), APP, {
        buildNumber: '1045',
        holdForDeveloperRelease: true,
      });
      expect(runner.commands().find((c) => c.includes('releases assign'))).toContain(
        '--status draft',
      );
    });
  });

  it('requires a version code', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google } = adapter([versionRoute()]);
      await expect(google.submitForReview(testContext(), APP, {})).rejects.toMatchObject({
        code: 'PLAN_INPUT_REQUIRED',
      });
    });
  });

  it('reports review status as inferred, and says why', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google } = adapter([
        versionRoute(),
        { match: 'releases status', stdout: await fixture('releases-status.json') },
      ]);
      const status = await google.getSubmissionStatus(testContext(), APP, {
        store: 'google',
        id: 'production:1042',
        synthetic: true,
      });
      expect(status.confidence).toBe('inferred');
      expect(status.detail).toContain('exposes no review status');
    });
  });
});

describe('setPhasedRelease', () => {
  it('converts the neutral fraction into the percentage gpc takes', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google, runner } = adapter([
        versionRoute(),
        { match: 'rollout increase', stdout: '{"track":"production","userFraction":0.25}' },
      ]);
      await google.setPhasedRelease(testContext(), APP, {
        action: 'start',
        userFraction: 0.25,
        track: 'production',
      });
      expect(runner.commands().find((c) => c.includes('rollout increase'))).toContain('--to 25');
    });
  });

  it('halts rather than pretending Google can cancel a rollout', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google, runner } = adapter([
        versionRoute(),
        { match: 'rollout halt', stdout: '{"track":"production","status":"halted"}' },
      ]);
      const result = await google.setPhasedRelease(testContext(), APP, { action: 'cancel' });
      expect(runner.commands().some((c) => c.includes('rollout halt'))).toBe(true);
      expect(result.warnings?.join(' ')).toContain('no way to cancel');
    });
  });

  it('refuses to start a rollout without a fraction', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google } = adapter([versionRoute()]);
      await expect(
        google.setPhasedRelease(testContext(), APP, { action: 'start' }),
      ).rejects.toMatchObject({ code: 'PLAN_INPUT_REQUIRED' });
    });
  });
});

describe('applyBatch', () => {
  it('reports which ops Google committed atomically and which it could not', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google } = adapter([
        versionRoute(),
        { match: 'listings get', stdout: await fixture('listings-get.json') },
        { match: 'listings push', stdout: await fixture('listings-push-result.json') },
        { match: 'releases notes set', stdout: '{"ok":true}' },
        { match: 'images sync', stdout: await fixture('images-sync-result.json') },
        { match: 'releases upload', stdout: await fixture('upload-result.json') },
      ]);

      const batch = await google.applyBatch(testContext(), APP, [
        // One `listings push` covers every locale: a single Play edit.
        {
          op: 'set_metadata',
          changes: {
            locales: [
              { locale: 'en-US', description: 'New.' },
              { locale: 'es-ES', description: 'Nuevo.' },
            ],
          },
        },
        // A whatsNew change adds one edit per locale, so this op is no longer atomic.
        {
          op: 'set_metadata',
          changes: { locales: [{ locale: 'en-US', description: 'X', whatsNew: 'Y' }] },
        },
        {
          op: 'sync_screenshots',
          plan: { sets: [{ locale: 'en-US', device: 'phone', assets: [] }] },
        },
        { op: 'upload_build', artifact: { path: '/tmp/app.aab', kind: 'aab' } },
      ]);

      expect(batch.ok).toBe(true);
      expect(batch.transactions.map((tx) => tx.atomic)).toEqual([true, false, true, true]);
      expect(batch.transactions.every((tx) => tx.committed)).toBe(true);
      expect(batch.builds?.[0]?.buildNumber).toBe('1045');
    });
  });

  it('discards the failed edit, stops, and marks the untried ops', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google } = adapter([
        versionRoute(),
        { match: 'listings get', stdout: await fixture('listings-get.json') },
        {
          match: 'listings push',
          exitCode: 4,
          stderr:
            'Error [API_CHANGES_ALREADY_IN_REVIEW]: Changes are already in review. Committing this edit would cancel the existing review.\nSuggestion: Wait for the current review to complete.',
        },
      ]);

      const batch = await google.applyBatch(testContext(), APP, [
        { op: 'set_metadata', changes: { locales: [{ locale: 'en-US', description: 'New.' }] } },
        { op: 'upload_build', artifact: { path: '/tmp/app.aab', kind: 'aab' } },
      ]);

      expect(batch.ok).toBe(false);
      expect(batch.failedAt).toBe(0);
      expect(batch.results[0]?.errorCode).toBe('STORE_CONFLICT');
      expect(batch.results[1]?.skipped).toBe(true);
      // gpc discards the edit on any failure, so nothing is left half-applied or open.
      expect(batch.transactions.every((tx) => tx.committed === false)).toBe(true);
    });
  });

  it('commits without review when the batch is held', async () => {
    await withGoogleEnvironment(async () => {
      const { adapter: google, runner } = adapter([
        versionRoute(),
        { match: 'listings get', stdout: await fixture('listings-get.json') },
        { match: 'listings push', stdout: await fixture('listings-push-result.json') },
      ]);
      await google.applyBatch(
        testContext(),
        APP,
        [{ op: 'set_metadata', changes: { locales: [{ locale: 'en-US', description: 'New.' }] } }],
        { holdForReview: true },
      );
      expect(runner.commands().find((c) => c.includes('listings push'))).toContain(
        '--changes-not-sent-for-review',
      );
    });
  });

  it('serialises calls for the same package so two edits are never open at once', async () => {
    await withGoogleEnvironment(async () => {
      const order: string[] = [];
      const runner = fakeRunner([
        versionRoute(),
        {
          match: 'listings get',
          stdout: await fixture('listings-get.json'),
          inspect: async () => {
            order.push('get:start');
            await new Promise((resolve) => setTimeout(resolve, 10));
            order.push('get:end');
          },
        },
        {
          match: 'tracks list',
          stdout: '{"tracks":[],"meta":{"count":0}}',
          inspect: () => {
            order.push('tracks');
          },
        },
        { match: 'listings push', stdout: await fixture('listings-push-result.json') },
      ]);
      const google = new GoogleAdapter({ runner: runner.runner });

      await Promise.all([
        google.setMetadata(testContext(), APP, {
          locales: [{ locale: 'en-US', description: 'New.' }],
        }),
        google.checkAuth(testContext(), APP),
      ]);

      // Which call wins the lane is a race; what must never happen is interleaving, since
      // that would mean two open Play edits for the same app.
      expect(order).toHaveLength(3);
      expect(order.indexOf('get:end') - order.indexOf('get:start')).toBe(1);
    });
  });
});

/** Reads a staged directory as `{ language: { fileName: contents } }`. */
async function readTree(root: string): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {};
  for (const language of await readdir(root)) {
    const files: Record<string, string> = {};
    for (const name of await readdir(join(root, language))) {
      files[name] = await readFile(join(root, language, name), 'utf8');
    }
    out[language] = files;
  }
  return out;
}

/** Lists a staged tree as relative paths, two levels deep. */
async function listTree(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const language of await readdir(root)) {
    const types = await readdir(join(root, language));
    if (types.length === 0) out.push(language);
    for (const type of types) {
      const files = await readdir(join(root, language, type)).catch(() => []);
      if (files.length === 0) out.push(`${language}/${type}`);
      for (const file of files) out.push(`${language}/${type}/${file}`);
    }
  }
  return out;
}
