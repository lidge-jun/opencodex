# 001 — OpenCodex Cursor inventory

Research only. Local tree + explorer Helmholtz / Planck / Hypatia / Leibniz.

## Layout

`src/adapters/cursor/` owns the live protobuf adapter. Supporting files:

- Transport: `live-transport.ts` (1443 lines), `transport.ts`, `transport-retry.ts`, `http1-bidi.ts`, `framing.ts`
- Request: `request-builder.ts`, `protobuf-request.ts`, `tool-definitions.ts`
- Events / usage: `protobuf-events.ts`, `checkpoint-store.ts`, `thread-continuity.ts`, `kv-store.ts`
- Exec: `native-exec.ts` + `native-exec-*.ts`, `exec-policy.ts`, `mcp-manager.ts`, `mcp-config.ts`
- Catalog: `discovery.ts`, `live-models.ts`, `effort-map.ts`
- Errors: `cursor-errors.ts`
- Generated proto: `gen/agent_pb.ts`
- OAuth: `src/oauth/cursor.ts` (not under adapters)
- Adapter entry: `src/adapters/cursor.ts`
- Tests: `tests/cursor-*.test.ts` (39 files)

## Protocol

OpenCodex posts `POST /agent.v1.AgentService/Run` as Connect proto, 5s `clientHeartbeat`, client version `cli-2026.07.08-0c04a8a`:

```90:92:src/adapters/cursor/live-transport.ts
const CURSOR_RUN_PATH = "/agent.v1.AgentService/Run";
const CURSOR_CLIENT_VERSION = "cli-2026.07.08-0c04a8a";
const HEARTBEAT_MS = 5_000;
```

HTTP/1 fallback exists: `RunSSE` + `BidiAppend` in `http1-bidi.ts:10-11`. First-frame timeout is 30s (`live-transport.ts:93`). After that, liveness is the Responses bridge stall watchdog (default 300s, `src/stall-timeout.ts:8`), kept alive by synthetic `heartbeat` events on swallowed progress frames (`live-transport.ts:1304-1309`).

`turnEnded` maps to `finalizeTurnEvents` (`protobuf-events.ts:1327-1328`). Transport still waits for Connect EOF. If EOF arrives after assistant text without `turnEnded`, it synthesizes `done` (`live-transport.ts:1147-1150`). Client-tool Responses path **intentionally** ends turn 1 without waiting for `turnEnded` (`live-transport.ts:203-206`).

Unknown `interactionQuery` replies empty with matching id so the server unblocks (`live-transport.ts:376-382`, issue #116). Web/exa queries are approved; askQuestion/switchMode rejected (`live-transport.ts:287-366`).

## Auth / catalog

Same Cursor PKCE poll as senpi: `loginDeepControl`, `auth/poll`, `exchange_user_api_key` (`src/oauth/cursor.ts:13-15`). After login, catalog uses stored tokens via `getValidAccessToken`. `GetUsableModels` is empty-body unary (`live-models.ts:12-14, 28`). Decode keeps **ids only** (`live-models.ts:115-131`). Static seed in `discovery.ts` is filtered by live ids; `stripCursorWirePrefix` at the comparison boundary (`discovery.ts:67-84`, issue #117). Effort is a static suffix table (`effort-map.ts`). `RequestedModel.maxMode` is hardcoded `false` (`protobuf-request.ts:963-966`).

## Exec

Known proto cases end at `writeShellStdinArgs` (`gen/agent_pb.ts:6886+`). Dispatcher: `native-exec.ts:550-609`. Default `nativeLocalExec` is **off**; only `"on"` authorizes local fs/shell/fetch (`exec-policy.ts:17-44`). Unknown exec returns `[]` to keep the stream alive (`native-exec.ts:605-609`). Responses `mcpArgs` are **not** executed locally (`live-transport.ts:226-246, 1236-1246`). Native exec emits `local_side_effect` before running so `invalid_argument` remint cannot replay (`live-transport.ts:1248-1252`).

## Usage / overflow

Checkpoint `usedTokens` is absolute context, not an output delta (`protobuf-events.ts:1233-1238`). Conversation-keyed cache: 200 entries / 60 minutes (`protobuf-events.ts:21-22`). Generated `TurnEndedUpdate` is empty (`gen/agent_pb.ts:3083-3085`), so billed cacheRead is not ingested. Generic `resource_exhausted` classifies as 429 unless an explicit size phrase wins (`cursor-errors.ts:131-163`). Transport retry never retries RE (`transport-retry.ts:25`). Conversation remint exists only for external-model `invalid_argument` (`src/adapters/cursor.ts:231-247`). Compaction uses an isolated conversation and does not store its checkpoints (`request-builder.ts:397, 443-444`; `src/server/responses/core.ts:2247-2249`).

## OpenCodex-only keepers

HTTP/1 RunSSE; interactionQuery matrix; fail-closed nativeLocalExec; Responses-tool suspend; JWT-sub multiauth; classified discovery errors; bounded blob KV / checkpoint store; `createTerminalSettler`.
