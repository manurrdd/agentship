import { defineConfig } from 'vitest/config';
import { agentshipAliases } from './vitest.aliases.js';

export default defineConfig({
  resolve: {
    // Tests run against the sources, so the suite never depends on a prior build.
    alias: agentshipAliases(),
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Toolchain and credential tests mutate a shared AGENTSHIP_HOME per file; keep files
    // isolated in separate processes so environment overrides never leak between them.
    pool: 'forks',
  },
});
