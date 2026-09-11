# Overview

## Product boundary

opencodex is a local proxy for Codex. It does not patch Codex binaries. It changes local Codex
state by writing root routing keys and a model catalog — a provider table only in the
API-auth-header form described in [`config.md`](config.md) —
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

> Decision record: [ADR-0001](decisions/ADR-0001-product-boundary.md)

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
| `~/.opencodex/config.json` | opencodex | Init creates via private temp plus no-replace hard link; dashboard and explicit updates use atomic replacement. |
| `~/.opencodex/auth.json` | opencodex | OAuth tokens; not committed. Multiauth shape: `provider -> { activeAccountId, accounts[] }` (legacy single-credential values normalize on load; a one-time `auth.json.pre-multiauth` backup guards downgrades). ChatGPT scratch OAuth stays separate from the Codex account store. For multi-slot providers, credentials without `accountId`/email replace the active slot on a normal login; an explicit add-account login preserves the prior slot and appends a distinct one. Single-slot providers such as ChatGPT remain replacement-only. |
| `~/.opencodex/codex-accounts.json` | opencodex | Hardened main-plus-added credential store used by `openai` in Pool mode. |
| `~/.opencodex/catalog-backup.json` | opencodex | One-time pristine Codex catalog backup for restore; per-catalog copies are hashed variants (see [`catalog.md`](catalog.md)). |
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

Each invariant carries a stable id. A bound invariant names one test, and that test names the id
back, so deleting or renaming the test fails `bun run structure:check` instead of quietly unbinding the
rule. The binding proves the test EXISTS and is claimed; it does not prove the assertions inside it
still cover the rule, which is a judgement only review makes.

- **INV-WS-01** — `websockets` defaults to `false`; only `true` advertises `supports_websockets`.
  Enforced by `tests/codex-integration/codex-catalog.test.ts`.
- **INV-TOML-01** — Root TOML keys such as `model_provider` and `model_catalog_json` must stay
  before any table.
  Enforced by `tests/codex-integration/codex-inject.test.ts`.
- **INV-OPENAI-01** — OpenAI has one `openai` Codex-login provider with Pool(default)/Direct modes
  and a separate `openai-apikey`; see [`openai-tiers.md`](providers/openai-tiers.md).
  Enforced by `tests/adapters/openai/openai-provider-option.test.ts`.
- **INV-AGENT-01** — Codex `spawn_agent` visibility depends on the first five featured catalog
  entries.
  Enforced by `tests/codex-integration/catalog-full-picker-order.test.ts`.
- **INV-AUTH-01** — The management plane (`/api/*`) and the data plane (`/v1/*`) never share an
  admission credential.
  Enforced by `tests/server/server-management-auth.test.ts`.
- **INV-RESTORE-01** — `ocx restore` returns the pristine Codex catalog, so a restored install is a
  usable native Codex. The service-stop and uninstall paths of the same promise are covered
  separately in `tests/cli/restore-completes-shared-teardown.test.ts` and are not bound to this id.
  Enforced by `tests/codex-integration/codex-catalog-restore.test.ts`.
- **INV-TESTS-01** — `tests/` is organised by domain (`tests/<domain>/`, mirroring `src/`); the map
  is `scripts/test-layout/layout.json` and `tests/test-layout.test.ts` rejects a test outside its
  domain. Only the two layout guards sit at the root. Source-oracle tests reach the repository
  through `tests/helpers/repo-root.ts`, never `import.meta.dir + "/.."`.
  Enforced by `tests/test-layout.test.ts`.

Two invariants are stated here without a binding, and `grace.unboundInvariants` in
[`manifest.json`](manifest.json) carries the reason for each. They are true statements about the system;
no test in this repository currently pins them, and saying so is more useful than naming a test that
would pass while the rule was violated.

- **INV-HOME-01** — `CODEX_HOME` wins over `~/.codex` when present and valid.
- **INV-SLUG-01** — Routed model slugs use `provider/model`.
