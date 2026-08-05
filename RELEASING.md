# Releasing Agentship

One artifact is published: the npm package `agentship`. Every `@agentship/*` workspace package
is bundled into it and stays private, so a release is a single version number and a single
tarball.

The pipeline is [.github/workflows/release.yml](.github/workflows/release.yml): pushing to
`main` opens a Changesets "version packages" pull request, and merging that pull request
publishes the version it created, with `--provenance`, from CI. Nothing is published by
hand from a laptop.

## Before you start

The pipeline needs no secret to publish, and that is the point. `agentship` names this
repository and `release.yml` as a **trusted publisher** on npm, so the runner exchanges its
OIDC identity for a credential that lives for minutes and can do nothing else. The package
is therefore set to npm's strictest publishing access — *two-factor authentication required,
tokens disallowed* — which is exactly what trusted publishing lets you keep: there is no
token left to steal, and provenance is generated automatically.

Two consequences worth knowing before changing anything:

- **Renaming `release.yml` breaks publishing.** npm matches the workflow by filename. Rename
  it on npm first, in the package's trusted publisher settings.
- **The Node version in `release.yml` is load-bearing.** Trusted publishing needs npm 11.5.1
  or later, which needs Node 22.14 or later. Lowering it turns publishing off.

Never enable *Bypass two-factor authentication* on the package to work around a publish
failure. It does not grant an exception to this pipeline; it permanently allows any token
with write access to publish, which is the door supply-chain attacks walk through.

Already done and not worth repeating: the `repository` field in `packages/cli/package.json`
(npm provenance fails without it) and two-factor authentication on the npm account.

### How 0.1.0 was published, and why it is the exception

`0.1.0` went out **by hand from a laptop**, because neither a token nor a trusted publisher
can be scoped to a package that does not exist yet and the name had to be claimed first.
That version therefore **carries no provenance attestation** — it is the only one that may.
Every release after it goes through the workflow, with provenance, and a version published
any other way is a bug in the process.

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

Describe the change in the words a user would use. Leave `AGENTSHIP_VERSION` in
`packages/core/src/kernel/version.ts` alone: `pnpm changeset:version` runs
`scripts/sync-version.ts` after bumping the packages, so the constant travels in the same
commit as the version it must match. Bumping it by hand instead only moves the red build —
`packages/cli/test/release.test.ts` fails whenever the constant and the package version
disagree, and they disagree either from the changeset until the version pull request lands,
or inside that pull request itself.

The very first release is the exception: `0.1.0` is already in `packages/cli/package.json`,
nothing is on the registry yet, and `changeset publish` publishes it as it stands. Every
release after it goes through a changeset.

Semver is strict from `0.1.0` on. The manifest schema, the MCP tool names and the pending
operation ids are public contract. While the package is below `1.0.0` a breaking change is a
`minor`, which is what semver already means at `0.x` and what keeps the version from claiming
a stability the project has not committed to yet; from `1.0.0` on it is a `major`. Either
way it is stated in the changeset, in the words the user will read in the changelog.

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
