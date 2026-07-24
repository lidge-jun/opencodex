# 030_cursor_continuity

## Objective

Port residual Cursor continuity contracts from TS `src/adapters/cursor/**`.

## Files

### NEW

| Path | Before | After |
|---|---|---|
| `go/internal/adapter/cursor/continuity.go` | absent | process-local store: conversation id, token checkpoint, isolated-turn isolation, TTL/byte cap |
| `go/internal/adapter/cursor/continuity_test.go` | absent | C1–C3 activation tests |

### MODIFY

| Path | Before | After |
|---|---|---|
| `go/internal/server/server.go` | body lacks `store` (~L163-175) | parse `store`; pass into request options/metadata |
| `go/internal/types/types.go` | RequestOptions lacks Store | add `Store *bool` or documented metadata key |
| `go/internal/adapter/cursor/request.go` | empty conversationID → newID() (~L32-34) | reuse continuity store id when retention required |
| `go/internal/adapter/cursor/proto.go` | RequestedModel encoding exists | always set for external models |
| `go/internal/adapter/cursor/cursor_test.go` | transport-focused | add retention/requested_model cases or keep in continuity_test |

### DELETE

None.

## Before/after contracts

1. store:false retention-on multi-turn reuses ConversationID
2. external models always encode RequestedModel.ID
3. isolated child turns do not mutate parent continuity entry
4. fail closed on missing token before network

## Activation matrix

| ID | Trigger | Fixture | Observable | Test path |
|---|---|---|---|---|
| C1 | two turns store:false retention-on | BuildAgentRunRequest metadata | same ConversationID | `continuity_test.go` |
| C2 | external model id | BuildAgentRunRequest | RequestedModel non-nil | `cursor_test.go` / continuity_test |
| C3 | isolated=true child | preloaded parent store | parent entry unchanged | `continuity_test.go` |
| C4 | missing token | live transport mock | fail closed | existing cursor tests |

## Verification

```bash
cd go
go test ./internal/adapter/cursor -count=1
go test ./... -count=1 -timeout 120s
```

## Resume stale-check (2026-07-24, session 019f93a7 wp3 P)

Re-verified against rebased dev2-go tree (ccef70ca):

| Doc claim | Current tree | Verdict |
|---|---|---|
| request.go:32 empty conversationID → newID() | `request.go:32-34` reads metadata, newID() fallback | match |
| request.go:95 RequestedModel conditional on parameters | `request.go:95` `if len(parameters) > 0` | match |
| proto.go RequestedModel encoding exists | `proto.go:99-108` full encoding | match |
| kvstore.go exists (blob store, not thread continuity) | `kvstore.go` KVStore with Get/Set/StoreBlob | match |
| No thread-continuity store in Go | rg confirms absent | match |
| server.go lacks `store` parsing | rg "store\|Store" server.go — no hits | match |
| types.go lacks Store field | rg "Store\|store" types.go — no hits | match |
| TS reference: src/adapters/cursor/thread-continuity.ts | bounded Map, TTL 1h, max 2048, scope key, remember/lookup/clear | match |
| TS reference: src/adapters/cursor.ts:81-170 | kv + continuity + recovery + isolate + RequestedModel wiring | match |

All MODIFY/NEW rows verified current. No amendments needed.
