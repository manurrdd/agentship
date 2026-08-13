import { mkdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentshipError } from '../src/errors.js';
import {
  agentshipHome,
  assertInside,
  ensureAgentshipHome,
  findProjectAbove,
  findProjectsBelow,
  isInside,
  logsDir,
  manifestPath,
  pathExists,
  pendingDir,
  projectDir,
  stateDir,
  toolsDir,
} from '../src/paths.js';
import { withTempHome } from './helpers.js';

describe('agentshipHome', () => {
  it('honours AGENTSHIP_HOME', async () => {
    await withTempHome(async (home) => {
      expect(agentshipHome()).toBe(home);
      expect(toolsDir()).toBe(join(home, 'tools'));
      expect(logsDir()).toBe(join(home, 'logs'));
    });
  });

  it('falls back to ~/.agentship when unset', async () => {
    const previous = process.env['AGENTSHIP_HOME'];
    delete process.env['AGENTSHIP_HOME'];
    try {
      expect(agentshipHome().endsWith('/.agentship')).toBe(true);
    } finally {
      if (previous !== undefined) process.env['AGENTSHIP_HOME'] = previous;
    }
  });
});

describe('ensureAgentshipHome', () => {
  it('creates the tree with owner-only permissions', async () => {
    await withTempHome(async (home) => {
      await ensureAgentshipHome();
      for (const dir of [home, toolsDir(), logsDir()]) {
        const info = await stat(dir);
        expect(info.isDirectory()).toBe(true);
        expect(info.mode & 0o777).toBe(0o700);
      }
    });
  });
});

describe('project paths', () => {
  it('derives the project layout from the repo root', () => {
    const root = '/repo';
    expect(projectDir(root)).toBe('/repo/.agentship');
    expect(manifestPath(root)).toBe('/repo/.agentship/agentship.yaml');
    expect(stateDir(root)).toBe('/repo/.agentship/state');
    expect(pendingDir(root)).toBe('/repo/.agentship/pending');
  });

  it('finds one initialized project above a nested working directory', async () => {
    await withTempHome(async (home) => {
      const repo = join(home, 'workspace', 'app');
      const child = join(repo, 'packages', 'feature');
      await mkdir(join(repo, '.agentship'), { recursive: true });
      await mkdir(child, { recursive: true });
      await writeFile(manifestPath(repo), 'version: 1\n');
      expect(await findProjectAbove(child)).toBe(repo);
    });
  });

  it('lists initialized children deterministically and ignores dependency trees', async () => {
    await withTempHome(async (home) => {
      const workspace = join(home, 'workspace');
      const first = join(workspace, 'apps', 'a');
      const second = join(workspace, 'apps', 'b');
      const dependency = join(workspace, 'node_modules', 'not-a-project');
      for (const repo of [second, first, dependency]) {
        await mkdir(join(repo, '.agentship'), { recursive: true });
        await writeFile(manifestPath(repo), 'version: 1\n');
      }
      expect(await findProjectsBelow(workspace)).toEqual([first, second]);
    });
  });
});

describe('isInside', () => {
  it('accepts the base itself and descendants', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/b/c/d')).toBe(true);
  });

  it('rejects siblings, parents and traversal', () => {
    expect(isInside('/a/b', '/a/bc')).toBe(false);
    expect(isInside('/a/b', '/a')).toBe(false);
    expect(isInside('/a/b', '/a/b/../../c')).toBe(false);
  });
});

describe('assertInside', () => {
  it('accepts a path inside the base', async () => {
    await withTempHome(async (home) => {
      await ensureAgentshipHome();
      await expect(assertInside(home, join(home, 'tools', 'asc'))).resolves.toBeUndefined();
    });
  });

  it('rejects lexical traversal out of the base', async () => {
    await withTempHome(async (home) => {
      await ensureAgentshipHome();
      await expect(assertInside(home, join(home, '..', 'elsewhere'))).rejects.toBeInstanceOf(
        AgentshipError,
      );
    });
  });

  it('rejects a symlink that escapes the base', async () => {
    await withTempHome(async (home) => {
      await ensureAgentshipHome();
      const outside = join(tmpdir(), `agentship-outside-${process.pid}`);
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, 'victim.txt'), 'do not delete');
      const link = join(home, 'tools', 'escape');
      await symlink(outside, link);
      await expect(assertInside(home, link)).rejects.toMatchObject({
        code: 'CONFIG_HOME_UNWRITABLE',
      });
      expect(await pathExists(join(outside, 'victim.txt'))).toBe(true);
    });
  });
});
