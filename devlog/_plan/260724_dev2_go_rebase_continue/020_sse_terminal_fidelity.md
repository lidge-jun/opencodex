# 020_sse_terminal_fidelity

## Objective

Close residual stream-terminal gaps vs TS SSE hardening on origin/dev.

## Files

### MODIFY

| Path | Before | After |
|---|---|---|
| `go/internal/protocol/sse.go` | comment lines `HasPrefix(":")` return with no activity (~L117-119) | invoke activity callback / emit comment activity so stall resets |
| `go/internal/protocol/stall.go` | Activity() only when callers invoke | wire decoder consumers to call Activity on comments |
| `go/internal/adapter/anthropic/anthropic.go` | EOF with usage → EventDone (~L502-510) | EOF without message_stop → EventError; usage alone insufficient |
| `go/internal/adapter/openai/chat.go` | usage-only EOF can Done (~L373-378) | require finish_reason or [DONE]; usage-only EOF → Error |
| `go/internal/adapter/google/google.go` | always EventDone after stream (~L520) | fail closed on missing/truncated terminal |
| `go/internal/adapter/openai/queue.go` | unbounded Push append (~L32-40) | enforce max depth; overflow returns false / abort signal |
| `go/internal/bridge/bridge.go` | terminal guard (~L156); incomplete synthesis | keep exactly-once; propagate stall/eof incomplete reasons |
| `go/internal/chat/outbound.go` | Error → no DONE; Done → DONE (~L149-166) | map stall/eof incomplete to error frame without DONE |
| `go/internal/server/relay.go` | keepalive comments written | ensure read-path activity if dual-direction |
| `go/internal/protocol/sse_test.go` | no comment-activity case | add comment keepalive activity test |
| `go/internal/adapter/anthropic/anthropic_test.go` | missing usage-only EOF error | add usage-only EOF → error |
| `go/internal/adapter/openai/queue_test.go` | no overflow bound | add max-depth overflow |
| `go/internal/adapter/openai/request_test.go` or chat tests | missing usage-only EOF | add usage-only EOF → error |
| `go/internal/adapter/google/google_test.go` | truncation partial | missing terminal / truncation fail-closed |
| `go/internal/chat/outbound_test.go` | DONE success cases | incomplete/stall → error, no DONE |
| `go/internal/bridge/bridge_test.go` | terminal count | double Done still count 1 |

### NEW

None expected if existing test files absorb cases. Only create `go/internal/protocol/sse_activity_test.go` if package isolation requires a new file (prefer MODIFY existing).

### DELETE

None.

### OUT

- GPT-Live (050), Cursor continuity store (030)

## Activation matrix

| ID | Trigger | Fixture | Observable | Test path |
|---|---|---|---|---|
| A1 | SSE only `: keepalive\n\n` then data | bytes → NewSSEDecoder | Activity ≥1; stall not fired | `protocol/sse_test.go` |
| A2 | Anthropic ends after usage, no message_stop | ParseStream fixture | EventError not Done | `adapter/anthropic/anthropic_test.go` |
| A3 | OpenAI chat usage then EOF without finish/[DONE] | ParseStream fixture | EventError | `adapter/openai/*_test.go` |
| A4 | Google/Vertex truncated tool stream | stream fixture | EventError | `adapter/google/google_test.go` |
| A5 | Push max+1 on bounded queue | TurnQueue max N | Push false / abort | `adapter/openai/queue_test.go` |
| A6 | Chat WriteChatStream EventError stall incomplete | handler test | error frame; no `data: [DONE]` | `chat/outbound_test.go` |
| A7 | Second EventDone after terminal | bridge Stream | terminal count == 1 | `bridge/bridge_test.go` |

## Verification

```bash
cd go
go test ./internal/protocol ./internal/bridge ./internal/chat ./internal/adapter/openai ./internal/adapter/anthropic ./internal/adapter/google -count=1
go test ./... -count=1 -timeout 120s
go test -race ./internal/protocol ./internal/adapter/openai ./internal/bridge -count=1
```
