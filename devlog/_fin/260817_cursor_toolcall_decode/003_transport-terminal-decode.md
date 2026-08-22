# 003 — Transport terminal decode

Source: `src/adapters/cursor/live-transport.ts`, `transport-retry.ts`,
`src/bridge.ts`. Verified by direct read plus an independent `gpt-5.6-sol`
audit that returned FAIL on this surface.

## Terminal settlement paths

`createTerminalSettler()` (`live-transport.ts:102`) is single-shot: the first
settle wins, later ones are ignored.

| Event | Classification |
|-------|----------------|
| Connect end-stream frame with error or malformed payload | fatal (`:891`, `:900`) |
| Successful `{}` trailer | **no settlement**; waits for HTTP/2 `end` (`:175`) |
| Nonzero `grpc-status` trailer | fatal (`:970`) |
| HTTP/2 `end` with leftover frame bytes | fatal `ConnectFrameError` **unless `expectedClose`** (`:1016`) |
| HTTP/2 `end` with zero frames | fatal unexpected EOF **unless `expectedClose`** (`:1024`) |
| HTTP/2 `end` with >=1 complete frame | **unconditional graceful finish** (`:1029`) |
| Socket/session error | fatal via `failAndClear` (`:824`, `:975`) |
| Socket error after intentional client-tool suspension | graceful, `expectedClose` (`:806`) |
| Abort | fatal unless `expectedClose` or already settled (`:1036`) |
| First-frame timeout (30s default, `:88`) | fatal (`:835`) |

A fatal settlement makes `run()` throw (`:619`); a graceful settlement only
marks the iterator done (`:597`).

## F1 — the clean-EOF gap (High)

The last row of that table is the defect. The `end` handler drains queued frame
work, then classifies: leftover bytes -> fail, zero frames -> fail, otherwise
`settler.settleFinish()` — **without consulting `state.terminated`, and without
asking whether the application-level `turnEnded` frame ever arrived**.

Consequences when Cursor's stream ends cleanly mid-turn:

1. `finalizeTurnEvents` never runs, so the fail-closed open-tool-call check at
   `protobuf-events.ts:1361` — the code written for exactly this hazard — is
   bypassed.
2. The adapter emits neither `done` nor `error`. Only pre-EOF text/reasoning
   reached the bridge; the tool call was buffered and deferred, so it is simply
   gone (`protobuf-events.ts:1249`).
3. Streaming Responses partly repairs this: a terminal-less adapter EOF becomes
   `response.incomplete` with reason `adapter_eof` (`bridge.ts:1283`).
4. **Non-streaming does not.** With no error and no incomplete event, status
   defaults to `"completed"` (`bridge.ts:1829`), so a truncated turn is reported
   as a success.

This matches the external report of a `cursor-grok` stream ending with
`hasToolCalls: true` and partial content before `turnEnded` (see `004`).

## Retry behavior

The retry guard (`transport-retry.ts:99`) is correct and must not be loosened:

```ts
const canRetry =
  !emittedAny &&
  attempt < CURSOR_RETRY_ATTEMPTS - 1 &&
  !signal?.aborted &&
  requestUncommitted(transport) &&
  isRetryableCursorError(err);
```

`emittedAny` is set before `onEvent()` (`:93`), so any emitted event blocks
retry — replay after partial emission would duplicate output. Note the second-
order consequence of F1: a clean EOF **throws nothing**, so the retry wrapper
returns success and never evaluates the guard at all (`:97`). Fixing F1 to
throw a typed error is what makes this path reachable in the first place.

## Idle and keep-alive

- First-frame deadline 30s (`:88`), cleared by the first raw `data` chunk (`:940`).
- No post-first-frame idle timeout in the transport.
- `clientHeartbeat` written upstream every 5s (`:1042`).
- The Responses bridge has a separate ~300s silence watchdog (`bridge.ts:1321`).

For a Responses-owned Computer Use call the transport normally emits `done` and
cancels Cursor before the client runs the minutes-long tool (`:737`), so tool
duration should not idle that stream. An inline native execution, or a call left
open awaiting completion, can still hit the 300s watchdog while 5s heartbeats
keep the socket alive — the socket is healthy and the turn is dead, which is the
worst shape for diagnosis.

