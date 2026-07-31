# Issue #44 — Request logs can miss successful ChatGPT native passthrough turns

- **Reporter:** 0disoft (ZeroDi)
- **URL:** https://github.com/<repo>/issues/44
- **Type:** Bug (observability / request-log finalization)
- **Severity:** Medium — no functional impact on turns; logs are incomplete.
- **Status:** Root-caused; reporter's analysis confirmed in code. Fix described
  below (NOT applied — documentation phase).

## Report summary

Successful `gpt-5.5` / `chatgpt` native-passthrough SSE turns complete in Codex
but do not appear in `/api/logs`, while routed providers (`umans`, `opencode-go`)
and a non-stream `chatgpt` 503 do appear. Suspected to be a follow-up edge case to
the native passthrough SSE workaround from #31.

## Root-cause analysis (confirmed)

Native passthrough SSE deliberately bypasses the normal request-log wrapper:

- `src/server.ts` `responseWithDeferredRequestLog()` (L1090) returns early for
  native passthrough responses:
  ```ts
  if (isNativePassthroughSseResponse(response)) { return response; }   // L1101
  ```
  So the normal `trackSseForRequestLog(...)` finalizer never runs for these.

- The client body comes from `upstreamResponse.body.tee()` (server.ts ~L498):
  branch[0] is relayed natively to the client; branch[1] is consumed in the
  background by `consumeForInspection(...)` (server.ts L1260), which is the ONLY
  path that can finalize a log entry for native passthrough.

- The terminal callback wired into `consumeForInspection` is `reportNativeTerminal`
  (server.ts ~L503-511):
  ```ts
  const reportNativeTerminal = (status) => {
    if (options.abortSignal?.aborted) { options.onNativePassthroughCancel?.(); return; }
    recordTerminal(status);
    options.onNativePassthroughTerminal?.(status);
  };
  ```

The gap is inside `consumeForInspection` (server.ts L1260-1320). On the
client-cancel / abort path it sets `cancelled = true` and **suppresses** the
terminal callback:

- Early-abort branch: `if (signal.aborted) { cancelled = true; reader.cancel(); return; }`
  → returns before `pump()`; **neither `onTerminal` nor `onDone` fires**.
- Mid-pump abort: the `done` branch and the `catch` branch both guard with
  `if (!reported && !cancelled) onTerminal("incomplete")` → with `cancelled=true`
  this is skipped, so `onTerminal` is **never** called.

Because `reportNativeTerminal` is only invoked through `consumeForInspection`'s
`onTerminal`, the `onNativePassthroughCancel?.()` branch is effectively dead on
the cancel path — neither terminal nor cancel finalization happens.

Why successful turns go missing: Codex frequently disconnects the client
connection the instant it has finished consuming the response. That aborts the
shared signal while the teed inspection branch (branch[1]) is still draining,
so `consumeForInspection` exits via the cancelled path → no terminal payload
detected → no `/api/logs` entry, even though the turn succeeded.

Secondary path: when `terminalBodyWillRecord` is false (no codex-forward terminal
recorder), the code uses `consumeForResponseLogMetadata(...)` (server.ts ~L1323)
which inspects metadata only and **never finalizes a log entry at all**.

Aggravating factor (reporter-noted): `/api/logs` is memory-only (`requestLog`,
max 200). A crash/restart in the window drops prior-process successes.

## Proposed solution (not applied)

Goal: a successful or cancelled native passthrough turn should always record
exactly one terminal `/api/logs` entry.

1. In `consumeForInspection` (server.ts L1260), on the cancelled path call a
   dedicated cancel finalizer instead of silently returning — e.g. invoke
   `onTerminal` with a cancel sentinel, or add an `onCancel` parameter that the
   native passthrough wiring maps to a `499` / `closeReason: "client_cancel"`
   log entry. Ensure `onDone?.()` runs on the early-abort branch too (currently
   it returns before `finally`).
2. Make `reportNativeTerminal` finalize on cancel: have the cancel path call
   `options.onNativePassthroughCancel?.()` from a place that actually executes
   (today it cannot, because `consumeForInspection` swallows the cancel).
3. Cover the `consumeForResponseLogMetadata` branch so a non-terminal-recorder
   native passthrough still finalizes one log entry.
4. (Separate, optional) Persist `/api/logs` to disk (or a ring buffer file) so
   entries survive proxy restarts.

Answers to reporter's questions:
- Q1 Yes — finalize on client cancel / inspection-pump abort as `499`
  `closeReason: "client_cancel"`.
- Q2 Yes — `consumeForInspection` should call a terminal/cancel callback even when
  `cancelled = true`.
- Q3 A focused PR with a regression test for native passthrough SSE
  cancel/finalization is the right first step; log persistence can be a separate
  change.

## Verification approach

- Regression test in `tests/`: simulate a native passthrough SSE response whose
  client aborts mid/after stream; assert exactly one `/api/logs` entry is recorded
  (status `499` on cancel, or the terminal status on success-then-disconnect).
- Manual: drive a real `gpt-5.5` passthrough turn via Codex and confirm it now
  appears in `/api/logs`.

## Effort & risk

- Effort: small-medium (callback plumbing + 1-2 tests). Persistence is larger and
  optional.
- Risk: low-medium. Must not double-log (guard with the existing `reported` flag)
  and must not block/disturb the client-facing native relay (branch[0]).
