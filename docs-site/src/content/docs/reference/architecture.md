---
title: Architecture
description: opencodex internals — module map, the AdapterEvent bridge, the request parser, and caching.
---

opencodex is a single Bun process. A request enters as OpenAI Responses, is normalized to an internal
model, routed, sent to a provider via an adapter, and bridged back to Responses SSE. See
[How It Works](/opencodex/getting-started/how-it-works/) for the end-to-end flow.

## Module map

```
src/
├── cli/                # ocx command dispatch, init, status, provider commands
├── server/             # Bun.serve, /v1/* proxy, /api/* management API, WS bridge
├── codex/              # Codex config injection, catalog sync, auth/account integration
├── providers/          # provider metadata, API-key pool, quota and labels
├── adapters/           # seven wire adapters, shared guards/utilities, Cursor protobuf transport
├── oauth/              # OAuth providers, API-key catalog, token store/refresh
├── usage/              # request usage extraction, JSONL logs, summaries, totals
├── lib/                # runtime, process, retry, privacy, token estimate helpers
├── web-search/         # web-search sidecar (synthetic tool, loop, executor, parser)
├── vision/             # vision sidecar (describe + plan)
├── config.ts           # ~/.opencodex/config.json, defaults, PID, env resolution
├── router.ts           # model id → provider + adapter
├── bridge.ts           # AdapterEvent stream → Responses SSE / JSON
├── reasoning-effort.ts # reasoning-effort translation, clamping, and catalog levels
├── responses/
│   ├── parser.ts       # Responses request → OcxParsedRequest
│   ├── schema.ts       # Zod validation
│   └── compaction.ts   # remote compaction prompts, envelopes, compact history
├── service.ts          # launchd / systemd / Task Scheduler background service
├── types.ts            # core interfaces + helpers (modelInList, namespacedToolName)
└── index.ts            # public entry
```

Three formerly large entry files now preserve compatibility as facades: `codex/catalog.ts` exports
the seven focused `codex/catalog/*.ts` modules, `server/management-api.ts` dispatches to the nine
`server/management/*.ts` modules, and `server/responses.ts` exports the five
`server/responses/*.ts` modules.

## Request flow

`server/index.ts` owns the HTTP boundary and delegates the Responses data plane to
the `server/responses.ts` facade and its `server/responses/*.ts` modules:

1. `server/index.ts` applies CORS and API authentication, rejects new work while draining, and
   records request lifecycle metadata. It serves `GET /v1/models`, `POST /v1/responses`,
   `POST /v1/responses/compact`, `POST /v1/images/generations` / `POST /v1/images/edits`
   (relayed to an OpenAI-family upstream by `server/images.ts` for codex's built-in `image_gen`
   tool), and the optional WebSocket upgrade on `/v1/responses`.
2. `server/responses/core.ts` decompresses and parses JSON, expands locally remembered
   `previous_response_id` input when available, then calls `responses/parser.ts`.
3. `router.ts` resolves a bare or `provider/model` id. The server then resolves Codex account
   affinity, refreshes provider OAuth when needed, and applies the selected credential to the route.
4. Before the main call, `vision/` describes images for models in `noVisionModels`; if no safe
   sidecar path exists, images are removed rather than sent to a text-only upstream.
5. `server/adapter-resolve.ts` applies any model-specific wire override and constructs one of the
   seven adapters. Responses passthrough relays the native body, Cursor runs its bidirectional
   `runTurn` transport, and translated adapters build/fetch/parse an upstream request.
6. For routed models with a hosted `web_search` tool, `web-search/` exposes a synthetic function,
   executes the real search through the ChatGPT sidecar, feeds results back to the routed model, and
   repeats within the configured loop limit.
7. `bridge.ts` produces Responses SSE or JSON. `server/request-log.ts` and `usage/` collect terminal
   status, latency, provider/model labels, and best-effort token usage without changing the response.

## The parser

`responses/parser.ts` validates the incoming request with `responses/schema.ts` (Zod), then builds an
`OcxParsedRequest`:

- **Messages** — `input` items become a normalized `OcxMessage[]`: user / developer / assistant /
  toolResult. `reasoning` items become thinking blocks; `function_call`, `custom_tool_call`, and
  `tool_search_call` items become tool calls; their `*_output` counterparts become tool results.
- **Tools** — function tools pass through; **namespaced (MCP) tools are flattened** to
  `namespace__name` (and restored on the way back); **freeform** tools (e.g. `apply_patch`) and
  **tool_search** discovery tools are flagged; **hosted tools** (`web_search`, image gen, …) are
  dropped and re-injected by a sidecar only if it will handle them.
- **Images** — preserved as real content parts (data URL or remote https), never inlined as text.
- **Feature flags** — `_webSearch` (hosted web search requested), `_structuredOutput`
  (`text.format` is json_schema / json_object), and `_compactionRequest` (remote compaction v2).

## The bridge

`bridge.ts` turns the adapter's internal `AdapterEvent` stream back into Responses SSE that Codex
understands:

