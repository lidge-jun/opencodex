# Model Catalog

## Shared catalog

`src/codex/catalog.ts` builds a shared Codex-shaped catalog for CLI, TUI, App, and SDK. It:

- preserves native OpenAI entries from the live catalog or static fallback, and emits
  gpt-5.6 natives from the pinned upstream models.json snapshot
  (`src/codex/data/upstream-models.json` — exact per-slug ladders: luna has no ultra);
- upgrades either an observed selector-qualified `*/gpt-daybreak-blue-latest` account row or an
  explicitly configured canonical `openai/gpt-daybreak-blue-latest` Codex-forward row from the
  pinned Sol capability metadata while preserving its selector and Daybreak wire identity;
  this never expands the bare/API-key model lists or rewrites the wire model to `gpt-5.6-sol`;
- clones a native template for routed `provider/model` entries;
- forces strict Codex catalog fields required by the current parser;
- hides `disabledModels` without blocking direct routing (routed provider ids are excluded;
  account-qualified native ids hide only that selector row; BARE native slugs hide the bare row
  and all account-selector clones and drop that model family from raw `/v1/models`);
- applies exact provider/model compatibility exclusions after live discovery and metadata
  augmentation, so upstream-advertised but uncallable rows never enter dashboard or Codex pickers;
- strips native-only service tier and WebSocket metadata unless the final routed provider/model
  explicitly enables the verified OpenAI-compatible service tier;
- backs up the pristine catalog once per catalog: the copy is keyed by a hash of the catalog path
  (`catalog-backup-<id>.json`), and the legacy unsuffixed `catalog-backup.json` is retained in
  addition for the default catalog, so a restore resolves the backup for the catalog it is restoring
  rather than assuming a single file;
- invalidates `$CODEX_HOME/models_cache.json` when model visibility changes.

On the default `opencodex-catalog.json` path, sync deliberately uses two catalog sources: Codex's
bundled catalog supplies a current native entry template, while the actual on-disk catalog supplies
the rows being merged. This split is required because empty or partial provider discovery must
preserve routed entries and genuine user-native rows from the file that will be overwritten; a
bundled catalog never contains those rows. Retained sync and evidence-bound convergence share an
explicit observed-state merge policy and restore native priorities from the once-only pristine
backup rather than from a catalog whose priorities may already have been rewritten. A configured
custom catalog remains the native metadata/template authority even when a bundled-catalog memo is
warm. Both paths may use an admitted matching bundled memo only as installed-runtime capability
evidence to remove unsupported reasoning efforts; convergence never probes Codex itself.

Custom Astra and Daybreak rows acquire native reasoning capability only through the existing
canonical `openai` forward destination and explicit capability-source predicate. The shared
custom-row producer bounds their merged effort lists against pinned per-model Codex metadata,
preserves an explicit empty list without a default, and recovers an incompatible nonempty list
to the native default singleton. A default must belong to the projected list. Other custom rows
keep their declaration precedence; a GPT model name, display alias, or arbitrary gateway is not
native provenance. Stored configuration and native capability maps are unchanged.

The observed-state merge tracks the current invocation's freshly generated custom row objects
after detaching its inputs. Those rows already own their complete reasoning projection, so the
merge does not append `max` again. This also keeps a generic none-only custom row none-only;
ordinary retained provider rows still receive the existing mock-tier policy. A persisted custom
marker alone never grants this exemption. Both gather entry points, retained sync, management
convergence and direct Codex model discovery use the same producer. The legacy runtime effort
union clamp remains separate; it is not a per-model or per-client-version grammar oracle.
Existing thread settings and the reported Desktop 0.153.4 gateway rejection require separate
runtime evidence. Codex's native `ultra` mode is preserved and is not a literal API wire promise.

When account selectors are enabled, the sync path may also observe exact, visible, API-supported
OpenAI-family ids from Codex's user-owned catalog/cache. Only rows with native catalog provenance
are trusted; unknown ids are carried through startup cache invalidation as hidden observations and
are emitted only as selector-qualified rows whose account provenance matches. They never expand
the bare native or API-key model list. This keeps account-scoped upstream ids such as
`gpt-daybreak-blue-latest` callable without treating them as a static release allowlist.

Account-gated native ids are a stricter subset. Their authenticated ChatGPT `/models` roster is
cached per credential generation with a bounded timeout. A bare gated row is emitted only when at
least one confirmed eligible account reports it; a selector-qualified row is emitted only when the
mapped account reports it. A failed or malformed discovery is not positive evidence and therefore
hides the gated row until a later refresh. The same snapshot gates Pool selection, so the catalog
and runtime cannot disagree by advertising through one account and dispatching through another.

