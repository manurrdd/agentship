import type { AnalysisWarning, Evidence, ExpoWorkflow, Framework } from '@agentship/core';
import { parseYaml } from './parsers.js';
import type { RepoFs } from './repo-fs.js';

/**
 * Framework detection.
 *
 * The detection order below is not a heuristic ranking, it is a containment ranking: a
 * Flutter project *contains* `ios/` and `android/` native projects; an Expo project
 * *contains* a React Native dependency; a prebuilt Expo project contains both. Checking the
 * outermost framework first is therefore the only order that gives the right answer, and
 * each level records the evidence that made it win so an agent can explain the choice.
 *
 * Precedence: flutter → expo → react-native → ios-native → android-native.
 */

interface Candidate {
  readonly framework: Framework;
  readonly score: number;
  readonly evidence: readonly Evidence[];
  readonly expoWorkflow?: ExpoWorkflow;
}

export interface DetectionOutcome {
  readonly framework: Framework;
  readonly confidence: 'certain' | 'inferred' | 'guess';
  readonly evidence: readonly Evidence[];
  readonly expoWorkflow?: ExpoWorkflow;
  readonly runnerUps: readonly { framework: Framework; score: number }[];
  /** Repo-relative directory holding the app; `.` when it is the repository root. */
  readonly appDir: string;
  readonly packageManager?: string;
  readonly warnings: readonly AnalysisWarning[];
}

/** Directories searched one level down when the repository root holds no app. */
const MONOREPO_ROOTS = [
  'apps',
  'packages',
  'examples',
  'example',
  'mobile',
  'app',
  'client',
  'src',
];

interface PackageJson {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly packageManager?: string;
}

function joinDir(dir: string, file: string): string {
  return dir === '.' ? file : `${dir}/${file}`;
}

async function candidatesFor(fs: RepoFs, dir: string): Promise<Candidate[]> {
  const found: Candidate[] = [];

  // --- Flutter ---------------------------------------------------------------
  const pubspecPath = joinDir(dir, 'pubspec.yaml');
  const pubspec = await fs.readText(pubspecPath);
  if (pubspec !== undefined) {
    const parsed = parseYaml(pubspec) as
      | { dependencies?: Record<string, unknown>; environment?: Record<string, unknown> }
      | undefined;
    const usesFlutter =
      parsed?.dependencies !== undefined && Object.hasOwn(parsed.dependencies, 'flutter');
    const declaresFlutterSdk =
      parsed?.environment !== undefined && Object.hasOwn(parsed.environment, 'flutter');
    if (usesFlutter || declaresFlutterSdk || /^\s*flutter:\s*$/m.test(pubspec)) {
      found.push({
        framework: 'flutter',
        score: 100,
        evidence: [
          {
            file: pubspecPath,
            note: usesFlutter
              ? 'pubspec.yaml declares the flutter SDK as a dependency'
              : 'pubspec.yaml contains a flutter section',
          },
        ],
      });
    }
  }

  // --- Expo and React Native -------------------------------------------------
  const packageJsonPath = joinDir(dir, 'package.json');
  const packageJson = await fs.readJson<PackageJson>(packageJsonPath);
  const deps = { ...packageJson?.dependencies, ...packageJson?.devDependencies };

  const appJsonPath = joinDir(dir, 'app.json');
  const appJson = await fs.readJson<{ expo?: unknown }>(appJsonPath);
  const appConfigPath = await fs.firstExisting([
    joinDir(dir, 'app.config.ts'),
    joinDir(dir, 'app.config.js'),
    joinDir(dir, 'app.config.json'),
  ]);

  const hasExpoDep = Object.hasOwn(deps, 'expo');
  const hasExpoConfig = appJson?.expo !== undefined || appConfigPath !== undefined;
  if (hasExpoDep || hasExpoConfig) {
    const evidence: Evidence[] = [];
    if (hasExpoDep) evidence.push({ file: packageJsonPath, note: 'package.json depends on expo' });
    if (appJson?.expo !== undefined) {
      evidence.push({ file: appJsonPath, note: 'app.json declares an expo configuration' });
    }
    if (appConfigPath !== undefined) {
      evidence.push({ file: appConfigPath, note: 'the project has an Expo app config file' });
    }
    // Checked-in native directories mean the project has been prebuilt: builds come from
    // the native projects, not from a managed Expo build.
    const nativeCheckedIn =
      (await fs.isDirectory(joinDir(dir, 'ios'))) ||
      (await fs.isDirectory(joinDir(dir, 'android')));
    if (nativeCheckedIn) {
      evidence.push({
        file: joinDir(dir, 'ios'),
        note: 'native project directories are checked in, so this is a prebuild workflow',
      });
    }
    found.push({
      framework: 'expo',
      score: 90,
      evidence,
      expoWorkflow: nativeCheckedIn ? 'prebuild' : 'managed',
    });
  }

  if (Object.hasOwn(deps, 'react-native')) {
    found.push({
      framework: 'react-native',
      score: 80,
      evidence: [{ file: packageJsonPath, note: 'package.json depends on react-native' }],
    });
  }

  // --- Native iOS ------------------------------------------------------------
  const xcode = await findXcodeProject(fs, dir);
  if (xcode !== undefined) {
    found.push({
      framework: 'ios-native',
      score: 50,
      evidence: [{ file: xcode, note: 'the repository contains an Xcode project' }],
    });
  }

  // --- Native Android --------------------------------------------------------
  const gradle = await findGradleApp(fs, dir);
  if (gradle !== undefined) {
    found.push({
      framework: 'android-native',
      score: 45,
      evidence: [{ file: gradle, note: 'the repository contains a Gradle application module' }],
    });
  }

  return found;
}

