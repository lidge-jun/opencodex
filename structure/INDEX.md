# opencodex Structure Index

This folder is the maintainer source of truth for the current system shape. Public user workflows
belong in `docs-site/`. Development work is recorded in `devlog/` units — `_plan/` while open,
`_fin/` once closed — while `docs/` keeps investigations and diagnostic notes worth retaining for
archaeology, debugging, or source research.

Generated from `structure/manifest.json` by `bun run structure:index`. Do not edit by hand; `bun run structure:check` fails when this file and the manifest disagree. The rules for changing anything
in this folder are in [`AGENTS.md`](AGENTS.md).

## Reading order

### Tier 1 — Foundation

What opencodex is, what it owns on disk, and the invariants nothing may break.

| Doc | Scope |
| --- | --- |
| [`overview.md`](overview.md) | Product boundary, local state ownership, and the non-negotiable invariants index. |
| [`runtime.md`](runtime.md) | Entrypoints, process lifecycle, CLI surface, and provider/adapter selection. |

### Tier 2 — Configuration and catalog

Persisted config, the Codex home it writes into, and the model catalog it publishes.

| Doc | Scope |
| --- | --- |
| [`config.md`](config.md) | Persisted config schema, both injection forms, provider validation, and restore. |
| [`codex-home.md`](codex-home.md) | CODEX_HOME resolution, the files opencodex manages there, and Codex-home diagnostics. |
| [`catalog.md`](catalog.md) | Shared Codex catalog assembly, account namespaces, pool rotation, and effort ladders. |
| [`subagents.md`](subagents.md) | Multi-agent surface mode and subagent roster ordering. |

### Tier 3 — Data planes and transports

The wire surfaces a client actually talks to.

| Doc | Scope |
| --- | --- |
| [`transports/responses.md`](transports/responses.md) | The Responses HTTP/SSE data plane, combo failover, and streaming commit boundaries. |
| [`transports/streaming-health.md`](transports/streaming-health.md) | Heartbeat and stall deadlines, plus the opt-in WebSocket transport. |
| [`transports/inventory.md`](transports/inventory.md) | The per-provider transport table and diagnostic outbound safety. |
| [`data-planes/images.md`](data-planes/images.md) | Standalone image generation and edit relay. |
| [`data-planes/search.md`](data-planes/search.md) | Hosted search relay and exact account selectors. |
| [`data-planes/inbound-compat.md`](data-planes/inbound-compat.md) | Chat Completions inbound, Anthropic-shaped clients, and JSON-upstream streaming clients. |

### Tier 4 — Providers and adapters

Per-vendor contracts and the adapter authority that constructs them.

| Doc | Scope |
| --- | --- |
| [`providers/openai-tiers.md`](providers/openai-tiers.md) | Pool/Direct account modes, API-key separation, wire identity, and quota evidence. |
| [`providers/cursor.md`](providers/cursor.md) | Cursor native exec, parameterized models, checkpoints, and active-context usage. |
| [`providers/google.md`](providers/google.md) | Gemini thought-text, response parts, thought-signature replay, and adjacency repair. |
| [`providers/kiro.md`](providers/kiro.md) | Kiro parallel-tool hints, Responses text controls, and reasoning round-trip. |
| [`providers/xai-grok.md`](providers/xai-grok.md) | Grok Build contract parity and hardening. |
| [`providers/chat-compat.md`](providers/chat-compat.md) | Cross-vendor Chat Completions behavior: reasoning, tool results, structured output, parallel tools. |
| [`adapters/registry.md`](adapters/registry.md) | The single adapter construction authority and contract inheritance. |
| [`adapters/compatibility-contracts.md`](adapters/compatibility-contracts.md) | Versioned provider compatibility claims and fixture-evidence boundaries. |
| [`adapters/compatibility-lab.md`](adapters/compatibility-lab.md) | Optional Lab evidence, automation, and its core-runtime isolation boundary. |

### Tier 5 — Surfaces and clients

The dashboard, the management API, and third-party client config ownership.

