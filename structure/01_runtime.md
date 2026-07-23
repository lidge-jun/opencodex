# Runtime SOT

## Entrypoints

| Path | Responsibility |
| --- | --- |
| `bin/ocx.mjs` | Published npm `bin` entry (Node shim). Resolves the bundled Bun binary (`bun` dependency), lazy-runs its `install.js` if only the placeholder stub is present, then execs `src/cli/index.ts` under Bun. Lets `npm install -g` work without a separately-installed Bun. |
| `src/lib/bun-runtime.ts` | Bundled-Bun resolution: `isRealBunBinary()` (size gate vs the ~450-byte placeholder stub), `bundledBunPath()`, `durableBunPath()` (path baked into service/shim artifacts). |
| `src/cli/index.ts` | `ocx` / `opencodex` CLI: init, start, stop, restore/eject, sync, status, login/logout, gui, service, update. Keeps the `#!/usr/bin/env bun` shebang for from-source dev (`bun run src/cli/index.ts`). |
| `src/server/index.ts` | Bun server entrypoint: `startServer`, `/v1/responses` HTTP + WebSocket routing, exact `POST /v1/images/generations` and `POST /v1/images/edits` routing, `/v1/models`, `/v1/*` JSON 404 guard, GUI fallback, and facade re-exports for split server modules. |
| `src/server/images.ts` | Standalone Images data plane: forward-provider selection, Codex account affinity, bounded opaque request relay, single-attempt upstream fetch, pool health recording, and safe response/cancellation relay. |
| `src/config.ts` | `~/.opencodex/config.json`, defaults, PID path, env-value resolution, `websocketsEnabled()`. |
| `src/router.ts` | Provider/model selection before adapter dispatch. |
| `src/types.ts` | Shared config, parsed request, adapter, and event types. |
| `src/reasoning-effort.ts` | Codex reasoning-level definitions (`low`/`medium`/`high`/`xhigh`), per-model effort mapping, and catalog effort sanitization. |
| `src/codex/shim.ts` | Codex autostart shim: replaces the `codex` binary with a wrapper that auto-starts the proxy on demand. It skips startup for management subcommands even when value-taking global flags precede the subcommand, and detects stale/overwritten wrappers for repair. |
| `src/service.ts` | OS service manager (macOS launchd, Linux systemd, Windows schtasks): always-on proxy with crash restart. |

The `src/` root stays thin: process entry, shared config/types, router, bridge, service manager, and
reasoning effort definitions live there. Feature code is grouped under `src/adapters/`, `src/codex/`,
`src/cli/`, `src/oauth/`, `src/providers/`, `src/responses/`, `src/server/`, `src/update/`,
`src/usage/`, `src/vision/`, `src/web-search/`, and `src/lib/`.

`src/server/` is split by responsibility: `index.ts` owns the listener and route ordering;
`responses.ts` owns Responses handling and compaction; `images.ts` owns the standalone Images relay;
`management-api.ts` owns `/api/*`;
`lifecycle.ts`, `request-log.ts`, `relay.ts`, and `auth-cors.ts` own server infrastructure; and
static GUI, WebSocket bridge, port/liveness, decompression, and adapter-resolution helpers live in
their own files.

## Lifecycle

`ocx start` refuses a duplicate PID, starts the proxy, writes `~/.opencodex/ocx.pid`, syncs Codex
config/catalog, then serves until shutdown. Normal shutdown restores native Codex. Service mode sets
`OCX_SERVICE=1`, so managed restarts do not repeatedly restore/reinject; explicit service stop and
uninstall still restore.

The bridge enforces a heartbeat stall deadline: after 5 minutes (150 ticks at the default 2 s
interval) of upstream silence with no real events, the stream is closed and the upstream request
cancelled. If the adapter generator ends without an explicit done/error event, the response is marked
`incomplete` rather than `completed` so Codex can distinguish a clean finish from a truncated stream.

The server exposes `POST /api/stop` which restores native Codex config, stops any installed service
(to prevent respawn), and exits the process. The GUI sidebar stop button calls this endpoint.

## Providers and adapters

| Path | Responsibility |
| --- | --- |
| `src/providers/registry.ts` | Canonical provider presets for CLI, dashboard, OAuth, key providers, and metadata. |
| `src/providers/derive.ts` | Enrichment from provider presets into user config. |
| `src/oauth/` | OAuth providers, token storage, refresh, and auth-token resolution. |
| `src/adapters/openai-responses.ts` | Native OpenAI/ChatGPT Responses passthrough. |
| `src/adapters/openai-chat.ts` | OpenAI-compatible Chat Completions bridge. |
| `src/adapters/anthropic.ts` | Anthropic Messages bridge. |
| `src/adapters/google.ts` | Gemini bridge. |
| `src/adapters/azure.ts` | Azure OpenAI bridge. |

Adapter output must stay in internal `AdapterEvent` form until `bridge.ts` converts it back to
Responses SSE or WebSocket frames.
