# 020_sse_terminal_fidelity

## Objective

Close residual stream-terminal gaps vs TS SSE hardening on origin/dev
(`src/` on this branch is the source of truth). After A-gate round 1 the scope
is the exact TS-parity port below; nothing stricter, nothing looser than TS.

## Worktree note (2026-07-24)

Execution home moved from the deleted hash worktree to the named sibling
worktree `/Users/jun/Developer/new/700_projects/opencodex-dev2-go-ports`
(branch `dev2-go`). All paths in this unit resolve there.

## Files

### MODIFY

| Path | Before | After (TS anchor) |
|---|---|---|
| `go/internal/types/types.go` | 6 event types; no heartbeat/incomplete | add `EventHeartbeat` + `EventIncomplete` with `Reason string` + `Message string` fields on `AdapterEvent` (`src/types.ts:237,264`) |
| `go/internal/protocol/sse.go` | comment lines dropped silently (`sse.go:115`) | opt-in comment records: decoder option delivering comment events; default stays drop (`src/lib/sse-decoder.ts:58`, `includeComments`) |
| `go/internal/adapter/anthropic/anthropic.go` | decoder without comment opt-in (`anthropic.go:543`); EOF+usage→Done (`anthropic.go:502`) | opt in comments → emit `EventHeartbeat` (`src/adapters/anthropic.ts:740`); terminal machine: `message_stop`→Done; EOF+`stopReason!=""`→Done(usage, EXACT mapping: `max_tokens`→`max_tokens`, `refusal\|content_filter`→`content_filter`, any other value→StopReason omitted) (`src/adapters/anthropic.ts:826-830`); EOF otherwise→EventError `"upstream stream ended before message_stop — possible truncation"` (`src/adapters/anthropic.ts:837`) |
| `go/internal/adapter/openai/chat.go` | `!sawFinish && usage == nil`→Error, else Done (`chat.go:371`) | NO behavior change — already TS parity (`src/adapters/openai-chat.ts:724`); tests only |
| `go/internal/adapter/google/google.go` (+`scanSSE`) | unconditional Done after scanner success (`google.go:481,520`); `scanSSE` drops non-`data:` lines and unterminated residuals silently (`google.go:633-664`) | redesign `scanSSE` to report framing state (clean EOF / `[DONE]` / residual bytes); non-`data:` non-comment residual→Error `"upstream stream ended with an incomplete SSE frame — possible truncation"` (`src/adapters/google.ts:453-460`); comment residual→heartbeat; invalid JSON in `data:` payload→Error `"malformed upstream SSE data frame"` (`src/adapters/google.ts:360`); liveness-only chunks (non-`data:` lines, no content event)→`EventHeartbeat` (`src/adapters/google.ts:447,456`); track `sawAnyFrame` + `sawTerminalSignal` (usage metadata OR non-empty finishReason); `!sawAnyFrame \|\| !sawTerminalSignal`→Error `"upstream stream ended without a terminal signal — possible truncation"` (`src/adapters/google.ts:470`); keep Vertex/CCA tool-call-only truncation + `VertexTruncationErrorMessage` (`src/adapters/google-truncation.ts:3`) |
| `go/internal/adapter/openai/queue.go` | capacity = make hint; unbounded `Push`; `deliver()` goroutine dequeues before blocking on unbuffered `out` (`queue.go:19,38,72-75`) | redesign to the TS no-worker model: `Push` = non-blocking direct handoff to a waiting reader (not counted), else enqueue; overflow when `len(queued) >= maxBacklog` (default 1024)→`OnBacklogExceeded()` + enqueue terminal `EventError "consumer backlog exceeded — turn aborted"` + Close (`src/adapters/run-turn-queue.ts:60-67`); two senders never pair, so no-reader tests are deterministic; heartbeat skipped in `PreflightAdapterEvents` (`src/adapters/run-turn-queue.ts:42-43`) |
| `go/internal/bridge/bridge.go` | no stall watchdog; EOF→incomplete w/o reason (`bridge.go:80,88`); `m.terminal` guard (`bridge.go:156`); `Buffered` terminal only on Done/Error (`bridge.go:129`); `recordStreamUsage` maps any ctx.Err()→`OutcomeCancelled` (`bridge.go:111`) | add stall watchdog: `StreamOptions.StallTimeout` (default 300s, `src/stall-timeout.ts:8`) + `StreamOptions.OnCancel func()` (`src/bridge.ts:795`); timer callback only signals a buffered stall channel — ALL machine mutation/writes stay serialized in the bridge select loop; fire→close open items + `response.incomplete` w/ `incomplete_details.reason="upstream_stall_timeout"` + invoke `OnCancel` (`src/bridge.ts:794-815`); EOF incomplete gets `reason="adapter_eof"` (`src/bridge.ts:756-770`); `accept` handles adapter-emitted `EventIncomplete`→finish incomplete w/ reason passthrough (`src/bridge.ts:677-696`); `Buffered` treats `EventIncomplete` as terminal; heartbeat consumed as activity only, never emitted; keep exactly-once guard; cancellation classification: server uses `context.WithCancelCause`, stall fires cancel with a sentinel `UpstreamStallError` cause, and `recordStreamUsage` classifies stall-cause (or status `incomplete`)→`OutcomeProviderError` (HTTP 502, `src/server/request-log.ts:518`) while genuine caller cancel stays `OutcomeCancelled`/499 |
| `go/internal/server/server.go` | Responses route builds `streamCtx` then calls `ParseStream` + `bridge.StreamWithOptions` (`server.go:288`) | create the cancellable stream context in the route, share it between `ParseStream` and the bridge, and pass its cancel as `StreamOptions.OnCancel` so a stall actually kills the adapter/upstream body (`src/server/responses/core.ts:1351`) |
| `go/internal/chat/outbound.go` | EventError→error frame, no DONE (`outbound.go:145`); no incomplete handling | add `EventIncomplete` case: `max_output_tokens`→finish `length`+[DONE]; `content_filter`→finish `content_filter`+[DONE]; else→error frame `"upstream stream ended early (<reason>)"`, NO [DONE] (`src/chat/outbound.ts:351-360`); heartbeat ignored |
| `go/internal/chat/messages_outbound.go` | two terminal switches w/o incomplete (`messages_outbound.go:19,132`); streaming errors default 502 `api_error` (`messages_outbound.go:182`) | add `EventIncomplete` case: `max_output_tokens`→finish `max_tokens`; `content_filter`→finish `refusal`; else→error status **529** type `overloaded_error` message `"upstream response was incomplete (<reason>)"` (or `details.message` when present), retryable (`src/claude/outbound.ts:408-419`); heartbeat = explicit no-op |
| `go/internal/chat/messages.go` | non-streaming converts every builder error into 502 (`messages.go:69`) | typed incomplete error carries status 529 + `overloaded_error` through the non-streaming path (`src/claude/outbound.ts:551`); unrelated errors stay 502 |
| `go/internal/chat/compact.go` | `compactionSummary` terminal = Done only (`compact.go:269`) | `EventIncomplete` = terminal boundary, no text contribution |
| `go/internal/search/loop.go` | `scanSearchCalls` counts only EventDone as terminal; `terminal != 1` errors (`loop.go:200-208`) | count `EventDone` OR `EventIncomplete` as the single terminal AND require the terminal to be the LAST event — late events after terminal are a stream protocol violation (`src/web-search/loop.ts:383-384`); passthrough incomplete |
| Tests: `protocol/sse_test.go`, `adapter/anthropic/anthropic_test.go`, `adapter/openai/request_test.go`, `adapter/openai/queue_test.go`, `adapter/google/google_test.go`, `chat/outbound_test.go`, `chat/compact_test.go`, `chat/handler_test.go`, `search/search_test.go`, `bridge/bridge_test.go` | gaps per activation matrix | see matrix A1–A9 |

