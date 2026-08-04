import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseToolJson, runTool, runToolJson } from '../src/exec.js';
import { createLogger } from '../src/logger.js';

const node = process.execPath;
const silent = createLogger({ level: 'silent', sinks: [] });
let scriptDir: string;

/** Writes a helper script and returns its absolute path. */
async function script(name: string, body: string): Promise<string> {
  const path = join(scriptDir, name);
  await writeFile(path, body);
  return path;
}

beforeAll(async () => {
  scriptDir = await mkdtemp(join(tmpdir(), 'agentship-exec-'));
});

afterAll(async () => {
  await rm(scriptDir, { recursive: true, force: true });
});

describe('runTool', () => {
  it('captures stdout and the exit code of a successful run', async () => {
    const path = await script('ok.cjs', 'process.stdout.write("hello");');
    const result = await runTool(node, { args: [path], logger: silent });
    expect(result.stdout).toBe('hello');
    expect(result.exitCode).toBe(0);
    expect(result.attempts).toBe(1);
  });

  it('refuses a relative binary path', async () => {
    await expect(runTool('node', { args: [], logger: silent })).rejects.toMatchObject({
      code: 'TOOL_EXEC_FAILED',
    });
  });

  it('refuses to put secret-looking material in argv', async () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';
    await expect(runTool(node, { args: ['-e', pem], logger: silent })).rejects.toMatchObject({
      code: 'TOOL_EXEC_FAILED',
    });
    await expect(
      runTool(node, { args: ['--api-key=abcdef123456'], logger: silent }),
    ).rejects.toMatchObject({ code: 'TOOL_EXEC_FAILED' });
  });

  it('maps a non-zero exit to TOOL_EXEC_FAILED and redacts stderr', async () => {
    const path = await script(
      'fail.cjs',
      'process.stderr.write("boom token=CANARYSECRETVALUE\\n"); process.exit(3);',
    );
    await expect(
      runTool(node, { args: [path], logger: silent, retry: false }),
    ).rejects.toMatchObject({ code: 'TOOL_EXEC_FAILED' });
    const err = await runTool(node, { args: [path], logger: silent, retry: false }).catch(
      (e: unknown) => e,
    );
    expect(JSON.stringify(err)).not.toContain('CANARYSECRETVALUE');
  });

  it('kills a run that exceeds its timeout', async () => {
    const path = await script('hang.cjs', 'setTimeout(() => {}, 60000);');
    await expect(
      runTool(node, { args: [path], timeoutMs: 300, logger: silent, retry: false }),
    ).rejects.toMatchObject({ code: 'TOOL_TIMEOUT' });
  });

  it('rejects output larger than the configured limit', async () => {
    const path = await script('flood.cjs', 'process.stdout.write("x".repeat(200000));');
    await expect(
      runTool(node, { args: [path], maxOutputBytes: 1024, logger: silent, retry: false }),
    ).rejects.toMatchObject({ code: 'TOOL_OUTPUT_TOO_LARGE' });
  });

  it('retries transient failures and succeeds', async () => {
    const counter = join(scriptDir, 'counter.txt');
    const path = await script(
      'flaky.cjs',
      `const fs = require('node:fs');
       let n = 0;
       try { n = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')); } catch {}
       fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
       if (n < 1) { process.stderr.write('HTTP 429 too many requests'); process.exit(1); }
       process.stdout.write('recovered');`,
    );
    const result = await runTool(node, {
      args: [path],
      logger: silent,
      retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
    });
    expect(result.stdout).toBe('recovered');
    expect(result.attempts).toBe(2);
  });

  it('does not retry a deterministic failure', async () => {
    const counter = join(scriptDir, 'counter2.txt');
    const path = await script(
      'always-fail.cjs',
      `const fs = require('node:fs');
       let n = 0;
       try { n = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')); } catch {}
       fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
       process.stderr.write('invalid bundle id'); process.exit(2);`,
    );
    await expect(
      runTool(node, {
        args: [path],
        logger: silent,
        retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
      }),
    ).rejects.toThrow();
    expect((await readFile(counter, 'utf8')).trim()).toBe('1');
  });

  it('builds the child environment explicitly instead of inheriting it', async () => {
    process.env['AGENTSHIP_TEST_LEAK'] = 'should-not-be-visible';
    const path = await script(
      'env.cjs',
      'process.stdout.write(JSON.stringify({ leak: process.env.AGENTSHIP_TEST_LEAK ?? null, given: process.env.GIVEN ?? null, path: process.env.PATH !== undefined }));',
    );
    const parsed = await runToolJson<{ leak: string | null; given: string | null; path: boolean }>(
      node,
      { args: [path], env: { GIVEN: 'yes' }, logger: silent },
    );
    delete process.env['AGENTSHIP_TEST_LEAK'];
    expect(parsed.leak).toBeNull();
    expect(parsed.given).toBe('yes');
    expect(parsed.path).toBe(true);
  });

  it('passes sensitive input through stdin', async () => {
    const path = await script(
      'stdin.cjs',
      'let d = ""; process.stdin.on("data", c => d += c); process.stdin.on("end", () => process.stdout.write(String(d.length)));',
    );
    const result = await runTool(node, { args: [path], input: 'secret-material', logger: silent });
    expect(result.stdout).toBe('15');
  });
});

describe('runToolJson', () => {
  it('parses JSON output', async () => {
    const path = await script('json.cjs', 'process.stdout.write(JSON.stringify({ ok: true }));');
    await expect(runToolJson(node, { args: [path], logger: silent })).resolves.toEqual({
      ok: true,
    });
  });

  it('fails with TOOL_INVALID_OUTPUT on non-JSON output', async () => {
    const path = await script('notjson.cjs', 'process.stdout.write("not json at all");');
    await expect(runToolJson(node, { args: [path], logger: silent })).rejects.toMatchObject({
      code: 'TOOL_INVALID_OUTPUT',
    });
  });

  it('truncates and redacts the sample it reports', () => {
    const err = (() => {
      try {
        parseToolJson(`token=CANARYSECRETVALUE ${'x'.repeat(2000)}`, 'asc');
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    const dumped = JSON.stringify(err);
    expect(dumped).not.toContain('CANARYSECRETVALUE');
    expect(dumped.length).toBeLessThan(1500);
  });
});
