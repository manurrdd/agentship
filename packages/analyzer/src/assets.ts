import type { AssetInventory, ImageAsset, Platform } from '@agentship/core';
import type { RepoFs } from './repo-fs.js';

/**
 * Inventory of the store-facing assets a repository already contains.
 *
 * The point is not to validate them — the stores do that, and their rules change — but to
 * tell an agent what exists before it asks the user for anything: an app icon that is
 * already committed does not need to be requested, and screenshots already laid out in the
 * `fastlane` convention can be uploaded as they are.
 */

const APP_ICON_PATTERNS: readonly RegExp[] = [
  // iOS asset catalogue.
  /Assets\.xcassets\/AppIcon\.appiconset\/[^/]+\.(png|jpg|jpeg)$/i,
  // Android launcher icons, including adaptive foregrounds.
  /res\/mipmap-[^/]+\/ic_launcher[^/]*\.(png|webp)$/i,
  // Expo / Flutter conventional locations.
  /(^|\/)assets\/(icon|app-icon|adaptive-icon)\.(png|jpg|jpeg)$/i,
];

const SCREENSHOT_PATTERNS: readonly { pattern: RegExp; platform?: Platform }[] = [
  { pattern: /fastlane\/screenshots\/.+\.(png|jpg|jpeg)$/i, platform: 'ios' },
  {
    pattern: /fastlane\/metadata\/android\/.+\/images\/.+\.(png|jpg|jpeg)$/i,
    platform: 'android',
  },
  { pattern: /(^|\/)screenshots\/.+\.(png|jpg|jpeg)$/i },
  { pattern: /(^|\/)store\/(ios|android)\/.+\.(png|jpg|jpeg)$/i },
];

const LISTING_PATTERNS: readonly RegExp[] = [
  /fastlane\/metadata\/.+\.txt$/i,
  /fastlane\/(Deliverfile|Appfile|Supplyfile)$/,
  /(^|\/)store\/.+\.(md|txt)$/i,
];

/** Reads width and height from a PNG header. Other formats report no dimensions. */
function pngDimensions(header: Buffer): { width: number; height: number } | undefined {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (header.byteLength < 24 || !header.subarray(0, 8).equals(signature)) return undefined;
  // IHDR is always the first chunk: width and height are big-endian at offsets 16 and 20.
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

async function toImageAsset(fs: RepoFs, path: string): Promise<ImageAsset> {
  const bytes = (await fs.fileSize(path)) ?? 0;
  const header = await fs.readHeader(path, 32);
  const dimensions = header === undefined ? undefined : pngDimensions(header);
  return { path, bytes, ...(dimensions ?? {}) };
}

export async function collectAssets(fs: RepoFs): Promise<AssetInventory> {
  const files = await fs.files();

  const iconPaths = files.filter((file) => APP_ICON_PATTERNS.some((p) => p.test(file)));
  const appIcons = await Promise.all(iconPaths.map((path) => toImageAsset(fs, path)));

  const screenshots: (ImageAsset & { platform?: Platform })[] = [];
  for (const file of files) {
    const match = SCREENSHOT_PATTERNS.find((entry) => entry.pattern.test(file));
    if (match === undefined) continue;
    const asset = await toImageAsset(fs, file);
    screenshots.push({
      ...asset,
      ...(match.platform === undefined ? {} : { platform: match.platform }),
    });
  }

  return {
    appIcons: appIcons.sort((a, b) => a.path.localeCompare(b.path)),
    screenshots: screenshots.sort((a, b) => a.path.localeCompare(b.path)),
    listingFiles: files.filter((file) => LISTING_PATTERNS.some((p) => p.test(file))).sort(),
  };
}