### NEW

None (existing test files absorb all cases).

### DELETE

None.

### OUT

- `go/internal/server/relay.go` — REMOVED from wp2 (A-gate finding 7: no
  caller, no TS-equivalent branch; relay activation needs its own unit).
- Queue production wiring — DEFERRED: Go has no `runTurn` producer
  (`go/internal/types/interfaces.go:10`). Unit-level contract port only.
  Anchors: `src/adapters/run-turn-queue.ts:52`, caller
  `src/server/responses/core.ts:1313`.
- Adapter-emitted `EventIncomplete` producers — NONE in wp2 (TS producers are
  the cursor adapter and web-search loop). Chat/Messages outbound incomplete
  mappings are contract-level ports verified by unit injection at the boundary
  TS defines; production activation arrives with wp3/wp6 cursor work. Bridge
  reasons `adapter_eof`/`upstream_stall_timeout` are Responses-frame level and
  never re-enter the adapter channel.
- OpenAI adapters do NOT opt into comment records (TS does not).
- GPT-Live (050), Cursor continuity store (030).

## Activation matrix

| ID | Trigger | Fixture | Observable | Test path |
|---|---|---|---|---|
| A1 | SSE `: keepalive` comments, opt-in decoder | bytes → decoder w/ comments | comment event surfaced; default decoder still drops | `protocol/sse_test.go` |
| A2a | Anthropic EOF after usage, no `message_stop`, no stop_reason | ParseStream fixture | EventError, exact truncation message | `adapter/anthropic/anthropic_test.go` |
| A2b | Anthropic `message_delta` stop_reason then EOF, no `message_stop` | fixtures (TS pin `tests/anthropic-compatible-stream.test.ts:175`): `refusal`, `end_turn` | `refusal`→Done w/ StopReason `content_filter`; `end_turn`→Done w/ StopReason omitted | `adapter/anthropic/anthropic_test.go` |
| A2c | Anthropic comment stream | fixture w/ `: keepalive` | EventHeartbeat emitted | `adapter/anthropic/anthropic_test.go` |
| A3a | OpenAI chat usage-only EOF, no [DONE]/finish_reason | fixture (TS pin `tests/openai-chat-eof.test.ts:110`) | EventDone | `adapter/openai/request_test.go` |
| A3b | OpenAI chat EOF, no [DONE]/finish_reason/usage | fixture | EventError, exact truncation message | `adapter/openai/request_test.go` |
| A4a | Google usage-only final frame | fixture (TS pin `tests/google-vertex-stream.test.ts:76`) | EventDone | `adapter/google/google_test.go` |
| A4b | Google text-only `MAX_TOKENS`, no tool calls | fixture (TS pin `tests/google-vertex-stream.test.ts:58`) | EventDone (no truncation error) | `adapter/google/google_test.go` |
| A4c | Google unterminated non-`data:` residual | valid terminal frame then residual: `data: {"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}]}\n\ngarbage-without-newline` (EOF, no trailing `\n`) | EventError `"upstream stream ended with an incomplete SSE frame — possible truncation"` | `adapter/google/google_test.go` |
| A4d | Google frames w/o usage or finishReason | fixture | EventError, no-terminal message | `adapter/google/google_test.go` |
| A4e | Google `data:` frame with invalid JSON | fixture `{invalid` payload | EventError `"malformed upstream SSE data frame"` | `adapter/google/google_test.go` |
| A4f | Google liveness-only chunk then EOF w/ terminal | comment/liveness lines only between content | EventHeartbeat emitted; default OpenAI path unchanged | `adapter/google/google_test.go` |
| A5 | Push beyond maxBacklog (no reader) | no-reader fill (two senders never pair → deterministic) | callback fired + terminal error event + closed; direct handoff to a waiting reader NOT counted as backlog; heartbeat skipped by preflight | `adapter/openai/queue_test.go` |
| A6 | Bridge: adapter channel closes w/o terminal; stall timeout fires; heartbeat resets | bridge test w/ short StallTimeout + recorder | `response.incomplete` w/ reason `adapter_eof` / `upstream_stall_timeout`; exactly one terminal + one [DONE]; `OnCancel` invoked on stall; stall recorded as `OutcomeProviderError` (502), caller cancel as `OutcomeCancelled` (499) | `bridge/bridge_test.go` |
| A7 | Second terminal event after first | bridge Stream fixture | terminal frame count == 1 across `completed\|failed\|incomplete`, one [DONE] | `bridge/bridge_test.go` |
| A8 | Chat outbound EventIncomplete per reason | handler tests | `max_output_tokens`→length+[DONE]; `content_filter`→content_filter+[DONE]; `adapter_eof`→error frame, no [DONE] | `chat/outbound_test.go` |
| A9 | Consumer terminal contract | unit tests per consumer | `Buffered` converts on incomplete; messages stream + non-stream `max_output_tokens`→max_tokens / `content_filter`→refusal / else **529 `overloaded_error`**; compact boundary; search loop accepts incomplete as the single LAST terminal and rejects late events after terminal | `bridge/bridge_test.go`, `chat/outbound_test.go`, `chat/handler_test.go`, `chat/compact_test.go`, `search/search_test.go` |

