# Changesets

Every change that reaches users needs one. `pnpm changeset` writes a markdown file here
describing what changed and how the version should move; the release workflow turns the
accumulated files into a version bump and a changelog entry.

Only `agentship` is published — the `@agentship/*` workspace packages are bundled into it and
stay private — so a changeset almost always names that one package.

`AGENTSHIP_VERSION` in `packages/core/src/kernel/version.ts` must move with it. See
[RELEASING.md](../RELEASING.md).
