import { cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

/**
 * `agentship` is the only publishable package: every `@agentship/*` workspace package is
 * bundled into its output, so a clean `npm install` pulls nothing but the third-party
 * dependencies declared in package.json.
 *
 * Three data sets are read at runtime relative to the module that needs them — the pinned
 * toolchain lockfile, the analyzer's catalogs and the console-operation catalog with its
 * privacy taxonomies — so they are copied next to `dist/`, where the bundle resolves them,
 * and shipped through `files`.
 *
 * They share one `data/` directory because the bundle collapses every module into
 * `dist/bin.js`: after bundling, every `new URL('../data/…', import.meta.url)` in any
 * workspace package points at the same place. The trees do not collide — the analyzer ships
 * `*.json` at the root, the catalog ships `apple/`, `google/` and `privacy/`.
 */
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: ['src/bin.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: false,
  clean: false,
  sourcemap: true,
  noExternal: [/^@agentship\//],
  banner: { js: '#!/usr/bin/env node' },
  // Bundle the workspace packages from their TypeScript sources (the `agentship-source`
  // export condition) instead of from their build output, so packaging never depends on
  // the order the other packages happened to be built in.
  esbuildOptions(options) {
    options.conditions = ['agentship-source'];
  },
  async onSuccess() {
    // npm shows the README of the package directory, and there is only one README worth
    // showing; copying it keeps the npm page and the repository from ever disagreeing.
    await cp(join(here, '../../README.md'), join(here, 'README.md'));
    await cp(join(here, '../toolchain/tools.lock.json'), join(here, 'tools.lock.json'));
    await cp(join(here, '../analyzer/data'), join(here, 'data'), { recursive: true });
    await cp(join(here, '../catalog/data'), join(here, 'data'), { recursive: true });
  },
});
