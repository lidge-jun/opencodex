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
| `go/internal/adapter/anthropic/anthropic.go` | decoder without comment opt-in (`anthropic.go:543`); EOF+usage→Done (`anthropic.go:502`) | opt in comments → emit `EventHeartbeat` (`src/adapters/anthropic.ts:740`); terminal machine: `message_stop`→Done; EOF+`stopReason!=""`→Done(usage, mapped reason); EOF otherwise→EventError `"upstream stream ended before message_stop — possible truncation"` (`src/adapters/anthropic.ts:824-838`) |
| `go/internal/adapter/openai/chat.go` | `!sawFinish && usage == nil`→Error, else Done (`chat.go:371`) | NO behavior change — already TS parity (`src/adapters/openai-chat.ts:724`); tests only |
| `go/internal/adapter/google/google.go` | unconditional Done after scanner success (`google.go:481,520`) | track `sawAnyFrame` + `sawTerminalSignal` (usage metadata OR non-empty finishReason); malformed residual frame→Error `"upstream stream ended with an incomplete SSE frame — possible truncation"`; `!sawAnyFrame \|\| !sawTerminalSignal`→Error `"upstream stream ended without a terminal signal — possible truncation"`; keep Vertex/CCA tool-call-only truncation + `VertexTruncationErrorMessage` (`src/adapters/google.ts:388,400,453,470`, `src/adapters/google-truncation.ts:3`) |
| `go/internal/adapter/openai/queue.go` | capacity = make hint; unbounded `Push` (`queue.go:19,38`) | explicit `maxBacklog` (default 1024); overflow→`OnBacklogExceeded()` callback + terminal `EventError "consumer backlog exceeded — turn aborted"` + Close; heartbeat skipped in `PreflightAdapterEvents` (`src/adapters/run-turn-queue.ts:42-43,52-60`) |
| `go/internal/bridge/bridge.go` | no stall watchdog; EOF→incomplete w/o reason (`bridge.go:80,88`); `m.terminal` guard (`bridge.go:156`) | add stall watchdog: `StreamOptions.StallTimeout` (default 300s, `src/stall-timeout.ts:8`), reset on ANY adapter event incl. heartbeat, fire→close open items + `response.incomplete` w/ `incomplete_details.reason="upstream_stall_timeout"` + cancel (`src/bridge.ts:794-815`); EOF incomplete gets `reason="adapter_eof"` (`src/bridge.ts:756-770`); heartbeat consumed as activity only, never emitted; keep exactly-once guard |
| `go/internal/chat/outbound.go` | EventError→error frame, no DONE (`outbound.go:145`); no incomplete handling | add `EventIncomplete` case: `max_output_tokens`→finish `length`+[DONE]; `content_filter`→finish `content_filter`+[DONE]; else→error frame `"upstream stream ended early (<reason>)"`, NO [DONE] (`src/chat/outbound.ts:351-360`); heartbeat ignored |
| Tests: `protocol/sse_test.go`, `adapter/anthropic/anthropic_test.go`, `adapter/openai/request_test.go`, `adapter/openai/queue_test.go`, `adapter/google/google_test.go`, `chat/outbound_test.go`, `bridge/bridge_test.go` | gaps per activation matrix | see matrix A1–A8 |

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
- OpenAI adapters do NOT opt into comment records (TS does not).
- GPT-Live (050), Cursor continuity store (030).

## Activation matrix

| ID | Trigger | Fixture | Observable | Test path |
|---|---|---|---|---|
| A1 | SSE `: keepalive` comments, opt-in decoder | bytes → decoder w/ comments | comment event surfaced; default decoder still drops | `protocol/sse_test.go` |
| A2a | Anthropic EOF after usage, no `message_stop`, no stop_reason | ParseStream fixture | EventError, exact truncation message | `adapter/anthropic/anthropic_test.go` |
| A2b | Anthropic `message_delta` stop_reason then EOF, no `message_stop` | fixture (TS pin `tests/anthropic-compatible-stream.test.ts:175`) | EventDone w/ usage+mapped stop reason | `adapter/anthropic/anthropic_test.go` |
| A2c | Anthropic comment stream | fixture w/ `: keepalive` | EventHeartbeat emitted | `adapter/anthropic/anthropic_test.go` |
| A3a | OpenAI chat usage-only EOF, no [DONE]/finish_reason | fixture (TS pin `tests/openai-chat-eof.test.ts:110`) | EventDone | `adapter/openai/request_test.go` |
| A3b | OpenAI chat EOF, no [DONE]/finish_reason/usage | fixture | EventError, exact truncation message | `adapter/openai/request_test.go` |
| A4a | Google usage-only final frame | fixture (TS pin `tests/google-vertex-stream.test.ts:58`) | EventDone | `adapter/google/google_test.go` |
| A4b | Google text-only `MAX_TOKENS`, no tool calls | fixture (TS pin `tests/google-vertex-stream.test.ts:76`) | EventDone (no truncation error) | `adapter/google/google_test.go` |
| A4c | Google malformed residual SSE frame | truncated fixture | EventError, incomplete-frame message | `adapter/google/google_test.go` |
| A4d | Google frames w/o usage or finishReason | fixture | EventError, no-terminal message | `adapter/google/google_test.go` |
| A5 | Push beyond maxBacklog (no reader) | direct backlog fill, deterministic | callback fired + terminal error event + closed; heartbeat skipped by preflight | `adapter/openai/queue_test.go` |
| A6 | Bridge: adapter channel closes w/o terminal; stall timeout fires; heartbeat resets | bridge test w/ controlled clock/timeout | `response.incomplete` w/ reason `adapter_eof` / `upstream_stall_timeout`; exactly one terminal + one [DONE] | `bridge/bridge_test.go` |
| A7 | Second terminal event after first | bridge Stream fixture | terminal frame count == 1 across `completed\|failed\|incomplete`, one [DONE] | `bridge/bridge_test.go` |
| A8 | Chat outbound EventIncomplete per reason | handler tests | `max_output_tokens`→length+[DONE]; `content_filter`→content_filter+[DONE]; `adapter_eof`→error frame, no [DONE] | `chat/outbound_test.go` |

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
