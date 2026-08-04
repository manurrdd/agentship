# Agentship

Publish an iOS or Android app by talking to your coding agent.

Agentship is an MCP server plus three agent skills. You install it once; after that you say
"publish my app" to Claude Code, Codex, Cursor, Gemini CLI or VS Code, and the agent reads
your repository, builds the app, plans the release, shows you each change, and applies only
what you approve. Anything the stores expose no API for comes back as exact console
instructions — the page, the steps, and the values already filled in.

**Agentship is a tool for AIs.** Its whole interface is the MCP server and the skills that
teach an agent to use it. This page, [PLATFORM-LIMITS.md](PLATFORM-LIMITS.md) and
[SECURITY.md](SECURITY.md) are the only documentation written for you.

## Install

```bash
npm install -g agentship
```

```bash
agentship setup --yes
```

`setup` downloads the two managed binaries it talks to the stores with (pinned versions,
checksums verified), registers the MCP server with every agent it finds on this machine,
and installs the skills. `agentship doctor` tells you whether it worked.

Requires Node 20+ on macOS or Linux. Building an `.ipa` also requires macOS with Xcode.

## Ask your agent this

> Analyse this repository with Agentship and tell me what publishing it would involve.

> Set up my App Store Connect credentials.

> Plan a 1.2.0 release to TestFlight and show me what would change.

> Publish 1.2.0 to the internal testing track on Google Play.

> How is my app doing? Is the build still processing?

> The review was rejected — what do I do?

You never type an API key into a chat, and you never approve "everything": the agent shows
you one change at a time, with the exact before and after.

## What is automatic and what is not

Automatic, through the store APIs: listing text and screenshots, uploading builds, tester
groups and tracks, versions, prices and in-app products, phased rollouts, Play Data Safety,
submitting for review — each after you approve that specific change.

Not automatic, because no API exists: creating the app record, developer enrolment,
agreements, tax and banking, content rating on Play, Apple's App Privacy answers, Play App
Signing, the first release on Play. Agentship hands these over as structured console steps and
verifies the result afterwards wherever a store lets it be verified.

The full boundary, generated from the code that enforces it, is in
[PLATFORM-LIMITS.md](PLATFORM-LIMITS.md).

## The manifest

Agentship keeps the desired state of your release in `.agentship/agentship.yaml`, generated from
the analysis of your repository. It is yours: commit it, edit it, and let the agent fill the
gaps it marks. Everything Agentship does is the difference between that file and what the
stores currently hold.

## Security in five lines

- Credentials live in your OS keychain (or environment variables in CI), never in plain
  text, never in a log, never in an agent's context.
- Nothing that spends money, changes privacy answers, or reaches production happens without
  an approval bound to that exact change, and identity, tax and banking are yours alone.
- The two managed binaries are pinned by version and SHA-256; a mismatch stops everything.
- No telemetry: Agentship contacts the two stores and nothing else, ever.
- Details and the known limitation of iOS signing: [SECURITY.md](SECURITY.md).

## For contributors

```bash
pnpm install && pnpm test && pnpm e2e:mock
```

`pnpm test` is the unit, contract and security suite; `pnpm e2e:mock` runs complete agent
journeys, the kill matrix and the no-telemetry check against in-memory stores. Real store
and real build tests are gated — see [e2e/REAL_TESTING.md](e2e/REAL_TESTING.md). Releasing
is documented in [RELEASING.md](RELEASING.md).

MIT licensed.
