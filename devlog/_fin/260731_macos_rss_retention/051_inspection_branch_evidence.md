# Inspection-branch retention evidence

Evidence captured 2026-08-01 from `dev` HEAD
`56ffd7a1b081f9c28070a1056f29528b768929bb` on Bun 1.3.14/macOS arm64.
This is a source audit and bounded-fix proposal only; no `src/` change was made.

## Verdict summary

| Claim | Verdict | Current evidence |
| --- | --- | --- |
| macOS tees every successful passthrough SSE body | **Confirmed; lines drifted** | The eager decision is constructed only for `process.platform === "win32" && !needsClientRewrite` (`src/server/responses/core.ts:1616-1621`). Darwin therefore always reaches `upstreamResponse.body.tee()` at `src/server/responses/core.ts:1679`. The claim is scoped to successful passthrough Responses SSE bodies, not every response handled by the server. |
| The inspector has an uncapped incomplete-frame `buffer` | **Confirmed; lines drifted** | `buffer` is initialized at `src/server/relay.ts:444-446`; every decoded chunk is appended at `src/server/relay.ts:504-505`; bytes leave only when `nextSseBlock` finds a blank-line delimiter (`src/server/relay.ts:506-511`) or `finish()` clears the buffer (`src/server/relay.ts:513-518`). There is no size check, overflow state, or resynchronization limit. |
| `completedItemsByOutputIndex` is not cleared after the completed-response callback | **Confirmed** | The map is allocated at `src/server/relay.ts:449-451`, receives every valid distinct/repeated output index at `src/server/relay.ts:476-485`, and is read to reconstruct output at `src/server/relay.ts:488-497`. The callback at `src/server/relay.ts:499` has no `clear()` in normal, exceptional, terminal, or `finish()` paths. |
| JSON is parsed twice per inspected event | **Refuted; current cost is higher** | Request-log inspection parses once for metadata (`src/server/request-log.ts:539-540`) and again for error/terminal metadata (`src/server/request-log.ts:564-576`). Before first output and terminal, the same payload is parsed again by first-output detection (`src/server/relay.ts:115-134`), terminal detection (`src/server/relay.ts:138-154`, called at `src/server/relay.ts:457-459`), and continuation capture (`src/server/relay.ts:468-475`): **five parses** with all hooks enabled. |
| Client disconnect explicitly cancels the inspection reader | **Refuted** | The macOS client relay cancels its tee reader and aborts `upstream` (`src/server/relay.ts:84-87`). The inspection consumer cancels its reader only when its supplied signal aborts (`src/server/relay.ts:537-554` or `src/server/relay.ts:600-608`), but that signal is `turnAc.signal` (`src/server/responses/core.ts:1708-1725`). `linkAbortSignal(upstream, turnAc.signal)` is one-way from `turnAc` to `upstream` (`src/server/responses/core.ts:1680-1682`, implementation at `src/server/responses/core.ts:2566-2574`); aborting `upstream` does not abort `turnAc`. |
| `relaySseEagerBounded` covers all inspector hooks under an 8 MiB bound | **Hook parity confirmed; whole-inspector bound refuted** | Runtime wiring supplies terminal, request-log, continuation, and first-output handlers to the same inspector (`src/server/responses/core.ts:1647-1652`) and feeds it from the eager producer (`src/server/responses/core.ts:1653-1669`, `src/server/relay-eager.ts:123-165`). The 8 MiB constant bounds only approximate queued client bytes (`src/server/relay-eager.ts:53`, `src/server/relay-eager.ts:69-71`, `src/server/relay-eager.ts:140-151`); it does not bound the inspector's frame string or item map. |

The source searches found no current `MAX_INSPECTION_*`/completed-item cap and no
`completedItemsByOutputIndex.clear()` call.

## Competing hypotheses and falsifiers