| AdapterEvent | Responses SSE emitted |
| --- | --- |
| `text_delta` | `response.output_text.delta` → `…done`, `response.content_part.done`, `response.output_item.done` |
| `thinking_delta` | `response.reasoning_summary_text.delta` → `…done`, item close |
| `reasoning_raw_delta` | A raw `reasoning_text` item (or a hidden round-trip envelope) |
| `thinking_signature` / `redacted_thinking` | Preserved in an `encrypted_content` reasoning envelope |
| `tool_call_start` | `response.output_item.added` (type: `function_call` / `custom_tool_call` / `tool_search_call`) |
| `tool_call_delta` | `response.function_call_arguments.delta` (skipped for freeform / tool_search) |
| `tool_call_end` | `response.function_call_arguments.done` → `response.output_item.done` |
| `web_search_call_begin` / `web_search_call_end` | One live `web_search_call` item plus URL citations |
| `heartbeat` | Marks upstream activity; no user-visible output item |
| `done` | `response.completed` (with usage) |
| `error` | `response.failed` (with `last_error`) |

The bridge also runs a **heartbeat keep-alive** (RC3): during upstream silence, it emits a
parser-ignored `response.heartbeat` SSE event every 2 seconds to re-arm Codex's idle timer. The
default **stall deadline** is 600 seconds (`stallTimeoutSec`); reaching it aborts the upstream and emits
`response.incomplete` with reason `upstream_stall_timeout`, preventing a hung connection from blocking
Codex indefinitely.

Tool calls are disambiguated into three Responses item types using the namespace map, the freeform
set, and the tool-search set captured by the parser — so MCP namespaces, `apply_patch`-style freeform
tools, and client-executed `tool_search` all round-trip. A `buildResponseJSON()` variant produces a
single non-streaming response object from the same events.

## Management API, OAuth, and usage

`server/management-api.ts` backs the dashboard and dispatches focused route groups to
`server/management/*.ts`. Its `/api/*` routes cover safe config/settings,
provider CRUD and key pools, model selection/context caps/v2 controls, catalog sync, diagnostics and
debug logs, usage and quotas, sidecar settings, updates, generated client API keys, OAuth login/status/
logout and account selection, Codex account management, and graceful stop. `server/auth-cors.ts`
requires `OPENCODEX_API_AUTH_TOKEN` for both `/api/*` and `/v1/*` when the proxy binds beyond
loopback; configured `corsAllowOrigins` entries extend the local-origin allowlist.

OAuth implementations live in `oauth/`; access tokens are loaded or refreshed immediately before a
routed call, while `oauth/token-guardian.ts` can proactively refresh only providers whose policy
allows it. Codex/ChatGPT pool credentials and thread affinity live under `codex/` and are kept out of
management responses. Request usage is normalized to `OcxUsage`, surfaced in Responses terminal
events, and aggregated by `usage/` for the dashboard and optional JSONL diagnostics.

## Transport and compaction

`server/index.ts` serves HTTP/SSE on `/v1/responses` by default. If Codex attempts a Responses
WebSocket upgrade while `websockets` is `false`, opencodex returns `426 upgrade_required`; Codex then
falls back to HTTP for that session. When `"websockets": true` is set, the same endpoint accepts the
upgrade and uses the WebSocket bridge.

Codex context compaction works for routed models. `server/responses/compact.ts` handles
`POST /v1/responses/compact` by running an internal routed summarization turn and returning compacted
history, while `responses/parser.ts` and `bridge.ts` handle remote compaction v2
`compaction_trigger` turns by emitting exactly one synthetic `compaction` output item.

## Caching & the catalog

- `codex/model-cache.ts` keeps a per-provider, in-memory TTL cache of live `/models` results (default 5 min,
  matching Codex's own cache), with a stale-fallback when a fetch fails.
- `codex/catalog/sync.ts`, exported through the `codex/catalog.ts` facade, merges routed models into
  Codex's catalog as namespaced entries, ranks featured
  [subagent models](/opencodex/guides/codex-integration/#the-subagent-picker) first, filters
  `disabledModels`, and can fully restore the pristine catalog from a one-time backup.

## Reasoning effort

`reasoning-effort.ts` translates Codex's reasoning labels into each provider's wire values. The
Codex catalog advertises labels Codex accepts (`low` / `medium` / `high` / `xhigh` / `max`), but
upstream providers may support only a smaller subset or require a real alias. The module:

- Defines the canonical `CODEX_REASONING_LEVELS` and their sort order.
- Clamps a requested effort to the closest supported tier when the exact level is unavailable.
- Resolves per-model and per-provider `reasoningEffortMap` overrides for custom wire mappings.
- Drops the effort entirely for models listed in `noReasoningModels`.

## Core types

The internal model lives in `types.ts`: `OcxParsedRequest`, `OcxContext`, the `OcxMessage` union,
`OcxContentPart` (text / image), `OcxToolCall`, `OcxTool`, `AdapterEvent`, and the config types
(`OcxConfig`, `OcxProviderConfig`). Two helpers are widely used: `namespacedToolName()` and
`modelInList()` (tolerant `:size`-tag matching for `noVisionModels` / `noReasoningModels`).
