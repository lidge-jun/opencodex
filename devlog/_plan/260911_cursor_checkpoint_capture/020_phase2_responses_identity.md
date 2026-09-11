# wp3 — is the fresh `conversationId` chat-completions-specific

Decides C2. Independent of wp2.

## What was seen, and what it does not yet prove

Two sequential `/v1/chat/completions` turns produced two different `conversationId`
values and `checkpointInvalidationReason: missing_ref` on both. That endpoint carries
no Responses state, so a fresh identity per turn may be correct there rather than a
defect.

`src/adapters/cursor.ts` reads the prior identity from
`_parsed._providerContinuation?.cursor?.checkpointRef` and `_parsed._cursorConversationId`,
and the builder comment says it "may derive a stable provider id from the client thread
when Responses state is unavailable". Whether that derivation actually holds across
turns is the open question.

Codex uses `/v1/responses`. If identity is stable there, C2 is not user-facing and the
honest outcome is to record that and close the half.

## Procedure

1. `ocx debug provider on`; record the baseline line count.
2. Turn 1: `POST /v1/responses`, `store: true`, model `cursor/auto-intelligence`,
   trivial prompt. Capture the response `id`.
3. Turn 2: `POST /v1/responses` with `previous_response_id` set to that `id`.
4. Compare the two `[ocx:cursor:run-request]` lines on `conversationId`,
   `checkpointPresent`, `checkpointInvalidationReason`, `continuationMode`.
5. `ocx debug provider off`.

## Decision rule

- **STABLE** — same `conversationId` on both turns and `checkpointPresent: true` on
  turn 2. C2 is an artifact of the stateless endpoint. Record and close.
- **UNSTABLE-IDENTITY** — `conversationId` differs between the two turns. That is C2
  on the path users take. Go to `030` branch B.
- **STABLE-IDENTITY-STORE-MISS** — `conversationId` matches but `checkpointPresent`
  is false with `missing_ref`. Folded from the wp1 audit (medium): the original rule
  ORed these two, but `request-builder.ts:454` returns `missing_ref` whenever no
  thread or ref is resolved, which is reachable with a perfectly stable id. This is a
  different defect — the checkpoint store, not identity — and needs its own doc before
  any patch. Do not route it to branch B.
- **BLOCKED** — the proxy rejects the Responses shape for this provider. Record what it
  rejected; do not infer the answer from the chat-completions result.

## Result — STABLE

Run 2026-09-11 on macbookpro-2, same account and toggle. Two `/v1/responses` turns,
`store: true`, second carrying `previous_response_id` from the first. Log read with a
fixed tail, not the line-count windowing that `012` shows is void.

```
turn 1  resp_dccfe5a37e224d1e908567403c53db10
[ocx:cursor:checkpoint-continuation] {"mode":"full-replay","conversationHash":"cursor_cdbed7dcc","checkpointRefHash":"717a262274c68762","checkpointBytes":492,"wireModel":"default"}

turn 2  resp_e023130d5f684c159951cd8458e72914  (previous_response_id set)
[ocx:cursor:checkpoint-continuation] {"mode":"checkpoint","conversationHash":"cursor_cdbed7dcc","checkpointRefHash":"e28ce47f916e7213","checkpointBytes":595,"wireModel":"default"}
```

**STABLE.** `conversationHash` is identical across both turns, and turn 2 reports
`mode: checkpoint` rather than `full-replay` — the continuation resumed from the
checkpoint turn 1 committed, which is exactly the behaviour `#4245` says is missing.

### What this removes from the issue

C2 does not affect a `/v1/responses` conversation that threads
`previous_response_id`, which is what a Codex session does. That is the shape the
reporter was running.

**Scoped precisely, folded from the wp3 audit (near-pass residual):** the earlier
wording claimed C2 closes for all `/v1/responses` users. It does not. A Responses
request with **no** `previous_response_id` drops `_cursorConversationId`
(`src/server/responses/core.ts:533`) and mints a fresh one
(`src/adapters/cursor/request-builder.ts:361`) unless a thread owner exists, so that
call is in the same position as chat-completions. `store: false` *with*
`previous_response_id` is not a hole (`core.ts:461`, `core.ts:6619`).

So: **closed without a patch for threaded conversations**, which is the reported
scenario; an unthreaded one-shot Responses call still starts fresh, and that is
expected rather than defective — there is no prior conversation to resume.

That also sharpens what is left. The reporter sees `cached_tokens: 0` and full replay;
plain multi-turn conversation on `/v1/responses` demonstrably does not do that. So the
surviving defect is C1 — turns that emit a client tool, where the checkpoint is
cancelled away before it can be captured. Branch B in `030` is not needed.
