import { fileURLToPath } from 'node:url';

/**
 * Where the shipped data lives, resolved in exactly one place.
 *
 * It has to be one place because the `agentship` CLI bundles every workspace package into a
 * single `dist/bin.js`: after bundling, every `import.meta.url` in this package is that one
 * file, so a path written relative to `src/privacy/` and a path written relative to `src/`
 * would resolve to the same directory at runtime and to different ones in development.
 * Resolving once, at `src/` depth, makes both modes agree — and the CLI's build copies
 * `data/` next to `dist/` so the bundle finds it.
 */
export const DATA_DIR = fileURLToPath(new URL('../data', import.meta.url));
