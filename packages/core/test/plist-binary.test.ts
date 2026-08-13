import { describe, expect, it } from 'vitest';
import { BinaryPlistError, isBinaryPlist, parseBinaryPlist } from '../src/plist-binary.js';

/**
 * The reader for the only `Info.plist` form a built app ever contains.
 *
 * These are byte-level tests on purpose. The defect this file exists to prevent was not a
 * wrong value: it was a reader that could not open the format at all, hidden because every
 * fixture in the suite was the XML form no packaged artifact uses.
 */

/** Minimal encoder, mirroring what Apple writes for the shapes below. */
function encode(objects: readonly Buffer[], rootIndex = 0): Buffer {
  const header = Buffer.from('bplist00', 'latin1');
  const offsets: number[] = [];
  let cursor = header.length;
  for (const object of objects) {
    offsets.push(cursor);
    cursor += object.length;
  }
  const table = Buffer.from(offsets);
  const trailer = Buffer.alloc(32);
  trailer.writeUInt8(1, 6);
  trailer.writeUInt8(1, 7);
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(BigInt(rootIndex), 16);
  trailer.writeBigUInt64BE(BigInt(cursor), 24);
  return Buffer.concat([header, ...objects, table, trailer]);
}

/** An ASCII string object; 15 characters or more move the length into a trailing integer. */
const ascii = (value: string): Buffer =>
  Buffer.concat([
    value.length < 15
      ? Buffer.from([0x50 | value.length])
      : Buffer.from([0x5f, 0x10, value.length]),
    Buffer.from(value, 'latin1'),
  ]);

describe('reading a binary property list', () => {
  it('recognises the format by its header, not by its extension', () => {
    expect(isBinaryPlist(encode([Buffer.from([0x08])]))).toBe(true);
    expect(isBinaryPlist(Buffer.from('<?xml version="1.0"?><plist></plist>'))).toBe(false);
    expect(isBinaryPlist(Buffer.from('bplist00'))).toBe(false); // header alone, no trailer
  });

  it('reads a dictionary of strings, the shape an Info.plist actually has', () => {
    const plist = encode([
      Buffer.from([0xd2, 0x01, 0x02, 0x03, 0x04]),
      ascii('CFBundleIdentifier'),
      ascii('CFBundleVersion'),
      ascii('com.example.app'),
      ascii('412'),
    ]);
    expect(parseBinaryPlist(plist)).toEqual({
      CFBundleIdentifier: 'com.example.app',
      CFBundleVersion: '412',
    });
  });

  it('reads UTF-16 text without disturbing the buffer for later reads', () => {
    const text = 'Ejemplo — ünïcode';
    const utf16 = Buffer.from(text, 'utf16le').swap16();
    const plist = encode([
      Buffer.from([0xd1, 0x01, 0x02]),
      ascii('CFBundleDisplayName'),
      Buffer.concat([Buffer.from([0x60 | 0x0f, 0x10, text.length]), utf16]),
    ]);
    const before = Buffer.from(plist);
    expect(parseBinaryPlist(plist)).toEqual({ CFBundleDisplayName: text });
    expect(plist.equals(before)).toBe(true);
    // Reading twice must give the same answer; an in-place byte swap would not.
    expect(parseBinaryPlist(plist)).toEqual({ CFBundleDisplayName: text });
  });

  it('reads the scalars and containers a bundle carries alongside its identity', () => {
    const plist = encode([
      Buffer.from([0xd4, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]),
      ascii('required'),
      ascii('count'),
      ascii('capabilities'),
      ascii('fraction'),
      Buffer.from([0x09]),
      Buffer.from([0x11, 0x01, 0x2c]),
      Buffer.from([0xa1, 0x09]),
      Buffer.from([0x23, 0x3f, 0xf8, 0, 0, 0, 0, 0, 0]),
      ascii('arm64'),
    ]);
    expect(parseBinaryPlist(plist)).toEqual({
      required: true,
      count: 300,
      capabilities: ['arm64'],
      fraction: 1.5,
    });
  });

  it('refuses a buffer that is not a binary plist at all', () => {
    expect(() => parseBinaryPlist(Buffer.from('<?xml version="1.0"?>'))).toThrow(BinaryPlistError);
  });

  it('refuses a reference that points outside the object table', () => {
    const plist = encode([Buffer.from([0xd1, 0x09, 0x09]), ascii('key')]);
    expect(() => parseBinaryPlist(plist)).toThrow(BinaryPlistError);
  });

  it('refuses a cycle instead of recursing forever', () => {
    // An array whose only element is itself: legal bytes, impossible value.
    const plist = encode([Buffer.from([0xa1, 0x00])]);
    expect(() => parseBinaryPlist(plist)).toThrow(/cycle/);
  });

  it('refuses an object type it cannot read faithfully', () => {
    const plist = encode([Buffer.from([0xf0])]);
    expect(() => parseBinaryPlist(plist)).toThrow(/unsupported object marker/);
  });

  it('refuses truncated object payloads instead of silently returning partial values', () => {
    // Claims a 5-byte string, but the object has only one payload byte before its offset table.
    const plist = encode([Buffer.from([0x55, 0x61])]);
    expect(() => parseBinaryPlist(plist)).toThrow(/runs past/);
  });
});
