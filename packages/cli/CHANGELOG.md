# agentship

## 0.3.0

### Minor Changes

- d25cc6f: Fixes from auditing every real use of Agentship recorded across Claude Code and Codex
  sessions — two independent corpora, five projects, and three defects that each returned
  success while doing the wrong thing.

  **Publishing the wrong bytes, silently**

  - A packaged `Info.plist` is a binary plist and was being parsed as XML, so verification
    failed on every `.ipa` Xcode actually produces. Agentship now reads `bplist00`.
  - A recorded artifact was reused whenever its own hash still matched, which ignores the
    project it was built from: changing an app icon without bumping the build number
    published the previous binary. Builds now record a fingerprint of their inputs.
  - Screenshots were staged as symlinks. `asc` rejects those outright and `gpc` skips them
    and reports success — an upload that uploaded nothing. They are copied now.

  **Money**

  - Play prices every region in that region's own currency, and one currency taken from the
    base territory was being stamped on all of them: `IN: 199` meaning ₹199 was sent as 199
    USD. Each territory is now denominated in its own currency.
  - Apple speaks ISO 3166-1 alpha-3 and Google alpha-2, and whatever the manifest said was
    passed through to both — so one manifest could not serve two stores, and the schema's own
    `US` default produced a phantom extra territory on Apple. A single canonical table now
    reconciles them; either spelling is accepted.
  - `strategy` no longer defaults to `convert`. Declaring `territories` _is_ the statement
    that those prices were chosen, so nothing else is proposed alongside them.
  - New `price.rounding: "pretty"` adopts the nearest conventional price for the currency
    (`1.82 → 1.99`, `203 → 199`); the default still sends the number as written, and says in
    the plan when a price has a shape App Store Connect has no price point for.

  **Approvals**

  - An action id no longer hashes the store's current value, only what the action will make
    true — so applying part of a plan stops expiring approvals for everything else. External
    drift still withdraws them, now as a stated rule rather than a side effect of hashing.
  - `agentship_apply` accepts a plan id as a single approval covering that exact plan.
    Submitting for review and releasing a held version always need their own.

  **Plans, errors and noise**

  - A differ that fails now blocks only its own resource; a missing screenshot no longer
    stops an unrelated build and upload. `ReleasePlan` gains `blocked` (schema version 3).
  - Manifest validation reports a flat `(path, message)` list that survives redaction,
    instead of a tree that arrived truncated, and every missing screenshot at once.
  - A schema failure inside the engine is no longer reported as a bad tool argument.
  - `agentship_pending verify` answers for first-release steps the catalog knows and no plan
    has emitted — the step users were told to perform was the one they could not confirm.
  - `concise` responses no longer repeat the whole plan after an apply, which was 88% of it.
  - `agentship_analyze` reports nested Agentship projects instead of leaving them to diverge.

  **Tests**

  - Credential tests no longer read the real OS keyring, where a failure printed a real
    private key into an assertion diff.

## 0.2.0

### Minor Changes

- 398c9c4: Closes the gaps two real publishing runs found.

  **Breaking.** `release.track` is now required in `.agentship/agentship.yaml`. It
  used to default to `internal_testing` silently, which is how a release meant for
  closed testing reached the wrong audience. Add one of `internal_testing`,
  `closed_testing`, `open_testing` or `production` under `release:`; a manifest
  without it now fails to load, naming the field and the four valid values.

  `agentship_pending` with `action: "verify"` answers with a `verifications` array
  instead of the previous single `verified`/`detail` pair, and accepts `ids` to
  verify several operations against one store read.

  Also in this release:

  - The generated manifest carries the build number the project already declares
    (Flutter's `+n`, Expo, `CFBundleVersion`, `versionCode`) instead of asking for
    it, and reveals the `pricing`, `review` and `monetization` sections it accepts.
  - The price of the app itself is planned from `manifest.pricing` on Apple, so it
    no longer has to be set by hand.
  - The plan reports what the store itself refuses (App Store Connect's own
    pre-submission report) and where the store already disagrees with the
    manifest, before an approval overwrites published text.
  - A contradiction between the code and the store — an ads SDK next to an age
    rating that declares no advertising — is reported without waiting for the
    privacy declaration to be confirmed.
  - The console itinerary is ordered by its prerequisites and separates
    contingencies from the work that is actually pending.
  - App Store Connect and Google Play credentials can be handed over as a file
    path, so the key never passes through the conversation.
