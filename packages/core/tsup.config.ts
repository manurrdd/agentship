import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  // Declarations are emitted by `tsc --build` (project references); do not clean
  // the output directory or they would be removed.
  dts: false,
  clean: false,
  sourcemap: true,
});
