import { describe, expect, it } from 'vitest';
import { APPLE_CAPABILITIES, AppleAdapter } from '../src/index.js';
import {
  fakeRunner,
  fixture,
  type Route,
  TEST_ISSUER_ID,
  TEST_KEY_ID,
  testContext,
  versionRoute,
  withAppleEnvironment,
} from './harness.js';

const APP = { store: 'apple' as const, id: '1234567890', platform: 'ios' as const };

/** Answers for every read `getAppState` performs, so tests only declare what they change. */
async function snapshotRoutes(): Promise<Route[]> {
  return [
    versionRoute(),
    { match: 'apps view --id', stdout: await fixture('app-view.json') },
    { match: 'versions list', stdout: await fixture('versions-list.json') },
    {
      match: 'localizations list --app',
      stdout: await fixture('localizations-appinfo.json'),
    },
    {
      match: 'localizations list --version',
      stdout: await fixture('localizations-version.json'),
    },
    { match: 'screenshots list', stdout: await fixture('screenshot-sets.json') },
    { match: 'builds list', stdout: await fixture('builds-list.json') },
    { match: 'testflight groups list', stdout: await fixture('testflight-groups.json') },
    { match: 'pricing current', stdout: await fixture('pricing-current.json') },
    { match: 'pricing availability view', stdout: await fixture('pricing-availability.json') },
    { match: 'iap list', stdout: await fixture('iap-list.json') },
    { match: 'subscriptions list', stdout: await fixture('subscriptions-list.json') },
    { match: 'phased-release view', stdout: await fixture('phased-release.json') },
    { match: 'age-rating view', stdout: await fixture('age-rating.json') },
  ];
}

function adapter(routes: readonly Route[]): {
  adapter: AppleAdapter;
  runner: ReturnType<typeof fakeRunner>;
} {
  const runner = fakeRunner(routes);
  return { adapter: new AppleAdapter({ runner: runner.runner }), runner };
}

describe('capabilities', () => {
  it('classifies every operation the contract names', () => {
    // A missing entry would let the kernel plan an operation nobody classified.
    expect(Object.keys(APPLE_CAPABILITIES).length).toBeGreaterThan(0);
    for (const [operation, action] of Object.entries(APPLE_CAPABILITIES)) {
      expect(action, operation).toMatch(
        /^(auto|needs_approval|needs_input|agent_browser|human_only|unsupported)$/,
      );
    }
  });

  it('routes the operations Apple has no public API for away from `auto`', () => {
    expect(APPLE_CAPABILITIES.createApp).toBe('agent_browser');
    expect(APPLE_CAPABILITIES.privacyLabels).toBe('agent_browser');
    expect(APPLE_CAPABILITIES.resolutionCenter).toBe('agent_browser');
    expect(APPLE_CAPABILITIES.agreementsTaxBanking).toBe('human_only');
  });

  it('never claims a Google-only operation', () => {
    expect(APPLE_CAPABILITIES.firstRelease).toBe('unsupported');
    expect(APPLE_CAPABILITIES.dataSafety).toBe('unsupported');
    expect(APPLE_CAPABILITIES.playAppSigning).toBe('unsupported');
  });
});