| Hypothesis | Falsifier | Result |
| --- | --- | --- |
| H1: Darwin can select the existing single-reader eager path, so tee is not universal there. | A Darwin-capable eager decision outside the Windows gate. | Rejected: the decision is only created under `winNoClientRewrite` at `core.ts:1619-1621`; Darwin reaches the tee at `core.ts:1679`. |
| H2: tee is the only unbounded state; inspector-local state is bounded. | Any frame-size/item-count or byte cap in `createSseInspector`. | Rejected: neither `buffer` nor the item map has a cap (`relay.ts:444-518`). |
| H3: client cancellation propagates through `turnAc` and explicitly cancels the inspection reader. | A reverse `upstream.signal -> turnAc.abort()` link or a direct client-cancel call to the inspection reader. | Rejected: the only link is `turnAc.signal -> upstream.abort()` (`core.ts:2566-2574`); no reverse/direct edge exists. |

## Retention mechanism and worst-case math

For one stream at time `t`, define:

- `R(t)`: upstream response bytes emitted so far.
- `Q(t)`: bytes emitted but still unread in the tee's inspection-branch queue.
- `F(t)`: UTF-8 source-byte equivalent of the decoded, unterminated SSE candidate
  held in `buffer`.
- `N(t)`: distinct output indexes retained by `completedItemsByOutputIndex`.
- `I_i`: live in-memory size of the parsed item object graph at retained index `i`.
- `Cmax`: largest single upstream chunk.

The live branch state is approximately:

```text
M_inspection(t)
  = Q(t)
  + stringMemory(F(t))
  + sum(I_i, i in retained output indexes)
  + O(N(t)) Map/object overhead
  + transient parse/framing allocations
```

There is no source-level constant bound on any of the first three terms:

1. **Tee queue:** the source delegates directly to `ReadableStream.tee()` at
   `core.ts:1679` and adds no queue limiter. If the client/source advances while
   inspection lags, `Q(t)` can approach the unread remainder of the response;
   for a finite response it is `O(R)`, and for an indefinitely producing SSE it
   is unbounded. If inspection is instead the faster branch, tee can place the
   analogous unbounded queue on the client branch; removing inspector CPU alone
   does not make the two-branch topology bounded.

2. **Incomplete frame:** `buffer += decoder.decode(...)` at `relay.ts:505`
   permits `F(t) = R(t)` for a stream that never supplies a blank-line SSE
   delimiter. The retained logical payload is `F` bytes for ASCII input; exact
   physical string memory is engine-dependent (one-byte or two-byte code units,
   plus concatenation/slicing temporaries) and therefore cannot be given a
   tighter byte bound from TypeScript source.

3. **Completed items:** for `N` distinct valid `response.output_item.done`
   indexes, the map retains all `N` item graphs and therefore
   `sum(I_i) + O(N)` bytes. `N` can equal the number of distinct done events.
   The callback does not release those references. When the terminal response
   has empty/missing `output`, the callback receives an array containing the map
   objects; `rememberResponseState` synchronously copies the array entries into
   continuation state (`src/responses/state.ts:429-455`). Clearing the map after
   callback would release the redundant map references while preserving the
   continuation store. When terminal `response.output` is already non-empty,
   the earlier done-item object graphs are not used at all but remain retained
   by the map.

For a finite stream, each retained payload term is `O(R)` and the branch has no
constant per-stream limit. Across concurrent streams `j`, aggregate retention is
`sum(M_inspection_j)`. Parsed object expansion and temporary repeated parses can
make RSS materially larger than source bytes even though asymptotic payload
retention remains linear in response size.

### Parse allocation volume

With the normal eligible passthrough wiring (`onTerminal`, `logCtx`,
`onCompletedResponse`, and `onFirstOutput` all present), parse calls per complete
JSON SSE event are:

| Inspector state | `JSON.parse` calls/event | Reason |
| --- | ---: | --- |
| Before first output and before terminal | 5 | request metadata + error capture + first-output + terminal + continuation |
| After first output, before terminal | 4 | first-output reporter short-circuits; the other four remain |
| Terminal event after first output | 4 | same as the preceding row; terminal is marked during this event |
| Complete block after terminal | 1 | log and terminal gates stop; continuation parsing intentionally continues |

These parses are sequential, so five full object graphs need not all remain live
simultaneously. They do create up to roughly five parsed-payloads' worth of
allocation churn per early event, in addition to regex matching, `slice`, line
`split`, data-array creation, and `join` at `src/server/relay.ts:91-107`.

A cheap in-process Bun probe against current source counted exactly:

```text
pre_output=5
first_output=5
post_output=4
terminal=4
post_terminal=1
```

