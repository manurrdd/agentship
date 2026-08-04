import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AdapterContext,
  createLogger,
  type RunResult,
  type ToolInvocation,
  type ToolRunner,
} from '@agentship/core';

/**
 * Running the whole backend offline.
 *
 * The adapter reaches `asc` through one function, so a contract test replaces that function
 * with a table of canned answers keyed on the arguments. Everything else runs for real: the
 * command table builds the argv, the private key is written to and removed from disk, the
 * environment is assembled and asserted, the JSON is parsed and mapped. What the tests do
 * not do is talk to Apple.
 *
 * This is also what makes the "no secrets in argv" and "no `asc web`" invariants testable:
 * every invocation the adapter makes is recorded here and can be asserted on.
 */

export interface Route {
  /** Matched against the arguments joined with a space. */
  readonly match: string | RegExp;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  /** Answer this route at most once, so a sequence of identical calls can differ. */
  readonly once?: boolean;
}

export interface RecordedCall {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string | undefined;
}

export interface FakeRunner {
  readonly runner: ToolRunner;
  readonly calls: RecordedCall[];
  /** Arguments of every call, joined, for readable assertions. */
  commands(): string[];
}

export function fakeRunner(routes: readonly Route[]): FakeRunner {
  const calls: RecordedCall[] = [];
  const consumed = new Set<number>();

  const runner: ToolRunner = async (invocation: ToolInvocation): Promise<RunResult> => {
    calls.push({
      args: [...invocation.args],
      env: { ...invocation.env },
      cwd: invocation.cwd,
    });
    const joined = invocation.args.join(' ');
    const index = routes.findIndex(
      (route, position) =>
        !consumed.has(position) &&
        (typeof route.match === 'string' ? joined.includes(route.match) : route.match.test(joined)),
    );
    const route = index === -1 ? undefined : routes[index];
    if (route === undefined) {
      // An unrouted call is a test bug, not a store failure; make it obvious.
      return {
        stdout: '',
        stderr: `no fixture for: asc ${joined}`,
        exitCode: 127,
        durationMs: 0,
        attempts: 1,
      };
    }
    if (route.once === true) consumed.add(index);
    return {
      stdout: route.stdout ?? '',
      stderr: route.stderr ?? '',
      exitCode: route.exitCode ?? 0,
      durationMs: 1,
      attempts: 1,
    };
  };

  return { runner, calls, commands: () => calls.map((call) => call.args.join(' ')) };
}

/**
 * Route that answers `asc --version` with the version the lockfile pins.
 *
 * Anchored, because `--version` also appears as a flag of several subcommands and a loose
 * match would answer `versions list --version 1.4.0` with a version banner.
 */
export function versionRoute(version = '3.4.1'): Route {
  return {
    match: /^--version$/,
    stdout: `${version} (commit: abc1234, date: 2026-08-01T00:00:00Z)`,
  };
}

export function testContext(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    profile: 'default',
    logger: createLogger({ level: 'silent', sinks: [] }),
    ...overrides,
  };
}

const APPLE_KEY_ID = 'ABCD1234EF';
const APPLE_ISSUER_ID = '69a6de70-03db-47e3-e053-5b8c7c11a4d1';

function applePrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

/**
 * Runs `fn` with a scratch `AGENTSHIP_HOME` and Apple credentials in the environment.
 *
 * The environment source is used rather than the keyring so the suite runs identically on
 * a CI machine with no secret service.
 */
export async function withAppleEnvironment<T>(fn: () => Promise<T>): Promise<T> {
  const saved = {
    home: process.env['AGENTSHIP_HOME'],
    keyId: process.env['AGENTSHIP_APPLE_KEY_ID'],
    issuerId: process.env['AGENTSHIP_APPLE_ISSUER_ID'],
    p8: process.env['AGENTSHIP_APPLE_P8'],
  };
  const home = await mkdtemp(join(tmpdir(), 'agentship-apple-'));
  process.env['AGENTSHIP_HOME'] = home;
  process.env['AGENTSHIP_APPLE_KEY_ID'] = APPLE_KEY_ID;
  process.env['AGENTSHIP_APPLE_ISSUER_ID'] = APPLE_ISSUER_ID;
  process.env['AGENTSHIP_APPLE_P8'] = applePrivateKeyPem();
  try {
    return await fn();
  } finally {
    restore('AGENTSHIP_HOME', saved.home);
    restore('AGENTSHIP_APPLE_KEY_ID', saved.keyId);
    restore('AGENTSHIP_APPLE_ISSUER_ID', saved.issuerId);
    restore('AGENTSHIP_APPLE_P8', saved.p8);
    await rm(home, { recursive: true, force: true });
  }
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

export const TEST_KEY_ID = APPLE_KEY_ID;
export const TEST_ISSUER_ID = APPLE_ISSUER_ID;

/** Reads a JSON fixture from `test/fixtures`. */
export async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}
