# 200 — Round-3 live-probe plan

Round 2 (100-190) landed T04/T07/shutdown. The 190 lock deferred five rows
for lack of live evidence (T06 maxMode, T02 rotation, #2305 external
continuation, client version watch, T09 cacheRead clamp); T08/T10 stay
deferred for non-live reasons and #2334 stays NEEDS_HUMAN by design. A live
Cursor account now exists on the probe host (macmini, ocx preview), so this
cycle buys the evidence.

## Probes

1. **P-1 maxMode (T06).** Dump GetUsableModels with full ModelDetails —
   which models report maxMode=true, and what contextTokenLimit pairs with
   it. Compare a Run with RequestedModel.maxMode=true vs false on one
   maxMode-capable model: does the server accept it, and does the reported
   context window / usage change? Wire flag only lands if this shows a real
   user-visible gain.
2. **P-2 rotation (T02 / #1527 suspect).** Drive a conversation toward the
   bare 0-token resource_exhausted shape (large-context turns on a pinned
   conversationId). If the server pins the rejection to the conversationId
   (fresh id succeeds with identical payload), T02 rotation is justified;
   implement bounded rotation + checkpoint rekey. If not reproducible within
   quota bounds, record and keep deferred.
3. **P-3 issue #2305.** Reproduce the client-tool continuation returning
   tool-call-like assistant text to Pi: drive a client-tool turn through the
   external continuation path and capture what text frames come back.
   Root-cause lives in rootPromptMessages / userMessageAction continuation
   (the a69d291fb fix covered native Auto; #2305 is the external path).
4. **P-4 client version.** GetUsableModels + one Run with the current pinned
   cli-2026.07.08-0c04a8a vs a newer senpi-observed string
   (cli-2026.07.23-e383d2b): any catalog or behavior delta? Bump only if
   probe shows the new string is accepted and changes nothing adverse.
5. **P-5 billed usage / cacheRead (T09).** Capture the billed turnEnded
   usage int64s (inputTokens / outputTokens / cacheRead*) from the SAME live
   Runs P-1 and P-4 already make (no extra quota): decode and record whether
   cacheRead exceeds 3x input the way senpi's clamp assumes, and whether our
   protobuf-events usage mapping already reports these fields sanely. Verdict
   IMPLEMENT (clamp justified) / NOOP (values sane, clamp unnecessary) /
   BLOCKED (fields absent on this plan tier).

## Probe hygiene (binding, extends doc 100 boundary)

- All transcripts REDACTED before entering devlog: no bearer tokens, no
  account ids, no email, no checksum headers. Raw dumps stay in .tmp/ on the
  probe host and are deleted after the docs lock.
- Quota respect: P-2 large-context attempts are capped (<= 5 runs); if the
  account rate-limits, stop and record BLOCKED for that probe.
- No Safe Storage access, no client patching, no endpoints beyond what the
  adapter already ships (Run, GetUsableModels, RunSSE fallback).

## Outputs

- 210_maxmode.md, 220_rotation.md, 230_issue2305.md, 240_client_version.md —
  each with verdict IMPLEMENT / NOOP / BLOCKED / NEEDS_HUMAN and, for
  IMPLEMENT, diff-level shape.
- 250_billed_usage.md — P-5 verdict for T09 (same contract).
- 290_round3_lock.md — ranked implementation order + updated senpi
  superiority verdict.
