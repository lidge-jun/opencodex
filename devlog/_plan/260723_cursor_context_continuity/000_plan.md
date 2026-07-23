# 260723 Cursor context continuity + error classification + transport hardening

## Objective

Restore per-conversation cumulative context propagation from the Cursor adapter to
Codex, fix the over-broad `resource_exhausted` → 400 classification observed live,
and harden two transport gaps. Work happens in worktree
`/Users/jun/.codex/worktrees/cursorctx-260723` on branch
`codex/260723-cursor-context-continuity` (base `origin/dev` = `71ebf77b`).

## Live evidence (2026-07-23, ~/.opencodex)

1. `usage.jsonl` (provider=cursor, one working session, 17:29–17:45 KST):
   `totalTokens` = 51676 → 107 → 78 → 111177 → 3455 → 518 → 1401 → 1736 → 683 →
   91045 → 421 → (504) → 1513 → 1703 → 698. Absolute context values are interleaved
   with per-turn output-delta-sized values. Expected: monotonic absolute context per
   conversation, like other providers.
2. Six consecutive 400 rows at 17:45:30–17:45:48 (~2s apart):
   `errorCode=invalid_request_error`,
   `upstreamError="Cursor resource limit exceeded: Cursor Connect error resource limit exceeded: Error"`.
   Codex retried blindly (its stream retry budget = 5 → 6 rows).
3. One 504: `"Cursor request timed out: Cursor transport timed out before first response"`.
4. `service.log`: `Cursor model discovery for "cursor" failed [timeout]: No response
   within 8000ms` and `[http]: HTTP/2 session failed; using stale/static catalog degradation.`
5. `responses-state.json`: **zero** entries containing a cursor continuation —
   direct proof the continuation state is never persisted for Cursor.

## Root causes

### RC1 — conversation continuity broken under `store:false` (owns evidence 1, 5)

- Cursor's completed response carries its `conversationId` through
  `continuationStateForResponse()` (`src/server/responses.ts:1245-1263`).
- `rememberResponseState()` skips persistence when the request has `store:false`
  unless `force:true` (`src/responses/state.ts:195`). Codex sends `store:false` on
  every non-Azure HTTP request.
- The two REACHABLE call sites for cursor (runTurn branch) pass `force` only for
  kiro: `src/server/responses.ts:1537`, `:1574`. (Generic sites `:1824`/`:1859`
  exist but cursor never reaches them — it always takes the runTurn branch at
  `:1483`; audit r1 blocker 1.)
- Next request → `previousResponseProviderState()` finds nothing →
  `_cursorConversationId` undefined → fresh UUID per request
  (`src/adapters/cursor/request-builder.ts:195`) → carry-forward cache miss →
  finalize falls back to `{...state.usage}` = output delta only
  (`src/adapters/cursor/protobuf-events.ts:453`).

### RC2 — `resource_exhausted` over-broadly mapped to 400 (owns evidence 2)

- `classifyCursorError()` maps every `resource_exhausted` to
  `"Cursor resource limit exceeded"` (`src/adapters/cursor/cursor-errors.ts:60-63`).
- `src/lib/errors.ts:102` / `:205` special-case that prefix as tool-catalog
  overflow: 400 `invalid_request_error` / `tool_catalog_too_large`.
- gRPC `RESOURCE_EXHAUSTED` is usually quota/rate exhaustion. Only explicit
  "tool catalog/registration too large" text justifies 400. Generic
  `resource_exhausted: Error` should surface as 429 `rate_limit_exceeded` so
  Codex clients back off properly, and combo failover treats it as transient.

### RC3 — transport gaps (owns evidence 3, 4)

- Live turn transport registers only `session.on("connect")`
  (`src/adapters/cursor/live-transport.ts:601`); no session-level `error`
  listener. A TLS/socket/GOAWAY session error may bypass the failure path (and in
  Node semantics, an unhandled `'error'` on a ClientHttp2Session can throw).
- First-frame timeout cleanup uses only `close()`
  (`src/adapters/cursor/live-transport.ts:642-643`); no `destroy()` fallback.
- Discovery `fetchCursorUsableModels()` has no bounded retry for transient
  pre-response failures (`src/adapters/cursor/live-models.ts:33-62`); its real
  caller is `src/codex/catalog.ts:1538`, reached synchronously from
  `/v1/models` and `/api/models` (audit r1 blocker 8).

## Dependency-ordered phase map (PHASE-SPLIT-01)

| Phase | Doc | Scope | Depends on |
|-------|-----|-------|------------|
| 1 | `010_phase1_conversation_continuity.md` | RC1: force-remember Cursor continuation state + byte-bounded response store | — (foundation: identity/state contract) |
| 2 | `020_phase2_resource_exhausted_classification.md` | RC2: split 400 vs 429 | — (independent, but lands after 1 to keep test churn ordered) |
| 3 | `030_phase3_transport_hardening.md` | RC3: settled guard, session error handler, idempotent cleanup, discovery retry | 1–2 landed (touches same files' test suites) |

## Scope boundary

- IN: `src/server/responses.ts` (2 runTurn call sites + predicate),
  `src/responses/state.ts` (byte cap), `src/adapters/cursor/cursor-errors.ts`,
  `src/lib/errors.ts`, `src/adapters/cursor/live-transport.ts`,
  `src/adapters/cursor/live-models.ts` (+ `transport.ts` factory input), matching tests.
- OUT: GUI, docs-site, kiro adapter behavior, catalog degradation policy,
  transport-retry commit semantics (post-connect no-replay stays), release work,
  any push (DEV-GIT-PUSH-01 — no push without explicit approval).

## Loop spec

- Archetype: spec-satisfaction repair. Trigger: live-log defects above.
- Verifier: `bun run typecheck` + `bun run test` (full) + focused
  `bun test tests/cursor-*.test.ts tests/responses-state.test.ts
  tests/adapter-error-inline.test.ts tests/request-log.test.ts
  tests/errors-adapter-failure.test.ts`.
- Stop: all criteria met (goalplan c1–c4) or Terminal outcome with evidence.
- Memory artifact: this unit + `.codexclaw/goalplans/opencodex-cursor-adapter-restore-per-conversatio/`.
- Escalation: any change that would alter kiro/passthrough semantics → NEEDS_HUMAN.
