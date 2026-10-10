# 002 — senpi Cursor inventory

Research only. senpi `main` SHA `a5eed44536f3024c5740dc3dfff4ffe0bb08b717`. Explorers Pasteur / Archimedes / Plato / Ohm.

## Layout

Cursor is a first-class builtin provider, not an OpenCodex-style proxy adapter.

- Provider: [packages/ai/src/providers/cursor.ts](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/providers/cursor.ts) — OAuth, empty static catalog, `fetchModels` = live `GetUsableModels`
- Run client: [packages/ai/src/api/cursor-agent.ts](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/api/cursor-agent.ts) (~4439 lines, Node http2)
- Lazy load: `cursor-agent.lazy.ts`; Bun static register: `cursor-agent-provider.ts`
- Catalog grouping: `packages/ai/src/cursor/catalog-grouping.ts`, `model-capabilities.ts`, `selection-descriptor.ts`, `store-migration.ts`
- OAuth: [packages/ai/src/auth/oauth/cursor.ts](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/auth/oauth/cursor.ts)
- Rotation: `packages/ai/src/api/cursor-conversation-rotation.ts`
- Overflow: `packages/ai/src/utils/overflow.ts`
- Host exec-bridge: `packages/coding-agent/src/core/cursor-exec-bridge.ts`
- CLI fallback: `packages/coding-agent/src/core/extensions/builtin/cursor-cli-oauth/`
- PRs: [#905](https://github.com/code-yeongyu/senpi/pull/905) OAuth, [#910](https://github.com/code-yeongyu/senpi/pull/910) protocol, [#921](https://github.com/code-yeongyu/senpi/pull/921) CLI, [#948](https://github.com/code-yeongyu/senpi/pull/948) reasoning levels, [#1013](https://github.com/code-yeongyu/senpi/pull/1013) ANTML skip, [#1015](https://github.com/code-yeongyu/senpi/pull/1015) compact-before-rotate, [#1062](https://github.com/code-yeongyu/senpi/pull/1062) turnEnded completion

## Protocol

Same `AgentService/Run` Connect path, 5s client heartbeat, client version `cli-2026.07.23-e383d2b`. HTTP/2 only; ALPN-stripping proxy is fatal (no h1 fallback). `turnEnded` is the application completion signal: drain exec ≤5s, then close the client HTTP/2 stream ([cursor-agent.ts L249-254, L698-704](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/api/cursor-agent.ts#L249-L254)). HTTP close without `turnEnded` is an error. Stream-health: 30s no inbound frames, 90s heartbeat/checkpoint-only.

Unknown exec is `ExecClientThrow` + `streamClose` so the server is never left blocked. Per-exec 3s heartbeat while a handler runs (`exec-lifecycle.ts`).

`handleServerMessage` has **no `interactionQuery` case** (open [#1026](https://github.com/code-yeongyu/senpi/issues/1026)).

## Auth / catalog

Same PKCE poll. Fail-fast on poll 400/401/403/410; 429 does not burn the transient budget. Catalog is fully dynamic: `models: []`, live GetUsableModels, then `normalizeCursorCatalog` grouping with `thinkingLevelMap` / `cursorReasoning` / `cursorMaxMode`. Live `maxMode` is copied onto `RequestedModel` ([reasoning-params.ts](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/api/cursor-agent/reasoning-params.ts#L8-L20)).

## Exec

Host-injected `CursorExecHandlers` map frames onto senpi tools (`read`/`bash`/`edit`/`write`/`grep`/`find`/`ls` + MCP). Exec-synthesized tool calls are stamped `kCursorExecResolved` so the agent loop does not re-run them. Pi exec family (proto 45–51) is dispatched. Computer-use / canvas / subagents / conversation-search are typed refusals (PR 910). CLI lane is a **separate** spawn of official `cursor-agent -p --output-format stream-json`; tools are display-only; `--force` needs `noApprovalAcknowledgedAt`; kill switch is verbatim `enabled: false`.

## Overflow

0-token `resource_exhausted` is payload overflow for compact-before-rotate (`overflow.ts` `isCursorPayloadResourceExhausted`). First 0-token RE is **surfaced** so session compaction can run; later ones rotate the wire id up to 3 times (`cursor-conversation-rotation.ts`). Billed `turnEnded` cacheRead that dwarfs checkpoint `usedTokens` (>3×) is ignored ([cursor-agent.ts L3544](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/api/cursor-agent.ts#L3544)). ANTML text-tool recovery is skipped for `api === "cursor-agent"` (PR #1013). Compact while a Cursor Run is live is skipped (#984). Open: [#1043](https://github.com/code-yeongyu/senpi/issues/1043) compact-reload restores full toolResult bodies.

## Deliberately not ported (senpi)

Computer use, subagents, Cursor-managed background shells (typed refuse; OpenCodex actually implements bg shell when native exec is on), canvas, smart-mode classifier, conversation search, Kimi-K3 thinking replay, proxy tunneling (PR 910).

