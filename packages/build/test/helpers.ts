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

/** A structurally valid `.ipa` declaring the given identity. */
export function makeIpa(fields: {
  bundleId: string;
  version: string;
  buildNumber: string;
}): Buffer {
  return makeZip([
    {
      name: 'Payload/Example.app/Info.plist',
      contents: infoPlist({
        CFBundleIdentifier: fields.bundleId,
        CFBundleShortVersionString: fields.version,
        CFBundleVersion: fields.buildNumber,
      }),
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