describe('invocation safety', () => {
  it('never puts the private key in the arguments and never in the environment', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple, runner } = adapter(await snapshotRoutes());
      await apple.getAppState(testContext(), APP);

      expect(runner.calls.length).toBeGreaterThan(1);
      for (const call of runner.calls) {
        const argv = call.args.join(' ');
        expect(argv).not.toContain('BEGIN PRIVATE KEY');
        expect(argv).not.toContain(TEST_ISSUER_ID);
        expect(JSON.stringify(call.env)).not.toContain('BEGIN PRIVATE KEY');
        // The key reaches asc as a path, and only as a path.
        expect(call.env['ASC_PRIVATE_KEY_PATH']).toMatch(/AuthKey_.*\.p8$/);
        expect(call.env['ASC_KEY_ID']).toBe(TEST_KEY_ID);
        expect(call.env['ASC_ISSUER_ID']).toBe(TEST_ISSUER_ID);
      }
    });
  });

  it('cuts asc off from the keychain, from any config file and from the project directory', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple, runner } = adapter(await snapshotRoutes());
      await apple.getAppState(testContext({ cwd: '/some/user/repo' }), APP);

      const call = runner.calls[0];
      expect(call?.env['ASC_BYPASS_KEYCHAIN']).toBe('1');
      expect(call?.env['ASC_CONFIG_PATH']).toMatch(/no-asc-config\.json$/);
      // A repo-local ./.asc/config.json must never be found: asc runs outside the repo.
      expect(call?.cwd).not.toBe('/some/user/repo');
      expect(call?.cwd).toMatch(/run\/asc$/);
    });
  });

  it('disables telemetry on every call', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple, runner } = adapter(await snapshotRoutes());
      await apple.getAppState(testContext(), APP);
      for (const call of runner.calls) {
        expect(call.env['DO_NOT_TRACK']).toBe('1');
        expect(call.env['ASC_TELEMETRY_DISABLED']).toBe('1');
      }
    });
  });

  it('never invokes a web-session subcommand', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple, runner } = adapter(await snapshotRoutes());
      await apple.getAppState(testContext(), APP);
      for (const command of runner.commands()) {
        expect(command.startsWith('web ')).toBe(false);
        expect(command.startsWith('auth ')).toBe(false);
      }
    });
  });
});

describe('version drift', () => {
  it('refuses to run when asc is not the pinned version', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple } = adapter([versionRoute('4.0.0')]);
      await expect(apple.checkAuth(testContext())).rejects.toMatchObject({
        code: 'TOOL_VERSION_DRIFT',
      });
    });
  });

  it('runs when the version matches the lockfile', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple } = adapter([
        versionRoute(),
        { match: 'apps list', stdout: await fixture('apps-list.json') },
      ]);
      await expect(apple.checkAuth(testContext())).resolves.toMatchObject({ ok: true });
    });
  });
});

describe('checkAuth', () => {
  it('reports failure with the store message instead of throwing', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple } = adapter([
        versionRoute(),
        {
          match: 'apps list',
          exitCode: 3,
          stderr:
            'Error: apps: failed to fetch: Authentication credentials are missing or invalid.: Provide a properly configured and signed bearer token.',
        },
      ]);
      const result = await apple.checkAuth(testContext());
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('Authentication credentials are missing or invalid');
    });
  });
});

describe('listApps', () => {
  it('normalises the App Store Connect documents', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple } = adapter([
        versionRoute(),
        { match: 'apps list', stdout: await fixture('apps-list.json') },
      ]);
      const apps = await apple.listApps(testContext());
      expect(apps).toHaveLength(2);
      expect(apps[0]).toMatchObject({
        name: 'Agentship Demo',
        bundleId: 'com.agentship.demo',
        sku: 'AGENTSHIPDEMO',
        primaryLocale: 'en-US',
      });
      expect(apps[0]?.ref.id).toBe('1234567890');
    });
  });
});

