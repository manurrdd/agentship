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
 * As on the Apple side, the adapter reaches `gpc` through one function, which a contract
 * test replaces with a table of canned answers. Everything above it runs for real —
 * including the staging directories `gpc listings push` and `listings images sync` read, so
 * the tests can assert on what would actually have been sent to Google.
 */

export interface Route {
  readonly match: string | RegExp;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly once?: boolean;
  /** Inspect the staged directory tree before the answer is returned. */
  readonly inspect?: (invocation: ToolInvocation) => void | Promise<void>;
}

export interface RecordedCall {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string | undefined;
}

export interface FakeRunner {
  readonly runner: ToolRunner;
  readonly calls: RecordedCall[];
  commands(): string[];
}

export function fakeRunner(routes: readonly Route[]): FakeRunner {
  const calls: RecordedCall[] = [];
  const consumed = new Set<number>();

  const runner: ToolRunner = async (invocation: ToolInvocation): Promise<RunResult> => {
    calls.push({ args: [...invocation.args], env: { ...invocation.env }, cwd: invocation.cwd });
    const joined = invocation.args.join(' ');
    const index = routes.findIndex(
      (route, position) =>
        !consumed.has(position) &&
        (typeof route.match === 'string' ? joined.includes(route.match) : route.match.test(joined)),
    );
    const route = index === -1 ? undefined : routes[index];
    if (route === undefined) {
      return {
        stdout: '',
        stderr: `Error [NO_FIXTURE]: no fixture for: gpc ${joined}`,
        exitCode: 127,
        durationMs: 0,
        attempts: 1,
      };
    }
    if (route.once === true) consumed.add(index);
    await route.inspect?.(invocation);
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

/** Anchored so it never answers a subcommand that merely carries a `--version…` flag. */
export function versionRoute(version = '0.9.93'): Route {
  return { match: /^--version$/, stdout: version };
}

export function testContext(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return { profile: 'default', logger: createLogger({ level: 'silent', sinks: [] }), ...overrides };
}

function serviceAccountJson(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return JSON.stringify({
    type: 'service_account',
    project_id: 'agentship-test',
    private_key_id: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    client_email: 'agentship-publisher@agentship-test.iam.gserviceaccount.com',
    client_id: '123456789012345678901',
    token_uri: 'https://oauth2.googleapis.com/token',
  });
}

export const TEST_CLIENT_EMAIL = 'agentship-publisher@agentship-test.iam.gserviceaccount.com';

export async function withGoogleEnvironment<T>(fn: () => Promise<T>): Promise<T> {
  const saved = {
    home: process.env['AGENTSHIP_HOME'],
    sa: process.env['AGENTSHIP_GOOGLE_SA_JSON'],
  };
  const home = await mkdtemp(join(tmpdir(), 'agentship-google-'));
  process.env['AGENTSHIP_HOME'] = home;
  process.env['AGENTSHIP_GOOGLE_SA_JSON'] = serviceAccountJson();
  try {
    return await fn();
  } finally {
    restore('AGENTSHIP_HOME', saved.home);
    restore('AGENTSHIP_GOOGLE_SA_JSON', saved.sa);
    await rm(home, { recursive: true, force: true });
  }
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

export async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

/** The value of a flag in a recorded command, e.g. `--dir`. */
export function flagValue(command: string, flag: string): string | undefined {
  const parts = command.split(' ');
  const index = parts.indexOf(flag);
  return index === -1 ? undefined : parts[index + 1];
}
