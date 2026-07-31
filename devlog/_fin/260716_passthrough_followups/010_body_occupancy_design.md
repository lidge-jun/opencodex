# 010 — Phase 1: Anthropic native passthrough body-occupancy bound (idle + size)

Research grounding: sol explorer survey 2026-07-16 (agent Volta), all anchors
verified against the working tree at dev `a6db6cc4`-era.

## 1. Problem statement

After PR #136 + `d83db031`, the header phase is correctly bounded and the timer
cannot leak. The BODY phase has **zero** bounds:

- `tapAnthropicSseForLog` (`src/server/claude-messages.ts:120-168`) relays chunks
  with "no timer, chunk/total byte counter, size cap, or synthetic failure tail"
  (survey §4).
- The non-stream branch buffers `await upstream.text()`
  (`src/server/claude-messages.ts:237`) with no size or inactivity bound. The
  count_tokens native path reaches this same non-stream branch
  (`src/server/claude-messages.ts:552-560` → `:236-244`), so §6 covers it — not a
  separate surface (audit round 1 confirmed).
- `stallTimeoutSec` does NOT cover this surface: it lives in `bridgeToResponsesSSE`
  (`src/bridge.ts:180-211`) and is wired only into routed /v1/responses turns
  (`src/server/responses.ts:848-860`, `:1040-1049`) and the web-search bridge
  (`src/web-search/loop.ts:541-553`). The native Anthropic branch returns its own
  `Response` before any bridge exists (`src/server/claude-messages.ts:225-234`).

Consequence: a dead-but-open upstream (silent socket, trickle attack, unbounded
body) occupies a proxy connection and, for the non-stream branch, unbounded memory.

### 1b. Adjacent defect folded in (survey §8)

When `req.signal` aborts mid-body and the abort surfaces as a `reader.read()`
rejection, the tap's catch path records `finalize(200, {closeReason:"terminal"})`
(`src/server/claude-messages.ts:160-163`) — a client cancel logged as a clean
terminal. The redesign must classify req-abort distinctly.

## 2. Design law (from 000_plan.md timeout history)

Idle-based + size-based ONLY. No total-wall-clock body budget: 30s→100s
(`b62a1450`)→200s (`src/types.ts:420-421`) history exists because slow-but-alive
generations are legitimate (docs default anchor: `src/types.ts:420-421`). `parseStreamWithProgress` already encodes the correct
shape: silence kills, any non-empty chunk re-arms
(`src/web-search/progress-stream.ts:156-233`).

## 3. Config surface (survey §7)

Add to `OcxClaudeCodeConfig` (`src/types.ts:247-260`), beside `nativePassthrough`
and `anthropicBaseUrl`:

```diff
   /** Upstream for the native passthrough (tests/enterprise gateways). Default: https://api.anthropic.com */
   anthropicBaseUrl?: string;
+  /**
+   * Native passthrough body inactivity budget (seconds of NO raw upstream bytes,
+   * NOT total duration — slow-but-alive streams never trip it). Default 90
+   * (parity with stallTimeoutSec). Min 1. 0 disables.
+   */
+  bodyStallSec?: number;
+  /**
+   * Native passthrough cumulative body byte cap (streamed SSE and buffered
+   * non-stream alike). OOM/occupancy guard, not a correctness limit.
+   * Default 64 MiB. 0 disables.
+   */
+  bodyMaxBytes?: number;
```

Decisions locked here: (a) Claude-scoped key, NOT a reinterpretation of the global
bridge-event `stallTimeoutSec` (survey §7 verdict — different unit: raw bytes vs
bridge events); (b) default 90s mirrors `stallTimeoutSec` docs
(`docs-site/src/content/docs/reference/configuration.md:31`); (c) 64 MiB default
is generous vs realistic Anthropic SSE output (<10 MB) while matching the repo's
response-cap precedents (16 MiB search `src/server/search.ts:37`, 100 MiB images
`src/server/images.ts:38-43`). RECOMMENDED defaults — final numbers are a
one-line product decision at implementation P.

## 4. New primitive (survey §5 verdict: build new)

