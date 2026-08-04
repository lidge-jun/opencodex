# macOS bounded single-reader gap analysis

Read-only source audit performed 2026-08-01 against `dev` at
`56ffd7a1b081f9c28070a1056f29528b768929bb` (Bun 1.3.14, Darwin arm64 target).
No source files were modified and no test or load suite was run.

## Executive verdict

The plan's three capability gaps are present in the current source, with one
important qualification: image-gen alias restoration and Responses item-ID
repair are not silently lost today. The eager selector excludes every request
that needs either rewrite (`src/server/responses/core.ts:1617-1620`), so those
requests fall through to tee. The eager path itself relays raw chunks after
inspection (`src/server/relay-eager.ts:130-143`) and therefore cannot yet take
those requests.

The platform gate has drifted from the plan's approximate line: the current
gate is `winNoClientRewrite` at `src/server/responses/core.ts:1619`, and
`decideEagerRelay` is consulted at `:1620`. Merely admitting Darwin to that
gate would still leave `streamMode: "auto"` on tee because
`MIN_FIXED_BUN_VERSION` is `null` (`src/lib/bun-stream-caps.ts:18-22`) and the
auto decision is therefore `auto-known-bad` (`:78-87`). It would make the
existing explicit `eager-relay` mode reachable on Darwin for no-rewrite
traffic.

All three client behaviors can live inside one eager producer without a second
reader. The failed tail needs only constant-bounded output. The two payload
rewrites need complete SSE-event framing and JSON parsing, so they are bounded
only if the new path introduces an explicit maximum pending SSE block and caps
the item-ID state. Reusing the current rewriter unchanged would not satisfy the
memory objective: its `buffer` grows until a blank-line delimiter with no size
limit (`src/server/sse-payload-rewrite.ts:70-80,109-110`).

## Current path shape

| Traffic | Current Darwin client path | Inspection | Result |
|---|---|---|---|
| SSE, no payload rewrite | `tee()` then `relaySseWithFailedTail(nativeBody, upstream)` (`core.ts:1679,1742-1744`) | Background tee branch | Alias/ID work is irrelevant; failed tail is preserved, but there are two consumers and a JS pull wrapper. |
| SSE, image alias and/or item-ID repair | `tee()` then one composed payload-rewrite wrapper, then failed-tail wrapper (`core.ts:1733-1744`) | Background tee branch sees raw bytes | Client sees repaired payload; inspection/replay retains raw upstream payload. |
| Eager (currently win32-only, no rewrite) | `relaySseEagerBounded(upstreamResponse.body, ...)` (`core.ts:1619-1621,1653-1677`) | Inline, before client enqueue | One upstream reader; raw client bytes; read failure errors the client stream. |

## Gap 1: client-facing image-gen alias restoration

### Evidence and current owner

**Verified gap.** Non-forward passthrough builds the alias map at
`src/server/responses/core.ts:1407-1410`; forward auth deliberately uses an
empty map. The tee client branch creates the image rewrite first in the
composition at `src/server/responses/core.ts:1733-1740`.

The behavior itself is owned by
`src/server/responses-image-gen-repair.ts:51-81`: it recursively visits one
parsed payload and, only for an exact `type: "function_call"` alias, restores
the local name and `namespace: "image_gen"` (`:74-80`). The composable callback
parses and rewrites one JSON payload at `:84-105`. Its explicit contract is
client-only because inspection and continuation replay must retain the raw
upstream alias (`:108-117`).

The generic tee-side SSE shell waits for a complete block, joins all `data:`
lines, replaces only the data field, and preserves non-data fields and the
original blank-line delimiter (`src/server/sse-payload-rewrite.ts:10-48,75-95`).

### Verdict

**Implementable in the eager single reader, with bounded per-event framing.**
It needs no cross-event state and no lookahead beyond the end of the current SSE
block. It is not a raw-chunk transform: the recursive rewrite requires a
complete JSON data payload.

### Bounded implementation sketch

1. Let the eager producer remain the only owner of `body.getReader()`.
2. Feed each raw upstream chunk to `inspector.feed` first, preserving the current
   raw continuation/request-log contract (`core.ts:1647-1656` and
   `responses-image-gen-repair.ts:108-110`).
3. For rewrite-enabled traffic, feed the same bytes into an inline streaming
   decoder and SSE block accumulator. On each complete block, apply the existing
   composed payload callback and enqueue only the client-facing encoded block.
   For no-rewrite traffic, retain the current raw-chunk fast path.
4. Account pending frame bytes and encoded output bytes separately from, but
   under, the eager queue policy. Set an explicit maximum SSE block size. A
   delimiter-free event over that limit must terminate with a classified failed
   tail (or another explicit protocol error); it cannot be passed through after
   earlier bytes have been withheld for possible rewriting.
