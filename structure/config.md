# Config Surface

Native function-result injection follows [the separate opt-in control contract](transports/streaming-health.md#experimental-native-function-result-injection); this surface does not infer upstream support or alter its defaults.

Native steering follows [the shared WebSocket contract](transports/streaming-health.md#experimental-native-mid-turn-steering); this surface's defaults remain unchanged.

Catalog HTTP acquisition follows the [proxy-routing contract](catalog.md#remote-catalog-http-proxy-routing).

Configuration consumers retain the [refresh-lock ownership boundary](catalog.md#accounts-namespaces-and-pool-rotation); failing to establish a usable matching lock identity does not authorize deleting its path or replacing the refresh callback outcome with a path-probe error. Cooperating lock metadata changes serialize through the existing SQLite mutation transaction; release keeps the descriptor open through identity comparison and any unlink, then closes it. Failed metadata writes remove only a matching owned path after successful coordination; unknown identity, failed probes or unavailable coordination retain the path for stale recovery. Async refresh work holds no metadata transaction.

Explicit Codex CLI installation observation reads only supplied installation paths; it neither discovers nor writes config. See the [read-only observation contract](runtime.md#explicit-codex-cli-installation-observation).

The configuration-only [plaintext V2 contract](subagents.md#plaintext-v2-agent-messages)
is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged. CLI installation inspection reason codes, including Windows deferral, follow the [runtime inspection contract](runtime.md#lifecycle).

Connected-client catalog diagnostics use the [terminal rendering contract](runtime.md#cli-readiness-diagnostics) on the first connection and on every `ocx sync` refresh; stored catalog values are unchanged.

Hub management ingress also selects the [local dashboard address](runtime.md#hub-management-dashboard-address) using its configured port.

Native main reauthentication follows the [CLI JSON output contract](runtime.md#native-main-reauth-json-output).

The Codex restart command follows the [CLI restart scope contract](runtime.md#cli-codex-restart-scope).

`src/cli/account-orca-import.ts` exposes an explicit-source, preview-first local import command.
Apply adds pool configuration under the shared mutation lock; the
[source-owned credential contract](codex-home.md#orca-source-owned-account-import) governs
deduplication and credential storage separately from Codex config injection.

## Config surface

Google providers may persist `googleToolSchemaPolicy` as `compatible` or `reject-lossy`.
`ocx provider add --google-tool-schema-policy` is one authoring path and is accepted only when the
effective adapter is `google`. Omission remains absent in `config.json`; the adapter resolves it to
`compatible` in memory.

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

`src/config/persisted-mutation.ts` owns schema-valid on-disk mutations under the shared lock.
It rechecks the file before committing, retries a changed snapshot up to three times, and
returns unavailable for missing, invalid, or persistently conflicting config. Its one-shot
test seam and the mutation types remain re-exported through `src/config.ts`.

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
process-wide temp sequence, symlink target resolution, no-follow directory-entry replacement for
externally writable integration directories, real-home test guard, owner manifest,
Windows ACL hardening, scrub-before-unlink failure path, and explicit residual-temp errors. A caller
must not replace it with a local temp-and-rename shortcut.

Windows hardening there is applied once per write, not once per harden call. Both calls stay
`required: true` and still fail the write closed, but the pre-rename call resolves through the
`src/lib/windows-secret-acl.ts` success memo: after the content write the writer re-asserts that the
path still resolves to the object its descriptor holds, then re-attributes the memo to that same
object so the freshness the data write moved does not read as a replacement. A different object, or
one that cannot be observed, retires the memo and the pre-rename call performs the full sequence.

> Decision record: [ADR-0016](decisions/ADR-0016-config-surface.md)

`src/types.ts` is the shape; the load/validate pipeline lives in the split config leaves — schema in `src/config/schema/` (`config-schema.ts`, `leaf-validators.ts`) and replace-path persistence in `src/config/persist-unlocked.ts`, with `src/config.ts` as the compatibility facade — and is not reproduced here. What
matters for maintainers is which groups exist and who resolves them:

A schema-invalid top-level JSON value is repairable only when it is a non-array object.
`loadConfig` backs up arrays, primitives, and null before using defaults, so the repair
merge cannot turn them into a valid config while discarding the original bytes.

| Group | Keys | Resolution rule |
| --- | --- | --- |
| Listener | `port`, `hostname` | The listener owns the port; `runtime-port.json` reports where it actually landed. |
| Routing | `defaultProvider`, `providers`, per-provider `selectedModels`, `combos` | Explicit `provider/model` wins over `defaultProvider`; combo dispatch uses the selected target's existing capability ladder and does not create a second catalog authority. |
| Compaction routing | `compactionRouting.model`, optional `compactionRouting.reasoningEffort`, optional `compactionRouting.triggers` | Explicit Codex compaction metadata whose `compaction.trigger` is one the block names activates a request-local override; `triggers` defaults to `["manual"]`. See [Responses compaction](transports/responses.md#compaction-routing-overrides). Invalid hand edits disable the block with a load warning without discarding providers; candidate writes reject invalid blocks. |
| Catalog | `disabledModels`, `customModels`, `modelCacheTtlMs`, `providerContextCaps`, `contextCapValue`, per-provider `modelDisplayNames`, `codexAccountNamespaces`, `codexAccountPickerEnabled` | Catalog state is derived; config only records intent. Exact provider model display names are durable display only overlays. The picker flag is an explicit visibility override, while selector mappings remain the durable exact-routing contract. |
| Retained state | `appOwnedMemoryBudgetMb` | Process-wide eviction target for app-owned logs, caches, blobs, and continuation payloads. Default 256 MiB, valid 64..4096; pinned state may temporarily exceed the target, but every pin-capable store has a finite local cap and their documented aggregate stays below `APP_OWNED_WORST_CASE_PINNED_BYTES` (512 MiB). Neither value caps RSS or native runtime memory. |
| Spend | `spend.root`, `spend.identity`, `spend.pool`, `spend.retentionDays` | Durable token ceilings for the spend-reservation ledger. Absent is the default and means observe-only accounting: spend is still journaled and nothing is refused, so observe-only and enforced servers take the same state-directory writer lease. One live process may write one directory; explicit sibling instances need separate `OPENCODEX_HOME` directories. There is no default figure for any scope — the ledger is on by default, so a shipped ceiling would refuse real traffic on upgrade against a number nobody chose. Strictly validated and positive-integer only, because 0 would read as a budget and refuse everything; a malformed section degrades to no ceiling, which is why the write path rejects it and load diagnostics report it. Resolution and application live in `src/lib/spend-reservation-ledger.ts`; see [`transports/responses.md`](transports/responses.md). |
| Transport | stream mode, timeouts, proxy settings, `websockets`, `emptyCompletionRetry` | `streamMode` persists in config.json; Windows services need a persisted input, and macOS uses it for explicit eager-relay opt-in. Empty-completion replay is an explicit top-level opt-in because its second upstream request may be billable. |
| Provider egress | `providers.<name>.proxy`, `providers.<name>.noProxy` | An absent `proxy` inherits global egress; `"direct"` or `null` forces direct egress; HTTP(S) and SOCKS5(H) URLs select a provider-owned proxy. `noProxy` uses NO_PROXY syntax and sends a matching destination direct across either a provider-owned or inherited global proxy. `src/lib/provider-egress.ts` owns parsing and request-local resolution. |
| Credentials | `apiKeys` | Data-plane only; never admitted to `/api/*`. |
| Lifecycle | `codexAutoStart`, shim/start behavior, resume-history sync, storage cleanup | Startup safety reads these; see [`gui-and-management-api.md`](gui-and-management-api.md). |

Env values are resolved through `src/config/proxy-env.ts`, so a config value naming an env var never persists
the secret itself.

Malformed optional data-loopback and nested hub-management listener blocks are disabled in memory and reported by load-time warnings and read-only config diagnostics. Ingress warnings validate the raw ingress independently, so an invalid hub sibling does not falsely blame a valid ingress. The warning names only the field; unrelated providers and keys survive. Explicit writes remain strictly validated.

The `ocx config show` reader in `src/cli/config-command.ts` uses those diagnostics directly. Its
client annotation compares only the bounded service-token fingerprint with the validated client
record; it does not call `loadConfig`, mutate permissions, or import the write-capable connect flow.
All config publication continues through the existing required ACL-hardened writers above.

`claudeCode.desktopProfile` follows the same preserve-the-rest rule. JSON `null` (or any non-string) `appliedFingerprint` / `appliedAt` is treated as unset. A profile that is still invalid after that is dropped as a whole — `src/config/salvage.ts` already does this for independent `routingProfiles` / `combos` entries — so one bad Desktop marker cannot replace the operator's providers with `getDefaultConfig()`. A `claudeCode` value that is not an object still fails the document, because there is no safe subtree to keep.

The former `showCodexSparkQuota` key is inert passthrough data when loading an old config.
It is absent from the typed settings contract and cannot re-enable Spark quota through the
management API. Retirement does not migrate user-selected model ids or erase usage history.

## Config injection

An explicit desktop restart after injection uses the [runtime process-membership contract](runtime.md#codex-desktop-process-membership); mixed Windows path spelling does not change which installation the restart targets.

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

The `name` field is the only presentation value in that table, and `codexProviderDisplayName`
chooses it (default `OpenCodex Proxy`). `resolveCodexProviderDisplayName` in
`src/codex/inject/config-toml.ts` is the single place that decides it, and every emitter goes
through `buildProviderTableBlockForTarget` so the active table, the retained compatibility table,
and the reference profile cannot disagree. Identity is deliberately not derived from it: routing
resolves through the provider id `opencodex` in the root `model_provider` line and the
`[model_providers.opencodex]` header, so a rename cannot reroute a thread or orphan a row that
already names that id (#4810). The field can never be emitted empty or omitted — Codex rejects a
provider with no name and rejects the whole config rather than one thread, which is strictly worse
than the branding it would remove — so a blank, over-length, or control-character value falls back
to the default instead of being written.

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

An injection whose OpenCodex config explicitly selects the v1 multi-agent surface also
reconciles Codex's higher-precedence global `features.multi_agent_v2` override to disabled before
taking the journal baseline. It uses the same format-preserving feature transition as explicit
mode selection, and it runs inside the injection's coordinated write boundary: the transition and
the artifact commit share one preimage. A publication conflict after the toggle, or final
coordinator validation or commit failure after the artifact writes, restores the flag, config,
profile and journal while the native and config locks are held. No competing writer can land
between them. Validation-only injection and externally managed provider configs remain read-only.
The write lock first compares the plan derived from the original input to reject stale work. After
the v1 transition, the coordinator publishes a witness derived from the rederived plan and the
post-transition input, so its recorded id describes the bytes committed by the injection.

### History backup manifest contract

`src/codex/history-manifest.ts` is the pure schema-and-identity leaf for the versioned history
backup manifest. It owns the accepted provider/source provenance tuples, platform-aware database
path identity, backup filename id, and validation from unknown JSON to a typed manifest. It does
not read files, inspect rollouts, open SQLite, retry, fingerprint, write, or delete anything.

On Windows the path identity strips the extended-length prefix (`\\?\` and `\\?\UNC\`)
before resolution, because Codex records both spellings for the same file and comparing them
literally failed the integrity check for intact sessions (#4442). A database path spelled with
that prefix hashed to a different backup filename before the normalization, so the readers
(`history-provider.ts` for mutation, `native-residue.ts` for observation) fall back to the
legacy filename when no canonical manifest exists. When both names exist the canonical manifest
wins and the legacy file is left in place; a conflict is never resolved by silently replacing
either file. History Worker job targets use that same canonical-first lookup rather than passing a canonical-only filename that would bypass the provider's legacy fallback.

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
Exactly one conversation-history refusal scopes the relabel unit instead of vetoing the apply
transition, and only because it is permanent. Codex allocates paginated rollout ordinals inside
its own writer, so `history_paginated_requires_native_writer` is not retryable: when the admitted
candidate preserves any existing provider table, the transition writes config, profile,
and `model_catalog_json`.
On successful apply, the relabel job is skipped without spawning
its Worker, and the reason travels in the human message and in the structured
`historyPreflightFailureReason` field *alongside* `success: true`. Every other reason — an
unreadable state database, a rollout whose identity changed, a preflight that could not run —
describes a store that may be relabelable on the next attempt, so those keep the hard refusal
and the compensating rollback. Recording them as a stand-down would mark the transition
converged and suppress the relabel permanently.

That stand-down applies only when the provider tags left in place still resolve through the
resulting configuration. A provider-table transition that finds a paginated `openai` row returns
`history_paginated_openai_requires_native_writer`, because removing the root `openai_base_url`
without relabeling that row would route a resumed conversation through Codex's built-in OpenAI
provider instead of this proxy. That reason selects a third state rather than a refusal:
`src/codex/inject/paginated-openai-compat.ts` keeps the marker-owned root override beside the
provider table, exactly as the client-compaction form already does, and the transition completes
with the relabel standing down. Codex merges the override onto its built-in `openai` entry when
it builds the provider map, so the row keeps reaching this proxy while never being rewritten, and
the retained value is journaled as OpenCodex's own so restore can still take it out.

Two cases cannot reach that state. An admission-token form cannot use the root key at all —
Codex's built-in entry carries no `x-opencodex-api-key` header — so it keeps the refusal, and the
message names the two configuration keys that resolve it (`unauthenticatedLoopbackListener`,
`syncResumeHistory`) instead of saying only "do not retry". A root line the user owns is left
alone and the conversation follows the destination they chose, which is the same guarantee the
injector makes everywhere else about a line it does not own. Refusing the whole transition with
no named way forward was the 2.60.0 regression in #5321: nothing was written, the integration
stayed disabled, and the only exits a reporter could find were deleting the affected
conversations or downgrading.

Rows this home tagged `opencodex` resolve through a `[model_providers.opencodex]` table.
Apply retains that existing definition before building the candidate witness, even when
history preflight passes. The root-override form still selects the built-in provider for new
conversations. Background history work is not atomic with config publication, so its future
success cannot authorize retiring the old definition first. If native pagination begins after
artifact commit or while the worker starts, the old references still resolve and any worker
failure is reported. Paginated rollout bytes and thread rows remain untouched. Explicit
restore and removal retain their separate guards below.

Treating the refusal as a veto is what made every current Codex home unusable: paginated
rollouts refuse unconditionally, so `model_catalog_json` never reached config.toml and both the
app and the CLI fell back to their built-in model list. `ocx sync` reported success anyway,
because that reason was special-cased into a `catalog-only` result — the downgrade is gone, so a
refusal that survives is a real config or integrity failure again.

Restore and removal now have that seam, so they no longer refuse on this one reason. The
argument that forced the refusal still holds — stripping the provider definition while its
threads still point at it would orphan them — but it only ever justified keeping the
`[model_providers.opencodex]` table, not keeping the routing that aims plain `codex` at the
proxy. Those are separable, and conflating them is what let `ocx uninstall` remove the proxy
and leave the config pointing at it.

On `history_paginated_requires_native_writer`, restore and removal take every OpenCodex root
routing key out and retain the provider table verbatim, captured from the pre-transform bytes
and re-appended into the same buffer so the file never passes through a state that names a
provider it does not define — upstream fails the entire config load on a missing provider id,
not the single thread. The history relabel is skipped rather than attempted, so paginated
rollout bytes and thread rows stay untouched here exactly as they do on apply. The result is
reported as `partial`, naming the retained lines and the command that removes them.
`ocx restore --remove-codex-provider-table` is the explicit opt-in for full removal, and it
states that conversations already tagged `opencodex` stop opening. Every other refusal reason
keeps the hard refusal and the compensating rollback.

Unattended sync, `POST /api/sync`, and every other config or ownership refusal keep the hard
failure above.
The real injection still revalidates under its normal write boundary after catalog convergence;
the preflight is an early no-write guard, not an authorization token for a later write.

> Decision record: [ADR-0019](decisions/ADR-0019-config-injection.md)

`supports_websockets = true` is appended to the provider table only when `websocketsEnabled(config)`
returns true.

## Desktop compatibility switches report three things, not one

`codexDesktopAuthless` and `codexClientCompaction` only mean anything through the injected
`config.toml`, so persisting them is not applying them. `PUT /api/settings` used to persist
and then converge the catalog, and a comment there claimed the injector rewrote the form;
`convergeCodexCatalog` rejects any scope but `catalog` and never reaches `injectCodexConfig`,
so the injected shape stayed as it was until a separate `ocx sync`.

The route now runs the real injection after catalog convergence and after the config mutation
lock has closed — coordinated Codex writes take the Codex write lock before the config mutation
lock, so awaiting the injector inside that transaction would invert the order — and reports
three separate facts per switch: the **stored** value in `config.json`, the **effective** value
this bind and role will actually produce, and whether `config.toml` was **applied**, with the
reason and retryability when it was not. `src/codex/desktop-switches.ts` owns that projection.

Effective values come from `isEffectiveCodexDesktopAuthless` and
`isEffectiveCodexClientCompaction` in `src/codex/loopback-target.ts` rather than a second copy
of the predicate, because the reporting answer and the injection answer diverging is the defect
being fixed: a non-loopback bind without the unauthenticated loopback listener drops the
authless flag while the API read back the configured `true`.

The report also states the auth-source consequence. The flag decides `requires_openai_auth` in
the injected provider table, which is what Codex reads to decide whether to ask the user to
sign in at all, so flipping it changes whose identity is in use and the user is told at the
moment they change it. The pre-existing top-level `codexDesktopAuthless` and
`codexClientCompaction` booleans keep reporting the configured value for compatibility; the
report is additive.

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

`src/providers/resolved-model-policy.ts` is the detached static-policy authority for this merge
contract. It preserves each field's existing rule rather than assigning one global priority:
operator scalars and explicit booleans fill over registry defaults, per-model maps fill per key with a case-varied operator key claiming the registry row,
restriction lists form a stable union, and hard wire pins precede valid operator overrides and
registry wire defaults. Only the canonical `openai-apikey` provider merges
`modelContextWindows` and `modelMaxInputTokens` by taking the lower positive value across
case-equal keys, retaining the operator's row spelling and provenance even when registry-clamped;
other providers use ordinary operator-per-key fill. Its output is recursively
frozen and carries field/model provenance. It never persists resolved policy and excludes API keys,
account selection, quota, health, cooldowns, discovered availability, and request-owned evidence.
Observed context/input/output values are combined only in a call-local projection that can narrow a
captured static cap but cannot write observations into the static result.
The resolver's model id is the post-alias, post-virtual-rewrite wire identity. An exact nonempty
`modelCapabilities[model].inputModalities` declaration outranks the legacy per-model modality map;
an empty declaration is non-authoritative and falls through. OAuth/key override admission remains a
live caller decision: the resolver accepts only its credential-free effective auth mode and records
that provenance, never the key, reference, or usability evidence that produced it.
Canonical static catalogs force live discovery off, narrowly recognized generated reasoning shapes
are repaired before freezing only for a matched registry transport, and same-named custom
destinations keep their operator-owned values. Key-auth service-tier defaults apply only to a
captured key authority; exact-model provenance comes from the merged key/registry map, then falls
back to the resolved provider capability provenance. A model max-input value is bounded by its
resolved context window.
Legacy model maps resolve exact id, then the base before a colon suffix, then case-folded exact id;
the separately captured explicit capability row remains exact-only. Per-model provenance is assigned
from the key that wins that same merged lookup, not from an independent source search.
Provider seed/enrichment and request routing consume the same field-level resolver. Persisted config
still stores operator intent rather than the frozen result; registry-only policy is applied at
capture/route time and explicit false or empty declarations retain their field-specific meaning.




## Provider validation ownership

`src/config/provider-validation.ts` owns the pure provider payload checks shared by persisted config,
CLI writes, and management DTO validation. `src/config.ts` imports those checks for Zod refinement
and re-exports them as a compatibility facade; it must not grow a second copy. Validation error text,
ordering, and cross-field rules are part of the write/load contract because management requests and
hand-edited `config.json` must accept and reject the same provider shapes.

The Google tool-schema policy uses a closed enum at this boundary. Unknown values fail config load,
management admission, and command-line creation rather than silently degrading to compatible mode.

> Decision record: [ADR-0020](decisions/ADR-0020-provider-validation-ownership.md)

## Provider relative send paths

`src/config/provider-relative-send-path.ts` owns the initialization-independent
`providerRelativeSendPathConfigError` check. The schema leaf re-exports it for compatibility;
`src/server/auth-cors.ts` imports the pure module directly, so this validator adds no
runtime dependency on config-schema initialization.
Both `responsesPath` and `chatCompletionsPath`
must be strings beginning with `/`, without a scheme, query or fragment; omission is allowed.
Provider registration/replacement rejects invalid values before DNS, persistence or catalog
refresh. Editor PATCH checks also validate retained paths when they revalidate a merged provider;
pacing-only and other existing validation bypasses are unchanged. No send-path PATCH setter is added.
`tests/server/management-provider-validation.test.ts` covers rejection without live/disk mutation
and valid-path persistence/reload through the actual management handler.
`tests/server/provider-send-path-import.test.ts` loads the management boundary before the
config facade in a fresh process, so an earlier schema import cannot mask an initialization cycle.

## Restore

`ocx stop`, `ocx restore` / `ocx eject`, `ocx service stop`, and `ocx service uninstall` must strip
opencodex config and routed catalog entries without damaging native Codex state. Catalog restoration
omits retired bare/account-qualified native rows even when they occur in a pristine backup;
the backup itself is not rewritten. See the [catalog contract](catalog.md#shared-catalog).

Full `ocx uninstall` config cleanup is ownership-manifest based. A fresh config directory receives a
root-bound owner marker and an uninstall manifest before its first atomic config write. Uninstall
validates both bounded metadata files, rejects path traversal and a symlink/junction config root,
and removes only normalized manifest entries. Manifest-owned directory links are unlinked without
traversing their targets. Unknown files remain in place and make the command report a partial
uninstall with their exact paths.

The newly created OAuth downgrade copy is registered after copying, so owned uninstall
includes it. Invalid-config recovery copies are deliberately NOT registered: their names carry
a timestamp, so one entry per invalid load would grow the uninstall manifest without bound, and
the manifest stops validating past its path ceiling. A manifest that stops validating makes
uninstall refuse outright, which would leave credentials on disk. Sweeping those copies by name
pattern at removal time is the shape that fits; it is not in this change. Registration is best-effort: an intentionally
unowned legacy home or a metadata-write failure must not suppress the recovery copy. Existing
OAuth downgrade copies are neither rewritten nor retroactively claimed. Both a `false` registration
result and a thrown registration error emit the same fixed warning without error details. Unregistered copies
remain subject to the existing partial/refused uninstall result.

Legacy nonempty config directories are deliberately not retroactively claimed. If either ownership
file is missing, malformed, or bound to another root, uninstall refuses config deletion and reports
the residual directory for manual review; there is no recursive-delete fallback.

## Remote client key files

The connection's `tokenFingerprint` participates in
[`ocx status` credential binding](runtime.md#remote-hub-status-credential-binding).

Client catalog readiness observes the selected Codex runtime without creating or rewriting
`codex-runtime.json`; general status reuses its already-resolved command under the [runtime contract](runtime.md#remote-hub-hardening-ownership).

Client connection metadata stores a stable `apiKeyId` and a non-secret rotation `pendingOperation`. The current data secret remains only in `service-api-token`; a bounded rotation temporarily keeps the old secret in owner-only `service-api-token.prev`. Commit or recovery clears the marker before orphan cleanup. `ocx disconnect` is local-only and leaves remote revocation to the hub's **Integrations → API Keys** page. Hub and local usage stores are not mirrored.

Codex display-cache expiry, retained blocking main-policy evidence, and reset history follow the
[quota cache contract](providers/openai-tiers.md#quota-cache-and-short-window-history).

`codexPool.excludedPlans` is interpreted only by automatic selection; its all-excluded and explicit-route behavior follows the [plan exclusion contract](providers/openai-tiers.md#automatic-pool-plan-exclusions).

Connected CLI usage follows the [client-scoped hub usage contract](gui-and-management-api.md#usage-accounting); local management and account data remain separate.

The unregistered executor CLI module stores Remote Workspace state separately from client configuration; see [Remote Workspace](remote-workspace.md).

Remote Workspace uses a separate, explicitly enabled server surface with structural WebSocket callbacks and awaited per-server cleanup; [its contract](remote-workspace.md) owns that integration.

Usage consumers preserve positive incomplete-history metadata as specified in [usage accounting](gui-and-management-api.md#usage-accounting); readable totals are not represented as a complete ledger. Upstream API-key usage follows the [physical-attempt account attribution contract](gui-and-management-api.md#upstream-key-account-attribution), independently of subscription quota observations.

`dropCodexSafetyBuffering` is an optional boolean, default false. Invalid API candidates reject;
malformed persisted values stay disabled. It controls only the allowlisted client-output hints
described in [Responses transport](transports/responses.md), not upstream policy or model selection.

## Management-backed CLI commands need a management plane

`src/cli/runtime-api.ts` is the single client every headless management subcommand calls through, so
it owns the refusal as well as the request. `runtimeBaseUrl` resolves the live listener through
`findLiveProxy`, and when that listener reports the client role — see
[the client role owns no management plane](gui-and-management-api.md#the-client-role-owns-no-management-plane)
— it refuses with `RuntimeApiError` status 503 instead of dialing it. The message names the port,
states that the listener serves only the machine routes, points custom-model and other management
edits at the hub the machine is connected to, and gives the on-machine alternative: edit
`customModels` in `config.json`, then run `ocx sync`. The status is also the honest exit code, since
`runCliAction` maps 404 to exit 4 and would otherwise report a missing record.

A 404 body carrying both `method` and `path` is rendered as the route that listener does not serve,
so any not-served-here answer stays legible rather than printing a bare token. `ocx models edit` in
`src/cli/models-runtime.ts` narrows the opposite case: only a 404 without those keys is the
management handler's own unknown-id answer, and it names the id and `ocx models list-custom`.

Paginated and migration-capable history follows the [authoritative writer contract](codex-home.md#paginated-history-writer-boundary); this document adds no independent writer guarantee.

Private pool credential metadata follows the [quota-history publication identity contract](providers/openai-tiers.md#quota-history-publication-identity); credential-only and account DTO projections omit it.

Codex pool settings and their consumers follow the [reset-first ordering contract](providers/openai-tiers.md#reset-first-account-ordering), including independent-quota fallback, preserved affinity, strategy-specific threshold summaries, and shared short-observation freshness for switch warnings.

The Cline client keeps connection settings and models in a separate native file pair; client path overrides and reversible writes follow [Cline paired files](clients/integrations.md#cline-paired-files).

`claudeCode.stabilizePromptCache` is a default-off operator setting for
[translated instruction stabilization](data-planes/inbound-compat.md#opt-in-claude-instruction-stabilization).
Config JSON preserves the boolean; only literal true activates the role-changing transform.

The lightweight top-level CLI help counts Cline CLI among the fifteen registered export clients; registry parity remains covered by the client help and integration tests.
Pool quota producers and account commands follow the [bounded raw-observation contract](providers/openai-tiers.md#bounded-pool-quota-observations), separate from the latest display snapshot and capacity estimates.

The account history response can include a [low-confidence effective capacity estimate](providers/openai-tiers.md#observed-effective-token-capacity); usage normalization retains local-answer provenance so local responses cannot supply samples.

Account quota surfaces use [safe probe diagnostics](transports/inventory.md#account-quota-failure-diagnostics) separately from quota validity, credential health and routing authority.

The OpenCode launcher resolves the existing local management origin from the live bind and configured hub ingress. Its admin credential comes from the existing admin environment/file policy; an absent credential fails without substituting a data key.

Provider `autoReviewModel` and `autoReviewModelOverrides` accept validated final-catalog selectors. Per-model keys preserve case and accept the existing raw/encoded slash equivalence. File-load degradation removes malformed optional selectors only; management writes reject malformed shapes. Omitted provider saves preserve selectors, explicit clears remove them, and raw editor candidates adopt normalized values before persistence and live replacement. See [catalog ownership](catalog.md#provider-scoped-approval-reviewer).

Display-name validation retains prototype-shaped model IDs as data; reviewer-target map validation remains separate and rejects its reserved keys.

## Explicit per-model capability declarations

`modelCapabilities` on `src/types/provider.ts` stores exact model-ID entries with optional inputModalities, contextTier and video.processing axes. `src/config/provider-validation.ts` strictly validates writes and merges PATCH axes without sharing live objects; null map/model/axis/processing tombstones delete, while empty PATCH objects do nothing. Complete POST/PUT replacements reject tombstones. File reads retain valid axes; malformed explicit modalities restrict to text with a diagnostic. The two catalog writers receive explicit config and gather fingerprints include the map. This storage contract alone does not activate a context tier, advertise a larger window or enable video processing.

The text-only consumer reads exact inputModalities declarations before legacy hints. CLI add/edit `--text-only` targets one model and preserves sibling declarations; `src/vision/eligibility.ts` routes declared text-only models into existing image-description or explicit-omission handling. Positive routed image declarations override stale candidate metadata, while native catalog authority retains its existing legacy policy.

An explicit custom row is the operator's own definition of one routed model, so its
`customModels[].inputModalities` outranks the provider-level vision hints
(`noVisionModels`, `modelInputModalities`) for that exact `provider`/`modelId` identity.
`modelCapabilities` keeps the top slot as the dedicated capability axis, including for the
`ocx provider edit --text-only` write. The catalog overlay in
`src/codex/catalog/routed-gather.ts` copies that declaration onto the advertised row directly,
and the request-path predicates in `src/vision/eligibility.ts` and `src/vision/plan.ts` read the
same field through `customRowInputModalities`, so an advertised row and the dispatch decision can
no longer disagree about one model. A custom row that declares no modalities stays silent rather
than becoming a text-only claim.

Every consumer that answers "can this model take an image" applies one rule to the declaration:
image is absent from the list. A row declaring only `audio` or `video` therefore counts as
image-incapable in both `requiresVisionPreprocessing` and `modelAcceptsImageInput`, rather than
being treated as a text model by one and an image target by the other.

## Catalog auto-refresh

`catalogAutoRefresh` on `src/types/config.ts` stores an optional `enabled` / `intervalMinutes` section that defaults off: an absent key, an explicit false, and a malformed value all leave the scheduler dormant. `src/config/feature-flags.ts` resolves the cadence; an explicit `intervalMinutes: 0` keeps the unref'd timer idle, and any other value is clamped up to 15 minutes because upstream `/models` caches have not moved below that and a shorter tick only multiplies rate-limit exposure. `src/codex/catalog-auto-refresh.ts` is the module-singleton interval `src/server/background-lifecycle.ts` starts beside the quota reset poller; a tick that is enabled and non-dormant drives the same catalog-only converge funnel management mutations drive. Each tick arms its independently loaded config snapshot as a detached baseline before provider work, so the discovery save rebases every field — the listener binding and sections absent from the snapshot included — against the disk state at save time and concurrent hand edits survive the tick — `disabledModels` merges by member, so an overlapping visibility edit survives alongside the discovery additions. Detached saves capture explicit persisted top-level deletion intent before reconciliation, so a changed discovery snapshot cannot erase a current disk tombstone by temporarily restoring its key. A defined value reintroduced on disk removes stale deletion authority; ordinary live-config conflict precedence remains unchanged. The last-outcome record lives in `src/codex/catalog-refresh-status.ts` (when the tick finished, the normalized `CatalogDisposition`, whether the served model set changed, consecutive failures) and carries no provider or account detail.

## Aggregate request metrics export

`metricsExport` on `src/types/config.ts` is an optional strict object with one optional boolean,
`enabled`. `src/config/feature-flags.ts` treats only literal `true` as enabled; absence, false, or a
malformed persisted value is off. `src/config/schema/config-schema.ts` degrades a malformed hand edit
to absence so an optional monitoring typo cannot discard providers or credentials. The live-write
boundary runs `metricsExportConfigError` in `src/config/diagnostics.ts` before the degrading schema,
so wrong types and unknown nested fields are rejected rather than silently saved. Activation is read
when the server process creates its serve options and therefore requires restart; it adds no setting
to the live `/api/settings` mutation surface.

Stored Direct substitution follows the [credential identity contract](providers/openai-tiers.md#sidecars-management-and-ui): both synchronous and asynchronous materializers discard the caller account header before applying the stored credential; ordinary native Direct passthrough is unchanged.

## SOCKS5 activation owner

`src/config/proxy-env.ts` remains the single application owner for global proxy
configuration. An explicit SOCKS5 or SOCKS5h URL selects ALL_PROXY and removes
stale scheme-proxy variables; HTTP(S) settings retain their existing environment
precedence. Activation keeps the existing Windows auto-discovery path and loopback
NO_PROXY entries. When the environment no longer selects SOCKS, activation
restores the native fetch; removing a saved field alone does not erase inherited
process environment variables.
SOCKS4 is rejected instead of being advertised as a working transport.

`src/cli/start-args.ts` parses `ocx start --socks5 [host:port]` and the mutually
exclusive `--socks5-off`. The start owner persists only an explicitly requested
change; the off flag refuses to erase a non-SOCKS proxy. Invalid-address errors
never echo user-supplied credentials, and status messages redact proxy URLs.
The parser regression cases live in `tests/cli/start-args.test.ts`.
The config CLI masks credential-bearing `proxy` URLs in show, get, and mutation output:
userinfo is stripped while host and port stay visible, `direct` and credential-less values
print unchanged, and a non-URL value that is not `direct` is masked whole. `config export`
keeps the raw file so exports can restore credentials. Get and mutation output select
redaction by the normalized final path segment, matching lookup and mutation semantics.

`src/config/schema/config-schema.ts` accepts the opt-in `codexAccountPriorityFailback` preference and degrades a malformed value in a loaded file to false without discarding providers, while a write candidate carrying a non-boolean value is rejected. A malformed entry in `codexAccountAutoSwitchThresholds` is dropped on load with a warning and the valid entries are kept, so an unrelated save cannot erase them. Its [routing contract](providers/openai-tiers.md#ongoing-priority-failback) requires quota strategy and a positive threshold.
