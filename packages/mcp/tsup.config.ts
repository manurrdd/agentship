import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: false,
  clean: false,
  sourcemap: true,
  external: [
    '@agentship/build',
    '@agentship/core',
    '@agentship/credentials',
    '@agentship/toolchain',
    '@agentship/analyzer',
    '@agentship/adapter-apple',
    '@agentship/adapter-google',
    '@agentship/setup',
  ],
});