describe('getAppState', () => {
  it('produces a complete normalised snapshot', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple } = adapter(await snapshotRoutes());
      const state = await apple.getAppState(testContext(), APP);

      expect(state.store).toBe('apple');
      expect(state.app.bundleId).toBe('com.agentship.demo');
      expect(state.gaps).toEqual([]);

      // Apple's states are collapsed onto the neutral enum, raw value preserved.
      expect(state.versions.map((version) => version.state)).toEqual(['draft', 'live']);
      expect(state.versions[0]?.rawState).toBe('PREPARE_FOR_SUBMISSION');
      expect(state.versions[0]?.releaseStrategy).toBe('automatic');
      expect(state.versions[1]?.buildId).toBe('build-1041');

      // App-info and version localizations are merged per locale.
      const english = state.localizations.find((l) => l.locale === 'en-US');
      expect(english).toMatchObject({
        name: 'Agentship Demo',
        subtitle: 'Publish from your agent',
        description: 'The old description.',
        keywords: 'ship,publish,store',
        versionId: 'ver-draft-1',
      });

      expect(state.images[0]).toMatchObject({
        locale: 'en-US',
        device: 'phone',
        slot: 'screenshots',
      });
      expect(state.images[0]?.images[0]?.md5).toBe('9f1c2a4b8d3e5f60718293a4b5c6d7e8');

      expect(state.builds.map((build) => build.state)).toEqual(['valid', 'expired']);

      // Internal, external and public TestFlight groups map onto the three neutral tracks.
      expect(state.testerGroups.map((group) => group.track)).toEqual([
        'internal_testing',
        'closed_testing',
        'open_testing',
      ]);

      expect(state.products.map((product) => product.kind)).toEqual([
        'non_consumable',
        'auto_renewable_subscription',
      ]);
      expect(state.phasedRelease).toMatchObject({ state: 'active', dayNumber: 3 });
      expect(state.tracks).toEqual([
        expect.objectContaining({ track: 'production', state: 'live' }),
      ]);
      expect(state.pending.map((operation) => operation.id)).toContain('apple:create-app-record');
    });
  });

  it('records a gap instead of failing when a section is forbidden', async () => {
    await withAppleEnvironment(async () => {
      const routes = (await snapshotRoutes()).filter((route) => route.match !== 'pricing current');
      const { adapter: apple } = adapter([
        ...routes,
        {
          match: 'pricing current',
          exitCode: 3,
          stderr: 'Error: pricing: FORBIDDEN: This request requires the Admin role.',
        },
      ]);
      const state = await apple.getAppState(testContext(), APP);
      expect(state.pricing).toBeUndefined();
      expect(state.gaps).toEqual([expect.objectContaining({ area: 'pricing', kind: 'forbidden' })]);
      // The rest of the snapshot is intact.
      expect(state.versions).toHaveLength(2);
    });
  });

  it('fails when the app itself does not exist', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple } = adapter([
        versionRoute(),
        {
          match: 'apps view',
          exitCode: 3,
          stderr: 'Error: apps: failed to fetch: 404 The specified resource does not exist.',
        },
      ]);
      await expect(apple.getAppState(testContext(), APP)).rejects.toMatchObject({
        code: 'STORE_NOT_FOUND',
      });
    });
  });
});

describe('setMetadata', () => {
  it('creates missing locales, updates existing ones, and warns about Google-only fields', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple, runner } = adapter([
        versionRoute(),
        { match: 'versions list', stdout: await fixture('versions-list.json') },
        {
          match: 'localizations list --version',
          stdout: await fixture('localizations-version.json'),
        },
        { match: 'localizations update', stdout: '{"data":{"type":"x","id":"1"}}' },
        { match: 'localizations create', stdout: '{"data":{"type":"x","id":"2"}}' },
        { match: 'versions update', stdout: '{"data":{"type":"x","id":"3"}}' },
      ]);

      const result = await apple.setMetadata(testContext(), APP, {
        locales: [
          { locale: 'en-US', description: 'New description.', name: 'Agentship' },
          { locale: 'fr-FR', description: 'Nouvelle description.', shortDescription: 'Court' },
        ],
        copyright: '2026 Agentship',
      });

      expect(result.ok).toBe(true);
      expect(result.changed).toBe(true);
      const commands = runner.commands();
      // en-US exists → update; fr-FR does not → create.
      expect(commands.some((c) => c.startsWith('localizations update --version'))).toBe(true);
      expect(commands.some((c) => c.startsWith('localizations create --version'))).toBe(true);
      // The app name lives on the app-info localization, not the version one.
      expect(commands.some((c) => c.includes('--type app-info'))).toBe(true);
      expect(result.warnings?.join(' ')).toContain('short description');
    });
  });

  it('performs no writes in a dry run', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple, runner } = adapter([
        versionRoute(),
        { match: 'versions list', stdout: await fixture('versions-list.json') },
        {
          match: 'localizations list --version',
          stdout: await fixture('localizations-version.json'),
        },
      ]);
      const result = await apple.setMetadata(testContext({ dryRun: true }), APP, {
        locales: [{ locale: 'en-US', description: 'New.' }],
      });
      expect(result.dryRun).toBe(true);
      expect(result.changed).toBe(false);
      expect(runner.commands().some((c) => c.startsWith('localizations update'))).toBe(false);
    });
  });

  it('refuses when no editable version exists', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple } = adapter([
        versionRoute(),
        {
          match: 'versions list',
          stdout: JSON.stringify({
            data: [
              {
                type: 'appStoreVersions',
                id: 'ver-live',
                attributes: { versionString: '1.3.2', appStoreState: 'READY_FOR_SALE' },
              },
            ],
          }),
        },
      ]);
      await expect(
        apple.setMetadata(testContext(), APP, { locales: [{ locale: 'en-US', description: 'x' }] }),
      ).rejects.toMatchObject({ code: 'PLAN_CONFLICT' });
    });
  });
});

