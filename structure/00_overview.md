# opencodex Structure

This folder is the maintainer source of truth for the current system shape. Public user workflows
belong in `docs-site/`. Development work is recorded in `devlog/` units — `_plan/` while open,
`_fin/` once closed — while `docs/` keeps investigations and diagnostic notes worth retaining for
archaeology, debugging, or source research.

## Reading order

| File | Purpose |
| --- | --- |
| [`00_overview.md`](00_overview.md) | Product boundary, local state, and non-negotiable invariants. |
| [`01_runtime.md`](01_runtime.md) | Process lifecycle, CLI, server endpoints, config, providers, adapters. |
| [`02_config-and-codex-home.md`](02_config-and-codex-home.md) | `CODEX_HOME`, the config surface, both injection forms, profile files, restore rules, and Codex-home diagnostics. |
| [`03_catalog-and-subagents.md`](03_catalog-and-subagents.md) | Shared Codex catalog and per-catalog backups, account namespaces and pool rotation, model cache, effort ceilings, multi-agent surface mode, and subagent ordering. |
| [`04_transports-and-sidecars.md`](04_transports-and-sidecars.md) | Responses HTTP/SSE, WebSocket opt-in, per-provider transport hardening, the transport inventory, sidecars, and compatibility guards. |
| [`05_gui-and-management-api.md`](05_gui-and-management-api.md) | Dashboard serving and surfaces, plus the `/api/*` management surface and which module owns each route area. |
| [`06_docs-and-release.md`](06_docs-and-release.md) | Public docs site, GitHub Pages, the workflow map, branch and devlog policy, README ownership, release flow. |
| [`07_design-methodology.md`](07_design-methodology.md) | Design process discipline for new GUI, CLI, and user-facing surfaces. |
| [`08_openai-provider-tiers.md`](08_openai-provider-tiers.md) | OpenAI Pool/Direct account-mode and API credential/routing invariants. |
| [`09_client-integrations.md`](09_client-integrations.md) | Third-party client config ownership, state classification, snapshots, refresh, disable, and restore. |
| [`09_compatibility-lab.md`](09_compatibility-lab.md) | Optional Compatibility Lab evidence, automation, and core-runtime isolation. |
| [`10_adapter-registry.md`](10_adapter-registry.md) | Adapter construction authority and registry-derived contract inheritance. |
| [`11_compatibility-contracts.md`](11_compatibility-contracts.md) | Versioned provider compatibility claims and fixture-evidence boundaries. |

## Product boundary

opencodex is a local proxy for Codex. It does not patch Codex binaries. It changes local Codex
state by writing root routing keys and a model catalog — a provider table only in the
API-auth-header form described in [`02_config-and-codex-home.md`](02_config-and-codex-home.md) —
then serves the Responses data plane:

```text
Codex CLI / TUI / App / SDK
  -> http://127.0.0.1:<port>/v1/responses
  -> opencodex routing + adapter bridge
  -> upstream provider
```

Responses is the primary surface. The same listener also answers Anthropic-shaped `/v1/messages`
and OpenAI-shaped `/v1/chat/completions`. On the routed path those are inbound translations onto the
same routing and adapter bridge rather than separate products; `/v1/messages` additionally has a
native Anthropic passthrough branch that forwards without translation. The Live/Realtime surface is
different in kind — it resolves an OpenAI/ChatGPT relay and forwards to it directly, without the
adapter bridge.

The default install keeps native OpenAI/ChatGPT passthrough working through one option-aware
`openai` provider. Pool is the default and selects across main plus added accounts; Direct uses only
the current caller/main login. `openai-apikey` explicitly selects API-key transport, and the two
credential routes never fall through into one another. Built-in provider presets include Anthropic,
Google, Azure, Neuralwatt Cloud, Tencent Cloud Coding Plan, SiliconFlow, and separate Volcengine Ark
pay-as-you-go, Coding Plan, and Agent Plan endpoints. Additional
providers are routed by explicit `provider/model`, provider model lists, or the configured
`defaultProvider`.

[Decision Log]
- 목적과 의도: Add two widely used API-key providers through the canonical registry so CLI, GUI, login, routing, and documentation remain in parity.
- 기존 구현 및 제약 조건: Tencent Coding Plan is OpenAI-compatible but contractually restricted to interactive coding tools and has a dynamic, text-only model set. SiliconFlow exposes a dynamic OpenAI-compatible catalog whose reasoning controls vary by model.
- 검토한 주요 대안: Treat both as custom providers only; freeze a large SiliconFlow model list and reasoning map; expose Tencent without a usage warning.
- 선택한 방식: Add registry-derived key presets, keep live discovery enabled, seed only Tencent's currently documented coding-plan models, and surface Tencent's usage restriction in both the preset note and public docs.
- 다른 대안 대신 이 방식을 선택한 이유: Registry presets remove setup friction while live discovery avoids claiming that mutable catalogs are permanent. Avoiding speculative SiliconFlow reasoning metadata prevents invalid vendor-specific parameters.
- 장점, 단점 및 영향: Both providers appear consistently across supported setup surfaces. Tencent users receive an explicit policy warning; SiliconFlow reasoning controls remain conservative until model-specific limits can be represented safely.

## Local state

