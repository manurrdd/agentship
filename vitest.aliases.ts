import { fileURLToPath } from 'node:url';

/**
 * Workspace packages resolved to their sources.
 *
 * Shared by the unit suite and the end-to-end suite so neither depends on a prior build,
 * and so a package added to one is never missing from the other.
 */
const PACKAGES = [
  'core',
  'toolchain',
  'credentials',
  'analyzer',
  'catalog',
  'build',
  'adapter-apple',
  'adapter-google',
  'setup',
  'mcp',
] as const;

export function agentshipAliases(): Record<string, string> {
  return Object.fromEntries(
    PACKAGES.map((pkg) => [
      `@agentship/${pkg}`,
      fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url)),
    ]),
  );
}