async function findXcodeProject(fs: RepoFs, dir: string): Promise<string | undefined> {
  for (const base of [dir, joinDir(dir, 'ios')]) {
    for (const name of await fs.list(base)) {
      if (name.endsWith('.xcworkspace') || name.endsWith('.xcodeproj')) return joinDir(base, name);
    }
  }
  return undefined;
}

async function findGradleApp(fs: RepoFs, dir: string): Promise<string | undefined> {
  for (const base of [dir, joinDir(dir, 'android')]) {
    const settings = await fs.firstExisting([
      joinDir(base, 'settings.gradle'),
      joinDir(base, 'settings.gradle.kts'),
    ]);
    if (settings === undefined) continue;
    const appBuild = await fs.firstExisting([
      joinDir(base, 'app/build.gradle'),
      joinDir(base, 'app/build.gradle.kts'),
    ]);
    if (appBuild !== undefined) return appBuild;
  }
  return undefined;
}

function bestOf(candidates: readonly Candidate[]): Candidate | undefined {
  return [...candidates].sort((a, b) => b.score - a.score)[0];
}

/** Detects the framework, descending into a monorepo when the root holds no app. */
export async function detectFramework(fs: RepoFs): Promise<DetectionOutcome> {
  const warnings: AnalysisWarning[] = [];

  const rootCandidates = await candidatesFor(fs, '.');
  let appDir = '.';
  let candidates = rootCandidates;

  if (candidates.length === 0) {
    const nested = await findInMonorepo(fs);
    if (nested !== undefined) {
      appDir = nested.dir;
      candidates = nested.candidates;
      if (nested.others.length > 0) {
        warnings.push({
          code: 'MULTIPLE_APPS_FOUND',
          severity: 'warning',
          message: `This repository contains more than one app (${[nested.dir, ...nested.others].join(', ')}). Analyzed ${nested.dir}.`,
          remediation: 'Point the analyzer at the specific app directory you want to publish.',
        });
      }
    }
  }

  const winner = bestOf(candidates);
  if (winner === undefined) {
    return {
      framework: 'unknown',
      confidence: 'guess',
      evidence: [],
      runnerUps: [],
      appDir,
      warnings: [
        ...warnings,
        {
          code: 'FRAMEWORK_UNKNOWN',
          severity: 'error',
          message:
            'No supported mobile app was found: expected a Flutter, Expo, React Native, Xcode or Gradle project.',
          remediation:
            'Point Agentship at the directory that holds the app, or check that the native project files are committed.',
        },
      ],
    };
  }

  const packageJson = await fs.readJson<PackageJson>(joinDir(appDir, 'package.json'));
  const packageManager = await detectPackageManager(fs, appDir, packageJson);

  const runnerUp = candidates.filter((c) => c !== winner).sort((a, b) => b.score - a.score)[0];

  return {
    framework: winner.framework,
    // The precedence gap is what decides confidence. A Flutter project also contains native
    // projects, but nothing else scores near it, so the answer is unambiguous. Expo (90) and
    // React Native (80) are genuinely close — an Expo app *is* a React Native app — so there
    // the answer comes from the rule, not from the evidence alone.
    confidence:
      runnerUp === undefined || winner.score - runnerUp.score >= 20 ? 'certain' : 'inferred',
    evidence: winner.evidence,
    ...(winner.expoWorkflow === undefined ? {} : { expoWorkflow: winner.expoWorkflow }),
    runnerUps: candidates
      .filter((c) => c !== winner)
      .map((c) => ({ framework: c.framework, score: c.score })),
    appDir,
    ...(packageManager === undefined ? {} : { packageManager }),
    warnings,
  };
}

async function findInMonorepo(
  fs: RepoFs,
): Promise<{ dir: string; candidates: Candidate[]; others: string[] } | undefined> {
  const matches: { dir: string; candidates: Candidate[]; score: number }[] = [];

  for (const parent of MONOREPO_ROOTS) {
    if (!(await fs.isDirectory(parent))) continue;
    for (const child of await fs.list(parent)) {
      const dir = `${parent}/${child}`;
      if (!(await fs.isDirectory(dir))) continue;
      const candidates = await candidatesFor(fs, dir);
      const best = bestOf(candidates);
      if (best !== undefined) matches.push({ dir, candidates, score: best.score });
    }
  }

  if (matches.length === 0) return undefined;
  matches.sort((a, b) => b.score - a.score || a.dir.localeCompare(b.dir));
  const winner = matches[0] as (typeof matches)[number];
  return {
    dir: winner.dir,
    candidates: winner.candidates,
    others: matches.slice(1).map((m) => m.dir),
  };
}

async function detectPackageManager(
  fs: RepoFs,
  dir: string,
  packageJson: PackageJson | undefined,
): Promise<string | undefined> {
  const declared = packageJson?.packageManager;
  if (declared !== undefined) return declared.split('@')[0];
  const lockfiles: [string, string][] = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ];
  for (const [file, manager] of lockfiles) {
    if ((await fs.exists(joinDir(dir, file))) || (await fs.exists(file))) return manager;
  }
  return packageJson === undefined ? undefined : 'npm';
}