`~/.opencodex/` is the default state root and `OPENCODEX_HOME` overrides it; the GUI and the
installed service resolve it the same way (`src/config.ts`). Ownership inside that root is tracked
by the uninstall manifest in `src/lib/config-ownership.ts`, which starts from a declared path list
and grows as opencodex claims further paths at runtime — so the manifest, not this table, is what
bounds uninstall. This table groups the state by purpose; it is not an exhaustive file list, and
derived files such as `auth.json.pre-multiauth` are covered by the group they belong to.

`$CODEX_HOME` is a separate root with a separate owner, and opencodex writes there too: removing the
opencodex state root does not undo those writes. Putting native Codex back is the job of
`ocx restore`/`eject` and the injection journal, not of deleting a directory.

| Path | Owner | Notes |
| --- | --- | --- |
| `~/.opencodex/config.json` | opencodex | Main config written by `ocx init` and the dashboard. Atomic temp-then-rename. |
| `~/.opencodex/auth.json` | opencodex | OAuth tokens; not committed. Multiauth shape: `provider -> { activeAccountId, accounts[] }` (legacy single-credential values normalize on load; a one-time `auth.json.pre-multiauth` backup guards downgrades). ChatGPT scratch OAuth stays separate from the Codex account store. For multi-slot providers, credentials without `accountId`/email replace the active slot on a normal login; an explicit add-account login preserves the prior slot and appends a distinct one. Single-slot providers such as ChatGPT remain replacement-only. |
| `~/.opencodex/codex-accounts.json` | opencodex | Hardened main-plus-added credential store used by `openai` in Pool mode. |
| `~/.opencodex/catalog-backup.json` | opencodex | One-time pristine Codex catalog backup for restore; per-catalog copies are hashed variants (see [`03_catalog-and-subagents.md`](03_catalog-and-subagents.md)). |
| `~/.opencodex/usage.jsonl` | opencodex | Append-only request usage log (0o600); request metadata + token counts only, never prompts or auth. |
| `~/.opencodex/ocx.pid`, `runtime-port.json`, `system-env-port` | opencodex runtime | Live process identity and the port a client should reach; rewritten on start. `runtime-port.json` also carries the protected per-process listener-attestation key used before CLI diagnostics attach a management bearer. |
| `~/.opencodex/codex-runtime.json`, `codex-runtime-clamp.json` | opencodex Codex runtime | Selected Codex executable/version state and effort-clamp diagnostics. Not process identity: these persist a resolved choice and a diagnostic, so losing them changes behavior until re-resolved. |
| `~/.opencodex/service-state.json`, `service.log`, `service-api-token`, `opencodex-service-launcher.vbs`, `opencodex-service-task.xml`, `opencodex-service.cmd`, `winsw`, `tray-state.json`, `tray-heartbeat.json`, `opencodex-tray.ps1`, `opencodex-tray-*.ico`, `update-job.json` | opencodex operators | Installed-service, Windows tray, and self-update artifacts and bookkeeping. The update record carries its worker PID so a dead worker recovers instead of blocking later runs. |
| `~/.opencodex/responses-state.json`, `responses-state-spill/`, `usage-debug.jsonl`, `crash.log`, `artifacts/` | opencodex diagnostics and artifacts | Bounded caches, diagnostics, and generated image/video artifacts served locally. The spill directory holds continuation state demoted out of the in-memory cap and is bounded in aggregate, not only per file. |
| `~/.opencodex/codex-shim.json`, `*.lock`, `kimi-device-id`, `mimo-client-id`, `.star-prompted` | opencodex bookkeeping | Shim restore obligations, cross-process locks, per-install client identifiers, one-shot UI flags. |
| `~/.opencodex/.opencodex-owner.json`, `.opencodex-uninstall.json` | opencodex | Ownership marker and the manifest that bounds what uninstall may remove. Both live in the OpenCodex state root, not in `$CODEX_HOME`. |
| `$CODEX_HOME/config.toml` | Codex, edited by opencodex | Active provider and provider table. |
| `$CODEX_HOME/opencodex.config.toml` | opencodex | Optional profile for explicit Codex opt-in. |
| `$CODEX_HOME/opencodex-catalog.json` | opencodex | Shared native+routed model catalog. |
| `$CODEX_HOME/opencodex-journal.json` | opencodex | Injection journal used by restore to strip only marker-owned values while preserving later user edits. |
| `$CODEX_HOME/models_cache.json` | Codex, invalidated by opencodex | Cache invalidated after model/catalog changes. |
| `dist/`, `gui/dist/`, `node_modules/` | generated | Build output/dependencies. |

## Non-negotiable invariants

- `websockets` defaults to `false`; only `true` advertises `supports_websockets`.
- `CODEX_HOME` wins over `~/.codex` when present and valid.
- Root TOML keys such as `model_provider` and `model_catalog_json` must stay before any table.
- Routed model slugs use `provider/model`.
- OpenAI has one `openai` Codex-login provider with Pool(default)/Direct modes and a separate `openai-apikey`; see [`08_openai-provider-tiers.md`](08_openai-provider-tiers.md).
- Codex `spawn_agent` visibility depends on the first five featured catalog entries.
- The management plane (`/api/*`) and the data plane (`/v1/*`) never share an admission credential.
- `ocx stop`, `ocx restore`, and service stop/uninstall must leave native Codex usable.

## Writing rule

Keep this directory flat. Add or extend lexicographically ordered `NN_topic.md` files; do not add
subdirectories. If one file grows too broad, split the next stable topic into the next unused number
instead of creating nested folders.
