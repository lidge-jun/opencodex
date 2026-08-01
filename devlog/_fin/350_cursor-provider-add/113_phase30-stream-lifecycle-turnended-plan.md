# 350.113 — Cursor Stream Lifecycle: turnEnded Alignment + Async Drain (work-phase 30)

Date: 2026-06-27
Branch: dev
Work phase: close findings **#5 (High, async race / completion)** and **#2 (High, turnEnded contract)**
from the GPT Pro review — opencodex completes the turn on the HTTP/2 `stream.end`, not on the protobuf
`turnEnded` signal jawcode/GJC treat as authoritative, and fires native-exec handlers without awaiting.

> Status: **PLAN**. C3-class (transport correctness; can hang/mis-complete live turns).

---

## 1. Easy explanation

Cursor tells you a turn is done two ways: an explicit "turnEnded" message *inside* the stream, and
later the raw HTTP connection closing. opencodex only listens for the connection closing. jawcode
listens for "turnEnded" first (with a comment that the alternative `stopReason` is unreliable) and
treats the connection close as a fallback. Result: opencodex can appear to hang after the model has
actually finished, or finish before async tool replies have been sent. The fix aligns opencodex with
jawcode: complete on `turnEnded`, keep `stream.end` as a fallback, and make sure in-flight native-exec
replies are drained before the generator ends.

## 2. Pre-write evidence

### Current opencodex — completes on stream end only
```169:204:src/adapters/cursor/live-transport.ts
this.stream.on("trailers", trailers => {
  const status = trailers["grpc-status"];
  if (status && status !== "0") fail(new Error(`Cursor gRPC error ${status}`));
});
this.stream.on("error", err => fail(err instanceof Error ? err : new Error(String(err))));
this.stream.on("end", finish);
…
if (message.message.case === "execServerMessage") {
  const replies = await handleCursorNativeExec(message.message.value);
  for (const reply of replies) this.stream.write(encodeConnectFrame(reply));
  return;
}
```
- `finish` (→ `done=true`) is wired **only** to `stream.on("end")` (`:174`). There is no completion on
  the `turnEnded` interaction event.
- `protobuf-events.ts:33-34` already maps `turnEnded` → a `{type:"done"}` *event*, but that event is
  just pushed to the consumer; it does **not** stop the transport generator (`run()` keeps looping
  `while (!done …)` until `stream.end`).
- `live-transport.ts:161-163` — server messages are handled **fire-and-forget**:
  `void this.handleServerMessage(...).catch(...)`. No in-flight tracking; `finish` on `:174` can run
  while an `execServerMessage` reply is still being computed/written.
- Heartbeat (`:182-186`) is cleared only in `close()`; not stopped at `turnEnded`.

### jawcode reference — turnEnded authoritative
(from research of `jawcode/packages/ai/src/providers/cursor.ts`)
- `jawcode cursor.ts:453-458`:
  ```
  // Resolve only on explicit turnEnded. stopReason defaults to "stop"
  // and is not a reliable signal for stream completion.
  if (isTurnEnded && resolveH2) { … r(); }
  ```
- `isTurnEnded` is detected at the frame level (`cursor.ts:434-451`) from
  `interactionUpdate → turnEnded`.
- HTTP `end` is a **fallback** that resolves unless a Connect end-stream error was seen
  (`cursor.ts:481-499`).
- Trailers `grpc-status != "0"` → reject (`cursor.ts:484-489`) — opencodex already matches this.
- NOTE (parity caveat): jawcode is **also** fire-and-forget at the frame level and has **no** in-flight
  drain before resolve (`cursor.ts:437-451`; research §4 "NOT FOUND"). So the async-drain improvement
  is opencodex going *beyond* jawcode — justified by review finding #5; document it as an intentional
  hardening, not a jawcode port.

## 3. Decision

1. Make `turnEnded` the **primary** terminal signal: when the protobuf event mapper emits `done`,
   the transport must `finish()` (idempotent), stop the heartbeat, and close the stream.
2. Keep `stream.on("end")` as a **fallback** `finish` (idempotent guard so double-finish is safe).
3. Track in-flight `handleServerMessage` promises and **await them before** `finish` actually flips
   `done` — so async exec/kv replies are flushed first. (Goes beyond jawcode; review #5.)
4. Reject/treat-as-error if `stream.end` arrives while a *required* reply is still pending and no
   `turnEnded` was seen (controlled error, not silent hang).

## 4. Diff-level plan

### MODIFY `src/adapters/cursor/live-transport.ts`
- Add idempotency: `let finished = false; const finishOnce = () => { if (finished) return; finished = true; … }`.
- Track in-flight handlers: `const inFlight = new Set<Promise<void>>();` In the `data` loop, instead of
  bare `void this.handleServerMessage(...)`, do:
  ```ts
  const p = this.handleServerMessage(frame…, state, push, onTurnEnded)
    .catch(err => fail(asError(err)))
    .finally(() => inFlight.delete(p));
  inFlight.add(p);
  ```
- `handleServerMessage` gains an `onTurnEnded` callback (or detects the `done` event from the mapper)
  and, on `turnEnded`, calls a new `requestFinish()` that: stops heartbeat, then
  `await Promise.all([...inFlight])`, then `finishOnce()`.
- `stream.on("end", () => { void drainThenFinish(); })` where `drainThenFinish` awaits `inFlight`
  then `finishOnce()` (fallback path).
- Stop heartbeat in `requestFinish`/`finishOnce` (not only in `close()`).
- (Optional, ties to `114`) if `stream.end` fires with non-empty `pending` and no `turnEnded`, `fail`.

### MODIFY `src/adapters/cursor/protobuf-events.ts` (no behavior change required)
- `turnEnded` still maps to `{type:"done"}`; the transport now *acts* on it. Confirm the mapper is the
  single place `turnEnded` is recognized so detection isn't duplicated.

## 5. Verification plan (non-destructive)
- NEW/extend `tests/cursor-live-transport.test.ts` with a **mock** HTTP/2 stream (no network):
  - emits text frames + a `turnEnded` interactionUpdate but **never** emits HTTP `end` → generator
    finishes, heartbeat interval cleared, stream closed.
  - emits HTTP `end` **without** `turnEnded` → controlled completion (fallback) or explicit error,
    not an infinite await.
  - emits an `execServerMessage` whose handler resolves slowly, then `turnEnded` → assert the exec
    reply was written **before** the generator completed (in-flight drain).
  - trailers `grpc-status:"5"` → still fails (no regression).
- `bun test tests/cursor-*.test.ts` → green; `bun x tsc --noEmit` → exit 0.
- NO live Cursor stream.

## 6. Out of scope
- Compressed/reserved frame handling and pending-buffer cap → `116`.
- `conversationCheckpointUpdate` state persistence → `114`.

## 7. Cross-references
- GPT Pro review 260627 — findings **#2 / #5 (High)**.
- jawcode `cursor.ts:453-458, 434-451, 481-499`.
- `99` (end-stream success/error fix — predecessor) · `116` (framing robustness) · `118` (index).
