# Security

Agentship holds the keys to your App Store Connect and Google Play accounts and acts on them
on behalf of an AI agent. This page says what it does with them, what it refuses to do, and
what it cannot protect you from.

Every claim here is a test. The suite in `packages/security/` is a permanent regression
suite for an adversarial audit of the whole product — secret redaction, the toolchain
supply chain, hostile repositories, prompt injection through store and repository content,
the kernel's approval and journal guarantees, the MCP surface and the installer. A
regression in any of those attacks fails the build.

## Credentials

- Stored in the operating system keychain through `@napi-rs/keyring`. Never written to disk
  in plain text, never in the manifest, never in the repository.
- In CI, or on a machine with no keyring, credentials come from environment variables. It is
  all or nothing per store: a half-set group is an error, not a fallback.
- They are materialised for the length of a single store call — an Apple `.p8` becomes a
  `0600` file that is removed afterwards, a Play service account is passed the same way — and
  every value is registered with the redactor before it exists.
- An agent never sees them. `agentship_configure_auth` collects values and stores them; the
  preferred hand-over is the *path* to the downloaded key file, which Agentship reads itself
  so the secret never passes through the conversation (and it warns when that file is
  group- or world-readable). Every response, log line, journal entry and error is scrubbed
  by shape and by literal, so a credential that leaked into a build's stdout is redacted
  before it reaches a model.
- Agentship never asks anyone for a password, a two-factor code, or the login of a store
  account, and the skills instruct agents to refuse if a user offers one.

## What needs a human

The engine classifies every action, and the classification is enforced by the kernel rather
than by convention:

- **Approvals are bound to content.** The id of an action embeds a hash of the exact change.
  An approval for one diff cannot execute a different one, an approval from a stale plan is
  rejected, and an agent cannot construct an id it was not given.
- **Money, privacy, review submissions, deletions and anything reaching production always
  require an approval**, even where the store API would let Agentship act alone.
- **Identity, agreements, tax and banking are human-only.** Agentship will not attempt them
  through any means, and says so instead of offering a workaround.
- **Privacy declarations have two independent gates**: you confirm the *content* of the
  declaration in the manifest, and you approve the *action* that sends it.

## Supply chain

- Two managed binaries (`asc` for Apple, `gpc` for Google) are pinned by version, SHA-256
  and size in `tools.lock.json`, which ships inside the package. A download that does not
  match is deleted and the operation fails; there is no "try again without checking".
- No `curl | bash`, no install scripts with effects in Agentship's own packages, no code
  downloaded at runtime other than those two pinned binaries.
- Published from CI with npm provenance, so every version is traceable to a commit and a
  workflow. Releases are described in [RELEASING.md](RELEASING.md).

## No telemetry

Agentship reports nothing to anybody. It contacts App Store Connect, Google Play and — during
`setup` or `update` — the pinned binary downloads. Nothing else. A test in the end-to-end
suite records every outbound connection during a complete release and fails if there is one,
and a second test fails if any URL outside the stores, their consoles and the pinned
toolchain appears anywhere in the shipped code.

## Untrusted input

A repository is data, never instructions. Agentship reads project files without executing them
(an `app.config.ts` is parsed as text, never evaluated), bounds every file it reads, refuses
symlinks that escape the repository, and keeps values found in a repository out of
instruction text: a console step is a template Agentship wrote, and a value from your project
can only ever appear as a form field an operator reviews. The same rule covers text coming
back from a store, including reviewer messages.

## Known limitation: iOS signing exposes App Store Connect credentials to your build

Signing an iOS app happens *during* `xcodebuild archive`, and that step runs your project's
own build phases and plugins. Apple offers no way to sign without giving the account key to
that step, so `APP_STORE_CONNECT_API_KEY_*` reaches the build subprocess — meaning a
malicious build script in the repository being built could read the `.p8` (mode `0600`, same
user).

This is inherent to the platform, not a defect in Agentship, and it does not affect Android:
an Android build only ever receives the upload keystore password, through a `0600` init
script, never on the command line or in the environment.

The planned remediation is to sign the archive with pre-obtained provisioning profiles and
give the App Store Connect credentials only to `-exportArchive`, which does not run build
phases. Until that ships: **only build repositories you trust**, and prefer a dedicated API
key with the narrowest role your workflow allows.

## Reporting a vulnerability

Open a private security advisory on the repository, or contact the maintainer directly. Do
not open a public issue for anything that involves credentials, signing or the toolchain
lockfile.