A second probe intercepted the map instance and observed the retained entry both
after the synchronous callback and after `finish()`:

```text
after_callback_size=1 callbacks=1
after_finish_size=1
```

Neither probe started an HTTP server or ran a test suite.

## Disconnect path

The actual macOS path is:

```text
client cancel
  -> relaySseWithFailedTail.cancel()
  -> upstream.abort(reason) + native tee-branch reader.cancel(reason)

turnAc.abort(reason) [shutdown/deadline path, not the client-cancel edge above]
  -> upstream.abort(reason) via linkAbortSignal
  -> inspection reader.cancel(reason) via consumeForInspection listener
```

The fetch was created with `upstream.signal` (`src/server/responses/core.ts:1471-1477`),
so Bun will normally tear down/error the fetch body after `upstream.abort()`. The
inspection pump may then settle indirectly when its tee read rejects. That is not
an explicit inspection-reader cancellation and is not guaranteed by this object
topology: the independent `turnAc.signal` listener never fires on client cancel.

This also means `consumeForInspection`'s `cancelled` flag and `onCancel` callback
are not necessarily selected for a client disconnect. If the fetch-body read
rejects first while `cancelled === false`, the catch path can synthesize failed
502 (`src/server/relay.ts:570-579`); if it ends cleanly it can synthesize
incomplete (`src/server/relay.ts:560-565`). The comments at
`src/server/responses/core.ts:1683-1687` describe a cancellation contract that
the current signal direction does not itself enforce. The isolated cancellation
tests abort the exact signal passed to `consumeForInspection`
(`tests/consume-for-inspection-cancel.test.ts:20-49`), so they do not exercise
this core wiring mismatch.

## Eager-relay hook coverage

| Inspector effect | Runtime wiring | Producer coverage | Verdict |
| --- | --- | --- | --- |
| Real terminal outcome and quota/terminal callback | `onTerminal: reportNativeTerminal` at `core.ts:1647-1649`; terminal metadata is set before callback at `relay.ts:457-465` | Every chunk is inspected before enqueue at `relay-eager.ts:123-140` | **Covered** |
| Synthetic incomplete/failed outcome | `onSynthetic` maps EOF/reset to terminal reporting at `core.ts:1657-1666` | EOF/error classification at `relay-eager.ts:123-128`, `relay-eager.ts:154-165` | **Covered** |
| Request-log usage/error/service metadata | `logCtx` at `core.ts:1649`; consumed at `relay.ts:453-455` and `request-log.ts:535-554` | Same inspector sees every upstream chunk | **Covered** |
| Continuation capture | `onCompletedResponse: rememberPassthroughResponse` at `core.ts:1650`; reconstruction/callback at `relay.ts:468-499` | Same inspector sees every upstream chunk and clean EOF flush | **Covered, but map unbounded** |
| First-output timing | `onFirstOutput: options.onFirstOutput` at `core.ts:1651`; reporter at `relay.ts:447`, `relay.ts:453-455` | Same inspector sees every upstream chunk | **Covered** |
| Turn cleanup | `onDone: unregisterTurn` at `core.ts:1669` | Exactly-once guard at `relay-eager.ts:87-94`, final call at `relay-eager.ts:161-174` | **Covered** |

The eager relay therefore has semantic inspector-hook parity. It does **not**
put all of those effects inside an 8 MiB memory envelope:

- 8 MiB is `DEFAULT_MAX_QUEUE_BYTES` (`relay-eager.ts:53`) and applies only to
  `queuedBytes` (`relay-eager.ts:69-75`).
- Inspection occurs before byte accounting and before the pause
  (`relay-eager.ts:130-151`), so `buffer` and the item map remain the same
  unbounded `createSseInspector` state.
- The producer enqueues the chunk and pauses only when `queuedBytes > cap`.
  Queue accounting can therefore overshoot to approximately `8 MiB + Cmax`;
  a single chunk has no cap. `pull()` resets the byte estimate to zero
  (`relay-eager.ts:185-190`), so the bound is intentionally approximate.
- After client cancel, the queue is discarded but inspection can continue for
  the separate 15 s / 32 MiB drain bounds (`relay-eager.ts:53-55`,
  `relay-eager.ts:131-138`, `relay-eager.ts:192-197`), again with up to one-chunk
  overshoot and with the inspector-local frame/map state still uncapped.