## Verification

```bash
cd go
go test ./internal/protocol ./internal/bridge ./internal/chat ./internal/adapter/openai ./internal/adapter/anthropic ./internal/adapter/google ./internal/types -count=1
go test ./... -count=1 -timeout 120s
go test -race ./internal/protocol ./internal/adapter/openai ./internal/bridge -count=1
go vet ./...
```

## Resume stale-check amendment (2026-07-24, session 019f93a7 wp2 P)

Re-verified every original MODIFY row against the rebased tree (`dev2-go` @
`e0000045`): the rebase replayed zero `go/` changes, all Before states matched
(`sse.go:115-117`, `stall.go` caller-only Activity, `anthropic.go:502-507`,
`chat.go:373-378`, `google.go:520-524`, `queue.go:35-44`, `bridge.go:159-161`,
`outbound.go:147-166`, `relay.go:73`). Amendment committed `603309b3`.

## A-gate round 1 fold-back

- Reviewer: Anscombe (`019f93b6-88dd-7191-b933-93e7acfdbeb3`, Sol medium)
- Verdict: `FAIL` (7 blocking findings + 1 medium)
- Synthesis (REVIEW-SYNTHESIS-01): all 8 findings ACCEPTED, no rebuttals, no
  cross-blocker conflicts. Findings 2+5+6 form one coherent chain
  (types → decoder opt-in → anthropic heartbeat → bridge watchdog/reasons →
  outbound mapping) and were folded as a single design.
