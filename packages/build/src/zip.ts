import { open } from 'node:fs/promises';
import { inflateRaw } from 'node:zlib';
import { AgentshipError, ERROR_CODES } from '@agentship/core';

/**
 * Reading one file out of a zip without unpacking it, and without a dependency.
 *
 * An `.ipa` and an `.aab` are both zip archives, and Agentship needs exactly two things from
 * them: the `Info.plist` inside `Payload/<App>.app/`, and the presence of the entries that
 * make an app bundle an app bundle. Shelling out to `unzip` would add a host tool that is
 * not guaranteed to exist; unpacking a 200 MB archive to read a 3 KB file would be worse.
 *
 * So this reads the central directory, finds the entry, and inflates that one entry.
 * Deliberately partial: no zip64, no encryption, no multi-disk — the archives both stores
 * produce need none of it, and an archive that does gets an honest error rather than a
 * silent misread.
 */
const END_OF_CENTRAL_DIRECTORY = 0x0605_4b50;
const CENTRAL_FILE_HEADER = 0x0201_4b50;
/** The maximum size of the end-of-central-directory record plus its comment. */
const EOCD_SEARCH_BYTES = 66_000;

export interface ZipEntry {
  readonly name: string;
  readonly compressionMethod: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

async function readTail(path: string, bytes: number): Promise<{ buffer: Buffer; size: number }> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(bytes, size);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return { buffer, size };
  } finally {
    await handle.close();
  }
}

function invalid(path: string, detail: string): AgentshipError {
  return new AgentshipError(
    ERROR_CODES.BUILD_ARTIFACT_INVALID,
    `${path} is not a readable archive: ${detail}`,
    { details: { path } },
  );
}

/** Lists the archive's entries, from its central directory. */
export async function listZipEntries(path: string): Promise<readonly ZipEntry[]> {
  const { buffer: tail, size } = await readTail(path, EOCD_SEARCH_BYTES);
  let eocd = -1;
  for (let offset = tail.length - 22; offset >= 0; offset--) {
    if (tail.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      eocd = offset;
      break;
    }
  }
  if (eocd === -1) throw invalid(path, 'no end-of-central-directory record was found.');

  const entryCount = tail.readUInt16LE(eocd + 10);
  const directorySize = tail.readUInt32LE(eocd + 12);
  const directoryOffset = tail.readUInt32LE(eocd + 16);
  if (directoryOffset === 0xffff_ffff || entryCount === 0xffff) {
    throw invalid(path, 'it uses zip64 extensions, which Agentship does not parse.');
  }
  if (directoryOffset + directorySize > size) {
    throw invalid(path, 'its central directory points outside the file.');
  }

  const handle = await open(path, 'r');
  let directory: Buffer;
  try {
    directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, directoryOffset);
  } finally {
    await handle.close();
  }

  const entries: ZipEntry[] = [];
  let cursor = 0;
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > directory.length) break;
    if (directory.readUInt32LE(cursor) !== CENTRAL_FILE_HEADER) {
      throw invalid(path, 'its central directory is malformed.');
    }
    const nameLength = directory.readUInt16LE(cursor + 28);
    const extraLength = directory.readUInt16LE(cursor + 30);
    const commentLength = directory.readUInt16LE(cursor + 32);
    entries.push({
      name: directory.toString('utf8', cursor + 46, cursor + 46 + nameLength),
      compressionMethod: directory.readUInt16LE(cursor + 10),
      compressedSize: directory.readUInt32LE(cursor + 20),
      uncompressedSize: directory.readUInt32LE(cursor + 24),
      localHeaderOffset: directory.readUInt32LE(cursor + 42),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Reads one entry's bytes. Supports the only two methods these archives use. */
export async function readZipEntry(path: string, entry: ZipEntry): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    // The local header repeats the name and extra field with its own lengths, and only
    // those are authoritative for where the data starts.
    const header = Buffer.alloc(30);
    await handle.read(header, 0, 30, entry.localHeaderOffset);
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
    const compressed = Buffer.alloc(entry.compressedSize);
    await handle.read(compressed, 0, entry.compressedSize, dataOffset);

    if (entry.compressionMethod === 0) return compressed;
    if (entry.compressionMethod !== 8) {
      throw invalid(
        path,
        `entry "${entry.name}" uses compression method ${entry.compressionMethod}.`,
      );
    }
    return await new Promise<Buffer>((resolvePromise, rejectPromise) => {
      inflateRaw(compressed, (error, result) => {
        if (error) rejectPromise(invalid(path, `entry "${entry.name}" could not be inflated.`));
        else resolvePromise(result);
      });
    });
  } finally {
    await handle.close();
  }
}

/** Reads the first entry whose name matches, or `undefined` when there is none. */
export async function readZipFile(
  path: string,
  matches: (name: string) => boolean,
): Promise<{ name: string; contents: Buffer } | undefined> {
  const entries = await listZipEntries(path);
  const entry = entries.find((candidate) => matches(candidate.name));
  if (entry === undefined) return undefined;
  return { name: entry.name, contents: await readZipEntry(path, entry) };
}
