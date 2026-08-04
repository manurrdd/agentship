import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Creates a scratch `AGENTSHIP_HOME` and restores the previous value afterwards. */
export async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const previous = process.env['AGENTSHIP_HOME'];
  const dir = await mkdtemp(join(tmpdir(), 'agentship-home-'));
  process.env['AGENTSHIP_HOME'] = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env['AGENTSHIP_HOME'];
    else process.env['AGENTSHIP_HOME'] = previous;
    await rm(dir, { recursive: true, force: true });
  }
}
