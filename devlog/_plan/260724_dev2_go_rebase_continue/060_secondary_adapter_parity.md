# 060_secondary_adapter_parity

## Objective

Re-verify/port secondary gaps after 020–050 foundations.

## Files (action-classified)

### MODIFY

| Path | Candidate | Before | After |
|---|---|---|---|
| `go/internal/adapter/kiro/kiro.go` | Kiro nonterminal | text can append EventDone without completion tool (~L678-694) | progress text nonterminal until completion tool/mode |
| `go/internal/adapter/kiro/kiro_test.go` | Kiro nonterminal | missing progress-only case | activation K1/K2 |
| `go/internal/oauth/authcontext.go` | Pool retry | ResolveAuth(provider, threadID) no exclusion (~L31) | accept excluded account IDs |
| `go/internal/oauth/accountpool.go` | Pool retry | Select no exclude (~L46) | Select(..., exclude map/set) |
| `go/internal/server/server.go` | Pool retry | non-2xx ends request | one retry on allow-listed unsupported-model 400 |
| `go/internal/oauth/store_test.go` or NEW pool test | Pool retry | no exclusion test | P1/P2 |
| `go/internal/claude/inbound.go` | WebSearch domains | web_search stripped bare (~L140-145) | sanitize keep valid domains only |
| `go/internal/claude/claude_test.go` | WebSearch domains | missing domain sanitize | W1 |
| `go/internal/types/types.go` | Freeform apply_patch | Tool lacks freeform (~L33-39) | optional Freeform/Custom flag |
| `go/internal/adapter/cursor/tool_defs.go` | Freeform apply_patch | no freeform envelope guidance | advertise freeform when apply_patch present |
| `go/internal/adapter/cursor/tools_test.go` | Freeform apply_patch | missing freeform flag case | F1 |
| `go/internal/adapter/google/google.go` / scanner helper | Google whitespace EOF | residual ignore partial | only if 020 did not absorb; unit test residual |

### NEW

| Path | When |
|---|---|
| `go/internal/oauth/accountpool_test.go` | if store_test cannot host exclusion cases cleanly |

### DELETE

None.

## Activation matrix (all five candidates)

| ID | Candidate | Trigger | Fixture | Observable | Test path |
|---|---|---|---|---|---|
| K1 | Kiro nonterminal | progress text, no completion tool | smithy/event fixture | no EventDone stop; phase commentary | `adapter/kiro/kiro_test.go` |
| K2 | Kiro nonterminal | completion tool present | fixture with completion | EventDone | `adapter/kiro/kiro_test.go` |
| P1 | Pool retry | first account 400 unsupported model | two-account pool + mock upstream | second account attempted once | `oauth/accountpool_test.go` or store_test + server test |
| P2 | Pool retry | non-allow-listed 400 | same | no hop; error returned | same |
| W1 | WebSearch domains | mixed valid/invalid domains on tool | inbound translate fixture | only valid domains remain | `claude/claude_test.go` |
| F1 | Freeform apply_patch | tools include apply_patch freeform | tool catalog build | Tool.Freeform true + envelope guidance | `adapter/cursor/tools_test.go` |
| G1 | Google whitespace EOF | whitespace-only residual then EOF | scanner fixture | no false parse error; terminal policy owned by 020 | `adapter/google/google_test.go` |

## Disposition table (fill in B/C)

| Candidate | ported / already_covered / deferred | Evidence |
|---|---|---|
| Kiro nonterminal | | |
| Pool retry | | |
| WebSearch domains | | |
| Freeform apply_patch | | |
| Google whitespace EOF | | |

## Verification

```bash
cd go
go test ./internal/adapter/kiro ./internal/oauth ./internal/claude ./internal/types ./internal/adapter/cursor ./internal/adapter/google ./internal/server -count=1
go test ./... -count=1 -timeout 120s
```