`src/lib/abort.ts` gains a resettable idle deadline; nothing existing is
resettable (`clearableDeadline` is one-shot, `signalWithTimeout.cleanup()`
detaches parent):

```ts
export interface IdleDeadline {
  /** Re-arm the timer; call on every unit of progress. No-op after cancel(). */
  reset: () => void;
  /** Stop permanently (success paths and teardown). */
  cancel: () => void;
}

/** Fires `onIdle` ONCE after `idleMs` with no reset() calls. Contract (audit round 1 #5):
 *  - `idleMs <= 0` returns an inert no-op deadline (never schedules): the 0-disable
 *    responsibility lives in the PRIMITIVE so callers cannot mis-handle it (A6).
 *  - Firing is idempotent: after onIdle runs, reset()/cancel() are no-ops and onIdle
 *    never runs again.
 *  - Race rule — first terminal wins: if reader.read() settles (EOF/error), req abort
 *    fires, or the consumer cancels BEFORE onIdle, the cleanup path calls cancel() and
 *    the timeout loses; if onIdle wins, later read settlement is ignored via a
 *    settled-guard in the tap (pattern: src/web-search/progress-stream.ts:176-200).
 *  - Never linked to fetch signals — the consumer decides how to kill the stream
 *    (reader.cancel), keeping body lifetime semantics identical to today. */
export function idleDeadline(idleMs: number, onIdle: () => void): IdleDeadline
```

Implementation is the `resetInactivity` pattern from
`src/web-search/progress-stream.ts:190-194` (clearTimeout + setTimeout), extracted
because two call sites need it (stream tap + non-stream reader).

## 5. Stream path diff sketch (`tapAnthropicSseForLog`)