The app-server's model list comes from this shared catalog, not from patching the App. Codex Desktop
may still apply its remote native-only allowlist after `model/list`; an explicitly configured combo
`nativeAlias` is the bounded compatibility path. It replaces one supported bare native row with a
routed, labeled row, routes the bare id before canonical OpenAI, and keeps account-qualified native
selectors genuine. Missing target discovery capabilities inherit the replaced native row's metadata,
while explicit target limits remain authoritative. Because the affected renderer ignores `visibility: "hide"`, the presence of any
native alias also omits disabled bare native rows from the effective catalog. Dashboard rows remain
derived from the static native set, and sync retains bundled/pristine native recovery sources so a
later re-enable or alias removal restores native metadata.

Provider live-model lists are cached with a configured TTL (`src/codex/model-cache.ts`). Adding,
deleting, or editing a provider's shape clears that per-provider cache; a disabled-only change
deliberately does not, because a disabled provider is already excluded from the catalog gather
instead. Codex's own `models_cache.json` is a different cache, invalidated by catalog refresh.

For `liveModels: false`, a static provider publishes the ordered union of `models` and
`retainModels`. When `models` is absent or empty, its configured `defaultModel` seeds that
union before retained ids; a nonempty explicit list does not import a different default.
Without any default or configured/retained ids, the static result stays empty. The existing
forward-auth native path remains separate. Static gathering does not refresh OAuth or call
the provider's model endpoint, and normal selection and visibility filters still apply.

The provider workspace uses the existing `/api/models` projection for displayed rows,
model identity and inventory counts. Counts cover distinct non-disabled selectors within
each provider, before search or the render cap; they are not selected-model or live-discovery
counts. The full available list and discovery provenance remain separate inputs.

Deleting a custom definition uses its stable record id and does not also hide the underlying
model. Native or discovered metadata can therefore reappear without changing the inventory
count. Hide uses the represented row's native/routed identity and changes visibility only.
The Models page can restore existing hidden rows; adding a definition does not implicitly
clear a previous hide or provider allowlist. Actions wait for current row and custom-ownership
observations, and mutations reconcile those observations instead of retaining browser-only
removal markers. These presentation operations do not grant routing or account entitlement.

### Windows request-path catalog-state discovery

> Decision record: [ADR-0021](decisions/ADR-0021-shared-catalog.md)

## Startup readiness

Each `startServer` invocation owns a private, one-shot readiness gate created before the listener
binds. `handleStart` supplies its gate and transitions it only after the shared catalog sync and
best-effort Claude Code roster reconciliation have both settled. The catalog sync remains the
authority for ready versus failed; a roster warning does not make an otherwise healthy proxy fail.
Calls without a supplied gate receive a fresh private gate that intentionally remains pending. Only
`ok: true` with no nonempty warning becomes ready; `null`, a throw, `ok !== true`, or a nonempty
warning becomes failed. State is isolated per server instance.

Exact unauthenticated `GET /readyz` returns sanitized identity fields plus pending, ready, or failed:
`200` for ready, or `503` with `Retry-After: 1` for pending and terminal failed. The full CLI syntax
is `ocx ready [--json] [--wait [--timeout <seconds>]]`. The probe validates the service, version,
uptime, PID, port, status, and HTTP/status pairing. The default is one probe. With `--wait`, it
applies one absolute deadline (45 seconds by default) across discovery, readiness probes, polling,
and sleeps, but exits immediately on terminal failed. `--timeout <seconds>` requires `--wait` and
accepts positive integer seconds from 1–300. CLI `--json` emits
`{ready, status, pid, port}`, with status in `ready|pending|failed|unreachable`. Exit 0 means ready;
exit 1 covers not-ready, pending, failed, timeout, and unreachable; exit 64 means invalid arguments.
Older proxies without `/readyz` fail closed as unreachable. `/healthz` remains the separate
liveness contract.

## Entry shape

Routed entries keep Codex-required metadata such as reasoning levels, shell type, API support flags,
base instructions, modalities, auto-compact fields, and strict parser booleans. The public slug uses
the canonical `provider/model`. Its display name uses the provider's exact `modelDisplayNames` override first,
then trusted catalog metadata such as a configured qualified provider/model alias, then the public slug.
This overlay never changes route identity or the upstream wire model, and its catalog fingerprint makes
a label edit refresh Codex output.