describe('syncScreenshots', () => {
  it('uploads per locale and device, skipping what the App Store cannot express', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple, runner } = adapter([
        versionRoute(),
        { match: 'versions list', stdout: await fixture('versions-list.json') },
        {
          match: 'localizations list --version',
          stdout: await fixture('localizations-version.json'),
        },
        { match: 'screenshots upload', stdout: '{"uploaded":1,"skipped":0}' },
      ]);

      const result = await apple.syncScreenshots(testContext(), APP, {
        sets: [
          {
            locale: 'en-US',
            device: 'phone',
            assets: [{ path: '/tmp/a.png', sha256: 'a'.repeat(64), order: 0 }],
          },
          { locale: 'en-US', device: 'tablet_7', assets: [] },
          { locale: 'en-US', device: 'phone', slot: 'app_icon', assets: [] },
          { locale: 'de-DE', device: 'phone', assets: [] },
        ],
      });

      const upload = runner.commands().find((c) => c.startsWith('screenshots upload'));
      expect(upload).toContain('--device-type IPHONE_65');
      // `--skip-existing` is what makes a re-run a no-op.
      expect(upload).toContain('--skip-existing');
      expect(upload).toContain('--version-localization loc-en');

      const warnings = result.warnings?.join(' ') ?? '';
      expect(warnings).toContain('tablet_7');
      expect(warnings).toContain('app icon');
      // de-DE has no localization on this version, so it is reported rather than guessed.
      expect(warnings).toContain('de-DE');
    });
  });
});

describe('uploadBuild', () => {
  it('waits for processing and confirms the result against the API', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple, runner } = adapter([
        versionRoute(),
        { match: 'builds upload', stdout: '{"buildNumber":"1042","status":"VALID"}' },
        { match: 'builds info', stdout: await fixture('build-info.json') },
      ]);
      const build = await apple.uploadBuild(testContext(), APP, {
        path: '/tmp/app.ipa',
        kind: 'ipa',
        version: '1.4.0',
      });
      expect(build).toMatchObject({
        store: 'apple',
        id: 'build-1042',
        buildNumber: '1042',
        state: 'valid',
      });
      expect(runner.commands().find((c) => c.startsWith('builds upload'))).toContain('--wait');
    });
  });

  it('rejects an artifact the App Store cannot accept', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple } = adapter([versionRoute()]);
      await expect(
        apple.uploadBuild(testContext(), APP, { path: '/tmp/app.aab', kind: 'aab' }),
      ).rejects.toMatchObject({ code: 'STORE_VALIDATION_FAILED' });
    });
  });
});

