# A release, end to end

A worked example of the conversation. The tool payloads are abbreviated; the shape is real.

## 1. Understand the app

```
agentship_analyze({ projectDir: "/Users/x/apps/lumo" })
```

```json
{
  "analysis": {
    "framework": { "framework": "flutter", "confidence": "certain" },
    "identity": { "bundleId": { "value": "com.acme.lumo", "confidence": "certain",
                                "source": "ios/Runner/Info.plist" } },
    "warnings": [{ "code": "MISSING_USAGE_DESCRIPTION", "severity": "warning", "…": "…" }]
  },
  "manifest": { "path": ".agentship/agentship.yaml", "created": true,
                "gaps": ["metadata.locales.en-US.description"] }
}
```

Say what was found, flag the warnings that will block a review, and ask **only** about the
gaps:

> It's a Flutter app, bundle id `com.acme.lumo`, version 1.4.0 — all read straight from the
> project. One thing I can't know: the App Store description. What should it say?
>
> Also, `NSCameraUsageDescription` has no purpose string; Apple rejects that on review.

Write the answer into `.agentship/agentship.yaml` (replacing the `<needs_input>` sentinel).

## 2. Check the machine

```
agentship_setup_status()
```

If `credentials.apple.source` is `none`, run the credential flow before planning Apple.
A store without credentials only blocks that store.

## 3. Plan

```
agentship_plan()
```

```json
{
  "plan": {
    "planId": "plan-8f3c…",
    "counts": { "actions": 3, "byClassification": { "auto": 1, "needs_approval": 2 } },
    "approvalsRequired": ["set_metadata:listing:1a2b…", "submit_for_review:release/1.4.0:9c8d…"],
    "actions": [
      { "id": "upload_build:build/210:44ef…", "classification": "auto",
        "summary": "Upload build 210 (1.4.0)" },
      { "id": "set_metadata:listing:1a2b…", "classification": "needs_approval",
        "diff": [{ "path": "metadata.en-US.description",
                   "before": "Old text", "after": "New text" }] },
      { "id": "submit_for_review:release/1.4.0:9c8d…", "classification": "needs_approval",
        "riskNotes": ["This submission targets production and will reach end users once approved."] }
    ]
  }
}
```

Present it as changes, one decision at a time:

> Two things need your approval:
>
> 1. **Listing text (en-US)** — description changes from "Old text" to "New text". OK?
> 2. **Submit 1.4.0 for review** — this one reaches real users once Apple approves. OK?
>
> I'll also upload build 210, which is reversible and doesn't need approval.

Wait for a real answer to each. "Do whatever you think" is not an approval for #2 — ask
again, concretely.

## 4. Apply

```
agentship_apply({ planId: "plan-8f3c…", approvals: ["set_metadata:listing:1a2b…"] })
```

Only what was approved goes in. The response:

```json
{
  "ok": true,
  "outcomes": [
    { "actionId": "upload_build:build/210:44ef…", "status": "done", "changed": true },
    { "actionId": "set_metadata:listing:1a2b…", "status": "done", "changed": true },
    { "actionId": "submit_for_review:release/1.4.0:9c8d…", "status": "needs_approval" }
  ],
  "staleApprovals": [],
  "plan": { "planId": "plan-b71a…", "approvalsRequired": ["submit_for_review:release/1.4.0:77aa…"] }
}
```

The submission id **changed** (`9c8d…` → `77aa…`) because the upload changed the store.
That is expected. Re-present the submission diff from the new plan and ask again.

## 5. What has no API

If the response carries `emittedPending`, or a status is `blocked`:

```
agentship_pending({ action: "get", id: "google:content-rating" })
```

```json
{
  "pending": {
    "actionClass": "agent_browser",
    "reason": "The IARC questionnaire is only available in the Play Console UI.",
    "console": { "url": "https://play.google.com/console/…", "path": ["Policy", "App content"] },
    "steps": ["Open App content", "Start the content rating questionnaire", "…"],
    "fields": [{ "name": "category", "proposedValue": "Utility", "rationale": "…" }],
    "blocking": ["submit_for_review:release/1.4.0:77aa…"]
  }
}
```

Proposed values are proposals. Show them, let the user decide, then
`action: "complete"` and `action: "verify"`. Once verified, `agentship_apply` (or
`agentship_resume`) runs what it was blocking.

For `human_only` operations — agreements, tax, banking, identity — hand over the steps and
stop. Do not attempt them.

## 6. When something breaks

Connection lost, machine slept, store returned an error:

```
agentship_resume()
```

Agentship reads its journal, asks the store what really happened and re-plans. A build
already uploaded is not uploaded twice; a submission that never landed comes back as a
normal action. There is nothing to clean up by hand, ever.

## 7. Report

Say what changed, what is waiting on the review team, and what the user still has to do
themselves. Check later with `agentship_store_status()` rather than promising an outcome
Agentship cannot see.