Supported bare native GPT rows also consume `providers.openai.modelDisplayNames`. Retained sync
and convergence pass the same map to the observed-state merge. After native normalization and
ordering, the merge applies the exact nonblank trimmed label and saves
`opencodex_native_display_name: { slug, original, applied }` in the local catalog only. The next
merge detaches its inputs, removes that marker, and restores `original` only if the native slug
still matches and the current name equals `applied`. Removing or blanking the override therefore
restores the owned name before normal native metadata upgrades. Divergent external names remain
subject to those upgrades: Astra still replaces non-pinned names with its pinned native name.
Template-derived rows discard the marker. The overlay leaves model IDs, metadata (including
capabilities), ordering, routed combo aliases, custom rows and account-qualified rows unchanged;
it does not relabel HTTP model listings or virtual `*-pro` rows.

## Native passthrough

Astra has its own pinned native row: 272,000 default context, 872,000 opt-in ceiling,
low-through-ultra effort, low default, and native multi-agent effort `xhigh`. The native-alias
fallback passes the same configured limits to context, max input and compaction. Unrelated routed
templates clear the native multi-agent effort; canonical Astra-forward custom rows retain it and
the pinned Fast speed description. Sync repairs only the exact old built-in Astra Fast description,
preserving custom descriptions and other stored row fields.

The API registry separately owns Astra's 1,050,000 context / 922,000 input / 128,000 output and
five API effort levels. Trusted discovery snapshots carry the output ceiling as well as input
and context, so reconstruction cannot drop it. User output limits may only lower that ceiling.
Pricing remains provider-scoped and API-referenced for every built-in dollar estimate, including
Codex-login routes. Both OpenAI identities use the same Astra/Sol API base and cache prices,
API Fast multipliers and published long-context bands; Fast stacks with long context for Astra,
GPT-5.6 and the Daybreak Blue selectors. No subscription-specific exception or credit multiplier
enters the estimate. Explicit user price overrides remain authoritative. See the public provider
reference for the dated source table.

Native bare OpenAI entries form one `openai` group. The provider's Pool(default)/Direct option
changes account selection without changing those ids; `openai-apikey/<model>` creates the separate
API-key identity. The API GPT-5.6 rows use 1,050,000 context / 922,000 max input; their `*-pro` virtual rows
rewrite to the base upstream model with `reasoning.mode: "pro"` while public state keeps the virtual
slug. Routed non-OpenAI models must not
inherit native-only service tier or WebSocket metadata unless the user explicitly enables that
capability. Detailed invariants live in [`openai-tiers.md`](providers/openai-tiers.md).

Native passthrough entries depend on the enabled provider set. With at least one enabled provider,
they appear only while an enabled canonical OpenAI forward provider exists — disabling every such
provider removes the native rows rather than leaving entries that resolve to no credential. With no
enabled provider at all, the native rows remain as bootstrap so a fresh install still has something
to route.

## Accounts, namespaces, and pool rotation

Pool mode routes across main plus added Codex credentials. Key rules:

- **A namespace is a public selector mapped to an internal target.** Generated selectors are how a
  caller names an account — the main login's selector is `main` (collision-suffixed if taken),
  which maps to the config-only sentinel `@main`; the sentinel deliberately sits outside the
  pool-account id grammar. Selector initialization requires an explicit opt-in and fills only an
  absent or empty map; a non-empty user map keeps its object identity and insertion order. Generated
  selectors avoid provider, combo, routing-policy, and slash-qualified routing-profile namespaces.
  Collision checks normalize provider and reserved namespace keys, while account and
  routing-profile selector prefixes are exact-case (`src/codex/account-namespaces.ts`,
  `src/codex/account-namespace-match.ts`, `src/routing/profile-namespace.ts`).
- **Selector labels carry no account-role semantics.** When at least one selector is advertisable,
  the Codex catalog clones each supported native row per selector and hides the bare picker rows;
  bare ids remain routable and stay in raw `/v1/models` unless explicitly disabled. Missing stored
  account targets are not advertised, and private account ids never become catalog labels.
  `codexAccountPickerEnabled: false` hides generated rows without deleting exact routing bindings;
  an omitted flag preserves the established behavior of a nonempty hand-written selector map.
- **Rotation is sticky.** A conversation stays on its selected account while that account is
  usable; failure moves it, success does not (`src/codex/pool-rotation.ts`).
