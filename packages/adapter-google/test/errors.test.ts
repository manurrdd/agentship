import { AgentshipError, ERROR_CODES, type RunResult, runToolRaw } from '@agentship/core';
import { describe, expect, it } from 'vitest';
import { classifyGpcFailure, GoogleAdapter, gpcCommands, parseGpcFailure } from '../src/index.js';
import { fakeRunner, testContext, versionRoute, withGoogleEnvironment } from './harness.js';

const APP = { store: 'google' as const, id: 'com.agentship.demo' };

function failure(code: string, message: string, exitCode: number, suggestion?: string): RunResult {
  return {
    stdout: '',
    stderr: `Error [${code}]: ${message}${suggestion === undefined ? '' : `\nSuggestion: ${suggestion}`}`,
    exitCode,
    durationMs: 1,
    attempts: 1,
  };
}

describe('parsing gpc failures', () => {
  it('reads the code, the message and the suggestion', () => {
    const parsed = parseGpcFailure(
      'Error [API_FORBIDDEN]: The caller does not have permission\nSuggestion: Invite the service account.\n\n→ Run gpc doctor to diagnose your credentials.',
    );
    expect(parsed).toEqual({
      code: 'API_FORBIDDEN',
      message: 'The caller does not have permission',
      suggestion: 'Invite the service account.',
    });
  });

  it('reads a failure that carries no suggestion and no trailing newline', () => {
    const parsed = parseGpcFailure('Error [API_NOT_FOUND]: Track not found');
    expect(parsed).toMatchObject({ code: 'API_NOT_FOUND', message: 'Track not found' });
    expect(parsed.suggestion).toBeUndefined();
  });

  it('degrades to the first line when gpc prints something unexpected', () => {
    const parsed = parseGpcFailure('node:internal/errors: something went very wrong');
    expect(parsed.code).toBeUndefined();
    expect(parsed.message).toContain('something went very wrong');
  });
});

/**
 * `gpc` classifies its own failures, in the exit code and in a stable error code. The table
 * below is the contract between the two catalogs; a code that disappears upstream shows up
 * here as an exit-code fallback rather than as a wrong classification.
 */
describe('classifying gpc failures', () => {
  it('maps credentials (exit 3)', () => {
    expect(classifyGpcFailure(failure('AUTH_NO_CREDENTIALS', 'No credentials found', 3))).toBe(
      ERROR_CODES.AUTH_MISSING_CREDENTIALS,
    );
    expect(classifyGpcFailure(failure('AUTH_TOKEN_FAILED', 'Failed to obtain token', 3))).toBe(
      ERROR_CODES.AUTH_INVALID_CREDENTIALS,
    );
  });

  it('maps a rejected request (401) and an insufficient role (403)', () => {
    expect(classifyGpcFailure(failure('API_UNAUTHORIZED', 'Unauthorized', 4))).toBe(
      ERROR_CODES.STORE_UNAUTHORIZED,
    );
    expect(classifyGpcFailure(failure('API_FORBIDDEN', 'No permission', 4))).toBe(
      ERROR_CODES.AUTH_PERMISSION_DENIED,
    );
  });

  it('maps every edit-lifecycle failure to a conflict', () => {
    for (const code of [
      'API_CHANGES_ALREADY_IN_REVIEW',
      'API_CHANGES_NOT_SENT_FOR_REVIEW',
      'API_EDIT_CONFLICT',
      'API_EDIT_EXPIRED',
    ]) {
      expect(classifyGpcFailure(failure(code, 'edit problem', 4)), code).toBe(
        ERROR_CODES.STORE_CONFLICT,
      );
    }
  });

  it('maps throttling (429) and server errors (5xx)', () => {
    expect(classifyGpcFailure(failure('API_RATE_LIMITED', 'Too many requests', 4))).toBe(
      ERROR_CODES.STORE_RATE_LIMITED,
    );
    expect(classifyGpcFailure(failure('API_SERVER_ERROR', 'Internal error', 4))).toBe(
      ERROR_CODES.STORE_UNAVAILABLE,
    );
  });

  it('maps a missing app (404)', () => {
    expect(classifyGpcFailure(failure('API_APP_NOT_FOUND', 'No such app', 4))).toBe(
      ERROR_CODES.STORE_NOT_FOUND,
    );
  });

  it('falls back to the exit code for an unmapped error code', () => {
    expect(classifyGpcFailure(failure('API_SOMETHING_NEW', 'new failure', 5))).toBe(
      ERROR_CODES.STORE_UNAVAILABLE,
    );
    expect(classifyGpcFailure(failure('API_SOMETHING_NEW', 'new failure', 2))).toBe(
      ERROR_CODES.STORE_VALIDATION_FAILED,
    );
  });

  it('classifies by exit code alone when gpc printed nothing recognisable', () => {
    const raw: RunResult = {
      stdout: '',
      stderr: 'connect ETIMEDOUT',
      exitCode: 5,
      durationMs: 1,
      attempts: 1,
    };
    expect(classifyGpcFailure(raw)).toBe(ERROR_CODES.STORE_UNAVAILABLE);
  });
});

