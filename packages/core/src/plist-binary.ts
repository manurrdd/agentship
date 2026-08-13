/**
 * Reading Apple's binary property list format, `bplist00`.
 *
 * Everything Xcode packages into a built `.app` is a binary plist: the `Info.plist` inside
 * an exported `.ipa` is *always* `bplist00`, never the XML the source tree holds. The `plist`
 * npm package parses XML only, and handing it a binary buffer decoded as UTF-8 does not fail
 * loudly — it mangles the bytes first and then reports a missing root element, which reads
 * like a corrupt archive rather than the wrong parser.
 *
 * So the format is decoded here. The same reasoning as `@agentship/build`'s zip reader
 * applies: the need is narrow (a handful of scalars out of a small, fully specified
 * container), a dependency for it would cost more than it saves, and a hand-rolled reader
 * can be honest about its limits. Deliberately partial, and it says so — object types that
 * an `Info.plist` never contains are rejected rather than guessed at, because a decoder that
 * silently returns the wrong bundle id is worse than one that refuses.
 *
 * Reference: CFBinaryPList.c, the format Apple has shipped unchanged since `bplist00`.
 */

/** The 8-byte magic every binary plist starts with. */
const MAGIC = 'bplist00';
/** Header magic plus the fixed 32-byte trailer: shorter than this cannot be a plist. */
const MIN_LENGTH = 40;
const TRAILER_LENGTH = 32;

/** True when these bytes are a binary property list rather than XML. */
export function isBinaryPlist(bytes: Buffer): boolean {
  return bytes.length >= MIN_LENGTH && bytes.subarray(0, 8).toString('latin1') === MAGIC;
}

/** Raised when the buffer is not a binary plist this reader can decode. */
export class BinaryPlistError extends Error {
  constructor(detail: string) {
    super(`Not a readable binary property list: ${detail}`);
    this.name = 'BinaryPlistError';
  }
}

export type PlistValue =
  | string
  | number
  | boolean
  | null
  | Date
  | Buffer
  | PlistValue[]
  | { [key: string]: PlistValue };

interface Trailer {
  readonly offsetIntSize: number;
  readonly objectRefSize: number;
  readonly objectCount: number;
  readonly rootObject: number;
  readonly offsetTableOffset: number;
}

/**
 * Decodes a binary property list.
 *
 * Throws {@link BinaryPlistError} for anything it cannot read faithfully — a truncated file,
 * a reference outside the object table, a cycle, or an object type outside the subset below.
 */
export function parseBinaryPlist(bytes: Buffer): PlistValue {
  if (!isBinaryPlist(bytes)) throw new BinaryPlistError('the bplist00 header is missing.');

  const trailer = readTrailer(bytes);
  const offsets = readOffsetTable(bytes, trailer);
  if (trailer.rootObject >= offsets.length) {
    throw new BinaryPlistError('the root object reference points outside the object table.');
  }
  // A malicious or corrupt file can describe a cycle; the object graph of a plist is a tree,
  // so revisiting an object while it is still being decoded is always a defect.
  return readObject(bytes, trailer, offsets, trailer.rootObject, new Set());
}

function readTrailer(bytes: Buffer): Trailer {
  const start = bytes.length - TRAILER_LENGTH;
  const offsetIntSize = bytes.readUInt8(start + 6);
  const objectRefSize = bytes.readUInt8(start + 7);
  // The counts are 64-bit, but a plist Agentship reads is kilobytes: anything that does not
  // fit a safe integer is corrupt, and reading the low half of a huge value would be a lie.
  const objectCount = readBigOffset(bytes, start + 8, 'the object count');
  const rootObject = readBigOffset(bytes, start + 16, 'the root object reference');
  const offsetTableOffset = readBigOffset(bytes, start + 24, 'the offset table position');

  if (offsetIntSize < 1 || offsetIntSize > 8) {
    throw new BinaryPlistError(`the offset integer size is ${offsetIntSize}.`);
  }
  if (objectRefSize < 1 || objectRefSize > 8) {
    throw new BinaryPlistError(`the object reference size is ${objectRefSize}.`);
  }
  if (offsetTableOffset + objectCount * offsetIntSize > start) {
    throw new BinaryPlistError('the offset table extends past the trailer.');
  }
  return { offsetIntSize, objectRefSize, objectCount, rootObject, offsetTableOffset };
}

