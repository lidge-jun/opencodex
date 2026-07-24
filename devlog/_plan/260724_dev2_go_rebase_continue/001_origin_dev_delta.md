# 001_origin_dev_delta — ancestry and TS clusters

Date: 2026-07-24

## Counts

- `origin/dev...HEAD` left-right: **131 / 31**
- Merge-base: `6a670bcefefa8f125ac12022446d85571349324c`
- Overlapping changed files since merge-base: **none**

## Only on `dev2-go` (representative)

- Entire `go/**` tree and `.github/workflows/go-ci.yml`
- Governance lines for `dev2-go`
- `devlog/_fin/260724_dev2_go_ci_stabilization/**`

## Only on `origin/dev` (high-signal clusters)

### Stream / responses hardening

- WP1 adapter terminal truth
- WP2 bridge terminal singleness + incomplete caching
- WP3 chat incomplete fidelity (no clean `[DONE]` on stall/eof incompletes)
- WP4 heartbeat/comment keepalive activity
- WP5a abort guard + queue cap
- WP5b pull-driven backpressure

### Cursor

- store:false continuity
- external `requested_model`
- isolated-turn non-mutation of parent continuity
- tool-result byte budget omissions

### Platform / CLI / management

- Codex shim auto-restore after update
- provider discovery status exposure
- pool model rejection retry
- runtime resolver / catalog hardening

### GPT-Live voice

- `src/server/live.ts` family: `POST /v1/live`, realtime call create, sideband WS, AVAS query, protocol header relay
- related server fixes joining sideband on API host, Frameless headers

### N/A for Go residual implementation

- GUI discovery badges / Claude navigation switch
- docs-site locales and README translations
- issue-triage / enforce-issue-quality workflows
- release-notes assembly / npm release train commits
- pure documentation closeouts

## Pre-rebase Go package counts (internal top-level)

adapter 71, server 24, oauth 21, platform 17, claude 16, cli 16, registry 16, protocol 13, chat 12, management 12, usage 10, codex 9, config 8, search 8, vision 7, combos 6, tray 5, service 4, types 4, bridge 3, storage 3, generated 2. Total ~290 Go files.

## Gap signals already observed on Go HEAD

- No Go route for `POST /v1/live` / realtime call sideband cluster; server mux exposes responses/chat/messages/compact + responses WS bridge only (`go/internal/server/server.go`).
- Chat stream emits `[DONE]` on `EventDone`; error path uses `writeChatStreamError` without DONE, but stall/incomplete classification parity with TS WP3 needs re-verify after rebase.
- Cursor package has conversation id + requested model wire fields, but not the full TS continuity store/`store:false` force-retention semantics.
- Codex shim exists; TS CLI auto-restore entrypoint (`maybeAutoRestoreCodexShim`) is not present as an equivalent Go CLI hook.
- Management providers API exists; discovery status field exposure needs parity check against TS `getProviderDiscoveryStatus`.


## Sol residual inventory (Avicenna, REBASE_CLEAN)

Source: independent explorer on HEAD `222b4371` vs local `origin/dev` `b7585565`.

### Classification refresh

| Cluster | Status | Evidence anchors |
|---|---|---|
| Adapter SSE terminal truth | Partial | Anthropic usage-as-terminal `go/internal/adapter/anthropic/anthropic.go:502`; OpenAI Chat usage-only EOF `go/internal/adapter/openai/chat.go:368`; Google always Done `go/internal/adapter/google/google.go:520` |
| Bridge terminal exactly-once | Partial | Guard `go/internal/bridge/bridge.go:156`; no authoritative previous-response/incomplete cache owner |
| Chat incomplete fidelity | Already covered (baseline) | Closed channel without terminal → chat error frame, not clean DONE |
| Heartbeat/stall activity | Missing | SSE comments discarded `go/internal/protocol/sse.go:110`; no link to `StallWatcher.Activity` `go/internal/protocol/stall.go:28` |
| Backpressure/abort | Partial | Demand-limited channel path; `TurnQueue` append unbounded `go/internal/adapter/openai/queue.go:19,32` |
| Cursor store:false continuity | Missing | No `store` parse in `go/internal/server/server.go:163`; new conversation id fallback `go/internal/adapter/cursor/request.go:32` |
| `/v1/live` voice relay | Missing | Routes only responses/chat/messages/health/ws at `go/internal/server/server.go:92` |
| Discovery status API | Partial | Failure timestamps in `go/internal/registry/cache.go:66`; `/api/providers` config-only `go/internal/management/providers.go:25` |
| Shim auto-restore | Missing | Install/uninstall `go/internal/codex/shim.go:105`; no CLI startup reconcile `go/internal/cli/cli.go:46` |
| Kiro progress nonterminal | Missing | Text can complete `go/internal/adapter/kiro/kiro.go:678` |
| Pool model-rejection retry | Missing | No exclusion arg in `ResolveAuth`/`AccountPool.Select`; non-2xx ends request |
| WebSearch domain sanitize | Missing | Domain config dropped `go/internal/claude/inbound.go:140` |
| Apply-patch freeform | Partial | Custom tool args parseable; no freeform flag on `types.Tool` |
| Google whitespace EOF | Narrowly covered | Residual ignore exists; broader terminal-truth still needed |

### N/A

GUI, docs-site/README locales, issue-triage Actions, release-notes automation, pure docs closeouts.

### Rebase mechanics confirmation

- changed-file intersection since merge-base: 0
- `git merge-tree --write-tree HEAD origin/dev` succeeded (tree `94a3ea0349b7b8added8d35fe9a73e319da7b7ed`)
- `go test ./...` green on pre-rebase tip

## Resume delta amendment (2026-07-24 18:51 KST)

- HEAD and fetched `origin/dev2-go`: `105cab4f3dda939fa00fa080605eb7b3ee9378a7`
- fetched `origin/dev`: `cc7bb577184a94784adab43e39a366b8ce65a7b6`
- merge-base: `d34e8ba5d199776834a9fc33dd54bcaab5d70a65`
- `git rev-list --left-right --count HEAD...origin/dev`: `33 1`
- the one new base commit changes only the docs-site header component and stylesheet
- changed-path intersection from the current merge-base: **none**
- current synthetic merge: success (`99594400f0eb715ab27a8b660ec79210bca7ff81`)

This amendment changes only the rebase input. It does not change the residual Go
port classification or the dependency order locked in `000_plan.md`.