Signature grows a guard argument; `finalize`'s closeReason union grows two members.
AUDITED (round 1 #1): closeReason is a CLOSED union, not a free string — the change
must ALSO widen `RequestLogEntry["closeReason"]` at `src/server/request-log.ts:71`
and its acceptance at `src/server/request-log.ts:363`; a local callback type alone
fails tsc at `addFinalRequestLog` (call-site `src/server/claude-messages.ts:185-188`).
Add request-log/API tests covering the two new values:

```diff
-function tapAnthropicSseForLog(
-  upstream: ReadableStream<Uint8Array>,
-  logCtx: RequestLogContext,
-  finalize: (status: number, meta: { closeReason: "terminal" | "client_cancel" }) => void,
-): ReadableStream<Uint8Array> {
+function tapAnthropicSseForLog(
+  upstream: ReadableStream<Uint8Array>,
+  logCtx: RequestLogContext,
+  finalize: (status: number, meta: { closeReason: "terminal" | "client_cancel" | "body_stall" | "body_overflow" }) => void,
+  guard?: { stallMs: number; maxBytes: number; reqSignal?: AbortSignal },
+): ReadableStream<Uint8Array> {
```

Inside, four additions (anchors show insertion points against
`src/server/claude-messages.ts:149-168`):

1. **Idle timer**: arm `idleDeadline(guard.stallMs, fireStall)` before the first
   `pull`; `reset()` after every non-empty chunk (mirror
   `progress-stream.ts:207-233` — zero-length chunks do NOT reset). `cancel()` on
   EOF/cancel/error.
2. **Byte accounting**: `bodyBytes += value.byteLength`; over `guard.maxBytes` →
   `fireOverflow`.
3. **Failure tail** (survey §3 adapted): on stall/overflow, enqueue a blank-line
   boundary + ONE Anthropic-vocabulary terminal frame, then close and cancel the
   upstream reader — the `relaySseWithFailedTail` lifecycle
   (`src/server/relay.ts:57-81`) with Anthropic wire shape instead of
   `response.failed`:

   ```
   \n\nevent: error\ndata: {"type":"error","error":{"type":"timeout_error","message":"anthropic passthrough body stalled: no bytes for <N>s"}}\n\n
   ```

   (overflow uses `"type":"api_error"`, message names the byte cap). AUDITED REWORD
   (round 1 #2): this frame is PROTOCOL-COMPATIBLE — the official Anthropic streaming
   dialect permits mid-stream error events, and our own adapter terminates on
   `event: error` / `data.type === "error"` (`src/adapters/anthropic.ts:751-808`) —
   but the native passthrough BYPASSES that adapter, so "Claude Code handles it" is
   not yet proven in-repo. Implementation MUST include a live-client or
   recorded-fixture activation test feeding this synthetic tail to a real Claude Code
   parse path. No `[DONE]` sentinel in the Anthropic dialect.
4. **Cancel classification fix (1b)**: register `guard.reqSignal` abort listener
   that marks `clientCancelled = true`; the catch path becomes
   `finalize(clientCancelled ? 499 : 200, { closeReason: clientCancelled ? "client_cancel" : "terminal" })`.
   Listener detached on every terminal path (`cancelBodyOnAbort` pattern,
   `src/lib/abort.ts:71-90`).

Status semantics: 200 already went out; stall/overflow are logged via
`finalize(200, {closeReason:"body_stall"|"body_overflow"})` — the closeReason,
not the status, is the observability signal (same policy as
`upstream_stall_timeout` inside a 200 bridge stream, `src/bridge.ts:196-200`).

## 6. Non-stream path diff sketch

Replace `await upstream.text()` (`src/server/claude-messages.ts:237`) with a
bounded streaming read using the SAME `idleDeadline` + byte cap (NOT
`readBoundedResponseBody` — that primitive is error-body-specific, 64 KiB and
total-wall-clock bounded, `src/lib/bounded-body.ts:1-13`). On overflow → 502
via `anthropicErrorResponse(502, ...)` (size-cap POLICY precedent
`src/server/search.ts:123-126` — note that surface uses its own
`formatErrorResponse`; same policy, different helper, this one speaks Anthropic
wire shape); on stall → 504 `timeout_error`. Headers are NOT
yet sent on this branch, so real status codes are still available — unlike §5.

## 7. What this design does NOT do

- No total-body wall clock (design law).
- No retry/resend on stall (upstream already committed — `src/server/relay.ts:46`
  policy).
- No change to routed Claude requests (they re-enter `handleResponses` and already
  have `stallTimeoutSec` coverage via `buildClaudeReplayConfig`,
  `src/server/claude-messages.ts:37-49`).
- No change to the /v1/responses native OpenAI passthrough relay (also uncovered
  today, survey §1 — OUT OF SCOPE here; candidate for its own unit if wanted).

## 8. Activation scenarios (C-ACTIVATION-GROUNDING-01)

| # | Trigger | Observable proof |
|---|---------|------------------|
| A1 | Upstream sends `message_start` then goes silent; `bodyStallSec: 1` | Client receives `event: error` `timeout_error` tail; request log closeReason=`body_stall`; upstream reader cancelled |
| A2 | Upstream floods > `bodyMaxBytes` (tiny cap in test) | `event: error` `api_error` tail; closeReason=`body_overflow` |
| A3 | Client aborts mid-body (AbortController on the fetch) | closeReason=`client_cancel`, status 499 — regression test for defect 1b |
| A4 | Slow-but-alive stream: 1 byte every 0.5×stall interval for 3×stall duration | Stream completes normally — the anti-total-wall-clock invariant, guards timeout history |
| A5 | Non-stream: silent upstream with `bodyStallSec: 1` | HTTP 504 `timeout_error` JSON |
| A6 | `bodyStallSec: 0` | No timer armed (config off-switch fires nothing) — assert via spy on `idleDeadline` |

A4 is the load-bearing test: it encodes "silence kills, progress lives" and fails
any future regression toward a total-duration cap.

## 9. Implementation order (one PABCD cycle)

1. `idleDeadline` in `src/lib/abort.ts` + unit tests (reset/fire/cancel/zero-disable).
2. Stream tap guard (§5) + A1-A4 endpoint tests.
3. Non-stream bounded read (§6) + A5.
4. Config keys + docs-site configuration.md rows + A6.
5. `structure/` SoT sync if any doc names the passthrough lifecycle.

Estimated class: C3 (public behavior change on a production surface, cross-file,
durable audit needed).