5. Split a rewritten block into bounded output chunks before enqueueing so one
   large event cannot exceed the 8 MiB queue by an arbitrary amount. JSON parse,
   recursive clone, and stringify transient memory is then bounded by a multiple
   of the maximum event size.

### Ordering and framing constraints

- `\n\n` and `\r\n\r\n` delimiters can straddle upstream chunks, as can UTF-8
  code points; keep `TextDecoder(..., { stream: true })` behavior.
- Preserve non-data fields, newline style, and delimiter exactly as the current
  shell does. A changed multi-line payload is intentionally collapsed to one
  `data:` line by `replaceSseDataPayload` (`sse-payload-rewrite.ts:32-48`).
- On clean EOF, the current shell processes a final unterminated block
  (`sse-payload-rewrite.ts:89-97,103-106`); eager parity should do the same.
- On read error, discard any rewrite-buffered partial block before the synthetic
  failed tail. That matches the current stacked rewrite-then-failed-tail shape:
  the payload wrapper has not emitted the partial block when its `reader.read()`
  rejects.
- Keep image restoration before item-ID repair, matching
  `core.ts:1733-1738` and the direct composition contract in
  `tests/sse-payload-rewrite.test.ts:40-96`.

## Gap 2: Responses item-ID repair

### Evidence and current owner

**Verified gap.** The provider-local opt-in is detected at
`src/server/responses/core.ts:1617-1618`, which excludes the request from eager,
and is composed into the tee client rewrite at `:1735-1740`. The config surface
is `src/config.ts:436-447`.

The repair callback owns two per-type maps keyed by `output_index` and a
per-stream scope (`src/server/responses-item-id-repair.ts:7-12,51-63`). It learns
or mints a canonical ID when an event contains an `item` and an index
(`:66-98`), rewrites later allowlisted `item_id` fields from the remembered map
(`:100-113`), and repairs terminal response snapshots (`:115-127`). One event is
parsed and transformed at `:130-166`; the stateful callback is created once per
stream at `:187-193`.

### Verdict

**Implementable in the eager single reader, with bounded frame and mapping
state. No future-event lookahead is required for current semantics.** The
algorithm depends on prior events, not future ones: the ordinary ordering is
`response.output_item.added` followed by deltas/done and then the terminal
snapshot, as characterized by
`tests/responses-item-id-repair.test.ts:41-80`.

If a malformed stream sends an allowlisted delta before any item-bearing event
establishes the mapping, the current implementation leaves that delta unchanged
(`responses-item-id-repair.ts:105-112`). Eager must preserve that behavior;
buffering and replaying early events in hopes of a later ID would add lookahead,
latency, and potentially unbounded storage that does not exist today.

### Bounded implementation sketch

Use the same inline SSE block transformer described for Gap 1 and compose the
existing stateful callback after image restoration. The raw inspector still
runs before client rewriting, so synthetic client IDs never enter continuation
state; that separation is part of the repair decision record
(`responses-item-id-repair.ts:169-185`).

The SSE frame limit bounds payload buffering, but a second bound is needed for
`outputIds.message` and `outputIds.reasoning`. They cannot be freely evicted at
`output_item.done`, because the terminal `response.output` snapshot can need all
earlier mappings (`:115-127`). Set a maximum number of remembered repairable
items per stream. Exceeding it should fail the client stream consistently rather
than disable repair mid-stream and expose internally inconsistent IDs.

The existing placeholder mapping is deterministic from stream scope, type, and
index (`:14-17,47-49`), but `repairMissingTerminalIds` can require retaining a
real earlier ID for a terminal item whose ID is absent. Therefore a state cap,
not blanket eviction, is the safe bounded design.

### Ordering and framing constraints

- Preserve event order exactly; emit a transformed block only when its complete
  upstream block is available.
- Preserve separate message and reasoning maps even when an invalid stream
  reuses an index (`responses-item-id-repair.ts:58-61`; test evidence at
  `tests/responses-item-id-repair.test.ts:132-150`).
- Never rewrite function-call `id`/`call_id`; the event allowlist at
  `responses-item-id-repair.ts:19-33,105-113` and test at
  `tests/responses-item-id-repair.test.ts:103-130` lock this boundary.
- Do not feed rewritten bytes into `createSseInspector`; continuation replay is
  intentionally raw upstream state.

## Gap 3: synthetic `response.failed` tail on mid-stream reset

### Evidence and current owner

**Verified gap.** The tee client branch wraps Darwin's rewritten/native branch
with `relaySseWithFailedTail` at `src/server/responses/core.ts:1742-1744`.
That wrapper preserves prior emitted bytes, appends a leading blank line to end
any partial SSE block, emits a `response.failed` payload containing both
`error` and `last_error`, emits one `[DONE]`, closes, and aborts upstream
(`src/server/relay.ts:43-82`). Client cancel aborts and cancels instead of
emitting a tail (`:84-87`). Tests pin healthy pass-through, partial-block reset,
pre-byte reset, and cancel behavior at `tests/sse-failed-tail.test.ts:34-78`.

