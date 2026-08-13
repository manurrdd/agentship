import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

/**
 * Building real archives in memory, so the artifact checks are exercised against bytes
 * rather than against a mock of themselves.
 *
 * A hand-written zip writer is the point: `verifyArtifact` refuses an artifact whose
 * `Info.plist` contradicts the release, and the only way to test that honestly is to
 * produce an `.ipa` that really contains a plist saying so.
 */
export interface ZipFileEntry {
  readonly name: string;
  readonly contents: Buffer | string;
  /** Store the entry uncompressed, to cover the method-0 path too. */
  readonly store?: boolean;
}

function crc32(buffer: Buffer): number {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xeda8_8320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

/** Writes a minimal but standards-correct zip archive. */
export function makeZip(entries: readonly ZipFileEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.contents)
      ? entry.contents
      : Buffer.from(entry.contents, 'utf8');
    const method = entry.store === true ? 0 : 8;
    const data = method === 0 ? raw : deflateRawSync(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x0403_4b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x0201_4b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc32(raw), 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += 30 + name.length + data.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x0605_4b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

export function infoPlist(fields: Readonly<Record<string, string>>): string {
  const entries = Object.entries(fields)
    .map(([key, value]) => `\t<key>${key}</key>\n\t<string>${value}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${entries}
</dict>
</plist>
`;
}

/**
 * Encodes a flat dictionary as an Apple *binary* property list.
 *
 * This exists because the XML writer above is not what Xcode produces. A packaged
 * `Info.plist` is always `bplist00`, so an `.ipa` fixture built from XML tests a shape no
 * real artifact has — which is exactly how a reader that could not decode binary plists
 * passed a full suite while failing on every archive a user actually built.
 *
 * Only the encodings a real `Info.plist` uses are emitted: ASCII and UTF-16 strings,
 * booleans, integers and string arrays, in one dictionary.
 */
export type PlistField = string | boolean | number | readonly string[];

export function binaryInfoPlist(fields: Readonly<Record<string, PlistField>>): Buffer {
  const objects: Buffer[] = [];
  /** Appends one object and returns the reference an owner stores. */
  const add = (bytes: Buffer): number => objects.push(bytes) - 1;

  const marker = (type: number, count: number): Buffer =>
    count < 15
      ? Buffer.from([type | count])
      : // 0x10 is the one-byte integer form; a fixture never needs a wider count.
        Buffer.from([type | 0x0f, 0x10, count]);

  const addString = (value: string): number => {
    // Printable ASCII takes the 0x50 form and anything else the UTF-16 one, exactly as
    // Apple writes them, so both branches of the reader are exercised by real fixtures.
    if (/^[ -~]*$/.test(value)) {
      return add(Buffer.concat([marker(0x50, value.length), Buffer.from(value, 'latin1')]));
    }
    const utf16 = Buffer.from(value, 'utf16le').swap16();
    return add(Buffer.concat([marker(0x60, value.length), utf16]));
  };

  const addValue = (value: PlistField): number => {
    if (typeof value === 'boolean') return add(Buffer.from([value ? 0x09 : 0x08]));
    if (typeof value === 'number') {
      const bytes = Buffer.alloc(5);
      bytes.writeUInt8(0x12, 0);
      bytes.writeUInt32BE(value, 1);
      return add(bytes);
    }
    if (Array.isArray(value)) {
      const refs = value.map((item) => addString(item as string));
      return add(Buffer.concat([marker(0xa0, refs.length), Buffer.from(refs)]));
    }
    return addString(value as string);
  };

  // The dictionary must be object 0 (the root), but its entries have to be encoded before
  // their references are known, so its slot is reserved and filled in afterwards.
  const rootIndex = add(Buffer.alloc(0));
  const entries = Object.entries(fields);
  const keyRefs = entries.map(([key]) => addString(key));
  const valueRefs = entries.map(([, value]) => addValue(value));
  objects[rootIndex] = Buffer.concat([
    marker(0xd0, entries.length),
    Buffer.from(keyRefs),
    Buffer.from(valueRefs),
  ]);

  const header = Buffer.from(MAGIC, 'latin1');
  const offsets: number[] = [];
  let cursor = header.length;
  for (const object of objects) {
    offsets.push(cursor);
    cursor += object.length;
  }

  // The offset table's integer width is whatever the largest offset needs. A real
  // `Info.plist` is over 256 bytes, so it is the two-byte form in practice — assuming one
  // byte silently truncates every offset past the first few objects.
  const offsetIntSize = cursor < 0x100 ? 1 : cursor < 0x1_0000 ? 2 : 4;
  const table = Buffer.alloc(offsets.length * offsetIntSize);
  for (const [index, offset] of offsets.entries()) {
    table.writeUIntBE(offset, index * offsetIntSize, offsetIntSize);
  }

  const trailer = Buffer.alloc(32);
  trailer.writeUInt8(offsetIntSize, 6);
  trailer.writeUInt8(1, 7); // objectRefSize — a fixture stays well under 256 objects
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(BigInt(rootIndex), 16);
  trailer.writeBigUInt64BE(BigInt(cursor), 24);

  return Buffer.concat([header, ...objects, table, trailer]);
}

const MAGIC = 'bplist00';

/**
 * A structurally valid `.ipa` declaring the given identity.
 *
 * Binary by default, because that is what Xcode exports; `xml: true` covers the
 * hand-assembled or re-signed archives that still carry the textual form.
 */
export function makeIpa(fields: {
  bundleId: string;
  version: string;
  buildNumber: string;
  /** Write the `Info.plist` as XML instead of the binary form Xcode produces. */
  xml?: boolean;
  extra?: Readonly<Record<string, PlistField>>;
}): Buffer {
  const identity = {
    CFBundleIdentifier: fields.bundleId,
    CFBundleShortVersionString: fields.version,
    CFBundleVersion: fields.buildNumber,
  };
  return makeZip([
    {
      name: 'Payload/Example.app/Info.plist',
      contents:
        fields.xml === true
          ? infoPlist(identity)
          : binaryInfoPlist({ ...identity, ...(fields.extra ?? {}) }),
    },
    { name: 'Payload/Example.app/Example', contents: 'MZ-not-really-a-binary' },
  ]);
}

/** A structurally valid `.aab`: the two entries that make it an app bundle. */
export function makeAab(): Buffer {
  return makeZip([
    { name: 'BundleConfig.pb', contents: Buffer.from([0x0a, 0x02, 0x08, 0x01]), store: true },
    { name: 'base/manifest/AndroidManifest.xml', contents: Buffer.from([0x03, 0x00, 0x08, 0x00]) },
    { name: 'base/dex/classes.dex', contents: 'dex\n035' },
  ]);
}

export interface Scratch {
  readonly dir: string;
  file(name: string, contents: Buffer | string): Promise<string>;
  cleanup(): Promise<void>;
}

export async function scratch(): Promise<Scratch> {
  const dir = await mkdtemp(join(tmpdir(), 'agentship-build-'));
  return {
    dir,
    async file(name, contents) {
      const path = join(dir, name);
      await writeFile(path, contents);
      return path;
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
