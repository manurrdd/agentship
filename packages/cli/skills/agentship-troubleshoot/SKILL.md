---
name: agentship-troubleshoot
description: Diagnose and recover Agentship failures — tools that will not run, credentials the store rejects, interrupted or failed applies, stale approvals, agents that no longer see the Agentship MCP server, and when to tell the user to run agentship setup, update or doctor. Use whenever an agentship_* tool returns an error or the publishing flow stops making progress.
---

# When Agentship fails

Every Agentship error is structured: `code`, `message`, `retryable`, usually `remediation`,
sometimes `details`. Read the remediation first — it is written for you to relay — and look
the code up in `references/errors.md`. Do not invent a fix that contradicts it.

## Triage in three questions

1. **Is it about this app, or about the machine?**
   Codes starting with `TOOL_`, `AUTH_` or `CONFIG_` are about the installation: run
   `agentship_doctor`. Codes starting with `STORE_`, `PLAN_` or `ANALYZE_` are about this
   project.
2. **Is it retryable?** `retryable: true` (rate limits, store outages, download failures) is
   the only case where repeating the same call unchanged is reasonable. Wait, then retry.
   Everything else needs something to change first.
3. **Did an apply stop halfway?** Then the answer is almost always `agentship_resume`.

## Recovering an interrupted run

`agentship_resume()` — always safe, including when you are not sure anything is broken.

Agentship reads its write-ahead journal, asks the store what actually happened, and re-plans
against the answer. Consequences worth telling the user:

- A non-idempotent operation (build upload, review submission) is never performed twice.
- Work that already landed simply is not in the new plan.
- If the journal is unreadable (`PLAN_JOURNAL_CORRUPT`), Agentship ignores every claim in it
  and verifies against the store instead. Slower, never dangerous.
- Never delete `.agentship/state/` to "start clean": that is the record of what really
  happened, and losing it makes recovery worse, not better.

## A build that fails

`BUILD_*` errors come from the user's own build system running on the user's own machine, so
the fix is almost never "try again". Read the `remediation`; the diagnosis already
distinguishes the cases that look alike.

- **`BUILD_PLATFORM_UNSUPPORTED`** — an `.ipa` needs macOS. Nothing on this machine changes
  that: build it on a Mac (or a macOS CI runner) and point `release.artifacts.apple` at the
  file. Everything else Agentship does still works from here.
- **`BUILD_TOOL_MISSING`** — Xcode, a JDK or the Flutter SDK is absent. Agentship does not
  install them; relay the exact command the remediation names.
- **`BUILD_SIGNING_FAILED`** — read which one it is. No certificate, an unregistered bundle
  id, unaccepted developer agreements and a wrong keystore password all look similar and have
  four different fixes. Unaccepted agreements come back as a `human_only` pending operation:
  no retry will ever succeed until a human accepts them.
- **`BUILD_ARTIFACT_INVALID`** — the artifact contradicts the release, usually because the
  project hard-codes its version. Do not upload it. Either align the manifest with the
  project or stop hard-coding the value so Agentship can inject it.
- **`BUILD_UNSUPPORTED_PROJECT`** — usually an Expo managed project. Never run
  `expo prebuild` for the user; offer the two documented ways out.

The full log is a file, and its path is in the error. Never paste it into the conversation:
summarise the diagnosis and offer the path.

`agentship_build` with `action:"status"` is the cheap way to check a machine before promising
anything — it compiles nothing.

## Stale approvals are not a bug

`staleApprovals` in an apply response means the store changed after the user approved —
often because the same apply changed it. The ids rotate by design; the content hash they
carry no longer matches.

Do: take the fresh `plan` from the same response, present the diffs again, ask the user,
send the new ids. Do not retry the old ids, and never approve the new ones yourself because
"it is the same change" — and never offer to approve everything at once to save a round
trip. Recovery is exactly when a mis-approval does the most damage.

`PLAN_NOT_FOUND` means the same thing for a plan id: call `agentship_plan` and use the new one.

## Installation problems

`agentship_doctor()` returns a check list with statuses. `fail` blocks publishing; `warn` does
not (a store with no credentials, for instance, only blocks that store).

These fixes are terminal commands the **user** runs — you cannot run them through this
server, so relay them:

- `agentship setup --yes` — install or repair the managed binaries, register the MCP server,
  install the skills.
- `agentship update --yes` — bring binaries and skills to this Agentship version. Suggest it
  when doctor reports a version drift, an outdated skill, or a registration pointing at a
  different installation.
- `agentship doctor` — the same checks from a terminal, `--json` for a script.
- `agentship uninstall --yes` — remove registrations, skills and binaries. Repositories are
  never touched.

If a check says a skill was edited after installation, say so plainly: `agentship update`
would overwrite those edits.

## Credentials the store rejects

`STORE_UNAUTHORIZED` or `AUTH_PERMISSION_DENIED` after a working setup usually means the
role, not the key:

- Apple: the key needs the **App Manager** role. A Developer-role key cannot edit App Store
  metadata. Roles cannot be changed after creation — a new key is needed.
- Google: the service account must be invited in **Play Console → Users and permissions**
  with release permissions, and the Google Play Android Developer API must be enabled in
  the Cloud project that owns it. Permission changes take a few minutes to propagate.

Re-run `agentship_configure_auth` for that store when a new credential is needed. Creating a
credential is `human_only` in both stores — the console gates it behind two-factor
authentication — so relay the steps and wait. Never ask for a password or a 2FA code:
those are never part of any Agentship flow.

## What not to do

- Do not work around a store limitation with another tool: if Agentship says an operation has
  no API, it has no API. `references/errors.md` and the coverage table are the truth.
- Do not retry a `TOOL_CHECKSUM_MISMATCH`. A managed binary that does not match its pinned
  hash is a supply-chain signal: stop and report it to the user.
- Do not edit `.agentship/state/` or `.agentship/pending/` by hand.
- Do not restart the interview because something failed: values Agentship read from the
  project (`certain`) are still right, and a proposed value the user already decided on
  stays decided. Re-ask only for what the error actually names.
- Do not hide a failure behind a summary. Name the action that failed and the store's own
  message.

## References

- `references/errors.md` — every error code and what to do about it, generated from the code.
