# Testing against the real thing

`pnpm e2e:mock` runs everything in this directory against in-memory stores: complete agent
journeys, the kill matrix and the no-telemetry check. It needs no account, no network and no
credentials, and it is what CI runs.

This page is about the other suite — the tests that talk to App Store Connect and Google
Play, download the managed binaries, and build real apps. They are **gated behind
environment variables, never run in CI, and cost real money to set up**. Run them by hand
before a release, on a macOS machine. The release checklist that calls them is
[RELEASING.md](../RELEASING.md).

## What you need, and what it costs

| | Cost | Why |
|---|---|---|
| Apple Developer Program | 99 USD / year | Any App Store Connect API access at all |
| Google Play Developer account | 25 USD, once | Any Play Developer API access at all |
| A throwaway app in each store | — | Never use a real product's record |
| macOS with Xcode | — | The only way to produce an `.ipa` |
| A JDK and the Android SDK | — | To produce an `.aab` |

Create a **test app in each store that no customer will ever see**, and use those. The
scenarios stop well short of anything irreversible — TestFlight and the internal test track
are the ceiling, nothing submits for review, nothing touches production — but the way to
keep it that way is to point them at an app whose worst case is embarrassment.

Google Play additionally requires the app record to exist and Play App Signing to be
configured before the API accepts an upload; a brand new personal account also has the
12-testers-for-14-days closed testing requirement before production, which these tests never
reach.

## Credentials

Store them the way a user would, in the keychain, under a dedicated profile:

```bash
AGENTSHIP_E2E_PROFILE=agentship-e2e
```

Apple needs an App Store Connect API key (Users and Access → Integrations → App Store
Connect API) with the App Manager role: the issuer id, the key id and the `.p8` file, which
Apple gives you exactly once. Google needs a service account JSON from the Cloud project
linked to your Play account, with the app granted to it in Play Console → Users and
permissions.

Set them through an agent with `agentship_configure_auth`, or through the environment
variables `agentship_setup_status` lists. Never commit any of them; the `.p8` and the service
account JSON stay outside the repository.

## The suites

### The published package, installed clean

Builds the package, packs it, installs the tarball into a fresh directory and runs the
binary: `--version`, `setup --yes`, `doctor --json`, `uninstall`. With `AGENTSHIP_E2E_NETWORK`
it also downloads the pinned binaries, which is the only way `doctor` can be entirely green.
No store account needed.

```bash
AGENTSHIP_PACK_TEST=1 AGENTSHIP_E2E_NETWORK=1 pnpm vitest run packages/cli/test/pack.test.ts
```

Run it on macOS **and** on Linux (a `node:20` container with pnpm is enough).

### The toolchain, downloaded for real

Downloads every pinned binary for this platform and verifies it against the lockfile
(~250 MB).

```bash
AGENTSHIP_E2E_NETWORK=1 pnpm vitest run packages/toolchain/test/network-smoke.test.ts
```

### Real builds

Generates Flutter and Gradle fixtures on the fly — a committed Xcode project or Gradle
wrapper rots with every tooling release — and builds them, including the case where the
project has no release signing and Agentship supplies the key through a `0600` init script.
Takes minutes and writes into `~/.agentship`.

```bash
AGENTSHIP_E2E_BUILD=1 pnpm vitest run packages/build/test/real-build.e2e.test.ts
```

### Real stores, read-only and TestFlight

Drives a real MCP session against the real adapters. Approvals are filtered by
classification rather than taken wholesale, so a scenario cannot submit for review by
accident.

```bash
AGENTSHIP_E2E_APPLE=1 \
AGENTSHIP_E2E_TEST_BUNDLE_ID=com.you.testapp \
AGENTSHIP_E2E_TEST_APP_ID=1234567890 \
  pnpm vitest run packages/mcp/test/real-store.e2e.test.ts

AGENTSHIP_E2E_GOOGLE=1 \
AGENTSHIP_E2E_TEST_PACKAGE=com.you.testapp \
  pnpm vitest run packages/mcp/test/real-store.e2e.test.ts
```

Optional, for the scenarios that need them: `AGENTSHIP_E2E_TEST_VERSION`,
`AGENTSHIP_E2E_TEST_BUILD`, `AGENTSHIP_E2E_PRODUCTS=1` with `AGENTSHIP_E2E_TEST_PRODUCT`.

### Adapter smoke tests

The narrowest real check: do the credentials work and does the pinned binary speak the API
this adapter expects. Reads only.

```bash
AGENTSHIP_E2E_APPLE=1 pnpm vitest run packages/adapter-apple/test/smoke.test.ts
AGENTSHIP_E2E_GOOGLE=1 AGENTSHIP_E2E_GOOGLE_PACKAGE=com.you.testapp \
  pnpm vitest run packages/adapter-google/test/smoke.test.ts
```

## Rules

- **Never point these at an app with customers.** Not the internal track, not TestFlight,
  not "just a metadata change".
- **Never put real credentials in CI.** These suites exist because that is not safe; the
  mock suite is what a pull request runs.
- If a run leaves something behind in a store — a draft version, an uploaded build — clean it
  up in the console. The tests are careful, but a killed test run is not.
