import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentshipError, ERROR_CODES, FILE_MODE, type Logger } from '@agentship/core';

/**
 * Verified download of a managed binary.
 *
 * The digest is computed while the bytes stream to disk, so a multi-hundred-megabyte
 * artifact is never buffered in memory, and the file is only ever handed back to the caller
 * once its size *and* SHA-256 match the lockfile exactly. Everything else — a truncated
 * stream, an oversized response, a rewritten release — fails here, before the file can be
 * made executable, let alone activated.
 */

export interface DownloadOptions {
  readonly url: string;
  /** Expected digest from the lockfile. */
  readonly sha256: string;
  /** Expected size from the lockfile; doubles as the hard cap on bytes accepted. */
  readonly size: number;
  /** Destination path, inside a staging directory the caller owns. */
  readonly dest: string;
  readonly attempts?: number;
  readonly logger?: Logger;
  readonly cancelSignal?: AbortSignal;
  /** Wall-clock budget for a single attempt. */
  readonly timeoutMs?: number;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** Downloads `url` to `dest`, verifying size and digest. Retries transient failures. */
export async function downloadVerified(options: DownloadOptions): Promise<void> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await downloadOnce(options);
      return;
    } catch (error) {
      lastError = error;
      await rm(options.dest, { force: true }).catch(() => undefined);
      const retryable = AgentshipError.is(error)
        ? error.code === ERROR_CODES.TOOL_DOWNLOAD_FAILED
        : true;
      if (!retryable || attempt === attempts) throw error;
      options.logger?.warn('tool download failed, retrying', {
        url: options.url,
        attempt,
        err: error,
      });
      await delay(Math.round(Math.random() * Math.min(500 * 2 ** (attempt - 1), 8_000)));
    }
  }
  throw lastError;
}

async function downloadOnce(options: DownloadOptions): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = (): void => controller.abort();
  options.cancelSignal?.addEventListener('abort', onAbort, { once: true });

  try {
    let response: Response;
    try {
      response = await fetch(options.url, {
        signal: controller.signal,
        headers: { 'user-agent': 'agentship-toolchain' },
        redirect: 'follow',
      });
    } catch (cause) {
      throw AgentshipError.from(
        ERROR_CODES.TOOL_DOWNLOAD_FAILED,
        `Could not download ${options.url}.`,
        cause,
        { details: { url: options.url } },
      );
    }

    if (!response.ok || response.body === null) {
      throw new AgentshipError(
        ERROR_CODES.TOOL_DOWNLOAD_FAILED,
        `Download of ${options.url} failed with HTTP ${response.status}.`,
        { details: { url: options.url, status: response.status } },
      );
    }

    // A Content-Length that already exceeds the lockfile size means the artifact is not the
    // one that was verified; refuse before transferring hundreds of megabytes.
    const declared = Number(response.headers.get('content-length') ?? Number.NaN);
    if (!Number.isNaN(declared) && declared > options.size) {
      throw new AgentshipError(
        ERROR_CODES.TOOL_SIZE_EXCEEDED,
        `${options.url} advertises ${declared} bytes but the lockfile expects ${options.size}.`,
        { details: { url: options.url, declared, expected: options.size } },
      );
    }

    const hash = createHash('sha256');
    let written = 0;
    // Hashes and counts every byte on its way to disk, so the artifact is never buffered
    // in memory and an over-long transfer is cut off instead of being written out in full.
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        written += chunk.byteLength;
        if (written > options.size) {
          callback(
            new AgentshipError(
              ERROR_CODES.TOOL_SIZE_EXCEEDED,
              `${options.url} sent more than the ${options.size} bytes recorded in the lockfile.`,
              { details: { url: options.url, expected: options.size } },
            ),
          );
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    try {
      // `wx` guarantees we create the file: a pre-existing path (a planted symlink, a
      // leftover from a killed run) is an error rather than a target we overwrite.
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        meter,
        createWriteStream(options.dest, { flags: 'wx', mode: FILE_MODE }),
      );
      const handle = await open(options.dest, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (cause) {
      // A connection dropped mid-transfer surfaces here, not at `fetch()`.
      if (AgentshipError.is(cause)) throw cause;
      throw AgentshipError.from(
        ERROR_CODES.TOOL_DOWNLOAD_FAILED,
        `The transfer of ${options.url} was interrupted after ${written} of ${options.size} bytes.`,
        cause,
        { details: { url: options.url, got: written, expected: options.size } },
      );
    }

    if (written !== options.size) {
      throw new AgentshipError(
        ERROR_CODES.TOOL_DOWNLOAD_FAILED,
        `${options.url} was truncated: got ${written} bytes, expected ${options.size}.`,
        { details: { url: options.url, got: written, expected: options.size } },
      );
    }

    const digest = hash.digest('hex');
    if (digest !== options.sha256) {
      throw new AgentshipError(
        ERROR_CODES.TOOL_CHECKSUM_MISMATCH,
        `Integrity check failed for ${options.url}: expected SHA-256 ${options.sha256}, got ${digest}. ` +
          'The published artifact does not match the one Agentship verified when this version was pinned.',
        {
          details: { url: options.url, expected: options.sha256, actual: digest },
          remediation: {
            summary:
              'Do not retry blindly. Update Agentship: a mismatch means the release changed after it was pinned.',
          },
        },
      );
    }
  } finally {
    clearTimeout(timeout);
    options.cancelSignal?.removeEventListener('abort', onAbort);
  }
}

/** Computes the SHA-256 of a file already on disk, streaming it. */
export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await open(path, 'r');
  try {
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) hash.update(chunk as Uint8Array);
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}
