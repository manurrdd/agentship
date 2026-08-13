import {
  type BuildPlatform,
  buildEnvironmentChecks,
  buildSupport,
  detectKeystore,
  detectProject,
  generateKeystore,
  keystorePendingOperation,
  runBuild,
} from '@agentship/build';
import {
  type AppAnalysis,
  checkArtifact,
  loadAnalysis,
  loadManifest,
  readArtifacts,
} from '@agentship/core';
import { z } from 'zod';
import { type Detail, ok } from '../format.js';
import { summarizeBuild, summarizeBuildSupport } from '../summaries.js';
import { DETAIL_DESCRIPTION, parseInput, projectDirArg, type ToolDefinition } from './types.js';

const PLATFORMS = ['ios', 'android'] as const;

const buildSchema = z.object({
  projectDir: projectDirArg,
  platform: z
    .enum(PLATFORMS)
    .optional()
    .describe(
      'Which artifact to produce. Default: every platform the manifest declares a store for.',
    ),
  action: z
    .enum(['status', 'build', 'create-keystore'])
    .optional()
    .describe(
      '"status" (default) reports what could be built here and what already exists — it compiles nothing. "build" produces and signs the artifact. "create-keystore" generates an Android upload key, and needs the user\'s explicit consent first.',
    ),
  version: z
    .string()
    .optional()
    .describe('Overrides release.version for this build. Rarely needed; the manifest decides.'),
  buildNumber: z.string().optional().describe('Overrides release.buildNumber for this build.'),
  detail: z.enum(['concise', 'full']).optional().describe(DETAIL_DESCRIPTION),
});

export const buildTool: ToolDefinition = {
  name: 'agentship_build',
  title: 'Compile and sign the app',
  description: `Produce the signed artifact a release needs: an .ipa for the App Store, an .aab for Google Play. Agentship runs the project's own build system — xcodebuild on the checked-in workspace, the repository's Gradle wrapper, or flutter build — and never rewrites the project's build files.

Start with action "status". It compiles nothing and answers the three questions worth knowing before a ten-minute build: can this machine build it, what is missing, and is there already a usable artifact. An artifact is reusable only when both its bytes and the source tree that produced it still match what was recorded; agentship_plan will not ask for a build then.

Then action "build". Signing needs no extra setup on iOS — Xcode asks App Store Connect for the certificate and profile with the same key Agentship already holds. On Android it needs an upload key: if the project signs itself (key.properties or a release signingConfig), Agentship injects nothing; otherwise it uses the keystore it custodies, and if there is none, "status" says so.

action "create-keystore" generates that key. Ask the user first, in plain words: until the app is enrolled in Play App Signing, this key IS the app's identity, and losing it means that listing can never be updated again. Agentship stores its password in the OS keyring and tells the user where the file is; backing both up is on them.

You usually do not need this tool at all. agentship_plan drafts a build action when a release lacks a usable artifact, and agentship_apply runs it in order with the upload that follows. Reach for agentship_build to diagnose a failing build, to rebuild deliberately, or to check the machine before promising the user a release.

Builds are slow (minutes) and they execute this repository's own build scripts. Agentship strips its own configuration from the build environment, but the code that runs is the project's. Never inline a build log into a message: the response carries a path and a diagnosis, and those are what the user needs.`,
  schema: buildSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },

  async handler(session, args, progress) {
    const input = parseInput(buildSchema, args);
    const detail: Detail = input.detail ?? 'concise';
    const repoRoot = await session.requireProject(input.projectDir);
    const manifest = await loadManifest(repoRoot);
    const action = input.action ?? 'status';

    const platforms: readonly BuildPlatform[] =
      input.platform !== undefined
        ? [input.platform]
        : [
            ...(manifest.stores.apple === undefined ? [] : (['ios'] as const)),
            ...(manifest.stores.google === undefined ? [] : (['android'] as const)),
          ];

    if (action === 'create-keystore') {
      const packageName = manifest.stores.google?.packageName;
      if (packageName === undefined) {
        return ok({
          projectDir: repoRoot,
          created: false,
          reason: 'The manifest declares no Google Play package name, so there is nothing to sign.',
          nextStep: 'Add stores.google.packageName to .agentship/agentship.yaml first.',
        });
      }
      await progress('generating the upload keystore');
      const generated = await generateKeystore({
        packageName,
        appName: manifest.app.name,
        logger: session.logger,
      });
      return ok({
        projectDir: repoRoot,
        created: true,
        keystore: { path: generated.path, alias: generated.alias },
        custodyNotice: generated.custodyNotice,
        nextStep:
          'Relay the custody notice to the user in full, then run agentship_build with action "build".',
      });
    }

    const shape = await detectProject(repoRoot, manifest);
    const register = await readArtifacts(repoRoot);

    if (action === 'status') {
      const analysis = await loadAnalysis(repoRoot);
      const support: Record<string, unknown>[] = [];
      for (const platform of platforms) {
        const platformSupport = await buildSupport(manifest, shape, platform);
        const suggestions = suggestedInputs(platformSupport.needsInput ?? [], analysis);
        support.push({
          ...summarizeBuildSupport(platformSupport),
          ...(suggestions.length === 0 ? {} : { suggestedInputs: suggestions }),
        });
      }
      const artifacts: Record<string, unknown> = {};
      for (const [store, record] of Object.entries(register.artifacts)) {
        if (record === undefined) continue;
        const check = await checkArtifact(record);
        artifacts[store] = {
          path: record.path,
          version: record.version,
          buildNumber: record.buildNumber,
          usable: check.valid,
          ...(check.detail === undefined ? {} : { detail: check.detail }),
          ...(record.unverified === undefined ? {} : { unverified: record.unverified }),
        };
      }
      const keystore =
        manifest.stores.google?.packageName === undefined
          ? undefined
          : await detectKeystore(shape.appDir, manifest.stores.google.packageName, manifest);

      return ok({
        projectDir: repoRoot,
        project: {
          framework: shape.framework,
          appDir: shape.appDir,
          hasIosProject: shape.hasIosProject,
          hasAndroidProject: shape.hasAndroidProject,
        },
        support,
        artifacts,
        ...(keystore === undefined
          ? {}
          : {
              keystore: {
                origin: keystore.origin,
                detail: keystore.detail,
                secretStored: keystore.secretStored,
                ...(keystore.origin === 'missing' && keystore.path !== undefined
                  ? {
                      pending: keystorePendingOperation(
                        manifest.stores.google?.packageName ?? '',
                        keystore.path,
                      ),
                    }
                  : {}),
              },
            }),
        ...(detail === 'full' ? { environment: await buildEnvironmentChecks() } : {}),
        nextStep: nextStepForStatus(support, artifacts),
      });
    }

    const results: Record<string, unknown> = {};
    for (const [index, platform] of platforms.entries()) {
      await progress(`building the ${platform} artifact`, index, platforms.length);
      const outcome = await runBuild({
        repoRoot,
        platform,
        profile: await session.engine.profileFor(repoRoot),
        manifest,
        logger: session.logger,
        ...(input.version === undefined ? {} : { version: input.version }),
        ...(input.buildNumber === undefined ? {} : { buildNumber: input.buildNumber }),
      });
      results[platform] = summarizeBuild(outcome, detail);
    }
    await progress('build finished', platforms.length, platforms.length);

    return ok({
      projectDir: repoRoot,
      builds: results,
      nextStep:
        'Call agentship_plan: the artifact is recorded, so the plan will move straight to uploading it.',
    });
  },
};

