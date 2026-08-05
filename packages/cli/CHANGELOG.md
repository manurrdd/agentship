# agentship

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
