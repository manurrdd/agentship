import { rm } from 'node:fs/promises';
import { ensureTool, pointerPath, readPointer, verifyInstall } from '@agentship/toolchain';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type FixtureServer,
  fakeBinary,
  fixtureLockfile,
  silentLogger,
  startFixtureServer,
  withTempHome,
} from '../../toolchain/test/helpers.js';

/**
 * Area 2 — supply chain. The download/verify/lock core held under a malicious fixture server
 * (those attacks are pinned by the toolchain install/verify suites). The gap this closed:
 * doctor's integrity audit trusted a self-written install manifest for any version string, so
 * a binary planted under a made-up version could be adopted or reported healthy. The lockfile
 * pin is the only trust anchor, and these tests hold it there.
 */

const base = { logger: silentLogger, lockTimeoutMs: 5_000 };
const servers: FixtureServer[] = [];

afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

async function server(content: string): Promise<FixtureServer> {
  const s = await startFixtureServer(content);
  servers.push(s);
  return s;
}

describe('the lockfile pin is the only trust anchor for what runs', () => {
  it('never adopts a self-consistent binary under a version the lockfile does not pin', async () => {
    await withTempHome(async () => {
      // Install a real, verified 9.9.9 (this is how an attacker gets a self-consistent binary
      // plus a matching install manifest onto disk), then lose the pointer.
      const planted = fakeBinary('9.9.9');
      const srv = await server(planted);
      await ensureTool('asc', {
        ...base,
        lockfile: fixtureLockfile(srv, planted, { version: '9.9.9' }),
      });
      await rm(pointerPath('asc'));

      // The lockfile now pins 1.0.0, which is NOT on disk. Only 9.9.9 is.
      const pinned = fakeBinary('1.0.0');
      const [report] = await verifyInstall({
        lockfile: fixtureLockfile(srv, pinned, { version: '1.0.0' }),
      });

      expect(report?.status).toBe('missing');
      expect(await readPointer('asc')).toBeUndefined();
    });
  });

  it('never reports an active non-pinned version as healthy', async () => {
    await withTempHome(async () => {
      const planted = fakeBinary('9.9.9');
      const srv = await server(planted);
      await ensureTool('asc', {
        ...base,
        lockfile: fixtureLockfile(srv, planted, { version: '9.9.9' }),
      });
      // Pointer left in place: 9.9.9 is the active version.

      const pinned = fakeBinary('1.0.0');
      const [report] = await verifyInstall({
        lockfile: fixtureLockfile(srv, pinned, { version: '1.0.0' }),
      });

      expect(report?.status).not.toBe('ok');
      expect((await readPointer('asc'))?.version).not.toBe('9.9.9');
    });
  });
});