describe('a review already in progress', () => {
  it('is surfaced as a decision for the user, not silently overridden', async () => {
    await withGoogleEnvironment(async () => {
      const runner = fakeRunner([
        versionRoute(),
        { match: 'listings get', stdout: '[]' },
        {
          match: 'listings push',
          exitCode: 4,
          stderr:
            'Error [API_CHANGES_ALREADY_IN_REVIEW]: Changes are already in review. Committing this edit would cancel the existing review.\nSuggestion: Wait for the current review to complete.',
        },
      ]);
      const google = new GoogleAdapter({ runner: runner.runner });

      await expect(
        google.setMetadata(testContext(), APP, {
          locales: [{ locale: 'en-US', description: 'New.' }],
        }),
      ).rejects.toMatchObject({
        code: ERROR_CODES.STORE_CONFLICT,
        remediation: { summary: expect.stringContaining('review is already in progress') },
      });

      // The switch that makes this an error rather than a silent cancellation.
      expect(runner.commands().find((c) => c.includes('listings push'))).toContain(
        '--error-if-in-review',
      );
    });
  });
});

describe('malformed output', () => {
  it('fails with a bounded, redacted sample rather than a parser crash', async () => {
    await withGoogleEnvironment(async () => {
      const runner = fakeRunner([
        versionRoute(),
        { match: 'apps info', stdout: '<html>502 Bad Gateway</html>' },
      ]);
      const google = new GoogleAdapter({ runner: runner.runner });
      await expect(google.getAppState(testContext(), APP)).rejects.toMatchObject({
        code: ERROR_CODES.TOOL_INVALID_OUTPUT,
      });
    });
  });

  it('fails when a command that should print JSON prints nothing', async () => {
    await withGoogleEnvironment(async () => {
      const runner = fakeRunner([versionRoute(), { match: 'apps info', stdout: '' }]);
      const google = new GoogleAdapter({ runner: runner.runner });
      await expect(google.getAppState(testContext(), APP)).rejects.toMatchObject({
        code: ERROR_CODES.TOOL_INVALID_OUTPUT,
      });
    });
  });
});

describe('timeouts', () => {
  it('propagates a timeout raised by the runner', async () => {
    await withGoogleEnvironment(async () => {
      const google = new GoogleAdapter({
        runner: async () => {
          throw new AgentshipError(
            ERROR_CODES.TOOL_TIMEOUT,
            'gpc did not finish within 120000 ms.',
          );
        },
      });
      await expect(google.getAppState(testContext(), APP)).rejects.toMatchObject({
        code: ERROR_CODES.TOOL_TIMEOUT,
      });
    });
  });
});

describe('no secrets in process arguments', () => {
  it('refuses a service-account JSON on the command line', async () => {
    await expect(
      runToolRaw('/usr/bin/true', {
        args: ['--service-account', '{"type":"service_account","private_key":"-----BEGIN..."}'],
        toolName: 'gpc',
        retry: false,
      }),
    ).rejects.toThrowError(/looks like a secret/);
  });
});

describe('forbidden subcommands', () => {
  it('cannot be produced by the command table at all', () => {
    // Stronger than a grep over the sources: every builder in the table is invoked, and
    // none may reach `gpc auth`, which writes a persistent profile and, unconfigured,
    // falls back to whatever Application Default Credentials the machine happens to have.
    const anything = Object.assign(['x'], {
      track: 'internal',
      language: 'en-US',
      assets: [],
      name: 'n',
    });
    const commands = Object.values(gpcCommands).map((build) =>
      (build as (...args: unknown[]) => string[])(anything, anything, anything, anything).map(
        String,
      ),
    );
    expect(commands.length).toBeGreaterThan(15);
    for (const argv of commands) {
      // `--yes` closes the global prefix, so the token after it is the subcommand.
      const start = argv.indexOf('--yes');
      const subcommand = start === -1 ? argv[0] : argv[start + 1];
      expect(subcommand, argv.join(' ')).not.toBe('auth');
      expect(argv, argv.join(' ')).not.toContain('login');
    }
  });
});

describe('the package lane', () => {
  it('keeps serialising after a failure, and does not leak lanes', async () => {
    await withGoogleEnvironment(async () => {
      const order: string[] = [];
      const runner = fakeRunner([
        versionRoute(),
        {
          match: 'apps info',
          exitCode: 4,
          stderr: 'Error [API_APP_NOT_FOUND]: No such app',
          once: true,
        },
        {
          match: 'tracks list',
          stdout: '{"tracks":[],"meta":{"count":0}}',
          inspect: () => {
            order.push('tracks');
          },
        },
      ]);
      const google = new GoogleAdapter({ runner: runner.runner });

      // A rejected predecessor has already released its Play edit; the next caller must
      // still get the lane rather than hanging behind a broken chain.
      await expect(google.getAppState(testContext(), APP)).rejects.toThrow();
      await expect(google.checkAuth(testContext(), APP)).resolves.toMatchObject({ ok: true });
      expect(order).toEqual(['tracks']);
    });
  });
});
