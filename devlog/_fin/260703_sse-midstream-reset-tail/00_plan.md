# Plan: Graceful terminal frame for mid-stream SSE resets (passthrough path)

**Date:** 2026-07-03 · **Class:** C3 (client-facing wire behavior, one path) · Follow-up 2 from
`260703_chatgpt-upstream-reset-retry`.

## Problem

A connection reset AFTER response headers kills the SSE stream mid-flight. Coverage today:
- Adapter (bridged) path: covered — `src/bridge.ts:472-482` catches stream errors and emits a
  clean `response.failed` + `[DONE]`.
- Sidecars: covered — parse errors degrade to error strings.
- Inspection branch: covered — `consumeForInspection` reports `incomplete` on error (server.ts:1305).
- **Passthrough SSE path: NOT covered** — `src/server.ts:441-463` returns the tee'd `nativeBody`
  directly, so a mid-stream reset tears the client connection with a raw socket error and no
  terminal SSE event.

## Decision: inject a terminal frame; do NOT auto-resend

Mid-stream auto-retry would replay a request the server already committed (duplicate completion,
duplicate billing) — rejected, consistent with cursor `transport-retry.ts` committed=non-replayable
policy and the reset-retry plan's residual-risk analysis. Codex retries at turn level on a cleanly
failed stream.

## Diff-level plan

### MODIFY `src/server.ts`

- NEW exported `relaySseWithFailedTail(body: ReadableStream<Uint8Array>, upstream: AbortController): ReadableStream<Uint8Array>`
  placed next to `relayWithAbort` (~:958). Pull-pump identical to `relayWithAbort`, except the
  mid-stream error case: instead of `controller.error(err)`, enqueue
  `\n\n` (terminates any partial SSE block) +
  `event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{...},"last_error":{...}}}\n\n` +
  `data: [DONE]\n\n`, then `controller.close()`. Error message: `upstream stream terminated
  unexpectedly: <err.message>` with code `upstream_reset` (shape mirrors bridge.ts:456-466 /
  `responseError`). `cancel(reason)` behavior identical to `relayWithAbort` (abort upstream,
  cancel reader).
- Wire-in at the passthrough SSE return (server.ts:460):
  `const clientBody = process.platform === "win32" ? nativeBody : relaySseWithFailedTail(nativeBody, upstream);`
  **Windows keeps the pure native relay** — the tee+native structure exists to dodge the Bun#32111
  JS-sink segfault (comment at server.ts:437-440); non-Windows already runs JS pull relays safely
  (`relayWithAbort` on the non-SSE branch). Tee and inspection branch unchanged.

### NEW `tests/sse-failed-tail.test.ts`

1. verbatim relay: chunks pass through unchanged, done → clean close, no injected frame
2. mid-stream error → prior bytes preserved, then `\n\n` + `response.failed` frame (parseable JSON,
   status "failed", code "upstream_reset") + `data: [DONE]`, stream CLOSES (no error thrown to reader)
3. error before any bytes → failed frame + [DONE] only
4. cancel() aborts the upstream AbortController and cancels the source reader

## Risks

1. **Wire conformance** — injected frame must parse as a Responses SSE event; mirrors the exact
   `sseEvent` shape bridge already emits (event: name + data: json + blank line). Partial-block
   corruption bounded by the leading `\n\n` (the truncated block fails JSON.parse client-side and
   is skipped; the failed frame parses cleanly).
2. **Bun#32111 regression** — avoided by platform gate; Windows behavior is byte-identical to today.
3. **Double terminal** — if the upstream already delivered a terminal event and THEN resets during
   trailing bytes, the client may see terminal + failed. Codex takes the first terminal; benign.
4. **Cancel path** — unchanged semantics (same as relayWithAbort), turnAc/registerTurn wiring untouched.

## Verification

- `bun test ./tests/sse-failed-tail.test.ts` + full suite + `npx tsc --noEmit`.