## Bounded-fix proposal (no source change in this task)

### 1. Strict 1 MiB incomplete-frame cap

Add `MAX_INSPECTION_SSE_FRAME_BYTES = 1_048_576`. To make this a strict byte
bound rather than `cap + one arbitrary chunk`, accumulate raw byte slices and
scan the ASCII SSE blank-line delimiter incrementally across chunk boundaries:

1. Track candidate byte count and delimiter state before appending each slice.
2. If a candidate would exceed 1 MiB before a delimiter, release all retained
   slices and enter `discardingOversizedFrame`.
3. While discarding, retain no payload bytes; scan only delimiter state. Resume
   after the next complete blank-line delimiter so a frame tail cannot be parsed
   as a new event.
4. Decode/parse only a complete candidate of at most 1 MiB. On `finish()`, do
   not parse a candidate already marked discarded.

This keeps the client bytes unchanged because the cap applies only to inspection.
It also avoids allocating a full `TextEncoder.encode(buffer)` copy merely to
measure an already oversized string.

### 2. Bound reconstructed items by count and source bytes

Add both:

```text
MAX_COMPLETED_OUTPUT_ITEMS = 256
MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES = 8 * 1024 * 1024
```

Store `{ item, sourceBytes }` per index, conservatively charging the full bounded
SSE payload bytes that produced each item. Replace an existing index only after
subtracting its old charge. Retain the lowest output indexes deterministically;
when count or aggregate bytes would exceed its cap, evict highest indexes until
both limits hold, and reject a single item whose charge exceeds the aggregate
cap. The 1 MiB frame cap limits any one retained event; the 8 MiB aggregate cap
prevents a count-only limit from permitting 256 near-1-MiB item graphs.

### 3. Clear at every ownership handoff/teardown

- For `response.completed`, call `handlers.onCompletedResponse(response)` inside
  `try/finally`; in `finally`, call `completedItemsByOutputIndex.clear()` and set
  retained-byte accounting to zero. The production callback synchronously copies
  output into continuation state before returning (`state.ts:429-455`).
- On `response.failed` or `response.incomplete`, clear immediately after terminal
  reporting because no `response.completed` reconstruction will consume the map.
- In `finish()`, clear frame/item state in `finally`, including malformed or
  unterminated EOF paths.
- Add an inspector `dispose()` that drops decoder/buffer/item state without
  parsing. Invoke it from both background consumers' `finally` blocks and from
  the eager producer's `finally`, so cancellation/error teardown does not depend
  on eventual closure collection.

### 4. Parse once and share the result

Parse each complete payload once into a typed best-effort result and pass that
same result to request-log metadata/error capture, first-output detection,
terminal detection, and continuation reconstruction. Preserve the raw payload
only for the current malformed-error fallback and bounded usage-debug sample.
This changes allocation volume from up to five parsed object graphs per early
event to one.

### 5. Make disconnect ownership explicit

Do not claim the current tee path explicitly cancels inspection. Either:

- migrate Darwin to the eager single-reader path once client rewrite and failed-tail
  parity are satisfied; its client-cancel drain is explicit and bounded; or
- add a shared client-cancel notification to the tee topology. To preserve the
  intended late-terminal contract, mark cancellation, discard-drain inspection
  for at most 15 s or 32 MiB, then explicitly `reader.cancel(reason)`, abort the
  upstream, dispose inspector state, and unregister the turn. An immediate
  `turnAc.abort()` is simpler but intentionally forfeits late-terminal capture.

The frame/item caps and clear points are useful on both tee and eager paths. They
bound inspector-local state; only removing tee or introducing explicit branch
backpressure/cancellation bounds the tee queue itself.

## Verification performed

- Read `000_plan.md` and `020_inspection_bounds.md` before source inspection.
- Traced current `core.ts`, `relay.ts`, `relay-eager.ts`, `request-log.ts`,
  `responses/state.ts`, lifecycle/abort helpers, and focused cancellation/eager tests.
- Ran two cheap in-process `bun -e` probes for parse count and post-callback map
  size; each completed in approximately 0.1 s with no server.
- Did not run the test suite, typecheck, load harness, or any CPU-heavy command,
  per delegated scope.