describe('distributeToTesters', () => {
  it('resolves group names to ids and submits external groups for beta review', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple, runner } = adapter([
        versionRoute(),
        { match: 'testflight groups list', stdout: await fixture('testflight-groups.json') },
        { match: 'builds add-groups', stdout: '{"data":[]}' },
      ]);
      const result = await apple.distributeToTesters(
        testContext(),
        APP,
        { store: 'apple', id: 'build-1042', buildNumber: '1042', state: 'valid' },
        ['Beta Testers'],
        'closed_testing',
      );
      const command = runner.commands().find((c) => c.startsWith('builds add-groups')) ?? '';
      expect(command).toContain('--group group-external');
      expect(command).toContain('--submit --confirm');
      expect(result.details).toMatchObject({ submittedForBetaReview: true });
    });
  });

  it('does not submit for beta review on the internal track', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple, runner } = adapter([
        versionRoute(),
        { match: 'testflight groups list', stdout: await fixture('testflight-groups.json') },
        { match: 'builds add-groups', stdout: '{"data":[]}' },
      ]);
      await apple.distributeToTesters(
        testContext(),
        APP,
        { store: 'apple', id: 'build-1042', buildNumber: '1042', state: 'valid' },
        ['Team'],
        'internal_testing',
      );
      expect(runner.commands().find((c) => c.startsWith('builds add-groups'))).not.toContain(
        '--submit',
      );
    });
  });

  it('fails when none of the requested groups exist', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple } = adapter([
        versionRoute(),
        { match: 'testflight groups list', stdout: await fixture('testflight-groups.json') },
      ]);
      await expect(
        apple.distributeToTesters(
          testContext(),
          APP,
          { store: 'apple', id: 'build-1042', buildNumber: '1042', state: 'valid' },
          ['Nobody'],
        ),
      ).rejects.toMatchObject({ code: 'STORE_NOT_FOUND' });
    });
  });
});

describe('manageTesterGroups', () => {
  it('creates missing groups, adds members and prunes the rest', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple, runner } = adapter([
        versionRoute(),
        { match: 'testflight groups list', stdout: await fixture('testflight-groups.json') },
        {
          match: 'testflight groups create',
          stdout: '{"data":{"type":"betaGroups","id":"group-new","attributes":{"name":"QA"}}}',
        },
        { match: 'testflight groups add-testers', stdout: '{"data":[]}' },
        { match: 'testflight testers list', stdout: await fixture('testers-list.json') },
        { match: 'testflight groups remove-testers', stdout: '{"data":[]}' },
      ]);

      const result = await apple.manageTesterGroups(testContext(), APP, {
        groups: [
          {
            name: 'Beta Testers',
            track: 'closed_testing',
            members: ['ada@example.com'],
            pruneMembers: true,
          },
          { name: 'QA', track: 'internal_testing', members: ['qa@example.com'] },
        ],
        prune: true,
      });

      const commands = runner.commands();
      expect(commands.some((c) => c.includes('groups create --app 1234567890 --name QA'))).toBe(
        true,
      );
      // The stale tester is removed by id, resolved from the tester list.
      expect(
        commands.some((c) =>
          c.includes('remove-testers --group group-external --tester tester-stale'),
        ),
      ).toBe(true);
      // Groups that exist but are not in the manifest are reported, never deleted.
      expect(result.warnings?.join(' ')).toContain('Public Beta');
    });
  });
});

describe('submitForReview and status', () => {
  it('attaches the build, creates the submission, adds the version and submits', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple, runner } = adapter([
        versionRoute(),
        { match: 'versions list', stdout: await fixture('versions-list.json') },
        { match: 'builds info', stdout: await fixture('build-info.json') },
        { match: 'versions attach-build', stdout: '{"data":{"type":"x","id":"1"}}' },
        {
          match: 'review submissions-create',
          stdout: await fixture('review-submission-created.json'),
        },
        { match: 'review items-add', stdout: '{"data":{"type":"x","id":"1"}}' },
        { match: 'review submissions-submit', stdout: '{"data":{"type":"x","id":"1"}}' },
      ]);

      const submission = await apple.submitForReview(testContext(), APP, { buildNumber: '1042' });
      expect(submission).toMatchObject({ store: 'apple', id: 'submission-1', synthetic: false });

      const commands = runner.commands();
      expect(
        commands.some((c) =>
          c.includes('versions attach-build --version-id ver-draft-1 --build-id build-1042'),
        ),
      ).toBe(true);
      expect(
        commands.some((c) =>
          c.includes('items-add --submission submission-1 --item-type appStoreVersions'),
        ),
      ).toBe(true);
      expect(
        commands.some((c) => c.includes('submissions-submit --id submission-1 --confirm')),
      ).toBe(true);
    });
  });

  it('reads the submission state directly, so its confidence is certain', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple } = adapter([
        versionRoute(),
        { match: 'review submissions-get', stdout: await fixture('review-submission.json') },
      ]);
      const status = await apple.getSubmissionStatus(testContext(), APP, {
        store: 'apple',
        id: 'submission-1',
        synthetic: false,
      });
      expect(status).toMatchObject({ state: 'waiting_review', confidence: 'certain' });
    });
  });

  it('refuses to treat a TestFlight track as an App Store submission', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple } = adapter([versionRoute()]);
      await expect(
        apple.submitForReview(testContext(), APP, { track: 'internal_testing' }),
      ).rejects.toMatchObject({ code: 'STORE_UNSUPPORTED_OPERATION' });
    });
  });
});

