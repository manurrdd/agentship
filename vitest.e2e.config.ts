import { defineConfig } from 'vitest/config';
import { agentshipAliases } from './vitest.aliases.js';

/**
 * The end-to-end suite: `pnpm e2e:mock`.
 *
 * Separate from the unit suite because it is a different question — not "does this module
 * behave" but "does a whole publication work" — and because it is slower: every scenario
 * runs a full agent conversation, and the kill matrix runs several dozen of them.
 */
export default defineConfig({
  resolve: { alias: agentshipAliases() },
  test: {
    include: ['e2e/scenarios/**/*.e2e.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Each scenario file owns an AGENTSHIP_HOME through the environment; forks keep them apart.
    pool: 'forks',
  },
});