The eager producer catches the upstream read failure, records a synthetic
failed outcome, but calls `controller.error(new Error("upstream stream failed"))`
(`src/server/relay-eager.ts:154-160`). The direct eager regression currently
expects the client reader to throw (`tests/relay-eager.test.ts:327-344`).

### Verdict

**Implementable inline with constant-bounded state and no SSE lookahead.** Do
not wrap the eager body in `relaySseWithFailedTail`: that would add another JS
reader and restore the double-relay shape.

### Bounded implementation sketch

Capture `err` in the eager catch. When there is no upstream protocol terminal,
client cancellation, or server abort:

1. discard any incomplete payload-rewrite frame;
2. enqueue the same leading delimiter, `response.failed` envelope, and `[DONE]`
   bytes as `relaySseWithFailedTail`;
3. invoke `onSynthetic("failed")` exactly once for accounting;
4. close rather than error the client stream; and
5. abort/cancel the exhausted upstream reader during teardown.

The tail is fixed-size apart from the error message. To make the bound strict,
cap the serialized error message length before encoding and account the tail in
the client queue. Suppress the tail if `hooks.sawTerminal()` is already true so
one late transport reset cannot create a second terminal. Do not feed the
synthetic tail back through the inspector: the current tee inspector records
the reset independently as synthetic 502 (`src/server/relay.ts:570-580`) and
does not inspect the client-only tail.

The leading blank line remains necessary on the no-rewrite fast path because
raw partial event bytes may already have reached the client. With payload
rewrites active, partial event bytes remain in the bounded frame accumulator and
are discarded; retaining the delimiter is harmless and matches the existing
client wrapper's framing.

## Bun#32111 and the purported JS-pull shield

Primary upstream evidence refreshed 2026-08-01:

