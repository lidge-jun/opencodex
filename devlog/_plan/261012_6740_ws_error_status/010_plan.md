# 6740 — keep the Codex WebSocket error frame's own status and terminal kind

Issue: lidge-jun/opencodex#6740. Base: origin/dev 7af092ca4f.
Prior work on the same issue: #6889 (v2.83.0, recognized bare-error classes keep 429/503),
#6860 (v2.82.0, sliding failure window + opt-in WS reuse). The reporter runs 2.80.0, which has neither.

## What the reported row means (verified by source reading)

Reported row: status 502, errorCode upstream_server_error, failureStage protocol-prelude,
failureCause upstream-fault, terminalSource synthetic, codexWsStage sent=true, upstreamFrames 5-6,
relayedEvents 3-4, closeCode null, attempts 1, upstreamError "An error occurred while processing your request...".

1. `src/server/responses/codex-ws-exchange.ts` onMessage relays every non-control `response.*` or
   `error` frame as SSE and ends the exchange on `response.completed|failed|incomplete|error`
   (line ~548). A post-commit `error` frame is relayed verbatim; `wrappedRejectionResponse` converts
   only a pre-commit 4xx.
2. The canonical passthrough eager relay (`passthrough-delivery.ts` onSynthetic, reason
   `upstream_error`, ~1142) synthesizes the failed terminal for a bare `error` and records
   `terminalSource=synthetic` WITHOUT touching transportPhase, at `logCtx.terminalHttpStatus ?? 502`.
3. `request-log-terminal-status.ts` captureTerminalHttpStatus sets a provisional status for a bare
   `error` only when `recognizedUpstreamError` matches (rate-limit/overload codes). The wrapper's
   `status`/`status_code` is ignored, so the row stays 502.
4. `request-failure-attribution.ts`: synthetic + no mid_stream/terminal_sse phase + 502 gives
   upstream-fault; terminalStatus failed + no output gives protocol-prelude.
   A socket death instead sets transportPhase mid_stream/streamAborted (transport-ambiguous) and a
   close-code message; the reported closeCode=null and upstream-fault exclude that.

So, on the ordinary canonical streaming path, the reported signature is produced by an upstream
bare `error` frame that this proxy relays and then re-labels 502 (source-based conclusion; the
counters do not name the preceding events, and the wrapper status/backend cause are unobserved). The native client (openai/codex
codex-rs/codex-api/src/endpoint/responses_websocket.rs map_wrapped_websocket_error_event) maps the
same frame's `status` to an HTTP transport error of that status. combo-stream-preflight
`bareErrorStatus` already reads the explicit status; the canonical path does not.

## Change (platform independent)

A. `src/server/request-log-terminal-status.ts`: in the `type === "error"` branch, after the
   recognized-class check, read the Codex WebSocket wrapper status (top-level `status` or its alias
   `status_code`; both present -> ignore, matching wrappedRejectionResponse) and note it provisionally
   when it is an integer in 500..599. 4xx is excluded on purpose: 429/402/401/403 move quota and
   credential routing and need their own review. Every 5xx is the same `transient` class in
   `classifyCodexUpstreamOutcome`, so account health, the #6860 failure window and rotation are
   unchanged; only the recorded status/errorCode/failureCause become truthful (503 ->
   server_is_overloaded / upstream-declined; 500 -> 500 / upstream-fault). A genuine later terminal
   still supersedes the provisional value. Client-facing tail is unchanged (native parity: native
   maps a 503 without an overload code to an unexpected-status retry, ours keeps upstream_server_error).
B. `CodexWsStageRecord` (`codex-ws-wire.ts`) gains two content-free fields filled in
   `codex-ws-exchange.ts`: `terminalEvent` ("response.completed" | "response.failed" |
   "response.incomplete" | "error" | null — the normalized type of the frame that ended the exchange,
   observed before any synthetic tail) and `terminalErrorStatus` (wrapper status of a terminal
   `error` frame, integer 100..599, else null). `src/usage/log.ts` normalizes them (older rows read
   as null; invalid values are dropped to null, never failing the row).
C. Docs: `structure/dashboard-and-usage.md` (bare-error status rule), `structure/transports/
   responses-wire-shapes.md` if it lists stage fields, docs-site management-api reference if it lists
   codexWsStage fields.

Out of scope: retry/replay changes, account auto-quarantine, client tail codes, 4xx wrapper status,
Windows-only transport changes.

## Verification

- New focused tests: bare `error` with `status`/`status_code` 503/500 -> provisional status,
  superseded by a genuine terminal, ignored for 4xx/invalid/both-fields; exchange stage record carries
  terminalEvent/terminalErrorStatus for error/failed/completed; usage log round-trip and legacy rows.
- bun test on touched suites, bun run test:changed, bun run typecheck, bun run structure:check,
  bun run privacy:scan, file-size ratchet.

## Audit round 1 (GPT-6.1-Sol high): NEAR-PASS, folded

1. Native control can end on acknowledgement frames outside the enum: terminalEvent/terminalErrorStatus
   stay null for nativeControl exchanges.
2. Plan wording made conditional (above).
3. Change A uses only noteStatus() after recognition fails; never a default 502; policy precedence,
   existing-status guard, genuine-terminal retirement and late-bare-error guard unchanged. Only the
   native wrapper contract is read: top-level integer `status` or `status_code` (not both); nested
   status, http_status and numeric strings are ignored. 4xx stays excluded.
4. Buffered JSON callers (buffered-sse-json.ts / passthrough-delivery presentation) keep their own
   status derivation; this patch is streaming-path only and documents that.
5. Normalization keeps legacy stages; malformed new values become null without dropping the stage.
   Pre-commit 4xx rejections still carry no stage record (unchanged, documented).
6. Docs: structure/dashboard-and-usage.md, structure/transports/responses-wire-shapes.md (status rule
   and stage field list), docs-site reference/management-api.md. New tests go into existing uncapped
   suites (upstream-failure-diagnostics, ws-failure-stage, usage-log-ws-stage); no layout changes.

## Not verifiable here (inference)

Whether the backend's frames carry `status` at all, and which value, needs a Windows/real-account
row from a build with this change. Upstream root cause (account/backend admission) is not provable
from source.

## Implementation and review (B/C)

- Change A: `codexWsWrapperStatus` (codex-ws-wire.ts) reads the native wrapper contract;
  `wrappedServerErrorStatus` (request-log-terminal-status.ts) adopts only 5xx after recognition fails.
- Change B: `terminalEvent` / `terminalErrorStatus` captured in the accepted non-control branch of
  codex-ws-exchange.ts, before relay-size/queue checks (review round 1 finding 1), null on native control.
- Review round 1 (GPT-6.1-Sol high): NEAR-PASS — capture position, missing terminal cases, docs-site
  streaming qualification; all fixed with regressions that fail on the prior code.
- Focused: 7 suites 413 pass / 1 skip / 0 fail. test:changed selected 1672 files; 37 fails in unrelated
  service/Lab/audio/toggle files that pass 430/430 alone on both base and change (load-dependent).