function readBigOffset(bytes: Buffer, at: number, what: string): number {
  const value = bytes.readBigUInt64BE(at);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BinaryPlistError(`${what} is larger than this reader supports.`);
  }
  return Number(value);
}

function readOffsetTable(bytes: Buffer, trailer: Trailer): readonly number[] {
  const offsets: number[] = [];
  for (let index = 0; index < trailer.objectCount; index++) {
    const at = trailer.offsetTableOffset + index * trailer.offsetIntSize;
    const offset = readUIntBE(bytes, at, trailer.offsetIntSize);
    if (offset >= bytes.length - TRAILER_LENGTH) {
      throw new BinaryPlistError(`object ${index} is stored past the end of the file.`);
    }
    offsets.push(offset);
  }
  return offsets;
}

/** Big-endian unsigned integer of 1–8 bytes, refusing widths that lose precision. */
function readUIntBE(bytes: Buffer, at: number, size: number): number {
  if (at + size > bytes.length) throw new BinaryPlistError('an integer runs past the end.');
  if (size <= 6) return bytes.readUIntBE(at, size);
  let value = 0n;
  for (let index = 0; index < size; index++) {
    value = (value << 8n) | BigInt(bytes[at + index] as number);
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BinaryPlistError('an integer is larger than this reader supports.');
  }
  return Number(value);
}

/** The length of a variable-sized object: the marker's low nibble, or the integer after it. */
function readLength(
  bytes: Buffer,
  at: number,
  nibble: number,
): { readonly length: number; readonly next: number } {
  if (nibble !== 0x0f) return { length: nibble, next: at };
  ensureAvailable(bytes, at, 1, 'an extended length marker');
  const marker = bytes.readUInt8(at);
  if ((marker & 0xf0) !== 0x10) {
    throw new BinaryPlistError('an extended length is not encoded as an integer.');
  }
  const size = 2 ** (marker & 0x0f);
  return { length: readUIntBE(bytes, at + 1, size), next: at + 1 + size };
}

// Apple counts dates from 2001-01-01 UTC, not from the Unix epoch.
const APPLE_EPOCH_OFFSET_MS = Date.UTC(2001, 0, 1);

