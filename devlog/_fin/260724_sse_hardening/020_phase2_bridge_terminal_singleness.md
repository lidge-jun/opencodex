# 020 — Phase 2: Bridge terminal singleness + incomplete replay caching
# (classes 7, 5)

One PABCD cycle. Core capability: exactly one terminal event per turn, and
the replay store honors the bridge's documented caching contract.

## Scope

IN:
- src/bridge.ts (terminal exactly-once in bridgeToResponsesSSE)
- src/responses/state.ts (rememberResponseState accepts incomplete)
- tests: bridge-lifecycle, bridge, responses-state

OUT: adapter behavior (phase 1 landed), chat outbound (phase 3),
passthrough inspector reconstruction (bugfix train owns it).

## File change map

### 1. src/bridge.ts — MODIFY the adapter-event loop (~438) and terminal
### cases (:633, :699, plus catch block)

Current (verified): each terminal case ends with `terminated = true; break;`
which exits only the `switch`; the `for await` keeps consuming and a second
terminal re-emits. `[DONE]` fires after the loop (:741).

Change:
- ORDER MATTERS (A-gate fold, High): inside terminal handling the sequence
  is (a) call the onCancel/source abort callback FIRST, (b) break the
  loop, (c) `void it.return?.()?.catch(() => {})` fire-and-forget. Never
  await iterator.return() before emitDone/controller.close: queue-backed
  sources (run-turn-queue.stream()) only settle their pending read on
  queue.close()/push, so awaiting the return before the abort hangs
  start() forever behind a hung producer. A bare try/catch around
  return?.() catches only synchronous throws — async cleanup rejections
  need the `.catch(() => {})` form or they become unhandledRejection.
- Add a loop-level guard: after the switch, `if (terminated) break;` so the
  first terminal event (done / incomplete / error / synthesized catch
  terminal) ends adapter consumption.
- Catch-block guard (A-gate fold, Low): the catch path must check
  `if (!terminated)` before emitting response.failed (today it emits
  unconditionally; with the loop guard a real terminal makes catch
  unreachable, but the guard keeps the invariant explicit).
- Source-level producer stop (A-gate finding, High): generator.return does
  NOT reach the Cursor-style `runTurn` path — core.ts:1153 starts
  `void runTurn()` which produces independently into run-turn-queue.ts:57's
  unbounded array, and queue.stream().return is not wired to that producer.
  The terminal path must therefore ALSO trigger the source-level abort that
  core.ts already owns (runTurnAbort / the abort signal linked for the
  turn), so the producer stops instead of filling a dead queue. Concretely:
  bridgeToResponsesSSE already receives/creates the abort wiring used for
  client disconnect; the terminal-break path must invoke the same
  cancellation. Exact call site is pinned in B against core.ts:1140-1180 —
  the contract (producer stops at first terminal) is not negotiable, the
  mechanism may be adjusted to the existing abort plumbing.
  STALE-CHECK (WP2 P, post-#352): the wiring now lives at
  core.ts:1304 (`const runTurnAbort = new AbortController()`) and the
  bridge receives the cancel callback at core.ts:1340-1343
  (`() => { runTurnAbort.abort(); queue.close(); }` passed as the
  cancellation argument of bridgeToResponsesSSE). B must verify whether
  the bridge currently invokes that callback on terminal events; if it
  only fires on client cancel, the terminal path must call it too.
- Guard the synthesized post-loop terminals (`if (!terminated)` already
  exists for the no-terminal EOF path — keep it; it becomes unreachable
  after a real terminal, which is the point).
- Do NOT change event ordering before the terminal: closing open items,
  compaction emission, usage attachment all stay exactly as-is.

### 2. src/responses/state.ts — MODIFY rememberResponseState (:244-280)

Current (verified, :257):
```ts
if (response.status !== undefined && response.status !== "completed") return;
```

Change:
- Accept `"incomplete"` as storable: the bridge already calls
  onCompletedResponse for incomplete max_tokens turns with the comment
  "Still cache the partial output so previous_response_id replay works"
  (bridge.ts:658). New guard:
  `if (response.status !== undefined && response.status !== "completed"
  && response.status !== "incomplete") return;`
- DECIDED (A-gate round, WP1 follow-on): incomplete caching applies to
  `max_output_tokens` partials ONLY. `content_filter` incompletes must NOT
  be cached: replaying filter-triggering partial text into the next turn's
  upstream history re-sends the very content that caused the refusal and
  invites repeated refusals. Implementation: the state guard accepts
  incomplete only when `response.incomplete_details.reason ===
  "max_output_tokens"`; the docblock records this boundary explicitly.
- Keep `"failed"` excluded: a failed turn's partial output must not become
  authoritative replay history.
- Cursor checkpointUsable logic unchanged (function_call presence check
  already covers incomplete tool turns).
- Update the docblock above rememberResponseState to state the incomplete
  contract explicitly.

### 3. src/bridge.ts — comment sync

The :658 comment becomes true after change 2; extend it to name the
state.ts guard so the two sides stop drifting.

## Accept criteria + activation scenarios

1. Adapter yields error then done (misbehaving generator): client receives
   response.failed exactly once, never response.completed; `[DONE]` still
   emitted exactly once. Activation: bridge-lifecycle test with a scripted
   event generator; assert terminal event sequence length 1.
2. Adapter yields done then trailing error: response.completed exactly
   once; trailing error swallowed (generator.return called).
2a. runTurn regression: a Cursor-style producer emitting error then done
   (or done then trailing events) stops producing at the first terminal —
   assert the queue length stops growing after terminal and the abort
   signal fired. Activation: scripted runTurn queue with an event source
   that keeps producing until aborted.
3. incomplete (max_tokens) turn: rememberResponseState stores the partial
   items; a subsequent expandPreviousResponseInput with that
   previous_response_id returns prior items + suffix. Activation:
   responses-state test driving remember + expand directly.
4. failed turn: still NOT stored (guard keeps failing statuses out).
5. Regression: bridge.test.ts, bridge-lifecycle.test.ts,
   bridge-raw-reasoning-hidden.test.ts, responses-state.test.ts green;
   `bun run typecheck` green.

## Risks

- Breaking the loop early abandons unconsumed adapter events: any adapter
  that relies on full drainage for side effects would notice. Mitigation:
  adapters are pull-based generators; abandonment is the standard early-exit
  contract, and generator.return gives them a cleanup hook.
- Caching incomplete could replay a truncated turn into the next request:
  that is exactly the bridge's documented intent (continue-from-partial);
  the alternative (current behavior) sends a naked delta, which is worse.
