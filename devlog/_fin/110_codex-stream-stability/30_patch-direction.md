# 110.30 — Patch Direction

Prioritized, file-level direction for the fixes implied by `10_root-cause-analysis.md`.
This is **direction, not applied code** — implementation is an approval-gated follow-up
phase. Sketches are illustrative; exact line offsets shift as the files evolve.

**Non-goals (explicit):** no WebSockets; no attempt to "force passthrough" for routed models
(structurally impossible — see `10_…` §7 and `20_…`). The invariant to restore: *every
streaming response terminates with exactly one `response.completed` or a classified
`response.failed`, and the upstream is aborted when the client disconnects.*

---

## P0 — Stream lifecycle correctness (highest leverage)

### P0a · RC1 — Guarantee a terminal Responses event (`src/bridge.ts`)

Track whether a terminal event was emitted; if the adapter generator ends without one,
synthesize `response.completed` before closing.

```ts
// bridge.ts — inside start(controller)
let terminated = false;
// set `terminated = true` in case "done" (after emit), case "error" (after emit),
// and in the catch block (after emit).

try {
  for await (const event of events) { /* … existing switch … */ }
} catch (err) {
  /* existing emit("response.failed", …) */            // bridge.ts:298
  terminated = true;
}

if (!terminated) {                                       // NEW — RC1 fix
  if (currentMsg) closeCurrentMessage();
  if (currentReasoning) closeCurrentReasoning();
  if (currentRawReasoning) closeCurrentRawReasoning();
  if (currentToolCall) closeCurrentToolCall();
  emit("response.completed", {
    response: { ...responseSnapshot("completed", finishedItems), usage: responsesUsage(undefined) },
  });
}

emitDone();            // bridge.ts:307 (kept; harmless for Codex)
controller.close();    // bridge.ts:308
```

Defense in depth at the adapter layer — make `anthropic.ts` always yield a terminal `done`
on EOF, mirroring `openai-chat.ts:239`:

```ts
// anthropic.ts — after the read loop, before `finally { reader.releaseLock() }`
yield { type: "done", usage: pendingUsage };   // pendingUsage may be undefined; bridge handles it
```

**Test:** feed `bridgeToResponsesSSE` an event sequence ending **without** `done`/`error`
(e.g. `[{type:"text_delta",text:"hi"}]`) and assert the SSE contains exactly one
`response.completed`.

### P0b · RC2 — Abort upstream on disconnect + never throw on a closed controller

`src/server.ts` — own an `AbortController`, pass its signal to **both** fetches, and let the
returned stream's cancel abort it.

```ts
const ac = new AbortController();
upstreamResponse = await fetch(request.url, { method, headers, body, signal: ac.signal }); // server.ts:179-183 (bridge)
// passthrough fetch (server.ts:145-149) likewise gets `signal: ac.signal`
```

`src/bridge.ts` — accept the controller (or an `onCancel` callback) and add `cancel()`;
guard every enqueue so a closed controller is a no-op, not a throw:

```ts
return new ReadableStream<Uint8Array>({
  async start(controller) {
    const emit = (name, data) => {
      try { controller.enqueue(encoder.encode(sseEvent(name, { type: name, sequence_number: seq++, ...data }))); }
      catch { /* client gone — stop emitting */ }      // NEW — stops the RC2 double-throw
    };
    /* … */
  },
  cancel() { onAbort?.(); },                            // NEW — aborts the upstream fetch
});
```

For the **passthrough** path opencodex returns `upstreamResponse.body` directly; to abort the
upstream on client cancel, pipe it through a pass-through `TransformStream` whose `cancel()`
calls `ac.abort()` (or rely on the runtime propagating cancel to the signalled fetch — verify
in Bun). The minimal, certain win is passing `signal` so an explicit abort is possible.

**Test:** start consuming the bridge stream, call `reader.cancel()`, assert the provided
abort callback fired and no unhandled rejection occurs.

---

## P1 — Stall and passthrough robustness

### P1a · RC3 — Idle keep-alive (`src/bridge.ts`) — IMPLEMENTED (`61dcec2`)

