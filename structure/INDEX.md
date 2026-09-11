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

## Source ownership

One source area has exactly one owning doc. Changing an owned area obliges the same change to update
its doc; see [`AGENTS.md`](AGENTS.md).

| Source path | Owning doc |
| --- | --- |
| `.github/` | [`ops/docs-and-release.md`](ops/docs-and-release.md) |
| `bin/` | [`runtime.md`](runtime.md) |
| `docs-site/` | [`ops/docs-and-release.md`](ops/docs-and-release.md) |
| `gui/` | [`gui-and-management-api.md`](gui-and-management-api.md) |
| `scripts/` | [`ops/docs-and-release.md`](ops/docs-and-release.md) |
| `src/adapters/` | [`adapters/registry.md`](adapters/registry.md) |
| `src/chat/` | [`providers/chat-compat.md`](providers/chat-compat.md) |
| `src/claude/` | [`clients/claude-desktop.md`](clients/claude-desktop.md) |
| `src/cli/` | [`runtime.md`](runtime.md) |
| `src/client/` | [`clients/integrations.md`](clients/integrations.md) |
| `src/clients/` | [`clients/integrations.md`](clients/integrations.md) |
| `src/codex/` | [`catalog.md`](catalog.md) |
| `src/codex/paths.ts` | [`codex-home.md`](codex-home.md) |
| `src/combos/` | [`transports/responses.md`](transports/responses.md) |
| `src/compatibility/` | [`adapters/compatibility-contracts.md`](adapters/compatibility-contracts.md) |
| `src/config.ts` | [`config.md`](config.md) |
| `src/config/` | [`config.md`](config.md) |
| `src/github/` | [`ops/docs-and-release.md`](ops/docs-and-release.md) |
| `src/grok/` | [`providers/xai-grok.md`](providers/xai-grok.md) |
| `src/images/` | [`data-planes/images.md`](data-planes/images.md) |
| `src/integrations/` | [`clients/integrations.md`](clients/integrations.md) |
| `src/lab/` | [`adapters/compatibility-lab.md`](adapters/compatibility-lab.md) |
| `src/lib/config-ownership.ts` | [`overview.md`](overview.md) |
| `src/oauth/` | [`providers/openai-tiers.md`](providers/openai-tiers.md) |
| `src/providers/` | [`runtime.md`](runtime.md) |
| `src/quota/` | [`providers/openai-tiers.md`](providers/openai-tiers.md) |
| `src/remote/` | [`gui-and-management-api.md`](gui-and-management-api.md) |
| `src/responses/` | [`transports/responses.md`](transports/responses.md) |
| `src/router.ts` | [`runtime.md`](runtime.md) |
| `src/routing/` | [`runtime.md`](runtime.md) |
| `src/server/` | [`gui-and-management-api.md`](gui-and-management-api.md) |
| `src/server/images.ts` | [`data-planes/images.md`](data-planes/images.md) |
| `src/server/responses/` | [`transports/responses.md`](transports/responses.md) |
| `src/sidecar/` | [`ops/service-and-sidecars.md`](ops/service-and-sidecars.md) |
| `src/tray/` | [`ops/service-and-sidecars.md`](ops/service-and-sidecars.md) |
| `src/types.ts` | [`runtime.md`](runtime.md) |
| `src/update/` | [`ops/docs-and-release.md`](ops/docs-and-release.md) |
| `src/usage/` | [`gui-and-management-api.md`](gui-and-management-api.md) |
| `src/vision/` | [`ops/service-and-sidecars.md`](ops/service-and-sidecars.md) |
| `src/web-search/` | [`data-planes/search.md`](data-planes/search.md) |

### Deliberately unowned

| Source path | Why |
| --- | --- |
| `src/generated/` | generated from scripts/model-metadata.source.json; the generator is owned by ops/docs-and-release.md |
| `src/lib/` | cross-cutting helpers; each helper is described by the doc of the subsystem that calls it |
| `src/storage/` | no current SOT section; assign one when the storage scanner surface is documented |
| `src/types/` | shared type declarations only |

## Decision records

Superseded reasoning lives in `decisions/` as numbered records. A doc states the contract that holds now and
links the record that explains why; it never carries the reasoning inline.