| Doc | Scope |
| --- | --- |
| [`gui-and-management-api.md`](gui-and-management-api.md) | Dashboard serving, authentication boundaries, /api/* ownership, and usage accounting. |
| [`clients/integrations.md`](clients/integrations.md) | Third-party client config ownership, snapshots, refresh, disable, and restore. |
| [`clients/claude-desktop.md`](clients/claude-desktop.md) | Claude Desktop profile ownership and config-library resolution. |

### Tier 6 — Operations and process

Background service, docs, release, and design discipline.

| Doc | Scope |
| --- | --- |
| [`ops/service-and-sidecars.md`](ops/service-and-sidecars.md) | Service install/repair, platform launchers, tray, and sidecar processes. |
| [`ops/docs-and-release.md`](ops/docs-and-release.md) | Docs site, workflow map, branch policy, release flow, and cross-platform CI. |
| [`design-methodology.md`](design-methodology.md) | Stage ordering for new GUI, CLI, and user-facing surfaces. |

## Which doc describes which source

A source area can be described by more than one doc, because these docs are organised by topic and
`src/` is organised by module. Changing an area obliges the same change to update every doc listed
for it; see [`AGENTS.md`](AGENTS.md).

| Source path | Described by |
| --- | --- |
| `.github/` | [`ops/docs-and-release.md`](ops/docs-and-release.md) |
| `bin/` | [`runtime.md`](runtime.md)<br>[`ops/docs-and-release.md`](ops/docs-and-release.md) |
| `docs-site/` | [`ops/docs-and-release.md`](ops/docs-and-release.md) |
| `gui/` | [`overview.md`](overview.md)<br>[`gui-and-management-api.md`](gui-and-management-api.md)<br>[`design-methodology.md`](design-methodology.md) |
| `scripts/` | [`overview.md`](overview.md)<br>[`ops/docs-and-release.md`](ops/docs-and-release.md) |
| `src/adapters/` | [`runtime.md`](runtime.md)<br>[`transports/responses.md`](transports/responses.md)<br>[`transports/inventory.md`](transports/inventory.md)<br>[`data-planes/inbound-compat.md`](data-planes/inbound-compat.md)<br>[`providers/cursor.md`](providers/cursor.md)<br>[`providers/chat-compat.md`](providers/chat-compat.md)<br>[`adapters/registry.md`](adapters/registry.md) |
| `src/chat/` | [`runtime.md`](runtime.md)<br>[`transports/inventory.md`](transports/inventory.md)<br>[`data-planes/inbound-compat.md`](data-planes/inbound-compat.md) |
| `src/claude/` | [`runtime.md`](runtime.md)<br>[`clients/claude-desktop.md`](clients/claude-desktop.md) |
| `src/cli.ts` | [`runtime.md`](runtime.md)<br>[`ops/docs-and-release.md`](ops/docs-and-release.md) |
| `src/cli/` | [`runtime.md`](runtime.md)<br>[`config.md`](config.md)<br>[`clients/claude-desktop.md`](clients/claude-desktop.md)<br>[`ops/docs-and-release.md`](ops/docs-and-release.md) |
| `src/client/` | [`runtime.md`](runtime.md)<br>[`clients/claude-desktop.md`](clients/claude-desktop.md) |
| `src/clients/` | [`clients/integrations.md`](clients/integrations.md) |
| `src/codex/` | [`runtime.md`](runtime.md)<br>[`config.md`](config.md)<br>[`codex-home.md`](codex-home.md)<br>[`catalog.md`](catalog.md)<br>[`subagents.md`](subagents.md)<br>[`providers/openai-tiers.md`](providers/openai-tiers.md)<br>[`gui-and-management-api.md`](gui-and-management-api.md)<br>[`ops/docs-and-release.md`](ops/docs-and-release.md) |
| `src/combos/` | [`runtime.md`](runtime.md) |
| `src/compatibility/` | [`runtime.md`](runtime.md)<br>[`adapters/compatibility-contracts.md`](adapters/compatibility-contracts.md) |
| `src/config.ts` | [`overview.md`](overview.md)<br>[`runtime.md`](runtime.md)<br>[`config.md`](config.md)<br>[`providers/openai-tiers.md`](providers/openai-tiers.md) |
| `src/config/` | [`runtime.md`](runtime.md)<br>[`config.md`](config.md) |
| `src/generated/` | [`runtime.md`](runtime.md) |
| `src/github/` | [`runtime.md`](runtime.md) |
| `src/grok/` | [`runtime.md`](runtime.md) |
| `src/images/` | [`runtime.md`](runtime.md)<br>[`transports/inventory.md`](transports/inventory.md) |
| `src/index.ts` | [`runtime.md`](runtime.md) |
| `src/integrations/` | [`clients/integrations.md`](clients/integrations.md) |
| `src/lab/` | [`runtime.md`](runtime.md)<br>[`adapters/compatibility-lab.md`](adapters/compatibility-lab.md) |
| `src/lib/` | [`overview.md`](overview.md)<br>[`runtime.md`](runtime.md)<br>[`transports/responses.md`](transports/responses.md)<br>[`transports/inventory.md`](transports/inventory.md)<br>[`gui-and-management-api.md`](gui-and-management-api.md)<br>[`clients/integrations.md`](clients/integrations.md)<br>[`ops/docs-and-release.md`](ops/docs-and-release.md) |
| `src/oauth/` | [`runtime.md`](runtime.md)<br>[`transports/inventory.md`](transports/inventory.md)<br>[`providers/xai-grok.md`](providers/xai-grok.md) |
| `src/providers/` | [`runtime.md`](runtime.md)<br>[`subagents.md`](subagents.md)<br>[`transports/inventory.md`](transports/inventory.md)<br>[`providers/xai-grok.md`](providers/xai-grok.md) |
| `src/reasoning-effort.ts` | [`runtime.md`](runtime.md) |
| `src/remote/` | [`runtime.md`](runtime.md) |
| `src/responses/` | [`runtime.md`](runtime.md)<br>[`transports/responses.md`](transports/responses.md)<br>[`providers/kiro.md`](providers/kiro.md)<br>[`providers/xai-grok.md`](providers/xai-grok.md)<br>[`providers/chat-compat.md`](providers/chat-compat.md) |
| `src/router.ts` | [`runtime.md`](runtime.md) |
| `src/routing/` | [`catalog.md`](catalog.md) |
| `src/server/` | [`runtime.md`](runtime.md)<br>[`catalog.md`](catalog.md)<br>[`subagents.md`](subagents.md)<br>[`transports/responses.md`](transports/responses.md)<br>[`transports/streaming-health.md`](transports/streaming-health.md)<br>[`transports/inventory.md`](transports/inventory.md)<br>[`data-planes/images.md`](data-planes/images.md)<br>[`data-planes/inbound-compat.md`](data-planes/inbound-compat.md)<br>[`providers/xai-grok.md`](providers/xai-grok.md)<br>[`adapters/registry.md`](adapters/registry.md)<br>[`gui-and-management-api.md`](gui-and-management-api.md)<br>[`clients/claude-desktop.md`](clients/claude-desktop.md)<br>[`ops/service-and-sidecars.md`](ops/service-and-sidecars.md) |
| `src/service.ts` | [`runtime.md`](runtime.md)<br>[`ops/docs-and-release.md`](ops/docs-and-release.md) |
| `src/stall-timeout.ts` | [`runtime.md`](runtime.md) |
| `src/storage/` | [`runtime.md`](runtime.md) |
| `src/tray/` | [`runtime.md`](runtime.md) |
| `src/types.ts` | [`runtime.md`](runtime.md)<br>[`config.md`](config.md) |
| `src/update/` | [`runtime.md`](runtime.md) |
| `src/usage/` | [`runtime.md`](runtime.md)<br>[`gui-and-management-api.md`](gui-and-management-api.md) |
| `src/vision/` | [`runtime.md`](runtime.md)<br>[`gui-and-management-api.md`](gui-and-management-api.md) |
| `src/web-search/` | [`runtime.md`](runtime.md) |

### Not described by any doc

| Source path | Why |
| --- | --- |
| `src/bridge.ts` | no doc names this file; it is the legacy adapter bridge entry and its behavior is described under the adapter registry without a path reference |
| `src/quota/` | no doc names a path here; quota evidence is described in providers/openai-tiers.md in prose only |
| `src/service-manager-probe.ts` | no doc names this file; service probing is described in ops/service-and-sidecars.md without a path reference |
| `src/sidecar/` | no doc names a path here; ops/service-and-sidecars.md describes sidecar behavior in prose only |
| `src/types/` | shared declarations plus the tool-name and wire-pin resolvers, which no doc currently describes |

## Decision records

Superseded reasoning lives in `decisions/` as numbered records. A doc states the contract that holds now and
links the record that explains why; it never carries the reasoning inline.

