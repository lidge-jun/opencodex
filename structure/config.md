# Config Surface

## Config surface

### OpenCodex home and live process state

`initializePersistedConfigIfMissing` in `src/config.ts` is the create-only path consumed by
`src/cli/init.ts`. It rechecks absence under the existing config-mutation lock and publishes through
`src/config/initialize.ts`: a private descriptor is hardened before secret bytes are written, then
linked without replacing an occupied destination. Existing invalid or unsafe entries are preserved.
The initializer never truncates a staged inode or rolls back by unlinking the destination; cleanup
only removes its own temporary name. Unsupported/denied links and incomplete cleanup fail explicitly,
and publication followed by a later failure can leave a complete config or private residue. Ordinary
`saveConfig` replacement behavior remains unchanged. This protects init-time config bytes, not a
foreign winner's ownership under future uninstall; the existing ownership manifest and global CLI
shim preflight keep their separate contracts.

Initial publication diagnostics distinguish required permission-hardening failures from denied
hard-link publication without exposing raw filesystem causes. Both identify `OPENCODEX_HOME`
as the supported-location recovery path; uncertain publication and cleanup warnings remain in
the CLI. The quickstart documents inspection before retry, private-permission requirements,
and fresh-location examples. Diagnostics do not introduce a fallback or alter file I/O ordering.

`src/config/paths.ts` is the single owner of `OPENCODEX_HOME` expansion and resolution. It exposes
the config directory and `config.json` path and retains the existing cache rule: a relative home is
resolved once for each distinct raw environment value, so a later working-directory change cannot
silently move the active installation.

`src/config/process-state.ts` derives `ocx.pid` and `runtime-port.json` from that resolved directory.
It owns their byte-compatible writes, parsing, expected-PID filters, cheap liveness, full OCX command
identity, and snapshot-guarded removal. `RuntimePortState.attestationSecret` remains optional,
owner-only state and is validated before a record is returned. `src/config.ts` re-exports the same
symbols for compatibility, but new lifecycle-only callers import the process-state leaf directly.

Replacing config and process-state writes use `src/config/atomic-write.ts`. The leaf preserves the shared
process-wide temp sequence, symlink target resolution, real-home test guard, owner manifest,
Windows ACL hardening, scrub-before-unlink failure path, and explicit residual-temp errors. A caller
must not replace it with a local temp-and-rename shortcut.

> Decision record: [ADR-0016](decisions/ADR-0016-config-surface.md)

`src/types.ts` is the shape and `src/config.ts` is the loader; neither is reproduced here. What
matters for maintainers is which groups exist and who resolves them:

| Group | Keys | Resolution rule |
| --- | --- | --- |
| Listener | `port`, `hostname` | The listener owns the port; `runtime-port.json` reports where it actually landed. |
| Routing | `defaultProvider`, `providers`, per-provider `selectedModels` | Explicit `provider/model` wins over `defaultProvider`. |
| Catalog | `disabledModels`, `customModels`, `modelCacheTtlMs`, `providerContextCaps`, `contextCapValue`, per-provider `modelDisplayNames`, `codexAccountNamespaces`, `codexAccountPickerEnabled` | Catalog state is derived; config only records intent. Exact provider model display names are durable display only overlays. The picker flag is an explicit visibility override, while selector mappings remain the durable exact-routing contract. |
| Retained state | `appOwnedMemoryBudgetMb` | Process-wide eviction target for app-owned logs, caches, blobs, and continuation payloads. Default 256 MiB, valid 64..4096; pinned state may temporarily exceed the target, but every pin-capable store has a finite local cap and their documented aggregate stays below `APP_OWNED_WORST_CASE_PINNED_BYTES` (512 MiB). Neither value caps RSS or native runtime memory. |
| Transport | stream mode, timeouts, proxy settings, `websockets`, `emptyCompletionRetry` | `streamMode` persists in config.json; Windows services need a persisted input, and macOS uses it for explicit eager-relay opt-in. Empty-completion replay is an explicit top-level opt-in because its second upstream request may be billable. |
| Credentials | `apiKeys` | Data-plane only; never admitted to `/api/*`. |
| Lifecycle | `codexAutoStart`, shim/start behavior, resume-history sync, storage cleanup | Startup safety reads these; see [`gui-and-management-api.md`](gui-and-management-api.md). |