- [Bun issue #32111](https://github.com/oven-sh/bun/issues/32111) is closed and
  reports the crash on Bun 1.3.14 on Darwin arm64 and Linux arm64. Its reproducer
  returns a JS `ReadableStream` whose `async pull` awaits before enqueueing; a
  client abort during that yield crashes the server. The issue's ablation says
  synchronous `pull`, or async `pull` without an await, did not reproduce.
- [Bun PR #32120](https://github.com/oven-sh/bun/pull/32120) merged on
  2026-06-21 and says it fixes #32111. Its accepted cause includes shared uWS
  callback user-data corruption and a sink signal outliving a collected stream
  controller under backpressure.
- GitHub's official latest-release endpoint still identifies
  [Bun v1.3.14](https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14), dated
  2026-05-13, so the merged fix is still in no stable release as of this audit.

**The Darwin JS-pull wrapper does not shield against #32111. It matches the
reported trigger shape.** `relaySseWithFailedTail` defines `async pull` and
awaits `reader.read()` (`src/server/relay.ts:58-60`); rewrite-enabled traffic
adds another wrapper with the same shape
(`src/server/sse-payload-rewrite.ts:100-110`). `tee()` does not make those outer
Response bodies native. Only the current win32 no-rewrite branch returns
`nativeBody` directly (`core.ts:1742-1744`).

The eager body is structurally different: its public `pull()` is synchronous
and only resets queue accounting/wakes the producer
(`src/server/relay-eager.ts:180-196`); asynchronous upstream reads happen in the
single producer loop (`:107-153`), which checks cancellation before enqueueing
(`:130-149`). That avoids the exact `async pull` form isolated by #32111.
However, it still returns a JS-produced stream to Bun's HTTP Response sink and
enqueues after asynchronous reads. Static source analysis therefore supports
"avoids the known reproducer shape," not "proven immune on Bun 1.3.14." The
repository's current capability gate is deliberately more conservative and
classifies the eager async producer as exposed until a released fix exists
(`src/lib/bun-stream-caps.ts:1-15`).

Consequently:

- The eager path must **not** acquire the current async-pull wrapper as a
  supposed shield; inline tail/rewrite logic is required.
- It **does** still need the platform/version policy shield: keep Darwin
  `auto` on legacy behavior while `MIN_FIXED_BUN_VERSION` is null, allow only
  explicit operator opt-in if desired, and require a targeted Darwin
  client-abort stress proof before claiming Bun 1.3.14 safety.
- The current Darwin tee path itself should not be described as #32111-safe.
  Its continued use is compatibility status quo, not runtime proof.

## Risk table: what breaks if the gate changes today

| Change made today | Client-visible/runtime risk | Severity | Containment |
|---|---|---|---|
| Add Darwin to the platform gate, retain `!needsClientRewrite`, retain `decideEagerRelay` | Default `auto` still uses tee. Explicit Darwin `eager-relay` no-rewrite traffic loses the synthetic failed tail and receives a stream error on reset (`relay-eager.ts:154-160`). | High for reset handling; bounded opt-in exposure | Land inline failed-tail behavior before making the opt-in reachable. |
| Same narrow gate change, healthy/reset-free traffic | Image aliases and item IDs do **not** break; those requests remain on tee because of `needsClientRewrite` (`core.ts:1617-1620`). The memory win does not cover configured rewrite traffic. | Low correctness risk; incomplete retention benefit | State the fallback explicitly and measure route mix. |
| Remove/bypass `needsClientRewrite` while eager still relays raw chunks | Aliased image function names leak to the client, and configured placeholder/missing item IDs remain unrepaired. Continuation inspection stays raw, but client protocol compatibility regresses. | Release blocker for affected providers | Do not widen until the bounded dual-view transform exists. |
| Wrap eager output with existing payload and/or failed-tail wrappers | Reintroduces one or two async JS pull readers, defeats the single-reader/client-queue ownership goal, and recreates the exact #32111 trigger shape. | Critical architecture/runtime regression | Inline all client transforms in the one producer. |
| Enable Darwin `auto` on Bun 1.3.14 by bypassing the capability decision | The stable runtime lacks merged #32120. Exact eager topology safety is unproven; client-abort may crash the process. | Critical | Keep `MIN_FIXED_BUN_VERSION = null`; opt-in only until stable fix plus stress proof. |
| Inline rewrites without a frame-size limit | A delimiter-free or huge SSE event grows the decoder/string buffer without bound, replacing tee amplification with a new live-object memory hazard. | High | Hard cap pending block bytes and bound transform state. |
| Inline item-ID repair without a map-entry cap | An unbounded stream of distinct output indexes grows both repair maps until terminal/close. | Medium/High under malformed upstream | Cap repairable items per stream and fail consistently on overflow. |
| Emit a failed tail after an already parsed terminal or after client cancel | Duplicate/conflicting terminal or writes after cancellation; accounting can diverge from client bytes. | High | Require `!sawTerminal && !cancelled && !upstream.signal.aborted`; test every ordering. |

The eager path also intentionally differs from tee after client cancellation:
it performs a bounded inspection-only drain (`relay-eager.ts:131-138,192-196`)
rather than immediately ending the inspection branch. That accounting change is
already documented in `030_macos_single_reader.md`; it remains part of the
Darwin opt-in risk even after the three gaps above are closed.

## Recommended migration order

1. **Close the failed-tail gap inside `relaySseEagerBounded`.** It is independent
   of payload framing and is required for basic client error semantics. Add
   reset-before-bytes, reset-after-partial-bytes, reset-after-terminal,
   concurrent cancel/reset, one-terminal/one-DONE, and upstream-abort controls.
2. **Admit Darwin only to the existing explicit `eager-relay` policy for
   no-rewrite traffic.** Keep `!needsClientRewrite`, `auto-known-bad`, and
   `legacy-tee` rollback. This removes tee for the dominant plain path without
   risking alias/item-ID regressions.
3. **Run the exact Darwin client-abort stress topology on Bun 1.3.14.** This is
   runtime evidence, not part of this read-only task. Treat a crash/hang as a
   forced-mode blocker; do not use a successful short run to mark #32111 fixed.
4. **Introduce one bounded inline SSE client-transform stage.** First activate
   image alias restoration alone: it is stateless across events and proves raw
   inspector/client-rewritten dual-view ordering. Lock delimiter splits,
   multi-line data, invalid JSON, clean EOF, block overflow, and reset while a
   block is partial.
5. **Compose item-ID repair into that same stage.** Preserve image-first order,
   cap mapping cardinality, and test message/reasoning separation, malformed
   ordering without lookahead, function-call exclusion, terminal snapshots,
   and overflow failure.
6. **Only then remove the rewrite fallback for eager opt-in traffic.** Compare
   client bytes and raw continuation state against legacy tee fixtures before
   expanding measurement claims.
7. **Enable `auto` only after a stable bundled Bun is verified to contain
   #32120 and the exact macOS abort/load harness passes.** Update
   `MIN_FIXED_BUN_VERSION` in the same runtime bump; do not infer safety from a
   canary or from static shape alone.

## Verification performed

- Static source trace with numbered lines across `core.ts`, `relay.ts`,
  `relay-eager.ts`, `sse-payload-rewrite.ts`, both rewrite owners, config, and
  focused existing tests.
- Scoped `git diff` confirmed no pre-existing changes in the investigated
  source files or this unit before writing this report.
- Primary upstream issue, merged PR, and latest stable release metadata were
  fetched live on 2026-08-01.
- No typecheck was needed for this documentation-only, read-only investigation.
  No test suite or CPU-heavy workload was run.
