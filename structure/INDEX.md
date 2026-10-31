# opencodex Structure Index

This folder is the maintainer source of truth for the current system shape. Public user workflows
belong in `docs-site/`. Development work is recorded in `devlog/` units — `_plan/` while open,
`_fin/` once closed.

Generated from `structure/manifest.json` by `bun run structure:index`. Do not edit by hand; `bun run structure:check` fails when this file and the manifest disagree. The rules for changing anything
in this folder are in [`AGENTS.md`](AGENTS.md).

## Reading order

### Tier 1 — Foundation

What opencodex is, what it owns on disk, and the invariants nothing may break.

| Doc | Scope |
| --- | --- |
| [`overview.md`](overview.md) | Product boundary, local state ownership, and the non-negotiable invariants index. |
| [`runtime.md`](runtime.md) | Entrypoints, process lifecycle, CLI surface, and the Remote Hub, sideband, and request-compatibility contracts on that path. |

### Tier 2 — Configuration and catalog

Persisted config, the Codex home it writes into, and the model catalog it publishes.

| Doc | Scope |
| --- | --- |
| [`config.md`](config.md) | Persisted config schema, both injection forms, provider validation, and restore. |
| [`codex-provider-routing.md`](codex-provider-routing.md) | Explicit provider-ID routing consent, URL-only publication and recovery. |
| [`codex-home.md`](codex-home.md) | CODEX_HOME resolution, the files opencodex manages there, and Codex-home diagnostics. |
| [`codex-prompts.md`](codex-prompts.md) | Prompt-layer repair, base import previews and bounded text-probe sources. |
| [`codex-cli-update.md`](codex-cli-update.md) | Content-bound planning and explicit POSIX/Windows x64 apply with isolated npm, artifact validation, installation leases and readback. |
| [`catalog.md`](catalog.md) | Shared Codex catalog assembly, account namespaces, pool rotation, and effort ladders. |
| [`catalog-vendor-context.md`](catalog-vendor-context.md) | Bundled model-ID window fallback, ambiguity handling, and inferred-capacity provenance. |
| [`catalog-effort-clamp.md`](catalog-effort-clamp.md) | Persisted effort-clamp observation identity and idempotent sync notices. |
| [`catalog-routed-ownership.md`](catalog-routed-ownership.md) | Generated routed-row ownership signals and combo catalog description overrides. |
| [`subagents.md`](subagents.md) | Multi-agent surface mode and subagent roster ordering. |
| [`subagent-capacity.md`](subagent-capacity.md) | Surface mode, hybrid global flag, concurrent child limits and canonical Codex setting ownership. |
| [`advisor.md`](advisor.md) | The optional expert consultation sidecar: manual/preflight/adaptive policies, evidence, durable task allowance, metadata activity, and loopback routing. |
| [`config-proxy.md`](config-proxy.md) | Global proxy activation, start flags, and credential-safe CLI output. |
| [`account-auto-pause.md`](account-auto-pause.md) | Opt-in permanent account refusal classification, credential fences, durable pause metadata, bounded recovery and resume. |

### Tier 3 — Data planes and transports

The wire surfaces a client actually talks to.

