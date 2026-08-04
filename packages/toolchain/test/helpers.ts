import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, type Logger } from '@agentship/core';
import { currentPlatform, type Lockfile } from '../src/index.js';

/** Logger that discards everything: tests assert on behaviour, not on log output. */
export const silentLogger: Logger = createLogger({ level: 'silent', sinks: [] });

export async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const previous = process.env['AGENTSHIP_HOME'];
  const dir = await mkdtemp(join(tmpdir(), 'agentship-tc-'));
  process.env['AGENTSHIP_HOME'] = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env['AGENTSHIP_HOME'];
    else process.env['AGENTSHIP_HOME'] = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

/** A runnable stand-in for a managed binary: answers `--version` like the real ones. */
export function fakeBinary(version: string): string {
  return `#!/bin/sh\necho "fake ${version}"\n`;
}

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export interface FixtureServer {
  readonly url: string;
  /** How many times each path has been requested, for concurrency assertions. */
  readonly hits: Map<string, number>;
  close(): Promise<void>;
}

/**
 * Local HTTP server standing in for GitHub releases.
 *
 * Serves the same artifact through routes that model each supply-chain failure Agentship must
 * survive: an artifact rewritten after it was pinned, a truncated transfer, a response
 * larger than the lockfile declares, and a server error.
 */
export async function startFixtureServer(content: string): Promise<FixtureServer> {
  const hits = new Map<string, number>();
  const body = Buffer.from(content);

  const server: Server = createServer((req, res) => {
    const path = req.url ?? '/';
    hits.set(path, (hits.get(path) ?? 0) + 1);

    if (path.startsWith('/ok')) {
      res.writeHead(200, { 'content-length': String(body.byteLength) });
      res.end(body);
      return;
    }
    if (path.startsWith('/tampered')) {
      // Same length, different bytes: only the digest catches this.
      const tampered = Buffer.from(content.replace(/fake/, 'evil').padEnd(body.byteLength, ' '));
      res.writeHead(200, { 'content-length': String(tampered.byteLength) });
      res.end(tampered.subarray(0, body.byteLength));
      return;
    }
    if (path.startsWith('/truncated')) {
      res.writeHead(200, { 'content-length': String(body.byteLength) });
      res.end(body.subarray(0, Math.floor(body.byteLength / 2)));
      return;
    }
    if (path.startsWith('/oversize')) {
      // Chunked, so nothing announces the real length: only Agentship's own byte cap,
      // fed by the lockfile, can stop the transfer.
      res.writeHead(200);
      res.end(Buffer.concat([body, Buffer.alloc(64 * 1024, 0x41)]));
      return;
    }
    if (path.startsWith('/slow')) {
      res.writeHead(200, { 'content-length': String(body.byteLength) });
      res.write(body.subarray(0, 1));
      // Never finishes: exercises the per-attempt timeout.
      return;
    }
    res.writeHead(500);
    res.end('boom');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface LockfileOptions {
  readonly route?: string;
  readonly version?: string;
  /** Digest to embed; defaults to the real digest of `content`. */
  readonly sha256?: string;
  /** Size to embed; defaults to the real size of `content`. */
  readonly size?: number;
  readonly tools?: readonly ('asc' | 'gpc')[];
}

/** Builds a lockfile pointing at the fixture server for the current platform. */
export function fixtureLockfile(
  server: FixtureServer,
  content: string,
  options: LockfileOptions = {},
): Lockfile {
  const platform = currentPlatform();
  const version = options.version ?? '1.0.0';
  const route = options.route ?? '/ok';
  const tools: Record<string, unknown> = {};

  for (const tool of options.tools ?? ['asc']) {
    tools[tool] = {
      version,
      tag: `v${version}`,
      repo: `example/${tool}`,
      license: 'MIT',
      description: `fixture ${tool}`,
      checksumsUrl: `${server.url}/checksums.txt`,
      platforms: {
        [platform]: {
          url: `${server.url}${route}/${tool}-${version}`,
          sha256: options.sha256 ?? sha256(content),
          size: options.size ?? Buffer.byteLength(content),
        },
      },
    };
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date(0).toISOString(),
    platforms: [platform],
    tools,
  } as Lockfile;
}
