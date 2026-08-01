# 110.10 — Root-Cause Analysis: Codex Stream Errors

All line citations verified against source on the authoring date. opencodex paths are
relative to the repo root; the Codex parser is the vendored upstream at
`/tmp/opencodex-codex-src/codex-rs/codex-api/src/sse/responses.rs`.

## 1. The Codex stream-error model (consumer side)

Codex consumes the proxy's SSE in `process_sse` (`responses.rs:434-479`). The poll loop
defines *every* way a stream can fail — each becomes `ApiError::Stream(...)`:

```rust
let response = timeout(idle_timeout, stream.next()).await;   // :446
match response {
    Ok(Some(Ok(sse)))  => sse,                                               // event
    Ok(Some(Err(e)))   => { send Err(ApiError::Stream(e));        return; }  // :454 frame decode
    Ok(None)           => { send Err(response_error                          // :457-460 stream end
                              .unwrap_or(ApiError::Stream(
                              "stream closed before response.completed"))); return; }
    Err(_)             => { send Err(ApiError::Stream(                       // :464-468 idle timeout
                              "idle timeout waiting for SSE"));    return; }
}
```

Per-event handling (`responses.rs:347-410`) adds three more:

| Trigger | Line | Condition |
|---------|------|-----------|
| `response.failed` w/o classifiable `error` | `:349`, `:378` | `error` absent / fails to deserialize into `Error` |
| `response.incomplete` | `:391` | any `response.incomplete` event |
| `response.completed` parse failure | `:406` | `ResponseCompleted` fails to deserialize |
| stream closed before completed | `:459` | byte stream ends, no prior error captured |
| idle timeout | `:466` | no SSE within `idle_timeout` |
| SSE frame decode error | `:454` | a malformed frame on the wire |

Key facts that constrain the proxy:
- The terminal success event is `response.completed` (`:393`). The chat-completions
  `data: [DONE]` sentinel is **ignored** by this parser — it keys on `response.completed`.
- `response.failed` reads `response.error`, **never** `last_error` (`:350`). Absent/unparseable
  `error` → `ApiError::Stream("response.failed event received")` (`:349`).
- `ResponseCompleted` requires only `id: String`; `usage` and `end_turn` are
  `#[serde(default)] Option<…>` (`:102-108`). The bridge always sets `id`
  (`bridge.ts:71`), so completed payloads parse — `:406` is not a current bridge defect.
- Recognized error `code`s (`responses.rs:557-580`): `context_length_exceeded`,
  `insufficient_quota`, `usage_not_included`, `invalid_prompt`, `cyber_policy`,
  `server_is_overloaded`, `slow_down`. **`rate_limit_exceeded` is not in this set** — it
  falls through to `ApiError::Retryable { delay }` (`:369-372`), not a dedicated rate-limit
  error. (Correction to the original hypothesis; behavior is acceptable but the wording
  "matches the parser code-checks" was wrong for that code.)

## 2. RC1 — Bridge ends the stream with no terminal `response.completed` (Bridge path)

**Severity: High. Path: bridge/routed only.**

`bridgeToResponsesSSE` emits a terminal event **only** inside two switch cases:

```ts
case "done":  emit("response.completed", …)   // bridge.ts:276
case "error": emit("response.failed", …)      // bridge.ts:286
// catch (err): emit("response.failed", …)     // bridge.ts:298
…
emitDone();            // bridge.ts:307  → "data: [DONE]\n\n"  (ignored by Codex)
controller.close();    // bridge.ts:308  → byte stream ends
```

If the adapter generator **returns without yielding `done` or `error`**, the `for await`
loop (`bridge.ts:171`) simply ends, and control falls to `emitDone()` + `close()`. No
`response.completed` is sent. Codex then hits `Ok(None)` → **"stream closed before
response.completed"** (`responses.rs:459`).

This is reachable today. `anthropic.ts` emits `done` **only** inside `case "message_delta"`
guarded by `if (usage)` (`anthropic.ts:264-271`); `message_stop` is a no-op
(`anthropic.ts:274-276`); the read loop breaks on EOF with no post-loop terminal yield
(`anthropic.ts:207-209`, `finally` at `:287`). So a stream that ends after `message_stop`,
or whose `message_delta` carries no `usage`, yields **no** `done` → RC1 fires.

> Contrast: `openai-chat.ts` is safe — it handles `[DONE]` (`:185`) **and** has a post-loop
> fallback `yield { type: "done" }` (`:239`). The defect is the missing invariant
> "*the bridge guarantees a terminal Responses event*," not any single adapter.

## 3. RC2 — No abort on disconnect; bridge re-throws on a closed controller (Both paths)

**Severity: High (interactive use). Path: both.**

The upstream fetch passes **no `signal`**:

```ts
upstreamResponse = await fetch(request.url, { method, headers, body });  // server.ts:179-183 (bridge)
upstreamResponse = await fetch(request.url, { … });                       // server.ts:145-149 (passthrough)
```

The bridge `ReadableStream` defines **only `start(controller)`** — no `cancel(reason)`
(`bridge.ts:59-60`). Consequences when the Codex client disconnects (interrupt, new turn,
tool-cycle, timeout — frequent in interactive use):