| Doc | Scope |
| --- | --- |
| [`transports/timeouts.md`](transports/timeouts.md) | Local header and JSON body deadlines, cancellation and optional OpenCode timeout export. |
| [`remote-messaging.md`](remote-messaging.md) | Explicit peer enrollment, connection-bound capabilities, bounded foreground SSH ownership and queued remote replies. |
| [`local-messaging.md`](local-messaging.md) | Loaded-session Unix messaging and separate opt-in stored-queue MCP tools, receipts and owned helper bounds. |
| [`transports/byte-accounting.md`](transports/byte-accounting.md) | Request-copy and stream-buffer byte accounting shared by parsing, SSE rewriting, the adapters, and the translator budget, plus durable spill admission. |
| [`transports/anthropic-thinking-recovery.md`](transports/anthropic-thinking-recovery.md) | One-shot exact signature-binding recovery before output, and successful-retry memo boundaries. |
| [`transports/response-turn-membership.md`](transports/response-turn-membership.md) | Embedding-owned signing material, dedicated authenticated caller/own-thread scope and pre-parser structural normalization. |
| [`transports/response-citations.md`](transports/response-citations.md) | OpenAI-operated outbound citation repair and generated JSON/SSE annotation titles. |
| [`transports/max-output-completion.md`](transports/max-output-completion.md) | Default-off translated Responses text-only token-limit completion and exclusions. |
| [`transports/responses.md`](transports/responses.md) | The Responses HTTP/SSE endpoint, dispatch, credential and upload boundaries, and core module ownership. |
| [`transports/native-reasoning-retention.md`](transports/native-reasoning-retention.md) | Optional native reasoning ciphertext forwarding on model/account switches, configuration and management controls. |
| [`transports/responses-citations.md`](transports/responses-citations.md) | Destination-gated citation repair for ordinary Responses and every native compact send. |
| [`transports/responses-wire-shapes.md`](transports/responses-wire-shapes.md) | Mixed-wire model defaults, xAI agent-message continuation, declared-tool membership, and passthrough SSE stream shapes. |
| [`transports/responses-failover.md`](transports/responses-failover.md) | Upstream reset retry, the ambiguous-resend gate, combo failover and commit boundaries, compaction routing, and output headroom. |
| [`transports/responses-combo-boundaries.md`](transports/responses-combo-boundaries.md) | Combo preflight output commitment, turn lease lifetime, and bounded hop warnings. |
| [`transports/policy-fallback.md`](transports/policy-fallback.md) | Original policy authorization, concrete candidate retries and physical destination deduplication. |
| [`transports/responses-spend.md`](transports/responses-spend.md) | Credential-hop and durable spend reservations, and what a spent budget tells the client. |
| [`transports/streaming-health.md`](transports/streaming-health.md) | Heartbeat and stall deadlines, plus the opt-in WebSocket transport. |
| [`transports/inventory.md`](transports/inventory.md) | The per-provider transport table and diagnostic outbound safety. |
| [`data-planes/images.md`](data-planes/images.md) | Standalone image generation/edit relay and local hosted Responses image display. |
| [`data-planes/search.md`](data-planes/search.md) | Hosted search relay and exact account selectors. |
| [`data-planes/inbound-compat.md`](data-planes/inbound-compat.md) | Chat Completions inbound, Anthropic-shaped clients, and JSON-upstream streaming clients. |
| [`data-planes/claude-tool-loading.md`](data-planes/claude-tool-loading.md) | Physical-adapter tool-loading projection, preserved catalogs, fallback exclusions and opt-in prerequisites. |
| [`data-planes/chat-reasoning-details.md`](data-planes/chat-reasoning-details.md) | The reasoning_details carrier that lets Chat Completions clients round-trip signed Anthropic thinking across tool steps (#7429). |
| [`data-planes/protocol-paths.md`](data-planes/protocol-paths.md) | Shared protocol vocabulary, declared feature dispositions, the ingress-by-upstream baseline, plan/trace shapes, and protocol settings. |
| [`fallback-policy.md`](fallback-policy.md) | OCX-11 fallback off: what is a model or provider fallback (and what intra-pool rotation is not), scope precedence, the guarded hop sites, the fallback_refused and home_unreachable contracts, and the ocx.fallback/1 state. |
| [`remote-workspace.md`](remote-workspace.md) | Opt-in workspace identity, executor grants, runtime adapters, management and dashboard integration. |
| [`remote-link.md`](remote-link.md) | SSH machine-link building blocks: OpenSSH argument policy, ssh_config candidates, tunnel lifecycle reducer, the private link store, and standalone pairing-grant delivery. |

### Tier 4 — Providers and adapters

Per-vendor contracts and the adapter authority that constructs them.

| Doc | Scope |
| --- | --- |
| [`quota-snapshots.md`](quota-snapshots.md) | Bounded write deferral and cancellation for Codex and provider account quota snapshots. |
| [`providers/generic-account-pool.md`](providers/generic-account-pool.md) | Opt-in conversation ownership, request-local selection receipts and bounded release for generic OAuth pools. |
| [`providers/anthropic-progress.md`](providers/anthropic-progress.md) | Opus 5.5 progress display, visible commentary, and exact signed-block replay. |
| [`providers/anthropic-account-thresholds.md`](providers/anthropic-account-thresholds.md) | Account-owned usage thresholds, inheritance, routing boundaries and durable policy changes. |
| [`providers/meta-muse.md`](providers/meta-muse.md) | CLI credential import, approval lifecycle, explicit recovery and account-free login diagnostics. |
| [`providers/oauth-reconciliation.md`](providers/oauth-reconciliation.md) | Operator limits and per-model declarations across startup reconciliation and OAuth upsert. |
| [`providers/antigravity-account-import.md`](providers/antigravity-account-import.md) | Cockpit Tools import schema, identity check, probe-gated project_id fallback and no-write failure paths. |
| [`providers/claude-cli-replay.md`](providers/claude-cli-replay.md) | Claude CLI stable replay, canonical tool schemas, capture-only client tool ownership and subscription usage admission. |
| [`providers-and-adapters.md`](providers-and-adapters.md) | Provider and adapter selection, the adapter inventory, live model discovery, and the hosted-search continuation bridge. |
| [`providers/opengateway.md`](providers/opengateway.md) | Preset discovery, paired Responses tool-result projection and bounded empty-completion recovery. |
| [`providers/jev-decision.md`](providers/jev-decision.md) | JEV Combo decision methods (TypeSafe, self-hosted System One rows, opencodex models), the decision request path, dashboard surfaces, and the content-free statistics projection. |
| [`providers/anthropic-key-billing.md`](providers/anthropic-key-billing.md) | Exact billing refusal evidence, immutable physical credential ownership, pacing provenance and bounded pre-output key recovery. |
| [`providers/workbuddy.md`](providers/workbuddy.md) | Browser login, account-bound refresh and catalogs, fixed-origin Chat transport, tool continuity and display-only credit balances. |
| [`providers/dsh-account.md`](providers/dsh-account.md) | Explicit read-only DSH credential import, verified account identity, disabled refresh, pinned inference and probe destinations, and authoritative-empty quota. |
| [`providers/anthropic-account-pool.md`](providers/anthropic-account-pool.md) | Anthropic OAuth instances (primary and Pool 2), account pause, model routes, quota labels, and pool-bound helpers, quota, reset grants and management surfaces. |
| [`providers/oauth-code-display-login.md`](providers/oauth-code-display-login.md) | Headless code-display OAuth login: flow ownership, expiry, unsupported providers, single-operator store. |
| [`providers/openai-tiers.md`](providers/openai-tiers.md) | Pool/Direct account modes, API-key separation, and the public provider and quota contract. |
| [`providers/pool-credit-renewal.md`](providers/pool-credit-renewal.md) | Independent credit-evidence renewal for opted-in exhausted Codex pool accounts. |
| [`providers/openai-accounts.md`](providers/openai-accounts.md) | Migration and restore, wire identity, store concurrency, pool ordering and exclusions, quota observations, and account-bound retention. |
| [`providers/openai-signed-in-preservation.md`](providers/openai-signed-in-preservation.md) | Opt-in effective priority bands that spend other pool accounts before the signed-in identity, its identity observation and management API. |
| [`providers/cursor.md`](providers/cursor.md) | Cursor native exec, parameterized models, checkpoints, and active-context usage. |
| [`providers/google.md`](providers/google.md) | Gemini thought-text, response parts, thought-signature replay, and adjacency repair. |
| [`providers/kiro.md`](providers/kiro.md) | Kiro parallel-tool hints, Responses text controls, and reasoning round-trip. |
| [`providers/xai-grok.md`](providers/xai-grok.md) | Grok Build contract parity and hardening. |
| [`providers/lm-studio-chat.md`](providers/lm-studio-chat.md) | Preset-scoped single-leading-system normalization, configuration and editor policy. |
| [`providers/chat-compat.md`](providers/chat-compat.md) | Cross-vendor Chat Completions behavior: reasoning, tool results, structured output, parallel tools. |
| [`providers/completed-tool-blocks.md`](providers/completed-tool-blocks.md) | Explicit response-only block completion, ordered safe-call delivery and terminal ownership. |
| [`providers/mimo-bare-calls.md`](providers/mimo-bare-calls.md) | Standalone MiMo bare-block recovery into declared freeform calls, separate from identified-wrapper reconciliation. |
| [`providers/chat-required-tool-results.md`](providers/chat-required-tool-results.md) | Translated Chat terminal guard that fails a clean completion missing a mandatory client tool call. |
| [`adapters/registry.md`](adapters/registry.md) | The single adapter construction authority and contract inheritance. |
| [`adapters/compatibility-contracts.md`](adapters/compatibility-contracts.md) | Versioned provider compatibility claims and fixture-evidence boundaries. |
| [`adapters/compatibility-lab.md`](adapters/compatibility-lab.md) | Optional Lab evidence, automation, and its core-runtime isolation boundary. |

### Tier 5 — Surfaces and clients

The dashboard, the management API, and third-party client config ownership.

| Doc | Scope |
| --- | --- |
| [`cli-management.md`](cli-management.md) | Terminal help and capability metadata, management-client output and the generated operating reference. |
| [`gui-and-management-api.md`](gui-and-management-api.md) | Dashboard serving, authentication boundaries, /api/* ownership, and startup safety. |
| [`provider-completion-diagnostic.md`](provider-completion-diagnostic.md) | Explicit single-model completion test: consent, applicability gate, send-time authority fingerprint, bounded streaming and metadata comparison. |
| [`dashboard-and-usage.md`](dashboard-and-usage.md) | Dashboard page contracts, usage accounting and request metrics, and per-surface management settings. |
| [`quota-pool.md`](quota-pool.md) | The passive GET /api/quota-pool read GOAT consumes (ocx.quota-pool/1): sources, window mapping, absent-not-zero, and the install identity behind homeId and accountRef. |
| [`pricing.md`](pricing.md) | User price policies, prompt-length rate selection, persistence and estimate cache invalidation. |
| [`clients/export-model-names.md`](clients/export-model-names.md) | Per-connection naming policy, router-proven aliases and passive export previews. |
| [`clients/omo-export-dialect.md`](clients/omo-export-dialect.md) | Opt-in Responses dialect for the managed Pi-based omo export and its refresh lifecycle. |
| [`clients/integrations.md`](clients/integrations.md) | Third-party client config ownership, snapshots, refresh, disable, and restore. |
| [`clients/codex-desktop.md`](clients/codex-desktop.md) | Windows package activation, restart context, and protected compatibility authority persistence. |
| [`clients/chatgpt-desktop.md`](clients/chatgpt-desktop.md) | Experimental macOS app-server stdout shim, opt-in launch, restore and failure boundaries. |
| [`clients/claude-desktop.md`](clients/claude-desktop.md) | Claude Desktop profile ownership and config-library resolution. |
| [`clients/claude-desktop-config-reads.md`](clients/claude-desktop-config-reads.md) | Verified regular-file reads of Claude Desktop config-library metadata, profiles and snapshots. |
| [`clients/claude-desktop-model-visibility.md`](clients/claude-desktop-model-visibility.md) | Per-client selection of the rows the Claude Desktop 3P model list carries. |
| [`clients/hermes.md`](clients/hermes.md) | Hermes profile discovery, per-profile selection, ownership stores, and boundaries. |
| [`clients/qoder.md`](clients/qoder.md) | Qoder settings.json provider and custom-model ownership, export and loopback placeholder rules. |
| [`clients/client-support-matrix.md`](clients/client-support-matrix.md) | Generated client support page: registry sources, curated protocol and test claims, drift checks. |
| [`clients/t3code.md`](clients/t3code.md) | T3 Code settings.json Claude provider-instance ownership, proxy environment, custom models and loopback marker rules. |
| [`companion.md`](companion.md) | Shared timeline filtering, usage/quotas, native and web tray title, and WidgetKit display contracts. |
| [`codex-account-controls.md`](codex-account-controls.md) | Account selection order, custom usage thresholds, and stable account-card editing. |

### Tier 6 — Operations and process

Background service, docs, release, and design discipline.

| Doc | Scope |
| --- | --- |
| [`desktop-shell.md`](desktop-shell.md) | Tauri desktop shell, proxy attachment and sidecar lifecycle, tray controls, bootstrap navigation, and desktop companion presence. |
| [`desktop-recovery.md`](desktop-recovery.md) | Native recovery intent, independently anchored executable and accepted-connection proof, cold-start decisions and installation scope. |
| [`desktop-terminal-command.md`](desktop-terminal-command.md) | Desktop-owned ocx command on PATH: record and journal, POSIX shim and shell blocks, Windows user Path, private-path ACL policy, and the local Terminal command page. |
| [`desktop-start-at-login.md`](desktop-start-at-login.md) | macOS tray Start at Login judgment shared with Startup safety, its parity fixture, click rules, and the guarded launch-origin migration. |
| [`ops/service-and-sidecars.md`](ops/service-and-sidecars.md) | Service install/repair, platform launchers, tray, and sidecar processes. |
| [`ops/desktop-supervision.md`](ops/desktop-supervision.md) | Durable Desktop ownership read, takeover-consent handling, live-supervision evidence, the Windows probe's trusted system-directory acquisition, and the supervision latch blocking contract consumed by service and update guards. |
| [`ops/service-logging.md`](ops/service-logging.md) | Service-only console timestamps and bounded copy-truncate log retention. |
| [`ops/service-health-recovery.md`](ops/service-health-recovery.md) | Opt-in sentinel that turns a hung but listening managed service proxy into an exit its manager restarts. |
| [`ops/update-supervised-recovery.md`](ops/update-supervised-recovery.md) | Manager-first recovery after a failed post-update service refresh, and the non-zero unsupervised fallback. |
| [`ops/plugins.md`](ops/plugins.md) | Plugin loading from OPENCODEX_HOME/plugins and the upstream rewrite slot plugins attach to. |
| [`ops/docs-and-release.md`](ops/docs-and-release.md) | Docs site, workflow map, branch policy, release flow, and cross-platform CI. |
| [`design-methodology.md`](design-methodology.md) | Stage ordering for new GUI, CLI, and user-facing surfaces. |
| [`ops/cross-platform-ci.md`](ops/cross-platform-ci.md) | Test lanes, platform coverage, aggregate gating, and release CI proof. |
| [`ops/test-sandbox-cleanup.md`](ops/test-sandbox-cleanup.md) | Test-runner home, case-scoped lifecycle teardown, and Bun test lock generation ownership. |

## Which doc describes which source

A source area can be described by more than one doc, because these docs are organised by topic and
`src/` is organised by module. Changing an area requires review of every listed document. Edit only the documents whose local explanation changes; named cross-cutting authorities and dependents are listed below.

| Source path | Described by |
| --- | --- |
| `.github/` | [`ops/docs-and-release.md`](ops/docs-and-release.md) |
| `app/` | [`overview.md`](overview.md)<br>[`companion.md`](companion.md) |
| `bin/` | [`runtime.md`](runtime.md)<br>[`ops/docs-and-release.md`](ops/docs-and-release.md) |
| `bin/ocx.mjs` | [`codex-cli-update.md`](codex-cli-update.md)<br>[`ops/desktop-supervision.md`](ops/desktop-supervision.md) |
| `desktop/` | [`desktop-shell.md`](desktop-shell.md)<br>[`companion.md`](companion.md) |
| `desktop/src-tauri/src/claim.rs` | [`ops/desktop-supervision.md`](ops/desktop-supervision.md) |
| `desktop/src-tauri/src/cli_command.rs` | [`desktop-terminal-command.md`](desktop-terminal-command.md) |
| `desktop/src-tauri/src/cli_command_posix.rs` | [`desktop-terminal-command.md`](desktop-terminal-command.md) |
| `desktop/src-tauri/src/cli_command_record.rs` | [`desktop-terminal-command.md`](desktop-terminal-command.md) |
| `desktop/src-tauri/src/cli_command_windows.rs` | [`desktop-terminal-command.md`](desktop-terminal-command.md) |
| `desktop/src-tauri/src/first_run.rs` | [`desktop-start-at-login.md`](desktop-start-at-login.md)<br>[`ops/desktop-supervision.md`](ops/desktop-supervision.md) |
| `desktop/src-tauri/src/identity.rs` | [`ops/desktop-supervision.md`](ops/desktop-supervision.md) |
| `desktop/src-tauri/src/login_registration.rs` | [`desktop-start-at-login.md`](desktop-start-at-login.md) |
| `desktop/src-tauri/src/ownership.rs` | [`ops/desktop-supervision.md`](ops/desktop-supervision.md) |
| `desktop/src-tauri/src/recovery.rs` | [`desktop-recovery.md`](desktop-recovery.md) |
| `desktop/src-tauri/src/recovery_activity.rs` | [`desktop-recovery.md`](desktop-recovery.md) |
| `desktop/src-tauri/src/recovery_presence.rs` | [`desktop-recovery.md`](desktop-recovery.md) |
| `desktop/src-tauri/src/resolve.rs` | [`ops/desktop-supervision.md`](ops/desktop-supervision.md) |
| `desktop/src-tauri/src/runtime_stop.rs` | [`ops/desktop-supervision.md`](ops/desktop-supervision.md) |
| `desktop/src-tauri/src/startup.rs` | [`desktop-recovery.md`](desktop-recovery.md)<br>[`ops/desktop-supervision.md`](ops/desktop-supervision.md) |
| `desktop/src-tauri/src/supervisor.rs` | [`desktop-recovery.md`](desktop-recovery.md) |
| `desktop/src-tauri/src/tray_login.rs` | [`desktop-start-at-login.md`](desktop-start-at-login.md) |
| `desktop/ui/cli.html` | [`desktop-terminal-command.md`](desktop-terminal-command.md) |
| `desktop/ui/cli.js` | [`desktop-terminal-command.md`](desktop-terminal-command.md) |
| `docs-site/` | [`clients/client-support-matrix.md`](clients/client-support-matrix.md)<br>[`ops/docs-and-release.md`](ops/docs-and-release.md) |
| `gui/` | [`overview.md`](overview.md)<br>[`transports/native-reasoning-retention.md`](transports/native-reasoning-retention.md)<br>[`gui-and-management-api.md`](gui-and-management-api.md)<br>[`provider-completion-diagnostic.md`](provider-completion-diagnostic.md)<br>[`dashboard-and-usage.md`](dashboard-and-usage.md)<br>[`fallback-policy.md`](fallback-policy.md)<br>[`design-methodology.md`](design-methodology.md)<br>[`companion.md`](companion.md) |
| `gui/src/account-pause-display.ts` | [`account-auto-pause.md`](account-auto-pause.md) |
| `gui/src/components/ModelPriceDialog.tsx` | [`pricing.md`](pricing.md) |
| `gui/src/hooks/useProviderAccountPools.ts` | [`account-auto-pause.md`](account-auto-pause.md) |
| `scripts/` | [`overview.md`](overview.md)<br>[`clients/client-support-matrix.md`](clients/client-support-matrix.md)<br>[`ops/docs-and-release.md`](ops/docs-and-release.md) |
| `scripts/generate-ocx-skill-surface.ts` | [`cli-management.md`](cli-management.md) |
| `scripts/test-run-lock-gate.ts` | [`ops/test-sandbox-cleanup.md`](ops/test-sandbox-cleanup.md) |
| `scripts/test-run-lock.ts` | [`ops/test-sandbox-cleanup.md`](ops/test-sandbox-cleanup.md) |
| `skills/ocx/` | [`cli-management.md`](cli-management.md) |
| `src/adapters/` | [`runtime.md`](runtime.md)<br>[`transports/byte-accounting.md`](transports/byte-accounting.md)<br>[`transports/native-reasoning-retention.md`](transports/native-reasoning-retention.md)<br>[`transports/responses-wire-shapes.md`](transports/responses-wire-shapes.md)<br>[`transports/inventory.md`](transports/inventory.md)<br>[`data-planes/inbound-compat.md`](data-planes/inbound-compat.md)<br>[`providers/anthropic-progress.md`](providers/anthropic-progress.md)<br>[`providers/claude-cli-replay.md`](providers/claude-cli-replay.md)<br>[`providers-and-adapters.md`](providers-and-adapters.md)<br>[`providers/cursor.md`](providers/cursor.md)<br>[`providers/chat-compat.md`](providers/chat-compat.md)<br>[`adapters/registry.md`](adapters/registry.md) |
| `src/adapters/anthropic-rejection-memo.ts` | [`transports/anthropic-thinking-recovery.md`](transports/anthropic-thinking-recovery.md) |
| `src/adapters/anthropic-replay.ts` | [`transports/anthropic-thinking-recovery.md`](transports/anthropic-thinking-recovery.md) |
| `src/adapters/anthropic-tool-catalog.ts` | [`transports/anthropic-thinking-recovery.md`](transports/anthropic-thinking-recovery.md) |
| `src/adapters/base.ts` | [`providers/completed-tool-blocks.md`](providers/completed-tool-blocks.md) |
| `src/adapters/dsh-account.ts` | [`providers/dsh-account.md`](providers/dsh-account.md) |
| `src/adapters/openai-chat.ts` | [`providers/completed-tool-blocks.md`](providers/completed-tool-blocks.md)<br>[`providers/mimo-bare-calls.md`](providers/mimo-bare-calls.md) |
| `src/adapters/openai-chat/` | [`providers/lm-studio-chat.md`](providers/lm-studio-chat.md)<br>[`providers/mimo-bare-calls.md`](providers/mimo-bare-calls.md) |
| `src/adapters/openai-chat/completed-tool-blocks.ts` | [`providers/completed-tool-blocks.md`](providers/completed-tool-blocks.md) |
| `src/adapters/openai-chat/required-tool-result.ts` | [`providers/chat-required-tool-results.md`](providers/chat-required-tool-results.md) |
| `src/adapters/openai-chat/serialized-tool-call-content.ts` | [`providers/completed-tool-blocks.md`](providers/completed-tool-blocks.md) |
| `src/adapters/openai-responses/` | [`transports/response-citations.md`](transports/response-citations.md) |
| `src/adapters/openai-responses/opengateway-input.ts` | [`providers/opengateway.md`](providers/opengateway.md) |
| `src/adapters/openai-responses/passthrough.ts` | [`transports/responses-citations.md`](transports/responses-citations.md)<br>[`providers/opengateway.md`](providers/opengateway.md) |
| `src/adapters/openai-responses/request-strips.ts` | [`transports/responses-citations.md`](transports/responses-citations.md) |
| `src/adapters/unique-tool-call-ids.ts` | [`providers/completed-tool-blocks.md`](providers/completed-tool-blocks.md) |
| `src/adapters/workbuddy-schema.ts` | [`providers/workbuddy.md`](providers/workbuddy.md) |
| `src/adapters/workbuddy.ts` | [`providers/workbuddy.md`](providers/workbuddy.md) |
| `src/advisor/` | [`advisor.md`](advisor.md) |
| `src/bridge.ts` | [`transports/responses.md`](transports/responses.md) |
| `src/bridge/` | [`transports/response-citations.md`](transports/response-citations.md)<br>[`transports/responses.md`](transports/responses.md)<br>[`transports/responses-wire-shapes.md`](transports/responses-wire-shapes.md)<br>[`providers/anthropic-progress.md`](providers/anthropic-progress.md) |
| `src/bridge/max-output-completion.ts` | [`transports/max-output-completion.md`](transports/max-output-completion.md) |
| `src/bridge/response-json.ts` | [`transports/max-output-completion.md`](transports/max-output-completion.md) |
| `src/bridge/sse.ts` | [`transports/response-turn-membership.md`](transports/response-turn-membership.md)<br>[`transports/max-output-completion.md`](transports/max-output-completion.md) |
| `src/chat/` | [`runtime.md`](runtime.md)<br>[`transports/byte-accounting.md`](transports/byte-accounting.md)<br>[`transports/inventory.md`](transports/inventory.md)<br>[`data-planes/inbound-compat.md`](data-planes/inbound-compat.md)<br>[`providers-and-adapters.md`](providers-and-adapters.md)<br>[`providers/chat-compat.md`](providers/chat-compat.md) |
| `src/chat/reasoning-details.ts` | [`data-planes/chat-reasoning-details.md`](data-planes/chat-reasoning-details.md) |
| `src/chatgpt/` | [`clients/chatgpt-desktop.md`](clients/chatgpt-desktop.md) |
| `src/claude/` | [`runtime.md`](runtime.md)<br>[`data-planes/claude-tool-loading.md`](data-planes/claude-tool-loading.md)<br>[`providers/anthropic-progress.md`](providers/anthropic-progress.md)<br>[`clients/claude-desktop.md`](clients/claude-desktop.md)<br>[`clients/claude-desktop-config-reads.md`](clients/claude-desktop-config-reads.md)<br>[`clients/claude-desktop-model-visibility.md`](clients/claude-desktop-model-visibility.md) |
| `src/cli.ts` | [`runtime.md`](runtime.md)<br>[`ops/docs-and-release.md`](ops/docs-and-release.md) |
| `src/cli/` | [`runtime.md`](runtime.md)<br>[`config.md`](config.md)<br>[`remote-messaging.md`](remote-messaging.md)<br>[`local-messaging.md`](local-messaging.md)<br>[`cli-management.md`](cli-management.md)<br>[`provider-completion-diagnostic.md`](provider-completion-diagnostic.md)<br>[`fallback-policy.md`](fallback-policy.md)<br>[`clients/export-model-names.md`](clients/export-model-names.md)<br>[`clients/integrations.md`](clients/integrations.md)<br>[`clients/codex-desktop.md`](clients/codex-desktop.md)<br>[`clients/chatgpt-desktop.md`](clients/chatgpt-desktop.md)<br>[`clients/claude-desktop.md`](clients/claude-desktop.md)<br>[`clients/hermes.md`](clients/hermes.md)<br>[`ops/docs-and-release.md`](ops/docs-and-release.md) |
| `src/cli/account-preservation.ts` | [`providers/openai-signed-in-preservation.md`](providers/openai-signed-in-preservation.md) |
| `src/cli/codex-cli-update.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/cli/codex-provider.ts` | [`codex-provider-routing.md`](codex-provider-routing.md) |
| `src/cli/desktop-runtime-guidance.ts` | [`ops/desktop-supervision.md`](ops/desktop-supervision.md) |
| `src/cli/ensure-desktop-cold-start.ts` | [`desktop-recovery.md`](desktop-recovery.md) |
| `src/cli/link-apply-restart.ts` | [`remote-link.md`](remote-link.md) |
| `src/cli/models-runtime.ts` | [`pricing.md`](pricing.md) |
| `src/cli/status-codex-settings.ts` | [`remote-link.md`](remote-link.md) |
| `src/cli/status-link.ts` | [`remote-link.md`](remote-link.md) |
| `src/cli/update-restart.ts` | [`ops/desktop-supervision.md`](ops/desktop-supervision.md) |
| `src/client/` | [`runtime.md`](runtime.md)<br>[`fallback-policy.md`](fallback-policy.md)<br>[`clients/claude-desktop.md`](clients/claude-desktop.md) |
| `src/client/link-connection.ts` | [`remote-link.md`](remote-link.md) |
| `src/client/link-home.ts` | [`remote-link.md`](remote-link.md) |
| `src/client/link-parity-reporter.ts` | [`remote-link.md`](remote-link.md) |
| `src/client/runtime-restart.ts` | [`remote-link.md`](remote-link.md) |
| `src/clients/` | [`clients/integrations.md`](clients/integrations.md)<br>[`clients/qoder.md`](clients/qoder.md)<br>[`clients/client-support-matrix.md`](clients/client-support-matrix.md)<br>[`clients/t3code.md`](clients/t3code.md) |
| `src/clients/config-export.ts` | [`transports/timeouts.md`](transports/timeouts.md)<br>[`clients/export-model-names.md`](clients/export-model-names.md)<br>[`clients/omo-export-dialect.md`](clients/omo-export-dialect.md) |
| `src/clients/config-export/` | [`clients/export-model-names.md`](clients/export-model-names.md) |
| `src/codex/` | [`runtime.md`](runtime.md)<br>[`config.md`](config.md)<br>[`codex-home.md`](codex-home.md)<br>[`codex-prompts.md`](codex-prompts.md)<br>[`catalog.md`](catalog.md)<br>[`subagents.md`](subagents.md)<br>[`subagent-capacity.md`](subagent-capacity.md)<br>[`transports/responses-failover.md`](transports/responses-failover.md)<br>[`providers/openai-tiers.md`](providers/openai-tiers.md)<br>[`providers/openai-accounts.md`](providers/openai-accounts.md)<br>[`gui-and-management-api.md`](gui-and-management-api.md)<br>[`dashboard-and-usage.md`](dashboard-and-usage.md)<br>[`fallback-policy.md`](fallback-policy.md)<br>[`clients/codex-desktop.md`](clients/codex-desktop.md)<br>[`clients/chatgpt-desktop.md`](clients/chatgpt-desktop.md)<br>[`ops/docs-and-release.md`](ops/docs-and-release.md) |
| `src/codex/account-pause.ts` | [`account-auto-pause.md`](account-auto-pause.md) |
| `src/codex/account-preservation.ts` | [`providers/openai-signed-in-preservation.md`](providers/openai-signed-in-preservation.md) |
| `src/codex/app-server-processes.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/codex/auth-api/account-preservation.ts` | [`providers/openai-signed-in-preservation.md`](providers/openai-signed-in-preservation.md) |
| `src/codex/auth-api/pool-mode-gate.ts` | [`providers/pool-credit-renewal.md`](providers/pool-credit-renewal.md) |
| `src/codex/catalog/effort.ts` | [`catalog-vendor-context.md`](catalog-vendor-context.md)<br>[`catalog-effort-clamp.md`](catalog-effort-clamp.md) |
| `src/codex/catalog/model-hints.ts` | [`catalog-vendor-context.md`](catalog-vendor-context.md) |
| `src/codex/catalog/ownership.ts` | [`catalog-routed-ownership.md`](catalog-routed-ownership.md) |
| `src/codex/catalog/parsing.ts` | [`catalog-vendor-context.md`](catalog-vendor-context.md) |
| `src/codex/catalog/routed-gather.ts` | [`catalog-vendor-context.md`](catalog-vendor-context.md)<br>[`providers/opengateway.md`](providers/opengateway.md) |
| `src/codex/catalog/vendor-context.ts` | [`catalog-vendor-context.md`](catalog-vendor-context.md) |
| `src/codex/cli-update-apply.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/codex/cli-update-artifacts.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/codex/cli-update-files.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/codex/cli-update-inspection-context.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/codex/cli-update-job-execution.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/codex/cli-update-job-store-windows.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/codex/cli-update-job-worker.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/codex/cli-update-job.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/codex/cli-update-lease.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/codex/cli-update-plan.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/codex/cli-update-recovery.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/codex/cli-update-selection-gate.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/codex/cli-update-windows-apply.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/codex/cli-update-windows-layout.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/codex/cli-update-windows-observation.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/codex/cli-update-windows-paths.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/codex/cli-update-worker-recovery.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/codex/cli-update-worker.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/codex/cli-windows-plan-provenance.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/codex/provider-routing.ts` | [`codex-provider-routing.md`](codex-provider-routing.md) |
| `src/codex/quota.ts` | [`quota-snapshots.md`](quota-snapshots.md) |
| `src/codex/runtime.ts` | [`catalog-effort-clamp.md`](catalog-effort-clamp.md) |
| `src/codex/shim.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/codex/signed-in-identity.ts` | [`providers/openai-signed-in-preservation.md`](providers/openai-signed-in-preservation.md) |
| `src/codex/windows-cli-child-native.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/codex/windows-cli-child-pipe.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/codex/windows-cli-child.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/codex/windows-cli-recovery-guardian.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/codex/windows-cli-recovery.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/codex/windows-installation-files.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/codex/windows-npm-execution.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/combos/` | [`runtime.md`](runtime.md)<br>[`providers-and-adapters.md`](providers-and-adapters.md)<br>[`providers/jev-decision.md`](providers/jev-decision.md)<br>[`fallback-policy.md`](fallback-policy.md) |
| `src/companion/` | [`overview.md`](overview.md)<br>[`gui-and-management-api.md`](gui-and-management-api.md)<br>[`companion.md`](companion.md) |
| `src/compatibility/` | [`runtime.md`](runtime.md)<br>[`adapters/compatibility-contracts.md`](adapters/compatibility-contracts.md) |
| `src/config.ts` | [`overview.md`](overview.md)<br>[`runtime.md`](runtime.md)<br>[`config.md`](config.md)<br>[`providers/openai-accounts.md`](providers/openai-accounts.md) |
| `src/config/` | [`runtime.md`](runtime.md)<br>[`config.md`](config.md)<br>[`transports/native-reasoning-retention.md`](transports/native-reasoning-retention.md)<br>[`providers/lm-studio-chat.md`](providers/lm-studio-chat.md)<br>[`fallback-policy.md`](fallback-policy.md) |
| `src/config/account-auto-pause-revisions.ts` | [`account-auto-pause.md`](account-auto-pause.md) |
| `src/config/live-reconcile.ts` | [`pricing.md`](pricing.md) |
| `src/config/persisted-mutation.ts` | [`runtime.md`](runtime.md) |
| `src/config/schema/account-auto-pause.ts` | [`account-auto-pause.md`](account-auto-pause.md) |
| `src/config/schema/config-schema.ts` | [`transports/max-output-completion.md`](transports/max-output-completion.md)<br>[`clients/omo-export-dialect.md`](clients/omo-export-dialect.md) |
| `src/config/schema/leaf-validators.ts` | [`transports/timeouts.md`](transports/timeouts.md)<br>[`pricing.md`](pricing.md)<br>[`clients/omo-export-dialect.md`](clients/omo-export-dialect.md) |
| `src/generated/` | [`runtime.md`](runtime.md) |
| `src/github/` | [`runtime.md`](runtime.md) |
| `src/grok/` | [`runtime.md`](runtime.md) |
| `src/images/` | [`runtime.md`](runtime.md)<br>[`transports/inventory.md`](transports/inventory.md)<br>[`providers/anthropic-progress.md`](providers/anthropic-progress.md) |
| `src/index.ts` | [`runtime.md`](runtime.md) |
| `src/integrations/` | [`clients/export-model-names.md`](clients/export-model-names.md)<br>[`clients/integrations.md`](clients/integrations.md)<br>[`clients/hermes.md`](clients/hermes.md)<br>[`clients/qoder.md`](clients/qoder.md)<br>[`clients/client-support-matrix.md`](clients/client-support-matrix.md)<br>[`clients/t3code.md`](clients/t3code.md) |
| `src/lab/` | [`runtime.md`](runtime.md)<br>[`adapters/compatibility-lab.md`](adapters/compatibility-lab.md) |
| `src/lib/` | [`overview.md`](overview.md)<br>[`runtime.md`](runtime.md)<br>[`transports/byte-accounting.md`](transports/byte-accounting.md)<br>[`transports/responses-wire-shapes.md`](transports/responses-wire-shapes.md)<br>[`transports/responses-failover.md`](transports/responses-failover.md)<br>[`transports/responses-spend.md`](transports/responses-spend.md)<br>[`transports/inventory.md`](transports/inventory.md)<br>[`gui-and-management-api.md`](gui-and-management-api.md)<br>[`dashboard-and-usage.md`](dashboard-and-usage.md)<br>[`clients/integrations.md`](clients/integrations.md)<br>[`ops/service-and-sidecars.md`](ops/service-and-sidecars.md)<br>[`ops/docs-and-release.md`](ops/docs-and-release.md) |
| `src/lib/abort.ts` | [`transports/timeouts.md`](transports/timeouts.md) |
| `src/lib/account-auto-pause-response.ts` | [`account-auto-pause.md`](account-auto-pause.md) |
| `src/lib/advisor-activation.ts` | [`advisor.md`](advisor.md) |
| `src/lib/bounded-body.ts` | [`transports/timeouts.md`](transports/timeouts.md) |
| `src/lib/decision-quota-sink.ts` | [`providers/jev-decision.md`](providers/jev-decision.md) |
| `src/lib/gui-pair-intent.ts` | [`remote-link.md`](remote-link.md) |
| `src/lib/local-upstream.ts` | [`transports/timeouts.md`](transports/timeouts.md) |
| `src/lib/tool-argument-integers.ts` | [`providers-and-adapters.md`](providers-and-adapters.md) |
| `src/lib/windows-owner-acl.ts` | [`codex-cli-update.md`](codex-cli-update.md)<br>[`remote-link.md`](remote-link.md) |
| `src/link/` | [`remote-messaging.md`](remote-messaging.md)<br>[`remote-link.md`](remote-link.md) |
| `src/local-credentials/` | [`remote-link.md`](remote-link.md) |
| `src/messaging/` | [`remote-messaging.md`](remote-messaging.md)<br>[`local-messaging.md`](local-messaging.md) |
| `src/oauth/` | [`providers/generic-account-pool.md`](providers/generic-account-pool.md)<br>[`runtime.md`](runtime.md)<br>[`transports/inventory.md`](transports/inventory.md)<br>[`providers/anthropic-account-thresholds.md`](providers/anthropic-account-thresholds.md)<br>[`providers/oauth-reconciliation.md`](providers/oauth-reconciliation.md)<br>[`providers/antigravity-account-import.md`](providers/antigravity-account-import.md)<br>[`providers-and-adapters.md`](providers-and-adapters.md)<br>[`providers/anthropic-account-pool.md`](providers/anthropic-account-pool.md)<br>[`providers/oauth-code-display-login.md`](providers/oauth-code-display-login.md)<br>[`providers/xai-grok.md`](providers/xai-grok.md) |
| `src/oauth/account-auto-pause-policy.ts` | [`account-auto-pause.md`](account-auto-pause.md) |
| `src/oauth/account-auto-pause.ts` | [`account-auto-pause.md`](account-auto-pause.md) |
| `src/oauth/api-key-pool-preserve.ts` | [`account-auto-pause.md`](account-auto-pause.md) |
| `src/oauth/dsh.ts` | [`providers/dsh-account.md`](providers/dsh-account.md) |
| `src/oauth/login-cli.ts` | [`providers/meta-muse.md`](providers/meta-muse.md) |
| `src/oauth/meta-muse-errors.ts` | [`providers/meta-muse.md`](providers/meta-muse.md) |
| `src/oauth/meta-muse-keychain.ts` | [`providers/meta-muse.md`](providers/meta-muse.md) |
| `src/oauth/meta-muse.ts` | [`providers/meta-muse.md`](providers/meta-muse.md) |
| `src/oauth/workbuddy.ts` | [`providers/workbuddy.md`](providers/workbuddy.md) |
| `src/plugins/` | [`ops/plugins.md`](ops/plugins.md) |
| `src/protocols/` | [`data-planes/protocol-paths.md`](data-planes/protocol-paths.md) |
| `src/providers/` | [`runtime.md`](runtime.md)<br>[`subagents.md`](subagents.md)<br>[`transports/inventory.md`](transports/inventory.md)<br>[`providers-and-adapters.md`](providers-and-adapters.md)<br>[`providers/anthropic-account-pool.md`](providers/anthropic-account-pool.md)<br>[`providers/xai-grok.md`](providers/xai-grok.md)<br>[`providers/lm-studio-chat.md`](providers/lm-studio-chat.md) |
| `src/providers/account-quota-disk.ts` | [`quota-snapshots.md`](quota-snapshots.md) |
| `src/providers/anthropic-billing-ownership.ts` | [`providers/anthropic-key-billing.md`](providers/anthropic-key-billing.md) |
| `src/providers/anthropic-billing-recovery.ts` | [`providers/anthropic-key-billing.md`](providers/anthropic-key-billing.md) |
| `src/providers/anthropic-billing-refusal.ts` | [`providers/anthropic-key-billing.md`](providers/anthropic-key-billing.md) |
| `src/providers/antigravity-quota-identity.ts` | [`providers/jev-decision.md`](providers/jev-decision.md) |
| `src/providers/api-key-pause.ts` | [`account-auto-pause.md`](account-auto-pause.md) |
| `src/providers/cc-switch-import-bytes.ts` | [`cli-management.md`](cli-management.md) |
| `src/providers/cc-switch-import-source.ts` | [`cli-management.md`](cli-management.md) |
| `src/providers/cc-switch-import.ts` | [`cli-management.md`](cli-management.md) |
| `src/providers/codex-capacity.ts` | [`providers/openai-tiers.md`](providers/openai-tiers.md) |
| `src/providers/dsh-account-destination.ts` | [`providers/dsh-account.md`](providers/dsh-account.md) |
| `src/providers/quota-decision-antigravity.ts` | [`providers/jev-decision.md`](providers/jev-decision.md) |
| `src/providers/quota-decision-publication.ts` | [`providers/jev-decision.md`](providers/jev-decision.md) |
| `src/providers/quota-decision-snapshot.ts` | [`providers/jev-decision.md`](providers/jev-decision.md) |
| `src/providers/quota/anthropic-account-quota.ts` | [`providers/anthropic-account-pool.md`](providers/anthropic-account-pool.md) |
| `src/providers/quota/dsh-account.ts` | [`providers/dsh-account.md`](providers/dsh-account.md) |
| `src/providers/quota/workbuddy.ts` | [`providers/workbuddy.md`](providers/workbuddy.md) |
| `src/providers/request-pacing.ts` | [`providers/anthropic-key-billing.md`](providers/anthropic-key-billing.md) |
| `src/providers/workbuddy-credit-balance.ts` | [`providers/workbuddy.md`](providers/workbuddy.md) |
| `src/providers/workbuddy-models.ts` | [`providers/workbuddy.md`](providers/workbuddy.md) |
| `src/providers/workbuddy.ts` | [`providers/workbuddy.md`](providers/workbuddy.md) |
| `src/quota-pool/` | [`quota-pool.md`](quota-pool.md) |
| `src/quota/` | [`dashboard-and-usage.md`](dashboard-and-usage.md) |
| `src/reasoning-effort.ts` | [`runtime.md`](runtime.md) |
| `src/remote-control/` | [`remote-workspace.md`](remote-workspace.md) |
| `src/remote/` | [`runtime.md`](runtime.md)<br>[`fallback-policy.md`](fallback-policy.md) |
| `src/responses/` | [`runtime.md`](runtime.md)<br>[`transports/byte-accounting.md`](transports/byte-accounting.md)<br>[`transports/responses.md`](transports/responses.md)<br>[`transports/native-reasoning-retention.md`](transports/native-reasoning-retention.md)<br>[`transports/responses-wire-shapes.md`](transports/responses-wire-shapes.md)<br>[`providers/anthropic-progress.md`](providers/anthropic-progress.md)<br>[`providers-and-adapters.md`](providers-and-adapters.md)<br>[`providers/kiro.md`](providers/kiro.md)<br>[`providers/xai-grok.md`](providers/xai-grok.md)<br>[`providers/chat-compat.md`](providers/chat-compat.md) |
| `src/responses/reasoning-replay-cache.ts` | [`transports/anthropic-thinking-recovery.md`](transports/anthropic-thinking-recovery.md) |
| `src/responses/turn-membership.ts` | [`transports/response-turn-membership.md`](transports/response-turn-membership.md) |
| `src/router.ts` | [`runtime.md`](runtime.md) |
| `src/routing/` | [`catalog.md`](catalog.md)<br>[`fallback-policy.md`](fallback-policy.md) |
| `src/routing/history/` | [`dashboard-and-usage.md`](dashboard-and-usage.md) |
| `src/server/` | [`transports/timeouts.md`](transports/timeouts.md)<br>[`providers/generic-account-pool.md`](providers/generic-account-pool.md)<br>[`runtime.md`](runtime.md)<br>[`codex-prompts.md`](codex-prompts.md)<br>[`catalog.md`](catalog.md)<br>[`subagents.md`](subagents.md)<br>[`transports/byte-accounting.md`](transports/byte-accounting.md)<br>[`transports/responses.md`](transports/responses.md)<br>[`transports/native-reasoning-retention.md`](transports/native-reasoning-retention.md)<br>[`transports/responses-wire-shapes.md`](transports/responses-wire-shapes.md)<br>[`transports/responses-failover.md`](transports/responses-failover.md)<br>[`transports/responses-combo-boundaries.md`](transports/responses-combo-boundaries.md)<br>[`transports/policy-fallback.md`](transports/policy-fallback.md)<br>[`transports/streaming-health.md`](transports/streaming-health.md)<br>[`transports/inventory.md`](transports/inventory.md)<br>[`data-planes/images.md`](data-planes/images.md)<br>[`data-planes/inbound-compat.md`](data-planes/inbound-compat.md)<br>[`providers/anthropic-progress.md`](providers/anthropic-progress.md)<br>[`providers-and-adapters.md`](providers-and-adapters.md)<br>[`providers/jev-decision.md`](providers/jev-decision.md)<br>[`providers/xai-grok.md`](providers/xai-grok.md)<br>[`adapters/registry.md`](adapters/registry.md)<br>[`gui-and-management-api.md`](gui-and-management-api.md)<br>[`provider-completion-diagnostic.md`](provider-completion-diagnostic.md)<br>[`dashboard-and-usage.md`](dashboard-and-usage.md)<br>[`fallback-policy.md`](fallback-policy.md)<br>[`clients/claude-desktop.md`](clients/claude-desktop.md)<br>[`clients/claude-desktop-model-visibility.md`](clients/claude-desktop-model-visibility.md)<br>[`clients/hermes.md`](clients/hermes.md)<br>[`ops/service-and-sidecars.md`](ops/service-and-sidecars.md) |
| `src/server/advisor-admission-scope.ts` | [`advisor.md`](advisor.md) |
| `src/server/auth-cors.ts` | [`transports/response-turn-membership.md`](transports/response-turn-membership.md)<br>[`providers/lm-studio-chat.md`](providers/lm-studio-chat.md) |
| `src/server/capture-admission-policy.ts` | [`advisor.md`](advisor.md) |
| `src/server/gui-pair-delivery.ts` | [`remote-link.md`](remote-link.md) |
| `src/server/index.ts` | [`adapters/compatibility-lab.md`](adapters/compatibility-lab.md) |
| `src/server/index/link-management.ts` | [`remote-link.md`](remote-link.md) |
| `src/server/inference/advisor-diagnostics.ts` | [`advisor.md`](advisor.md) |
| `src/server/management/` | [`providers/oauth-code-display-login.md`](providers/oauth-code-display-login.md)<br>[`providers/lm-studio-chat.md`](providers/lm-studio-chat.md)<br>[`clients/export-model-names.md`](clients/export-model-names.md) |
| `src/server/management/anthropic-pool-settings.ts` | [`providers/anthropic-account-pool.md`](providers/anthropic-account-pool.md) |
| `src/server/management/codex-cli-update-routes.ts` | [`codex-cli-update.md`](codex-cli-update.md) |
| `src/server/management/companion-routes.ts` | [`desktop-shell.md`](desktop-shell.md) |
| `src/server/management/link-routes.ts` | [`remote-link.md`](remote-link.md) |
| `src/server/management/model-routes.ts` | [`pricing.md`](pricing.md) |
| `src/server/management/quota-pool-routes.ts` | [`quota-pool.md`](quota-pool.md) |
| `src/server/responses/` | [`data-planes/claude-tool-loading.md`](data-planes/claude-tool-loading.md) |
| `src/server/responses/account-auto-pause-recovery.ts` | [`account-auto-pause.md`](account-auto-pause.md) |
| `src/server/responses/adapter-delivery.ts` | [`transports/response-turn-membership.md`](transports/response-turn-membership.md)<br>[`transports/max-output-completion.md`](transports/max-output-completion.md) |
| `src/server/responses/adapter-dispatch.ts` | [`transports/response-turn-membership.md`](transports/response-turn-membership.md) |
| `src/server/responses/advisor-plan-slot.ts` | [`advisor.md`](advisor.md) |
| `src/server/responses/advisor-slot.ts` | [`advisor.md`](advisor.md) |
| `src/server/responses/anthropic-thinking-recovery.ts` | [`transports/anthropic-thinking-recovery.md`](transports/anthropic-thinking-recovery.md) |
| `src/server/responses/compact.ts` | [`transports/responses-citations.md`](transports/responses-citations.md) |
| `src/server/responses/opengateway-completion-guard.ts` | [`providers/opengateway.md`](providers/opengateway.md) |
| `src/server/responses/passthrough-completion.ts` | [`providers/opengateway.md`](providers/opengateway.md) |
| `src/server/responses/passthrough-dispatch.ts` | [`providers/opengateway.md`](providers/opengateway.md) |
| `src/server/responses/request-prepare.ts` | [`transports/response-turn-membership.md`](transports/response-turn-membership.md) |
| `src/server/responses/request-transport.ts` | [`transports/response-turn-membership.md`](transports/response-turn-membership.md)<br>[`account-auto-pause.md`](account-auto-pause.md) |
| `src/server/responses/run-turn-execution.ts` | [`transports/max-output-completion.md`](transports/max-output-completion.md) |
| `src/server/responses/turn-membership.ts` | [`transports/response-turn-membership.md`](transports/response-turn-membership.md) |
| `src/service-manager-probe.ts` | [`ops/service-and-sidecars.md`](ops/service-and-sidecars.md) |
| `src/service.ts` | [`runtime.md`](runtime.md)<br>[`ops/docs-and-release.md`](ops/docs-and-release.md) |
| `src/service/` | [`runtime.md`](runtime.md) |
| `src/service/cli.ts` | [`ops/desktop-supervision.md`](ops/desktop-supervision.md) |
| `src/service/desktop-command-guard.ts` | [`ops/desktop-supervision.md`](ops/desktop-supervision.md) |
| `src/service/desktop-recovery-process.ts` | [`desktop-recovery.md`](desktop-recovery.md) |
| `src/service/desktop-recovery.ts` | [`desktop-recovery.md`](desktop-recovery.md) |
| `src/service/desktop-startup.ts` | [`desktop-start-at-login.md`](desktop-start-at-login.md)<br>[`ops/desktop-supervision.md`](ops/desktop-supervision.md) |
| `src/service/desktop-supervision.d.mts` | [`ops/desktop-supervision.md`](ops/desktop-supervision.md) |
| `src/service/desktop-supervision.mjs` | [`ops/desktop-supervision.md`](ops/desktop-supervision.md) |
| `src/service/health-sentinel-launch.ts` | [`ops/service-health-recovery.md`](ops/service-health-recovery.md) |
| `src/service/health-sentinel-linux.ts` | [`ops/service-health-recovery.md`](ops/service-health-recovery.md) |
| `src/service/health-sentinel-main.ts` | [`ops/service-health-recovery.md`](ops/service-health-recovery.md) |
| `src/service/health-sentinel-policy.ts` | [`ops/service-health-recovery.md`](ops/service-health-recovery.md) |
| `src/service/health-sentinel-probe.ts` | [`ops/service-health-recovery.md`](ops/service-health-recovery.md) |
| `src/service/health-sentinel-windows.ts` | [`ops/service-health-recovery.md`](ops/service-health-recovery.md) |
| `src/service/logging.ts` | [`ops/service-logging.md`](ops/service-logging.md) |
| `src/service/orchestration.ts` | [`ops/desktop-supervision.md`](ops/desktop-supervision.md) |
| `src/service/repair.ts` | [`ops/desktop-supervision.md`](ops/desktop-supervision.md) |
| `src/sidecar/` | [`ops/service-and-sidecars.md`](ops/service-and-sidecars.md) |
| `src/sidecar/anthropic-binding.ts` | [`providers/anthropic-account-pool.md`](providers/anthropic-account-pool.md) |
| `src/stall-timeout.ts` | [`transports/timeouts.md`](transports/timeouts.md)<br>[`runtime.md`](runtime.md) |
| `src/storage/` | [`runtime.md`](runtime.md) |
| `src/tray/` | [`runtime.md`](runtime.md) |
| `src/types.ts` | [`runtime.md`](runtime.md)<br>[`config.md`](config.md) |
| `src/types/` | [`providers/generic-account-pool.md`](providers/generic-account-pool.md)<br>[`transports/native-reasoning-retention.md`](transports/native-reasoning-retention.md)<br>[`providers/anthropic-progress.md`](providers/anthropic-progress.md)<br>[`providers-and-adapters.md`](providers-and-adapters.md)<br>[`providers/lm-studio-chat.md`](providers/lm-studio-chat.md)<br>[`fallback-policy.md`](fallback-policy.md) |
| `src/types/account-auto-pause.ts` | [`account-auto-pause.md`](account-auto-pause.md) |
| `src/types/admission-policy.ts` | [`advisor.md`](advisor.md) |
| `src/types/config.ts` | [`transports/timeouts.md`](transports/timeouts.md)<br>[`config.md`](config.md)<br>[`transports/max-output-completion.md`](transports/max-output-completion.md)<br>[`clients/omo-export-dialect.md`](clients/omo-export-dialect.md) |
| `src/types/provider.ts` | [`pricing.md`](pricing.md) |
| `src/update/` | [`runtime.md`](runtime.md)<br>[`ops/service-and-sidecars.md`](ops/service-and-sidecars.md) |
| `src/update/guarded-port-reclaim.ts` | [`ops/update-supervised-recovery.md`](ops/update-supervised-recovery.md) |
| `src/update/guarded-runtime-ops.ts` | [`ops/update-supervised-recovery.md`](ops/update-supervised-recovery.md) |
| `src/update/guarded-tray-ops.ts` | [`ops/update-supervised-recovery.md`](ops/update-supervised-recovery.md) |
| `src/update/index.ts` | [`ops/desktop-supervision.md`](ops/desktop-supervision.md) |
| `src/update/job-pinned-start.ts` | [`ops/update-supervised-recovery.md`](ops/update-supervised-recovery.md) |
| `src/update/job-supervised-restart.ts` | [`ops/update-supervised-recovery.md`](ops/update-supervised-recovery.md) |
| `src/update/job.ts` | [`ops/update-supervised-recovery.md`](ops/update-supervised-recovery.md) |
| `src/update/mutation-guard.mjs` | [`ops/update-supervised-recovery.md`](ops/update-supervised-recovery.md) |
| `src/update/restart-ownership.ts` | [`ops/desktop-supervision.md`](ops/desktop-supervision.md) |
| `src/update/supervised-recovery.mjs` | [`ops/update-supervised-recovery.md`](ops/update-supervised-recovery.md) |
| `src/usage/` | [`runtime.md`](runtime.md)<br>[`providers/jev-decision.md`](providers/jev-decision.md)<br>[`gui-and-management-api.md`](gui-and-management-api.md)<br>[`dashboard-and-usage.md`](dashboard-and-usage.md)<br>[`companion.md`](companion.md) |
| `src/usage/cost.ts` | [`pricing.md`](pricing.md) |
| `src/usage/timeline.ts` | [`gui-and-management-api.md`](gui-and-management-api.md) |
| `src/usage/user-cost-overlays.ts` | [`pricing.md`](pricing.md) |
| `src/usage/user-cost-validation.ts` | [`pricing.md`](pricing.md) |
| `src/vision/` | [`runtime.md`](runtime.md)<br>[`gui-and-management-api.md`](gui-and-management-api.md) |
| `src/web-search/` | [`runtime.md`](runtime.md)<br>[`providers/anthropic-progress.md`](providers/anthropic-progress.md)<br>[`providers-and-adapters.md`](providers-and-adapters.md) |
| `src/web-search/header-deadline.ts` | [`transports/timeouts.md`](transports/timeouts.md) |
| `tests/` | [`ops/test-sandbox-cleanup.md`](ops/test-sandbox-cleanup.md) |

### Not described by any doc

| Source path | Why |
| --- | --- |

## Cross-cutting contracts

Source review remains defined by the source-to-doc map above. This registry names each authoritative statement and the documents that review it. Link validation proves declared topology, not behavioral correctness.

| Contract | Authority | Review dependents |
| --- | --- | --- |
| `paginated-history-writer` | [`codex-home.md#paginated-history-writer-boundary`](codex-home.md#paginated-history-writer-boundary) | [`catalog.md`](catalog.md)<br>[`config.md`](config.md)<br>[`dashboard-and-usage.md`](dashboard-and-usage.md)<br>[`ops/docs-and-release.md`](ops/docs-and-release.md)<br>[`providers/openai-accounts.md`](providers/openai-accounts.md)<br>[`runtime.md`](runtime.md)<br>[`subagents.md`](subagents.md) |
| `request-copy-accounting` | [`transports/byte-accounting.md#request-copy-accounting`](transports/byte-accounting.md#request-copy-accounting) | [`adapters/registry.md`](adapters/registry.md)<br>[`catalog.md`](catalog.md)<br>[`clients/claude-desktop.md`](clients/claude-desktop.md)<br>[`clients/integrations.md`](clients/integrations.md)<br>[`data-planes/images.md`](data-planes/images.md)<br>[`data-planes/inbound-compat.md`](data-planes/inbound-compat.md)<br>[`ops/docs-and-release.md`](ops/docs-and-release.md)<br>[`ops/service-and-sidecars.md`](ops/service-and-sidecars.md)<br>[`overview.md`](overview.md)<br>[`providers/chat-compat.md`](providers/chat-compat.md)<br>[`providers/cursor.md`](providers/cursor.md)<br>[`providers/xai-grok.md`](providers/xai-grok.md)<br>[`runtime.md`](runtime.md)<br>[`subagents.md`](subagents.md)<br>[`transports/inventory.md`](transports/inventory.md)<br>[`transports/streaming-health.md`](transports/streaming-health.md) |
| `stream-buffer-accounting` | [`transports/byte-accounting.md#stream-buffer-accounting`](transports/byte-accounting.md#stream-buffer-accounting) | [`adapters/registry.md`](adapters/registry.md)<br>[`catalog.md`](catalog.md)<br>[`clients/claude-desktop.md`](clients/claude-desktop.md)<br>[`clients/integrations.md`](clients/integrations.md)<br>[`data-planes/images.md`](data-planes/images.md)<br>[`data-planes/inbound-compat.md`](data-planes/inbound-compat.md)<br>[`ops/docs-and-release.md`](ops/docs-and-release.md)<br>[`ops/service-and-sidecars.md`](ops/service-and-sidecars.md)<br>[`overview.md`](overview.md)<br>[`providers/chat-compat.md`](providers/chat-compat.md)<br>[`providers/cursor.md`](providers/cursor.md)<br>[`providers/xai-grok.md`](providers/xai-grok.md)<br>[`runtime.md`](runtime.md)<br>[`subagents.md`](subagents.md)<br>[`transports/inventory.md`](transports/inventory.md)<br>[`transports/streaming-health.md`](transports/streaming-health.md) |

## Decision records

Superseded reasoning lives in `decisions/` as numbered records. A doc states the contract that holds now and
links the record that explains why; it never carries the reasoning inline.

