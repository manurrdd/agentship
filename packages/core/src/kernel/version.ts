/**
 * Version stamped into journals, snapshots and plans.
 *
 * Kept as a constant rather than read from package.json so that the kernel stays free of
 * filesystem lookups at import time. It must equal the version of the published `agentship`
 * package; `packages/cli/test/release.test.ts` fails the build when the two drift, and
 * `RELEASING.md` says to change them together.
 */
export const AGENTSHIP_VERSION = '0.3.0';