1. The upstream socket is never aborted → leaked connection, wasted upstream tokens/time.
2. The next `controller.enqueue()` (`bridge.ts:62`) throws on the now-closed stream. That
   throw is caught at `bridge.ts:297`, which calls `emit("response.failed")` → `enqueue`
   **throws again, now uncaught inside `start()`** → unhandled rejection; `emitDone()`/
   `close()` (`:307-308`) also throw.

Across a long interactive session this is the most plausible driver of *"엄청 발생"*
(errors *en masse*): every cancel leaks an upstream stream and emits noisy proxy-side
errors. On the passthrough path the leak is the same (no `signal`), though opencodex returns
`upstreamResponse.body` directly so there is no custom `cancel` to add there — the fix is the
`signal`.

## 4. RC3 — No idle heartbeat; slow routed providers trip the idle timeout (Bridge path)

**Severity: Medium (provider-dependent). Path: bridge/routed.**

Codex aborts with **"idle timeout waiting for SSE"** if no event arrives within
`idle_timeout` (`responses.rs:446,464-468`). The bridge emits `response.created` immediately
(`bridge.ts:75`), which covers first-token latency, but it emits **nothing during mid-stream
stalls** — a slow routed provider, a long upstream reasoning gap, or a slow tool round-trip
produces silence on the opencodex→Codex hop. There is no periodic keep-alive in
`bridgeToResponsesSSE`. Native passthrough inherits the ChatGPT backend's own pacing/keep-
alives, so this primarily bites routed models — i.e. the exact configuration in which the
proxy is most often used (e.g. `opencode-go/deepseek-v4-pro`).

## 5. RC4 — Bridge fidelity: error envelope + dropped frames (Bridge path)

**Severity: Medium. Path: bridge/routed. Partly fixed by phase 100.5.**

- **Error envelope (fixed):** pre-100.5 the bridge emitted `response.failed` with only
  `last_error`. Codex reads `error` (`responses.rs:350`), so every translated failure became
  `ApiError::Stream("response.failed event received")` (`:349`). Phase 100.5 (`a0d4ec9`)
  added a classified `error` via `classifyError` (`errors.ts`, `bridge.ts:289-290`).
  `context_length_exceeded` and `insufficient_quota` now match the parser's `is_*_error`
  checks exactly (`responses.rs:557-580`). **Caveat:** `errors.ts:26` emits
  `rate_limit_exceeded`, which the parser does **not** special-case → generic
  `ApiError::Retryable` (`:369-372`). The bridge also emits both `error` and `last_error`
  (`bridge.ts:289-290`); `last_error` is dead weight (the parser ignores it) but harmless.
- **Silently dropped frames:** all adapters `catch { continue }` on a JSON parse failure
  (`openai-chat.ts:191-193`, `anthropic.ts:226-229`, `google.ts:142-143`). A malformed or
  chunk-split upstream frame is dropped silently. This does not throw on the Codex side
  (it ignores unparseable frames, `responses.rs:476-478`), but it can truncate content and,
  combined with RC1, end the stream without a terminal event.
- **Malformed proxy output:** if opencodex ever emits a malformed Responses frame, Codex
  surfaces it as `ApiError::Stream` (`responses.rs:454`). Not currently observed, but the
  reason to keep `sseEvent` (`bridge.ts:8-9`) strictly well-formed.

## 6. RC5 — Passthrough header fidelity (Passthrough path)

**Severity: Medium. Path: native `gpt-*`. Mitigated by phase 100.5; verify.**

On passthrough, opencodex relays `upstreamResponse.body` with `sanitizePassthroughHeaders`
(`server.ts:153-155`). Bun's `fetch` auto-decompresses the body but leaves the upstream
`content-encoding: gzip` and a stale `content-length`. If those are relayed, the Codex
client double-decodes / truncates → a malformed frame → `ApiError::Stream`
(`responses.rs:454`). Phase 100.5 expanded the drop set to cover
`content-encoding, content-length, transfer-encoding, connection, keep-alive,
proxy-authenticate, proxy-authorization, te, trailer, upgrade` (`server.ts:241-259`), which
mitigates this. **Verification owed:** confirm `content-type: text/event-stream` survives
sanitization and that Bun always auto-decompresses the passthrough body (if it ever relays
raw gzip bytes, dropping `content-encoding` would itself corrupt the stream).

## 7. Likelihood & impact, mapped to actual usage

The proxy is most often pointed at **routed models** (chat/completions upstreams) — e.g. the
`opencode-go/deepseek-v4-pro` session in this project's history. That puts the user squarely
on the **bridge path**, where RC1 + RC3 (+ RC2 on disconnect) compound:

1. **RC1** (missing terminal) and **RC2** (disconnect re-throw) — highest expected frequency
   in interactive Codex sessions; directly produce `ApiError::Stream`.
2. **RC3** (idle timeout) — frequency scales with upstream latency/stalls.
3. **RC4 / RC5** — envelope correctness (mostly fixed) and header hygiene (mostly fixed);
   residual risk is silent truncation and the `rate_limit_exceeded` classification gap.

The single highest-leverage invariant to restore: **the proxy must always terminate a
streaming response with exactly one `response.completed` or a classified `response.failed`,
and must abort the upstream when the client goes away.** Patch direction in `30_…`.