- Folded fixes:
  1. A3 reversed TS SoT → chat.go change removed; parity pins A3a/A3b added.
  2. A1 unreachable → full heartbeat chain specified (types, decoder opt-in,
     anthropic wiring, bridge stall watchdog 300s default); OpenAI stays
     opted-out per TS.
  3. A2 too broad → exact TS terminal machine with stop_reason success path
     (A2b) and exact error messages.
  4. A5 wrong contract/dead caller → TS queue contract ported unit-level
     (1024 default, callback, terminal error, close); production wiring
     deferred with anchors; deterministic backlog test.
  5. A6 lossy → EventIncomplete+Reason contract through bridge and chat
     outbound with TS finish-reason mapping (A8).
  6. A4 underspecified → exact sawAnyFrame/sawTerminalSignal predicates +
     4 fixtures incl. positive pins.
  7. relay.go removed from scope (no caller, no TS equivalent).
  8. A7 assertion widened to all terminal names + single [DONE].

Round 2 must use the same reviewer and must pass before B.

## A-gate round 2 fold-back

- Reviewer: Anscombe (`019f93b6-88dd-7191-b933-93e7acfdbeb3`, Sol medium)
- Verdict: `FAIL` (3 High + 2 Medium + 1 Low new findings; round-1 fixes
  confirmed 2 resolved / 6 partial)
