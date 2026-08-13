import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentshipError } from '../src/errors.js';
import { resolveScreenshotSets } from '../src/kernel/assets.js';

describe('resolving manifest screenshots', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('reports every missing path in one actionable error', async () => {
    root = await mkdtemp(join(tmpdir(), 'agentship-screenshots-'));
    const error = await resolveScreenshotSets(root, [
      { locale: 'en-US', device: 'phone', files: ['one.png'] },
      { locale: 'es-ES', device: 'tablet_10', files: ['two.png'] },
    ]).catch((cause: unknown) => cause);

    expect(AgentshipError.is(error)).toBe(true);
    expect((error as AgentshipError).message).toContain('2 screenshots');
    expect((error as AgentshipError).message).toContain('one.png');
    expect((error as AgentshipError).message).toContain('two.png');
    expect((error as AgentshipError).details?.['missing']).toEqual([
      { file: 'one.png', locale: 'en-US', device: 'phone' },
      { file: 'two.png', locale: 'es-ES', device: 'tablet_10' },
    ]);
    expect((error as AgentshipError).remediation?.summary).toContain('Ask the user');
  });
});