Env values are resolved through `src/config.ts`, so a config value naming an env var never persists
the secret itself.

## Config injection

`src/codex/inject.ts` writes one of two forms. The choice is not cosmetic: it decides whether Codex
keeps its native provider id, which decides whether existing thread history still resolves.

**Loopback (default).** A single marker-owned root override, no provider table:

```toml
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
openai_base_url = "http://127.0.0.1:10100/v1"
```

Codex keeps the native `openai` provider id, so new threads stay under that identity instead of
being re-tagged. History restore is manifest-authoritative: only rows whose original provider,
source, and event marker were backed up for the same state database are restored exactly. A bare
`opencodex` row is never assumed to have originated at OpenAI; it stays unchanged unless the user
explicitly runs legacy OpenAI recovery. A user-owned root `openai_base_url` is preserved instead of
overwritten, and that case also blocks managed sub-agent defaults rather than fighting the user for
ownership.

Client-compaction mode can retain that user-owned root URL alongside an injected provider table.
Its status must distinguish ownership from destination: an unmarked user-owned line may already
point to this proxy. Report that existing `openai` threads follow the configured root URL and new
threads use the injected table, without inferring a foreign endpoint or prescribing URL removal.
This diagnostic distinction does not change URL ownership, journal entries, or session history.

**API auth header (non-loopback).** The built-in `openai` provider cannot carry the
`x-opencodex-api-key` env header, so this form re-tags the root provider and appends the table:

```toml
model_provider = "opencodex"
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"

[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://<host>:<port>/v1"
wire_api = "responses"
requires_openai_auth = true
env_key = "OPENCODEX_API_AUTH_TOKEN"
```

Root TOML keys must be written before the first `[table]`. Re-injection strips the stale form of
both shapes — opencodex blocks, injected root base-url overrides, stale root context-window
overrides, and stale catalog paths — before rewriting, so switching between forms leaves no residue.

Read-only doctor and project-routing diagnostics use a lightweight root/table TOML reader rather
than mutating or normalizing the user's file. That reader must lexically skip both basic and literal
multiline string bodies: instruction prose can contain key-shaped examples and `[table]` snippets,
which are data rather than configuration. Diagnostic result objects may retain the real path for
local correlation, but every formatted doctor line must pass it through the shared user-path
redaction boundary before display.

> Decision record: [ADR-0017](decisions/ADR-0017-config-injection.md)

Native Codex sub-agent defaults are a separate, explicit opt-in. When
`syncCodexSubagentDefaults` is true and `injectionModel` is set, injection writes marker-owned
`agents.default_subagent_model` and, when configured,
`agents.default_subagent_reasoning_effort`. Unmarked values are user-owned and must never be
overwritten. Disabling the option and fallback restore remove only marker-owned values; journal
restore must preserve later user edits while stripping those managed values.

### History backup manifest contract

`src/codex/history-manifest.ts` is the pure schema-and-identity leaf for the versioned history
backup manifest. It owns the accepted provider/source provenance tuples, platform-aware database
path identity, backup filename id, and validation from unknown JSON to a typed manifest. It does
not read files, inspect rollouts, open SQLite, retry, fingerprint, write, or delete anything.

`history-provider.ts` remains the strict mutation owner and maps shared validation failures to its
restore/no-op integrity states. `native-residue.ts` remains a read-only observer and maps the same
result to clean, residue, or indeterminate before inspecting referenced rollout files.

> Decision record: [ADR-0018](decisions/ADR-0018-config-injection.md)

If the root config selects a provider other than `openai` or `opencodex`, injection must leave the
config byte-for-byte unchanged and skip profile creation/updates and history metadata restoration. External
provider managers own that routing configuration, and replacing their provider id can hide
otherwise intact Codex sessions. This ownership check must run before catalog/cache refresh,
journal creation, and the background history restoration guardian.

