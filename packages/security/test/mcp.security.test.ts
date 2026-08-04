import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentshipHome, createLogger } from '@agentship/core';
import { fail, Session } from '@agentship/mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * Area 6 — the MCP boundary. Inputs are agent-supplied and may carry injected values; the
 * server must confine where it writes project state and reject bad arguments cleanly instead
 * of surfacing them as internal server faults.
 */

const silent = createLogger({ level: 'silent', sinks: [] });
const cleanups: string[] = [];
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env['AGENTSHIP_HOME'];
});
afterEach(async () => {
  if (savedHome === undefined) delete process.env['AGENTSHIP_HOME'];
  else process.env['AGENTSHIP_HOME'] = savedHome;
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentship-proj-'));
  cleanups.push(dir);
  return dir;
}

describe('projectDir confinement', () => {
  it('accepts an ordinary repository directory', async () => {
    const repo = await tempDir();
    const session = new Session({ logger: silent });
    await expect(session.setProject(repo)).resolves.toBe(repo);
  });

  it('refuses the home directory as a project', async () => {
    const session = new Session({ logger: silent });
    await expect(session.setProject(homedir())).rejects.toThrow();
  });

  it('refuses a directory inside Agentship’s private home', async () => {
    const home = await tempDir();
    process.env['AGENTSHIP_HOME'] = home;
    const session = new Session({ logger: silent });
    // The home root itself and anything under it must be refused.
    await expect(session.setProject(agentshipHome())).rejects.toThrow();
  });
});

describe('bad tool arguments surface as validation errors, not internal faults', () => {
  it('reports a schema violation as INVALID_INPUT rather than INTERNAL', () => {
    const schema = z.object({ projectDir: z.string().max(10) });
    let response: ReturnType<typeof fail> | undefined;
    try {
      schema.parse({ projectDir: 'x'.repeat(5000) });
    } catch (error) {
      response = fail(error);
    }
    const text = response?.content[0]?.text ?? '';
    expect(text).toContain('INVALID_INPUT');
    expect(text).not.toContain('INTERNAL');
    expect(response?.isError).toBe(true);
  });
});