**Correction (see `40_p0-implementation.md`):** a plain SSE comment (`:\n\n`) will NOT work.
Codex's loop is `timeout(idle_timeout, stream.next())` (`responses.rs:446`) over an
`eventsource_stream` (`responses.rs:12,440`), which parses at the **event** level — a
comment-only frame dispatches no event per the SSE spec, so `.next()` stays pending and the
timer is NOT reset. The keep-alive must be a **real SSE event** that deserializes into
`ResponsesStreamEvent` and is then ignored by the parser's catch-all
(`responses.rs:426-427`, `_ => Ok(None)`) — e.g. a benign `{"type":"response.heartbeat"}`
frame emitted WITHOUT consuming the main `sequence_number` counter.

**Observed `idle_timeout` values** (vendored codex): default
`DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000` (`model-provider-info/src/lib.rs:26`), but provider
overrides go as low as `5_000` (`model-provider/src/provider.rs:366`) and `9_000`
(`config/src/thread_config/remote.rs:472,535`). A safe interval is ~2500 ms (under the 5 s floor).

```ts
const HEARTBEAT_MS = 2_500;   // under the observed 5 s provider floor; ideally configurable
const beat = setInterval(() => {
  if (closed) return;
  // a REAL event (not a comment) so eventsource_stream yields it and resets Codex's idle timer;
  // an unhandled type is ignored by the parser. Do NOT bump `seq` (keep real events contiguous).
  try { controller.enqueue(encoder.encode('event: response.heartbeat\ndata: {"type":"response.heartbeat"}\n\n')); }
  catch { closed = true; }
}, HEARTBEAT_MS);
// clearInterval(beat) before controller.close() and inside cancel()
```

**Implemented** (`61dcec2`): a real, parser-ignored `response.heartbeat` emitted only during
upstream silence (an `activity` flag skips ticks when real events flow), interval 2000 ms (under
the 5 s provider floor), cleared on every terminal path + close + cancel. The earlier "needs the
user's idle_timeout / maintainer sign-off" concern was retired by an independent review: a ~2 s
interval covers the worst floor without the value, and unknown event types are codex's own
forward-compat path (`responses.rs:426-431`, `_ => Ok(None)`), so emitting one is in-contract.
Unit-tested in `tests/bridge-lifecycle.test.ts` (heartbeat appears during silence).

### P1b · RC5 — Passthrough header regression test (`tests/`)

`sanitizePassthroughHeaders` (`server.ts:241-259`) already drops the stale encoding/length
and hop-by-hop headers (phase 100.5). Add an explicit regression test that
`content-type: text/event-stream` **survives** sanitization and `content-encoding` /
`content-length` are dropped, and document a one-time manual check that Bun auto-decompresses
the passthrough body (if it ever relays raw gzip, dropping `content-encoding` would corrupt
the stream — that case needs different handling).

---

## P2 — Fidelity hardening (lower urgency)

- **`src/errors.ts` — rate-limit classification.** `rate_limit_exceeded` (`errors.ts:26`) is
  not recognized by the Codex parser and degrades to generic `ApiError::Retryable`
  (`responses.rs:369-372`). Acceptable, but consider mapping 503/overload to
  `server_is_overloaded` / `slow_down` (parser-recognized, `responses.rs:577-579`) for
  faithful backoff. Also consider dropping the redundant `last_error` from the bridge
  `response.failed` (`bridge.ts:289-290`) — the parser ignores it.
- **Dropped-frame visibility.** Adapters `catch { continue }` on bad JSON
  (`openai-chat.ts:191-193`, `anthropic.ts:226-229`, `google.ts:142-143`). Add debug/telemetry
  logging so silent truncation is detectable, rather than swallowing frames silently.

---

## Verification plan (for the implementation phase)

1. **Unit (`bun test`):**
   - RC1 terminal-guarantee test (P0a).
   - RC2 cancel/abort test (P0b).
   - RC3 heartbeat-interval test (P1a, can use a fake/short interval).
   - RC5 header-preservation test (P1b).
2. **Static:** `bun x tsc --noEmit` clean; `git diff --check`.
3. **Regression:** full `bun test` stays green (baseline 26 pass / 0 fail).
4. **Live (user environment):** run the Codex CLI against `ocx` with a **routed** model over
   a multi-turn session that includes interrupts; confirm the absence of `ApiError::Stream`
   ("stream closed before response.completed" / "idle timeout") and no leaked upstream
   connections. This is the acceptance gate — the symptom is only fully reproducible with a
   live Codex client.

## Sequencing

P0a + P0b together restore the core invariant and address the most frequent errors; ship
them first behind the unit tests above. P1 follows. P2 is opportunistic. None of this
requires or benefits from a transport change (`20_…`).
