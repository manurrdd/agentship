import { AgentshipError, ERROR_CODES, type RunResult, runToolRaw } from '@agentship/core';
import { describe, expect, it } from 'vitest';
import { AppleAdapter, ascCommands, classifyAscFailure } from '../src/index.js';
import { fakeRunner, testContext, versionRoute, withAppleEnvironment } from './harness.js';

function failure(stderr: string, exitCode = 3): RunResult {
  return { stdout: '', stderr, exitCode, durationMs: 1, attempts: 1 };
}

/**
 * `asc` reports store failures as prose on stderr with a coarse exit code, so the mapping
 * from what Apple said to what Agentship raises is the part most likely to rot. Each case
 * below is text `asc` or App Store Connect actually produces.
 */
describe('classifying asc failures', () => {
  it('maps missing credentials', () => {
    expect(
      classifyAscFailure(
        failure(
          "Error: apps: missing authentication. Run 'asc auth login' or create ~/.asc/config.json",
        ),
      ),
    ).toBe(ERROR_CODES.AUTH_MISSING_CREDENTIALS);
  });

  it('maps a rejected key (401)', () => {
    expect(
      classifyAscFailure(
        failure(
          'Error: apps: failed to fetch: Authentication credentials are missing or invalid.: Provide a properly configured and signed bearer token.',
        ),
      ),
    ).toBe(ERROR_CODES.STORE_UNAUTHORIZED);
  });

  it('maps an insufficient role (403)', () => {
    expect(
      classifyAscFailure(
        failure('Error: finance: FORBIDDEN: This request requires the Admin role.'),
      ),
    ).toBe(ERROR_CODES.AUTH_PERMISSION_DENIED);
  });

  it('maps a state conflict (409)', () => {
    expect(
      classifyAscFailure(
        failure('Error: versions: 409 STATE_ERROR: cannot be modified in its current state'),
      ),
    ).toBe(ERROR_CODES.STORE_CONFLICT);
  });

  it('maps throttling (429)', () => {
    expect(classifyAscFailure(failure('Error: apps: 429 Too Many Requests'))).toBe(
      ERROR_CODES.STORE_RATE_LIMITED,
    );
  });

  it('maps a server error (5xx)', () => {
    expect(classifyAscFailure(failure('Error: apps: 503 Service Unavailable'))).toBe(
      ERROR_CODES.STORE_UNAVAILABLE,
    );
  });

  it('maps a missing resource (404)', () => {
    expect(
      classifyAscFailure(failure('Error: apps: 404 The specified resource does not exist')),
    ).toBe(ERROR_CODES.STORE_NOT_FOUND);
  });

  it('maps a payload rejection (400)', () => {
    expect(
      classifyAscFailure(
        failure('Error: localizations: ENTITY_ERROR.ATTRIBUTE.INVALID: keywords is too long'),
      ),
    ).toBe(ERROR_CODES.STORE_VALIDATION_FAILED);
  });

  it('maps a missing agreement to a policy rejection', () => {
    expect(
      classifyAscFailure(
        failure(
          'Error: pricing: The Paid Applications agreement is not in place for this account.',
        ),
      ),
    ).toBe(ERROR_CODES.STORE_REJECTED);
  });

  it('treats a usage error as a tool failure, not a store failure', () => {
    expect(classifyAscFailure(failure('Error: --id is required', 2))).toBe(
      ERROR_CODES.TOOL_EXEC_FAILED,
    );
  });
});

describe('retry policy', () => {
  it('marks only transient store failures as retryable', () => {
    expect(new AgentshipError(ERROR_CODES.STORE_RATE_LIMITED, 'x').retryable).toBe(true);
    expect(new AgentshipError(ERROR_CODES.STORE_UNAVAILABLE, 'x').retryable).toBe(true);
    expect(new AgentshipError(ERROR_CODES.STORE_CONFLICT, 'x').retryable).toBe(false);
    expect(new AgentshipError(ERROR_CODES.AUTH_PERMISSION_DENIED, 'x').retryable).toBe(false);
  });
});

describe('malformed output', () => {
  it('fails with a bounded, redacted sample rather than a parser crash', async () => {
    await withAppleEnvironment(async () => {
      const runner = fakeRunner([
        versionRoute(),
        { match: 'apps list', stdout: '<!DOCTYPE html><html>gateway timeout</html>' },
      ]);
      const apple = new AppleAdapter({ runner: runner.runner });
      await expect(apple.listApps(testContext())).rejects.toMatchObject({
        code: ERROR_CODES.TOOL_INVALID_OUTPUT,
      });
    });
  });

  it('rejects JSON that is not an App Store Connect document', async () => {
    await withAppleEnvironment(async () => {
      const runner = fakeRunner([
        versionRoute(),
        { match: 'apps list', stdout: '{"data":[{"nope":true}]}' },
      ]);
      const apple = new AppleAdapter({ runner: runner.runner });
      await expect(apple.listApps(testContext())).rejects.toMatchObject({
        code: ERROR_CODES.TOOL_INVALID_OUTPUT,
      });
    });
  });
});

describe('timeouts', () => {
  it('propagates a timeout raised by the runner', async () => {
    await withAppleEnvironment(async () => {
      const apple = new AppleAdapter({
        runner: async () => {
          throw new AgentshipError(
            ERROR_CODES.TOOL_TIMEOUT,
            'asc did not finish within 120000 ms.',
          );
        },
      });
      await expect(apple.listApps(testContext())).rejects.toMatchObject({
        code: ERROR_CODES.TOOL_TIMEOUT,
      });
    });
  });
});

describe('no secrets in process arguments', () => {
  it('is enforced by the shared runner before anything is spawned', async () => {
    // argv is world-readable through `ps`; the guard lives below every adapter.
    await expect(
      runToolRaw('/usr/bin/true', {
        args: ['--private-key', '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'],
        toolName: 'asc',
        retry: false,
      }),
    ).rejects.toThrowError(/looks like a secret/);
  });
});

describe('forbidden subcommands', () => {
  it('cannot be produced by the command table at all', () => {
    // Stronger than a grep over the sources: every builder in the table is invoked with
    // plausible arguments, and none of them may reach `asc web` (an unofficial Apple ID
    // web session) or `asc auth` (a persistent login Agentship must never create).
    // One value that satisfies every builder's parameter, whatever its shape: an array
    // (so `.join` works) carrying the option properties (so `'versionId' in target` works).
    const anything = Object.assign(['x'], {
      versionId: 'v',
      appId: 'a',
      groups: ['g'],
      assets: [],
      buildId: 'b',
      name: 'n',
      territories: ['US'],
      answers: { gambling: false },
    });
    const commands = Object.values(ascCommands).map((build) =>
      (build as (...args: unknown[]) => string[])(anything, anything, anything, anything),
    );
    expect(commands.length).toBeGreaterThan(20);
    for (const argv of commands) {
      expect(argv[0], argv.join(' ')).not.toBe('web');
      expect(argv[0], argv.join(' ')).not.toBe('auth');
    }
  });
});