function readObject(
  bytes: Buffer,
  trailer: Trailer,
  offsets: readonly number[],
  index: number,
  visiting: Set<number>,
): PlistValue {
  if (visiting.has(index)) throw new BinaryPlistError('the object graph contains a cycle.');
  const offset = offsets[index];
  if (offset === undefined) {
    throw new BinaryPlistError(`object ${index} is referenced but not in the offset table.`);
  }

  ensureAvailable(bytes, offset, 1, `object ${index}`);
  const marker = bytes.readUInt8(offset);
  const type = marker & 0xf0;
  const nibble = marker & 0x0f;

  if (type === 0x00) {
    if (nibble === 0x00) return null;
    if (nibble === 0x08) return false;
    if (nibble === 0x09) return true;
    throw new BinaryPlistError(`unsupported singleton marker 0x${marker.toString(16)}.`);
  }
  if (type === 0x10) {
    // Integers are signed only at 16 bytes wide; the 1/2/4-byte forms are unsigned and the
    // 8-byte form is signed, which is how CFBinaryPList writes negative numbers.
    const size = 2 ** nibble;
    if (size === 8) {
      ensureAvailable(bytes, offset + 1, size, 'an integer');
      const value = bytes.readBigInt64BE(offset + 1);
      if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
        throw new BinaryPlistError('an integer is larger than this reader supports.');
      }
      return Number(value);
    }
    if (size > 8) throw new BinaryPlistError(`an integer is ${size} bytes wide.`);
    return readUIntBE(bytes, offset + 1, size);
  }
  if (type === 0x20) {
    if (nibble === 0x02) {
      ensureAvailable(bytes, offset + 1, 4, 'a real');
      return bytes.readFloatBE(offset + 1);
    }
    if (nibble === 0x03) {
      ensureAvailable(bytes, offset + 1, 8, 'a real');
      return bytes.readDoubleBE(offset + 1);
    }
    throw new BinaryPlistError(`a real is 2^${nibble} bytes wide.`);
  }
  if (type === 0x30) {
    ensureAvailable(bytes, offset + 1, 8, 'a date');
    return new Date(bytes.readDoubleBE(offset + 1) * 1000 + APPLE_EPOCH_OFFSET_MS);
  }
  if (type === 0x40) {
    const { length, next } = readLength(bytes, offset + 1, nibble);
    ensureAvailable(bytes, next, length, 'a data object');
    return Buffer.from(bytes.subarray(next, next + length));
  }
  if (type === 0x50) {
    const { length, next } = readLength(bytes, offset + 1, nibble);
    ensureAvailable(bytes, next, length, 'an ASCII string');
    // "ASCII" in the specification; Apple writes only 7-bit bytes here, and latin1 decodes
    // those identically while never throwing on a stray high byte.
    return bytes.subarray(next, next + length).toString('latin1');
  }
  if (type === 0x60) {
    const { length, next } = readLength(bytes, offset + 1, nibble);
    ensureAvailable(bytes, next, length * 2, 'a UTF-16 string');
    // `swap16` works in place, and `subarray` shares memory with the input — so the slice is
    // copied first, or reading a string would corrupt the buffer for every later read.
    return Buffer.from(bytes.subarray(next, next + length * 2))
      .swap16()
      .toString('utf16le');
  }
  if (type === 0x80) {
    // A UID only appears in keyed archives, never in an Info.plist, but reading it as its
    // integer value is faithful rather than a guess.
    return readUIntBE(bytes, offset + 1, nibble + 1);
  }
  if (type === 0xa0 || type === 0xc0) {
    const { length, next } = readLength(bytes, offset + 1, nibble);
    ensureAvailable(bytes, next, length * trailer.objectRefSize, 'an array reference list');
    const nested = new Set(visiting).add(index);
    const items: PlistValue[] = [];
    for (let item = 0; item < length; item++) {
      const ref = readUIntBE(bytes, next + item * trailer.objectRefSize, trailer.objectRefSize);
      items.push(readObject(bytes, trailer, offsets, ref, nested));
    }
    return items;
  }
  if (type === 0xd0) {
    const { length, next } = readLength(bytes, offset + 1, nibble);
    ensureAvailable(bytes, next, length * trailer.objectRefSize * 2, 'a dictionary reference list');
    const nested = new Set(visiting).add(index);
    const valuesAt = next + length * trailer.objectRefSize;
    const result: Record<string, PlistValue> = {};
    for (let entry = 0; entry < length; entry++) {
      const keyRef = readUIntBE(bytes, next + entry * trailer.objectRefSize, trailer.objectRefSize);
      const key = readObject(bytes, trailer, offsets, keyRef, nested);
      if (typeof key !== 'string') {
        throw new BinaryPlistError('a dictionary key is not a string.');
      }
      const valueRef = readUIntBE(
        bytes,
        valuesAt + entry * trailer.objectRefSize,
        trailer.objectRefSize,
      );
      result[key] = readObject(bytes, trailer, offsets, valueRef, nested);
    }
    return result;
  }
  throw new BinaryPlistError(`unsupported object marker 0x${marker.toString(16)}.`);
}

function ensureAvailable(bytes: Buffer, at: number, size: number, what: string): void {
  if (!Number.isSafeInteger(at) || !Number.isSafeInteger(size) || at < 0 || size < 0) {
    throw new BinaryPlistError(`${what} has an invalid position or size.`);
  }
  if (at + size > bytes.length - TRAILER_LENGTH) {
    throw new BinaryPlistError(`${what} runs past the object table.`);
  }
}