`ocx sync` and `ocx restore back` run the injector's non-writing preflight before provider
discovery or catalog/cache replacement. Deterministic config and ownership refusals therefore
leave the existing catalog and cache untouched, and their concrete messages are emitted on stderr.
The real injection still revalidates under its normal write boundary after catalog convergence;
the preflight is an early no-write guard, not an authorization token for a later write.

> Decision record: [ADR-0019](decisions/ADR-0019-config-injection.md)

`supports_websockets = true` is appended to the provider table only when `websocketsEnabled(config)`
returns true.

## Profile and fast tier

When opencodex owns routing, it also writes `$CODEX_HOME/opencodex.config.toml` as an explicit profile
target. Codex config uses `service_tier = "fast"` and `[features].fast_mode = true`;
catalog/request tier metadata may use `priority`. Do not collapse these spellings into one value.

## Provider output defaults

`OcxProviderConfig.defaultMaxOutputTokens` and `modelMaxOutputTokens` are OpenAI Chat wire defaults,
not context-window metadata. They are applied only when a Responses request omits
`max_output_tokens`; an explicit request value wins, then a model-specific configured value, then
the provider default, then the adapter omits `max_tokens`.

Both fields must stay positive finite integers at disk-config and management validation boundaries.
Registry entries may seed them through `providerConfigSeed`, key-login derivation, OAuth reconcile,
and `routeModel`, but user config overrides registry defaults per field/key.

## Provider validation ownership

`src/config/provider-validation.ts` owns the pure provider payload checks shared by persisted config,
CLI writes, and management DTO validation. `src/config.ts` imports those checks for Zod refinement
and re-exports them as a compatibility facade; it must not grow a second copy. Validation error text,
ordering, and cross-field rules are part of the write/load contract because management requests and
hand-edited `config.json` must accept and reject the same provider shapes.

> Decision record: [ADR-0020](decisions/ADR-0020-provider-validation-ownership.md)

## Restore

`ocx stop`, `ocx restore` / `ocx eject`, `ocx service stop`, and `ocx service uninstall` must strip
opencodex config and routed catalog entries without damaging native Codex state.

Full `ocx uninstall` config cleanup is ownership-manifest based. A fresh config directory receives a
root-bound owner marker and an uninstall manifest before its first atomic config write. Uninstall
validates both bounded metadata files, rejects path traversal and a symlink/junction config root,
and removes only normalized manifest entries. Manifest-owned directory links are unlinked without
traversing their targets. Unknown files remain in place and make the command report a partial
uninstall with their exact paths.

Legacy nonempty config directories are deliberately not retroactively claimed. If either ownership
file is missing, malformed, or bound to another root, uninstall refuses config deletion and reports
the residual directory for manual review; there is no recursive-delete fallback.

## Remote client key files

Client connection metadata stores a stable `apiKeyId` and a non-secret rotation `pendingOperation`. The current data secret remains only in `service-api-token`; a bounded rotation temporarily keeps the old secret in owner-only `service-api-token.prev`. Commit or recovery clears the marker before orphan cleanup. `ocx disconnect` is local-only and leaves remote revocation to the hub's **Integrations → API Keys** page. Hub and local usage stores are not mirrored.

Codex display-cache expiry, retained main-policy evidence, and reset history follow the
[quota cache contract](providers/openai-tiers.md#quota-cache-and-short-window-history).

## Paginated history writer boundary

`src/codex/history-provider.ts` refuses external writes to paginated or migration-capable history. `src/codex/inject.ts` checks affected rows and manifest-owned restore targets before artifact changes and compensates detected migration. Failed config restore stops later catalog/history work. See the [history writer contract](codex-home.md#paginated-history-writer-boundary) for guarantees and concurrent-writer limits.

The Cline client keeps connection settings and models in a separate native file pair; client path overrides and reversible writes follow [Cline paired files](clients/integrations.md#cline-paired-files).

`claudeCode.stabilizePromptCache` is a default-off operator setting for
[translated instruction stabilization](data-planes/inbound-compat.md#opt-in-claude-instruction-stabilization).
Config JSON preserves the boolean; only literal true activates the role-changing transform.

The lightweight top-level CLI help counts Cline CLI among the fifteen registered export clients; registry parity remains covered by the client help and integration tests.
