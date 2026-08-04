# Releasing Agentship

One artifact is published: the npm package `agentship`. Every `@agentship/*` workspace package
is bundled into it and stays private, so a release is a single version number and a single
tarball.

The pipeline is [.github/workflows/release.yml](.github/workflows/release.yml): pushing to
`main` opens a Changesets "version packages" pull request, and merging that pull request
publishes the version it created, with `--provenance`, from CI. Nothing is published by
hand from a laptop.

## Before you start

The pipeline needs one secret to publish anything:

- `NPM_TOKEN` in the repository secrets: a **granular access token with write permission on
  `agentship` and nothing else**, never a classic token, with a short expiry. Without it the
  workflow still runs the whole suite and stops at `npm publish --dry-run`, which is a
  supported state — it just does not publish.

Already done and not worth repeating: the `repository` field in `packages/cli/package.json`
(npm provenance fails without it) and two-factor authentication on the npm account.

### How 0.1.0 was published, and why it is the exception

`0.1.0` went out **by hand from a laptop**, because a granular token cannot be scoped to a
package that does not exist yet and the name had to be claimed first. That version therefore
**carries no provenance attestation** — it is the only one that may. Every release from
`0.1.1` on goes through the workflow, with provenance, and a version published any other way
is a bug in the process.

## The checklist

Run it in order. Anything that fails stops the release; none of these steps is optional
because "nothing changed there".

### 1. The toolchain lockfile

`packages/toolchain/tools.lock.json` pins `asc` and `gpc` by version, SHA-256 and size, and
it is the only anchor of trust for those binaries on every user's machine.

- If the tools are unchanged, confirm the file is unchanged: `git diff` must be empty.
- If a tool is being upgraded, regenerate it and **read the diff by hand**:

  ```bash
  pnpm update-tools-lock --asc <tag> --gpc <tag>
  ```

  The script downloads every platform asset, hashes it locally and cross-checks the digest
  against the `checksums.txt` the upstream project publishes. Verify in the diff that: only
  the intended tool changed, every platform got a new digest *and* a new size, the version
  and tag match the upstream release you meant, and the URLs still point at that project's
  own releases. A digest that changes without a version change is a supply-chain signal —
  stop and investigate, do not commit it.

### 2. Catalog freshness

Console instructions rot when a store redesigns a page. Check that the `lastVerified` dates
in `packages/catalog/data/**/*.yaml` are reasonably recent, and spot-check the entries a
first release depends on (`apple:create-app-record`, `google:create-app`,
`google:first-release`, both privacy entries) against the live consoles. Update the steps
and the date together, in one reviewed commit.

### 3. The suite

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm e2e:mock && pnpm build
```

`pnpm test` includes `packages/security`, the permanent regression suite for the security
audit. A failure there is a release blocker, never a flake to retry.

### 4. The gated tests, by hand

CI never runs these: they touch real accounts, real hardware and real money. Run them on a
macOS machine before a release that changes anything about builds, adapters or the
toolchain. The preparation, credentials and costs are in
[e2e/REAL_TESTING.md](e2e/REAL_TESTING.md).

```bash
AGENTSHIP_E2E_CLI=1 pnpm vitest run packages/mcp/test/cli-surface.e2e.test.ts
AGENTSHIP_PACK_TEST=1 AGENTSHIP_E2E_NETWORK=1 pnpm vitest run packages/cli/test/pack.test.ts
AGENTSHIP_E2E_BUILD=1 pnpm vitest run packages/build/test/real-build.e2e.test.ts
AGENTSHIP_E2E_APPLE=1 AGENTSHIP_E2E_TEST_BUNDLE_ID=… AGENTSHIP_E2E_TEST_APP_ID=… \
  pnpm vitest run packages/mcp/test/real-store.e2e.test.ts
AGENTSHIP_E2E_GOOGLE=1 AGENTSHIP_E2E_TEST_PACKAGE=… \
  pnpm vitest run packages/mcp/test/real-store.e2e.test.ts
```

`AGENTSHIP_E2E_CLI` is the cheapest of these and the one with no excuse: it needs no account
and no credentials, only the network, and it is the **only** check that the argv in
`commands.ts` is still the argv `asc` and `gpc` accept. Every other adapter test answers the
tool from a fixture, so a renamed flag passes the whole offline suite and fails on the user's
first real publish. Run it on every tool version bump, before regenerating the lockfile.

The clean install is run on both platforms: the same `pack` command on macOS and on Linux
(a container is fine). What it proves is that the tarball carries the skills and the runtime
data, that the bundle runs with only its declared third-party dependencies, and that
`agentship setup --yes` and `agentship doctor` work on a machine that has never seen Agentship.

### 5. Dependencies

- `pnpm audit --audit-level moderate` — read it, do not merely run it.
- No new dependency without a reason written in the pull request: what it replaces, how
  maintained it is, what it pulls in transitively.
- No `postinstall`, `install`, `preinstall` or `prepare` script in any Agentship package. The
  end-to-end suite fails if one appears.
- Versions stay pinned by the lockfile; `pnpm install --frozen-lockfile` in CI.

### 6. Version and changeset

```bash
pnpm changeset
```

Describe the change in the words a user would use. Then bump `AGENTSHIP_VERSION` in
`packages/core/src/kernel/version.ts` to the version the changeset will produce — it is
stamped into journals, snapshots and plans, and `packages/cli/test/release.test.ts` fails if
it disagrees with the package version.

The very first release is the exception: `0.1.0` is already in `packages/cli/package.json`,
nothing is on the registry yet, and `changeset publish` publishes it as it stands. Every
release after it goes through a changeset.

Semver is strict from `0.1.0` on. The manifest schema, the MCP tool names and the pending
operation ids are public contract: changing any of them is a major.

### 7. Merge and publish

Merge the "version packages" pull request. The workflow runs the whole suite again, builds,
and publishes with provenance from a protected workflow using OIDC — no long-lived
credential is ever present in the runner.

Verify afterwards:

```bash
npm view agentship version
npm view agentship dist.provenance
```

and install the published package on a clean machine:

```bash
npm install -g agentship@latest && agentship doctor
```

## If the publish must be done by a human

Publishing from a laptop is a fallback, not a path. It loses provenance, so use it only if
CI is unavailable and the release cannot wait:

```bash
pnpm build
pnpm --filter agentship exec npm publish --dry-run   # read the file list
pnpm --filter agentship exec npm publish             # asks for the 2FA code
```

Then open an issue to publish the next version from CI, and say in the release notes that
this version has no provenance attestation.

## Open security work tracked across releases

- **iOS signing exposes App Store Connect credentials to the build subprocess** (M6 in the
  audit). Documented in [SECURITY.md](SECURITY.md) as a known limitation until the archive
  is signed with pre-obtained profiles and the credentials reach only `-exportArchive`.
  Validating that change needs a macOS machine with Xcode and a real Apple account, so it
  ships with a gated end-to-end test, not with unit tests.