- Synthesis (REVIEW-SYNTHESIS-01): all 6 findings ACCEPTED, no rebuttals.
  Findings 1+2 share one root (incomplete/stall ownership was bridge-local
  instead of route-level, and the terminal contract was not propagated to all
  consumers) — folded as one ownership amendment. Main-agent addition beyond
  the findings: Google liveness→heartbeat (`src/adapters/google.ts:447,456`)
  folded into the same heartbeat contract for consistency.
- Folded fixes:
  1. Watchdog cancellation ownership → `StreamOptions.OnCancel func()` added;
     `go/internal/server/server.go` added to MODIFY (route creates the shared
     cancellable ctx for `ParseStream` + bridge); timer only signals a
     buffered stall channel, mutation serialized in the select loop; A6 now
     asserts `OnCancel` fires.
  2. A8 reachability/consumers → `EventIncomplete` defined as a terminal
     adapter event across ALL consumers: `bridge.Buffered`,
     `chat/messages_outbound.go` (both switches, TS `src/claude/outbound.ts:408-419`
     mapping), `chat/compact.go`, `search/loop.go`; adapter-producer
     activation honestly deferred to wp3/wp6 (OUT section).
  3. A4c feasibility → `scanSSE` framing redesign specified (typed residual
     reporting); exact A4c bytes pinned; A4e malformed-JSON case added with
     exact message `"malformed upstream SSE data frame"`.
  4. A5 race → queue redesigned to the TS no-worker model (non-blocking
     direct handoff, enqueue otherwise); determinism argument recorded.
  5. Anthropic mapping → exact `max_tokens`/`refusal|content_filter`/omit
     table in the After column; A2b pins `refusal` and `end_turn`.
  6. A4a/A4b TS anchors swapped (Low).

Round 3 must use the same reviewer and must pass before B. Third FAIL returns
this work-phase to P with a changed plan (LOOP-REPAIR-01).

## A-gate round 3 fold-back (LOOP-REPAIR-01 P-return)

- Reviewer: Anscombe (`019f93b6-88dd-7191-b933-93e7acfdbeb3`, Sol medium)
- Verdict: `FAIL` (2 High + 3 Medium; round-2 fixes confirmed 3 resolved /
  3 partial)
- P-return record: this third FAIL triggered the LOOP-REPAIR-01 P-return.
  The plan was re-verified WHOLESALE against the TS contract surfaces the
  three rounds touched (usage/outcome classification, Messages wire status,
  search terminal ordering, fixture validity, test-file existence) rather
  than patched piecemeal. No scope change resulted: every finding is a
  narrow contract detail inside the existing design, so the "changed plan"
  is this amended doc plus the wholesale re-verification record here.
  Trajectory: 7 blockers → 3H/2M/1L → 2H/3M, all rounds disjoint.
- Synthesis (REVIEW-SYNTHESIS-01): all 5 findings ACCEPTED, no rebuttals.
- Folded fixes:
  1. Stall misclassification → `context.WithCancelCause` + sentinel
     `UpstreamStallError`; `recordStreamUsage` classifies stall/incomplete as
     `OutcomeProviderError` (502, `src/server/request-log.ts:518`), genuine
     caller cancel stays 499; A6 gains a recorder assertion.
  2. Messages 529 contract → streaming else-branch emits 529
     `overloaded_error`; `go/internal/chat/messages.go` added to MODIFY so
     the non-streaming path propagates the same typed status
     (`src/claude/outbound.ts:551`); A9 asserts status+type.
  3. A4c fixture self-defeated → replaced with a valid terminal-bearing
     frame followed by the unterminated garbage residual; A4e remains the
     invalid-JSON case.
  4. Search ordering → terminal must be exactly one AND the last event
     (`src/web-search/loop.ts:383`); A9 adds a late-event rejection fixture.
  5. A9 phantom test paths → repointed to existing owners
     (`chat/outbound_test.go`, `chat/handler_test.go`, `chat/compact_test.go`,
     `search/search_test.go`) and the test MODIFY row now lists every A9
     surface.

Round 4 uses the same reviewer. Any further FAIL returns to P for genuine
scope reduction (candidate: split the consumer-contract rows into a separate
work-phase) rather than another in-place fold.