function nextStepForStatus(
  support: readonly Record<string, unknown>[],
  artifacts: Record<string, unknown>,
): string {
  const blocked = support.filter((entry) => entry['status'] !== 'supported');
  if (blocked.length > 0) {
    if (blocked.some((entry) => Array.isArray(entry['suggestedInputs']))) {
      return 'Relay the project-derived suggestedInputs with their source and confidence. They are evidence for filling the manifest, so do not ask the user to rediscover those values; do not write them into .agentship/agentship.yaml until the user has seen and accepted them. Then re-run status.';
    }
    return 'Relay the remediation of every platform that is not "supported". Agentship cannot build those here; the user either fixes the cause or supplies the artifact through release.artifacts.';
  }
  if (Object.values(artifacts).some((entry) => (entry as { usable?: boolean }).usable === true)) {
    return 'A usable artifact already exists. Call agentship_plan; it will not ask for a rebuild.';
  }
  return 'Call agentship_build with action "build", or just agentship_plan — it drafts the build as an action and agentship_apply runs it in order.';
}

interface SuggestedBuildInput {
  readonly path: string;
  readonly value: string;
  readonly confidence: string;
  readonly source: string;
  readonly note: string;
}

/** Project-derived answers for manifest gaps, carried as evidence and never written silently. */
function suggestedInputs(
  missing: readonly string[],
  analysis: AppAnalysis | undefined,
): readonly SuggestedBuildInput[] {
  if (analysis === undefined) return [];
  const suggestions: SuggestedBuildInput[] = [];
  const add = (
    path: string,
    candidate:
      | { readonly value: string | number; readonly confidence: string; readonly source?: string }
      | undefined,
  ): void => {
    if (!missing.includes(path) || candidate === undefined || candidate.source === undefined)
      return;
    suggestions.push({
      path,
      value: String(candidate.value),
      confidence: candidate.confidence,
      source: candidate.source,
      note: 'This value was read from the project. It is a suggested manifest update, not a change Agentship has made.',
    });
  };
  add('release.buildNumber', analysis.versions.buildNumber);
  add('release.version', analysis.versions.marketingVersion ?? analysis.versions.versionName);
  if (missing.includes('build.ios.scheme') && analysis.buildHints.ios?.schemes.length === 1) {
    suggestions.push({
      path: 'build.ios.scheme',
      value: analysis.buildHints.ios.schemes[0] as string,
      confidence: 'certain',
      source:
        analysis.buildHints.ios.workspace ?? analysis.buildHints.ios.project ?? 'Xcode project',
      note: 'This is the only shared scheme the project exposes. It is a suggested manifest update, not a change Agentship has made.',
    });
  }
  return suggestions;
}