- **The credential store is generation-guarded.** A refresh takes a lock and persists only if the
  generation it started from still holds; a lost race raises a generation-conflict error rather
  than overwriting the newer credential (`src/codex/account-store.ts`). Callers handle that error;
  they do not assume a silent retry.

Warmup issues a bounded request with a fallback model so a cold account reports usability before a
real turn depends on it (`src/codex/warmup.ts`).

## Routed tool discovery and hosted search

All routed catalog rows advertise `supports_search_tool: true` together with
`tool_mode: "code_mode_only"` — the pair is load-bearing. The field selects Codex's deferred
tool-discovery surface; it does not describe the hosted web-search sidecar. Under code mode,
deferred MCP tools remain callable through exec's `tools` global / `ALL_TOOLS` without a
`tool_search` round-trip (upstream codex-rs code_mode suite; live canary 2026-08-13: routed
kimi/k3 executed `tools.mcp__node_repl__js`, devlog `260813_tool_catalog_deferral/010+020`).
Stamping `false` instead forces every MCP declaration into `exec.description` — a measured 2.7x
turn-1 payload regression (96,699 → 258,929 chars). For Cursor this can also make the unified
`exec` exceed the 120,000-byte serialized `McpTools` ceiling; the budget then drops `exec` and
its companion `wait` (#1830). Hosted search remains independent: non-Cursor routes keep
`web_search_tool_type: "text_and_image"`, while Cursor omits it because runTurn bypasses the
search sidecar.

> Decision record: [ADR-0022](decisions/ADR-0022-routed-tool-discovery-and-hosted-search.md)

## Ultra reasoning level

Ultra is always advertised in the catalog regardless of the `multi_agent_v2` toggle. The v2 toggle
controls only the multi-agent collab surface, not ultra visibility. The `nativeEffortClamp` function
wire-clamps ultra/max to each model's real top rung (e.g. gpt-5.5 ultra → xhigh on the wire).

`effortCap` and `subagentEffortCap` are hard ceilings applied on the V2 path
(`src/server/effort-policy.ts`): they lower or preserve the requested effort rather than rejecting
the request, and they never raise it.

The `ocx effort` CLI accepts only the same canonical cap ladder before live probing or persistence.
Its status output preserves unsupported legacy cap values and reports that those fields are ignored;
the read does not normalize or migrate them, and an ignored subagent field does not disable a valid
main cap. Injection-effort input remains a separate contract.

Operator-owned `pinnedReasoningEffort`, `modelPinnedReasoningEfforts`, and root
`modelPinnedEfforts` resolve before applicable effort caps at the final destination.
Provider model pins precede provider-wide pins, then global selector/destination pins.
A pin can raise the effective caller effort; the later cap can still lower or omit it.
`none` means explicit-effort omission (provider default), not guaranteed reasoning disablement.
Compaction maintenance is exempt. Pins are user overlays and do not alter registry seeds,
model discovery or advertised ladders. Native Chat normalizes newly pinned values through
provider wire mapping; unpinned native requests retain their existing pass-through contract.

> Decision record: [ADR-0023](decisions/ADR-0023-ultra-reasoning-level.md)

> Decision record: [ADR-0024](decisions/ADR-0024-ultra-reasoning-level.md)

> Decision record: [ADR-0025](decisions/ADR-0025-ultra-reasoning-level.md)

> Decision record: [ADR-0026](decisions/ADR-0026-ultra-reasoning-level.md)

Codex display-cache expiry, retained main-policy evidence, and reset history follow the
[quota cache contract](providers/openai-tiers.md#quota-cache-and-short-window-history).

Chat helper admission in `src/server/responses/core.ts` follows the
[deferred stored-main contract](providers/openai-tiers.md): only a needed Direct OpenAI helper
claims stored main, after terminal vision, routed vision and search exclusions.

The management quota DTO keeps Combo editing aligned with scoped inference evidence;
see [Combo editor routing quota](gui-and-management-api.md#combo-editor-routing-quota).

## Paginated history writer boundary

`src/codex/history-provider.ts` refuses external writes to paginated or migration-capable history. `src/codex/inject.ts` checks affected rows and manifest-owned restore targets before artifact changes and compensates detected migration. Failed config restore stops later catalog/history work. See the [history writer contract](codex-home.md#paginated-history-writer-boundary) for guarantees and concurrent-writer limits.

Claude replay carries [Go conversation affinity](data-planes/inbound-compat.md#claude-affinity-at-final-go-dispatch)
privately to final dispatch; preliminary route selection does not inject Go-only headers.