describe('setPhasedRelease', () => {
  it('warns that Apple ignores a requested user fraction', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple, runner } = adapter([
        ...(await snapshotRoutes()),
        { match: 'phased-release update', stdout: '{"data":{"type":"x","id":"phased-1"}}' },
      ]);
      const result = await apple.setPhasedRelease(testContext(), APP, {
        action: 'pause',
        userFraction: 0.5,
      });
      expect(result.warnings?.join(' ')).toContain('seven-day');
      expect(runner.commands().some((c) => c.includes('phased-release update'))).toBe(true);
    });
  });

  it('refuses to pause a rollout that does not exist', async () => {
    await withAppleEnvironment(async () => {
      const routes = (await snapshotRoutes()).filter(
        (route) => route.match !== 'phased-release view',
      );
      const { adapter: apple } = adapter([
        ...routes,
        { match: 'phased-release view', stdout: '{"data":null}' },
      ]);
      await expect(
        apple.setPhasedRelease(testContext(), APP, { action: 'pause' }),
      ).rejects.toMatchObject({ code: 'PLAN_CONFLICT' });
    });
  });
});

describe('applyBatch', () => {
  it('reports every op as its own non-atomic transaction, because Apple has none', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple } = adapter([
        versionRoute(),
        { match: 'versions list', stdout: await fixture('versions-list.json') },
        {
          match: 'localizations list --version',
          stdout: await fixture('localizations-version.json'),
        },
        { match: 'localizations update', stdout: '{"data":{"type":"x","id":"1"}}' },
        { match: 'builds upload', stdout: '{"buildNumber":"1042"}' },
        { match: 'builds info', stdout: await fixture('build-info.json') },
      ]);

      const batch = await apple.applyBatch(testContext(), APP, [
        { op: 'set_metadata', changes: { locales: [{ locale: 'en-US', description: 'New.' }] } },
        { op: 'upload_build', artifact: { path: '/tmp/app.ipa', kind: 'ipa' } },
      ]);

      expect(batch.ok).toBe(true);
      expect(batch.transactions).toHaveLength(2);
      expect(batch.transactions.every((tx) => tx.atomic === false)).toBe(true);
      expect(batch.transactions.every((tx) => tx.committed)).toBe(true);
      expect(batch.builds?.[0]?.buildNumber).toBe('1042');
    });
  });

  it('stops at the first failure and marks what it never attempted', async () => {
    await withAppleEnvironment(async () => {
      const { adapter: apple } = adapter([
        versionRoute(),
        { match: 'versions list', stdout: await fixture('versions-list.json') },
        {
          match: 'localizations list --version',
          stdout: await fixture('localizations-version.json'),
        },
        {
          match: 'localizations update',
          exitCode: 3,
          stderr: 'Error: localizations: 409 ENTITY_ERROR: cannot be modified in its current state',
        },
      ]);

      const batch = await apple.applyBatch(testContext(), APP, [
        { op: 'set_metadata', changes: { locales: [{ locale: 'en-US', description: 'New.' }] } },
        { op: 'upload_build', artifact: { path: '/tmp/app.ipa', kind: 'ipa' } },
      ]);

      expect(batch.ok).toBe(false);
      expect(batch.failedAt).toBe(0);
      expect(batch.results[0]?.errorCode).toBe('STORE_CONFLICT');
      expect(batch.results[1]?.skipped).toBe(true);
      // Nothing after the failure was committed.
      expect(batch.transactions[1]?.committed).toBe(false);
    });
  });
});
