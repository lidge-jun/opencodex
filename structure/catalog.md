# Model Catalog

Native result continuations and function-result injection follow [the mode-specific result and control contract](transports/streaming-health.md#experimental-native-function-result-injection); this surface does not infer upstream support or alter its defaults.
Explicit Codex CLI installation observation supplies no selected-runtime proof to catalog discovery or publication. See the [read-only observation contract](runtime.md#explicit-codex-cli-installation-observation).

Native steering follows [the shared WebSocket contract](transports/streaming-health.md#experimental-native-mid-turn-steering); this surface's defaults remain unchanged.

Catalog discovery remains separate from the Responses final-route
[core module ownership](transports/responses.md#core-module-ownership). This surface retains its existing behavior.

The configuration-only [plaintext V2 contract](subagents.md#plaintext-v2-agent-messages)
is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged. CLI installation inspection reason codes, including Windows deferral, follow the [runtime inspection contract](runtime.md#lifecycle).

Shared parsing and streaming follow the [request-copy](transports/byte-accounting.md#request-copy-accounting) and [stream-buffer accounting](transports/byte-accounting.md#stream-buffer-accounting) contracts. Response-attached WebSocket telemetry follows the [stage record identity contract](transports/responses-wire-shapes.md#passthrough-sse-stream-shapes-314).

## Remote catalog HTTP proxy routing

`src/codex/catalog/remote.ts` permits loopback HTTP only when Bun fetch has no effective HTTP proxy or a matching NO_PROXY bypass. Its local matcher follows [Bun fetch semantics](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/dotenv/env_loader.rs#L369), including non-empty lowercase-variable priority, ASCII whitespace, literal host/port comparison and bracket-preserving IPv6. It does not normalize URL-shaped bypass entries, paths, wildcard prefixes, trailing dots or Unicode whitespace, and leaves the broader WebSocket proxy grammar unchanged. It refuses before authentication headers and fetch with a content-free `insecure_http_refused` error. ALL_PROXY and HTTPS-only settings do not affect HTTP acquisition; HTTPS and existing redirect, size, validation and coordinated-installation contracts are preserved. `tests/codex-integration/catalog-remote-pull.test.ts` covers these routing and non-disclosure boundaries.

Accounts added through the [Orca import](codex-home.md#orca-source-owned-account-import) remain
validation-pending. Import alone supplies no entitlement evidence for the model catalog.

## Shared catalog

Static policy and observed catalog evidence are separate authorities.
`src/providers/resolved-model-policy.ts` resolves and freezes only registry/operator static facts,
hard wire pins, aliases, and explicit false/empty declarations. Discovery responses, generated
metadata, cache freshness, availability, credentials, account state, quota and health never enter
that result. A catalog consumer may pass observed context, max-input, or max-output values to the
resolver's call-local limit projection; the lower observed/static value wins, and an observed value
may fill an absent static one only inside that call-local projection — the frozen static policy is
unchanged and never widened — max input never exceeds the resolved context window, and the
projection mutates neither input. Gather admission freezes an enriched provider
snapshot before discovery; per-model hint projection resolves from that snapshot, so no post-admission
registry read can change a running gather flight.

Policy is keyed by the final upstream wire model. Public alias and virtual-model identities remain
diagnostic/catalog provenance and must be resolved before policy capture. Exact nonempty explicit
input-modality declarations outrank the registry/config modality map; an empty declaration
falls through to that map.
Anthropic numeric point releases inherit the nearest configured family context window before the
provider-wide fallback. Exact model output limits precede the provider default output limit.

`src/codex/catalog.ts` builds a shared Codex-shaped catalog for CLI, TUI, App, and SDK. It:

- preserves native OpenAI entries from the live catalog or static fallback, and emits
  gpt-5.6 natives from the pinned upstream models.json snapshot
  (`src/codex/data/upstream-models.json` — exact per-slug ladders: luna has no ultra);
- reads pinned native rows only through `pinnedNativeModelRows()`
  (`src/codex/catalog/pinned-models.ts`): the codex-rs snapshot first, then rows from
  `src/codex/data/roster-pinned-models.json` whose slug the snapshot lacks. The roster file holds
  verbatim authenticated-roster rows for models codex-rs has not bundled yet (`gpt-6-sol`,
  `gpt-6-luna`, captured 2026-09-23 at `client_version=0.155.0`), so a wholesale snapshot re-pin
  never erases them and a snapshot row for the same slug always wins;
- excludes retired `gpt-5.3-codex-spark` from native fallback, observed/cache rows, and
  account-selector projections, including retained sync and native restore;
- upgrades either an observed selector-qualified `*/gpt-daybreak-blue-latest` account row or an
  explicitly configured canonical `openai/gpt-daybreak-blue-latest` Codex-forward row from the
  pinned Sol capability metadata while preserving its selector and Daybreak wire identity;
  this never expands the bare/API-key model lists or rewrites the wire model to `gpt-5.6-sol`;
- clones a native template for routed `provider/model` entries without its `comp_hash`, and resets
  that value on opencodex rows kept from disk while their provider's discovery is degraded, so these
  rows carry the fixed `"opencodex"` marker instead of whichever native row a rebuild found first;
  Codex compacts a thread whenever that value changes (#5796). Codex-forward aliases keep their
  native value and rows written by other tools keep theirs;
- forces strict Codex catalog fields required by the current parser;
- hides `disabledModels` without blocking direct routing (routed provider ids are excluded;
  account-qualified native ids hide only that selector row; BARE native slugs hide the bare row
  and all account-selector clones and drop that model family from raw `/v1/models`);
- applies exact provider/model compatibility exclusions after live discovery and metadata
  augmentation, so upstream-advertised but uncallable rows—including retired aliases retained in
  generated metadata for historical accounting—never enter dashboard or Codex pickers;
- strips native-only service tier and WebSocket metadata unless the final routed provider/model
  explicitly enables the verified OpenAI-compatible service tier;
- backs up the pristine catalog once per catalog: the copy is keyed by a hash of the catalog path
  (`catalog-backup-<id>.json`), and the legacy unsuffixed `catalog-backup.json` is retained in
  addition for the default catalog, so a restore resolves the backup for the catalog it is restoring
  rather than assuming a single file; restoration omits retired bare and trusted account-qualified
  native rows from the output without rewriting the pristine backup or unrelated snapshots;
- invalidates `$CODEX_HOME/models_cache.json` when model visibility changes.

Per-catalog hashed backups are recorded only after `src/codex/catalog/parsing.ts` writes or `src/codex/internal/catalog-writer.ts` publishes a new one;
preserving an existing file never registers it, even when its deterministic name or bytes match. Retained sync initializes metadata in an empty
root before publication without claiming the hashed path, and publication attempts to record ownership before temporary-file cleanup, whose errors stay visible;
a root with missing or invalid ownership metadata leaves the new backup unregistered, so uninstall reports it as a residual.
Recorded paths keep their ownership; unrecorded pre-ledger backups remain residuals (after stopping OpenCodex and any needed restore, review and
archive those exact paths, then remove only confirmed obsolete backups, never by glob). Legacy fixed-name manifest entries are not migrated by
this rule, and uninstall keeps the [manifest validation and residual reporting contract](config.md#restore).

Cache invalidation reports an unchanged derived cache separately from a failed rewrite. `ocx sync-cache` treats identical bytes as a successful no-op, preserving the cache mtime and avoiding a needless app-server restart; malformed catalogs and write failures remain errors.

`src/codex/catalog/model-visibility.ts` also excludes models owned by disabled providers, including custom rows. `src/codex/catalog/routed-gather.ts` does not inherit provider configuration into custom rows while that provider is disabled.

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

Custom Astra and Daybreak rows acquire native identity -- Responses Lite, multi-agent, context
windows, display names -- only through the canonical `openai` forward destination and explicit
capability-source predicate. Catalog-advertised reasoning lists are a narrower bound: when a
custom row's model id has pinned native capability metadata, the shared producer intersects an
explicit declared ladder with that pinned list even on an arbitrary gateway such as
`YYLJ/gpt-6-astra`. Desktop validates the model id, so `none` and `minimal` must not survive on
those catalog rows. An explicit empty list remains empty; a nonempty incompatible list falls back
to the native default singleton. A default must belong to the projected list. Full native identity
is still not inferred from a GPT name. Stored configuration and native capability maps are
unchanged. Request-time native effort clamps remain canonical-forward only.

The observed-state merge tracks the current invocation's freshly generated custom row objects
after detaching its inputs. Those rows already own their complete reasoning projection, so the
merge does not append `max` again. This also keeps a generic none-only custom row none-only;
ordinary retained provider rows still receive the existing mock-tier policy. A persisted custom
marker alone never grants this exemption. Both gather entry points, retained sync, management
convergence and direct Codex model discovery use the same producer. The legacy runtime effort
union clamp remains separate; it is not a per-model or per-client-version grammar oracle.
Before combo derivation, an explicit custom-model context, modality, reasoning, or
tool-mode declaration overlays the matching provider member in the private combo input map. This
keeps a combo's advertised intersection aligned with the final custom row without changing the
provider-native row or inventing capabilities for other models. Public custom-row materialization
and routed-slug deduplication remain the final catalog owner's responsibility.
Codex's native `ultra` mode is preserved and is not a literal API wire promise.

Selector decode hints are identity evidence and nothing else. `knownModelIdsForProvider` unions
the configured models, the registry's static list, the native ids the registry's classified
model-keyed maps name (`src/providers/registry/model-ids.ts`), the last-known-good discovery
cache and custom model ids, so an id declared only in a policy map still round-trips through an
encoded selector. A hint publishes no catalog row, grants no availability or entitlement and
confers no transport authority: the registry transport identity is checked before hints are
read, and an ambiguous selector is still rejected rather than guessed.
When account selectors are enabled, the sync path may also observe exact, visible, API-supported
OpenAI-family ids from Codex's user-owned catalog/cache. Only rows with native catalog provenance
are trusted; unknown ids are carried through startup cache invalidation as hidden observations and
are emitted only as selector-qualified rows whose account provenance matches. They never expand
the bare native or API-key model list. This keeps account-scoped upstream ids such as
`gpt-daybreak-blue-latest` callable without treating them as a static release allowlist.

Configured natives are the operator's way to widen that bare list without a release. A bare
`gpt-*` id under `providers.openai.models` on the canonical Codex forward provider joins
`NATIVE_OPENAI_MODELS` / `SUPPORTED_NATIVE_OPENAI_SLUGS` in place (`src/codex/catalog/native-models.ts`),
and `metadata.ts` keeps its pinned-capability, upstream-entry and context tables in step through
a subscription. Each borrows the pinned `gpt-6-sol` row under a name generated from its slug, takes
the GPT-6 272,000 / 872,000 context pair (`NATIVE_GPT6_CONTEXT`, also used by the built-in GPT-6
rows), and is never account-gated. Built-in, retired and reserve ids never register. The filter
lives in `src/config/derived-registries.ts`, whose `refreshConfigDerivedRegistries` runs on every
load, persist and reconcile path, so every process that loads config sees the same set; removing
the id unregisters it and the next canonical write drops the row. Configured natives are not in
`ENTITLEMENT_PREFERRED_NATIVE_OPENAI_MODELS` or `NATIVE_MAIN_DRAIN_SENTINEL_MODELS` (they behave
like `gpt-5.5` there), and a combo `nativeAlias` cannot target one because schema validation runs
before registration. Covered by `tests/codex-integration/configured-native-models.test.ts`.

Retirement is a catalog/evidence policy, not a universal request denylist. Manually supplied
model ids still follow generic routing. User-selected config and historical usage remain stored.

Account-gated native ids use authenticated ChatGPT `/models` rosters cached per credential generation with a bounded timeout.
A bare gated row requires a confirmed eligible account; a selector-qualified row requires its mapped account. Failed discovery
grants neither. The same snapshot gates Pool selection, so catalog and runtime use consistent account evidence.
The roster's per-model `available_access_programs` is projected separately: bare native rows use only confirmed main-account
metadata, and selector-qualified rows use only their mapped account. An object requires a valid `cyber` string array; malformed values under other program keys are omitted without losing that grant. Explicit `null` stays null; omission stays omitted.
Failed discovery or credential replacement removes stale access-program metadata. It changes presentation, not routing grants.

`client_version` arrives on the inbound request and is part of that cache identity, so
`src/codex/model-entitlements.ts` bounds the work as well as the state: stored versions per account, concurrent
roster flights per account, and distinct caller-selected versions admitted per account in one roster
window. Repeating a version already charged still retries on the failure TTL, and the locally
selected runtime version is never charged, so a legitimate refresh survives. Over the bound the
answer is unconfirmed, which hides the gated row rather than confirming a denial. Flight capacity
is checked before charging a distinct version, so a capacity refusal consumes no miss allowance.

The app-server's model list comes from this shared catalog, not from patching the App. Codex Desktop
may still apply its remote native-only allowlist after `model/list`; an explicitly configured combo
`nativeAlias` is the bounded compatibility path. It replaces one supported bare native row with a
routed, labeled row, routes the bare id before canonical OpenAI, and keeps account-qualified native
selectors genuine. Missing target discovery capabilities inherit the replaced native row's metadata,
while explicit target limits remain authoritative. Because the affected renderer ignores `visibility: "hide"`, the presence of any
native alias also omits disabled bare native rows from the effective catalog. Dashboard rows remain
derived from the static native set, and sync retains bundled/pristine native recovery sources so a
later re-enable or alias removal restores native metadata.

Without such an alias, a disabled bare native keeps a `visibility: "hide"` row, and that retention
has an operator-visible consequence. `visibleNativeSlugs` in `src/codex/catalog/metadata.ts` drops
the slug from `/v1/models` and the dashboard while `applyNativeVisibility` keeps the catalog row, so
a renderer that ignores `visibility` can still offer a model every other surface calls disabled.
Selecting it is not refused: `disabledModels` is a catalog control, and `src/router.ts` never
consults it, so the turn resolves by the ordinary routing rules instead of failing as disabled.
Retention is the deliberate trade — it preserves real upstream metadata for a later re-enable
rather than synthesizing a guess — and a `nativeAlias` combo is the lever that omits the row
outright.

Nothing in the catalog validates Codex's own root `model` pin against this exposed set;
`readConfiguredDefaultModel` in `src/codex/catalog/parsing.ts` reads the pin, and `ocx doctor`
reports it (see [Runtime](runtime.md)).

Provider live-model lists are cached with a configured TTL (`src/codex/model-cache.ts`). Adding,
deleting, or editing a provider's shape clears that per-provider cache; a disabled-only change
deliberately does not, because a disabled provider is already excluded from the catalog gather
instead. Codex's own `models_cache.json` is a different cache, invalidated by catalog refresh.
Account-scoped discovery transports remain bound to the credential snapshot that supplied the
token. Devin discovery uses the allowlisted tenant API base URL from that same snapshot rather
than pairing a durable account key with the provider registry's default host. The same holds for
the provider connection test and for refreshing catalog gathers of every OAuth row: the token and
its origin come from one snapshot, so a Copilot account switch or a refresh that moves the
account's API host cannot pair one account's token with another origin, and a key row never
borrows a stored OAuth account's origin. When the snapshot carries no API host (a legacy credential), the destination comes only from static configuration validated against the vendor allowlist, or the vendor default, and never from the live credential store. If the stored
destination is invalid, registered Devin discovery and routing use the registry's fixed base URL
instead of a stale configured override. For Devin, the irreversible roster fingerprint covers
both credential and validated destination, so switching either observes neither fresh nor stale
data recorded under the previous pair.
Entitlement-specific rosters (Qoder, Devin, Cursor, CodeBuddy) additionally bind their cache entry to an
irreversible credential fingerprint: a credential switch observes neither the fresh nor the stale
roster recorded under the previous credential, and a failed discovery's cooldown neither supplies
the previous credential's stale roster nor suppresses the next credential's first discovery.
Selector decoding uses the same authority boundary through `getRoutingCached`: it resolves a
credential only for a scoped entry, reads OAuth through the passive store observer, and rejects
unavailable or changed authority. Successful API-key selection commits clear the cache and revoke
in-flight publication; unrelated unscoped rows require no credential lookup.

A Devin live row spreads its measured `inputModalities` before
`catalogHintsFromProviderConfig`, so exact `modelCapabilities` declarations, the legacy
`modelInputModalities` record and the vision-sidecar rewrite keep precedence and the live
value survives only when none of them applies.

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

When the desktop app is explicitly restarted to reload synchronized state, [process membership](runtime.md#codex-desktop-process-membership) is determined from its installation path; catalog model selectors do not identify restart targets.

Each `startServer` invocation owns a private, one-shot readiness gate created before the listener
binds. `handleStart` supplies its gate and transitions it only after the shared catalog sync and
best-effort Claude Code roster reconciliation have both settled. The catalog sync remains the
authority for ready versus failed; a roster warning does not make an otherwise healthy proxy fail.
Calls without a supplied gate receive a fresh private gate that intentionally remains pending.
`ok: true` becomes ready; `null`, a throw, or `ok !== true` becomes failed. State is isolated per
server instance.

A nonempty catalog-sync `warning` does not become failed. `ok` is the sync's verdict on the
essential work (write admission and config injection); `warning` names a degradation of artifacts
in the local Codex home that the sync deliberately continued past — no catalog source, omitted
combos, a conversation-history relabel left to Codex's own writer, or a caught catalog-refresh
exception after which injection still runs. None of those stops the process from serving HTTP or
routing to a provider. Treating them as terminal is what #5181 reported: a single-replica
Kubernetes deployment lost its only Service endpoint while every non-Codex route stayed healthy.
This is the same boundary the Claude roster reconciliation already has, applied to the catalog sync.

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

Raw `/v1/models` rows advertise positive safe capacity values in both Cursor's nested
`capabilities` object and top-level discovery fields used by other clients. A model with a larger
opt-in context tier uses that effective long window in both shapes; invalid values are omitted.

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

GPT-6 Sol and Luna (announced 2026-09-22) are self-described the same way, from their roster-pinned
rows: labels `GPT-6-Sol` / `GPT-6-Luna`, 272,000 default context and 872,000 opt-in ceiling,
`medium` default. Sol ships low-through-ultra; Luna stops at `max`, and no path may add `ultra` to
it: `nativeLadderIncludesUltra` answers from the self-described row (or an alias's source row), so
`ensureGpt56ReasoningLevels` restores `max` everywhere but adds `ultra` only where the pinned row
ships it. Both are ungated flagships. `gpt-6-astra-minor` is an account-gated capability alias of
Astra with its own presentation (`GPT-6-Astra-Minor`); it has no pinned row of its own and stays
hidden and request-refused until an authenticated roster lists it.

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
- **An omitted Luna Reserve row explains itself once.** The Reserve projection is
  account-qualified (`<selector>/gpt-reserve`), so it cannot be written without a selector that
  targets the main Codex account, and a fresh authless install has an empty selector map. Because
  an omission has no row to carry a reason, catalog sync emits one warn-once line naming the
  cause — absent canonical OpenAI provider, explicitly disabled picker, empty selector map, or a
  map with no main-account target — and the action that restores it
  (`src/codex/catalog/reserve-warn.ts`). It is scoped to an install where authless Codex Desktop
  routing is effective, so an install that never opted in is never told about a Reserve row it
  did not ask for. An install that stores the flag where it cannot take effect is a different
  silence, reported as `inertReason` by `describeCodexDesktopSwitches` rather than repeated here.
- **Rotation is sticky.** A conversation stays on its selected account while that account is
  usable; failure moves it, success does not (`src/codex/pool-rotation.ts`).
- **A transient hold is probed half-open, never opened all at once.** While a bound account is
  held for a 5xx streak, one in-flight probe may test it and every other request keeps the
  remembered detour; the lease carries a deadline and a generation so a late answer from a
  probe that already lost cannot overwrite a newer binding or failure state. When every
  candidate is held the caller gets a typed withheld outcome, not a send. Recovery dispatches
  (retries and probes, never a new request's initial send) sit under a pool-wide ratio ceiling
  measured over a sliding window (`src/routing/probe-lease.ts`).

  Where that reaches production, because a primitive nobody calls bounds nothing: the two
  transient-hold branches of `resolveCodexAccountForThreadDetailed`
  (`src/codex/routing.ts`) ask `resolveHeldAccountDispatch` what this request may do and
  return a `withheld` resolution instead of selecting the failing account;
  `resolveCodexAuthContext` (`src/codex/auth-context.ts`) turns that into
  `CodexRecoveryWithheldError` before any upstream I/O, so a refused request reaches the
  client as a 429 carrying the limiter's own change point in `Retry-After`. A granted probe
  travels on the auth context, is settled by `recordCodexUpstreamOutcome` under the credential
  generation the binding held, and is handed back by `releaseCodexAuthContextProbeLease` on
  every path that never sends. The pool window observes demand at the initial passthrough send
  and gates the alternate-account replay through `classifyPoolRecoveryDispatch`, which lives
  with the window itself rather than in the transport: `src/server/responses/fetch-helpers.ts`
  owns no routing policy and `tests/responses/responses-fetch-helpers-boundary.test.ts` pins
  its runtime imports to three transport modules. Same-account transient retries remain bounded
  by the per-request send budget alone: refusing inside the retry helper's thunk would surface a
  pool refusal as a 502 transport failure and record a transient outcome against an account
  that was never asked, which is worse than the gap.

  This hold and the quota-cooldown probe (`src/codex/routing/probe-lease.ts`) are different
  domains one directory apart. They cannot both describe an account at once, because
  `isTransientOnlyAffinityBlock` refuses to recognise a transient hold on an account carrying
  quota health -- which is why no request ever pays two recovery permits for one send.
- **The credential store is generation-guarded.** A refresh takes a lock and persists only if the
  generation it started from still holds; a lost race raises a generation-conflict error rather
  than overwriting the newer credential (`src/codex/account-store.ts`). Callers handle that error;
  they do not assume a silent retry.
  The lock itself is identity-scoped: a not-yet-readable lock counts as held until it ages out,
  and release requires a usable matching descriptor identity. Unknown identity leaves the path
  for stale recovery without replacing the callback outcome when the path probe fails; confirmed-owner unlink errors other than `ENOENT` still propagate. Acquisition, stale reclamation and identity-checked release run inside the existing synchronous SQLite config-mutation transaction; the async refresh callback runs outside it. Release keeps the descriptor open through identity comparison and any unlink, then closes it. Failed metadata writes remove only a matching owned path after successful coordination; unknown identity, failed probes or unavailable coordination retain the path for stale recovery. Busy release coordination preserves the callback outcome and leaves the path for stale recovery. This serializes cooperating writers; stat/unlink is not atomic against non-cooperating filesystem writers.
- **Authentication identity, quota domain, and cache domain are tracked separately**
  (`src/routing/identity-domains.ts`). `classifyCredential` returns all three with provenance:
  `pool.credentialGroups` supplies operator-declared quota domains, a small built-in table
  supplies the provider-documented cases (OpenAI limits per organization and project and caches
  per organization and region, Anthropic cache per workspace, Azure per deployment), and every
  other answer is `unknown`. `unknown` is a first-class relation result, never silently read as
  shared or as distinct: `assessQuotaRotation` reports `same-domain` so a quota refusal is not
  answered by rotating inside the limit that refused, `countQuotaCapacity` counts one known
  domain once and reports unknown-domain credentials separately, and
  `canPortConversationState` keeps conversational-state portability a separate question from
  cache compatibility by refusing any request that carries `previous_response_id`, a
  provider-side conversation id, uploaded file ids, or encrypted reasoning. The classifier is groundwork that no routing boundary calls yet: it lands with its tests
  so the consuming layers can be reviewed one at a time. Until one of them wires it, declaring
  `pool.credentialGroups` changes no routing decision, and the rules above state the contract
  those consumers must honour rather than behaviour an operator can rely on today.
- **Proven separation and proven sharing are separate facts** (`src/routing/identity-domains.ts`).
  Every domain carries `evidence` alongside its provenance: a rule that documents only that two
  credentials are in different domains never lets an equal key mean "shared". OpenAI's cache rule
  is the case that forces it — caches are documented as not shared across organizations or
  regional processing boundaries, while no documentation states that two keys inside one
  organization do share a cache, so a different org or region relates `distinct` and the same org
  and region relates `unknown`. The absent promise is what withholds `shared` there, not a
  documented denial. OpenAI quota, Anthropic workspace cache, and Azure deployment domains carry
  the sharing half as well and still relate `shared`.
- **A declared credential group cannot mean two things** (`src/routing/identity-domains.ts`,
  `src/config.ts`). `credentialGroupIssues` is the one definition of a valid grouping: unique
  group ids, a non-empty member list, and each credential in at most one group, with members
  written `"<provider>:<credential-id>"` because ids are provider-scoped in the auth store. The
  config write path rejects a declaration that breaks any of those and the load path drops the
  list with a warning, keeping `pool.kernel` and `pool.cacheAffinity`. Validation diagnostics
  identify group and member positions without reproducing operator-supplied identifiers;
  `classifyCredential`
  reports an ambiguous claim on `declaredGroupConflict` and falls back to the documented or
  unknown answer rather than taking the first matching group.

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

The shared Responses path follows the [bounded multipart recovery contract](subagents.md#multipart-encrypted-task-recovery); credential admission and retry policy remain unchanged.

## Ultra reasoning level

Ultra is always advertised in the catalog regardless of the `multi_agent_v2` toggle. The v2 toggle
controls only the multi-agent collab surface, not ultra visibility. The `nativeEffortClamp` function
wire-clamps ultra/max to each model's real top rung (e.g. gpt-5.5 ultra → xhigh on the wire).

For routed models, `modelSuppressSyntheticMax` is a catalog-only per-model setting. A true value
prevents `src/codex/catalog/effort.ts` from adding a missing synthetic `max` and prevents
`src/codex/catalog/build-entries.ts` from repairing that missing rung during observed-state merge.
It never removes a provider-declared `max`, and `ultra` remains advertised. If the configured default
names a suppressed missing `max`, the catalog selects the highest real rung below it. A degraded sync
also preserves any `max` already recorded on disk: without persisted provenance OpenCodex cannot
distinguish an older synthetic rung from a real provider rung, so only a later healthy provider rebuild
can remove the former. Codex uses this same membership for the picker and explicit `spawn_agent`
effort validation; an explicit `max` spawn can therefore fail client-side before proxy wire clamping,
while retained `ultra` remains the supported harness path.

`effortCap` and `subagentEffortCap` are hard ceilings applied on the V2 path
(`src/server/effort-policy.ts`): they lower or preserve the requested effort rather than rejecting
the request, and they never raise it.

Combo dispatch reads the final target ladder through the same `supportedLadderFor` authority. An
explicit empty ladder means that target receives no effort control; an unknown ladder receives no
parent effort controls only when the combo opts into `reasoningEffortMode: "adaptive"`. Known
non-empty ladders continue through the existing per-target resolution.

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
model discovery or advertised ladders. Native Chat applies qualifying caps even without a
pin, and normalizes pinned values and values rewritten by a cap through provider wire
mapping. Without a pin or a cap rewrite, native caller values retain their original wire
spelling; the V1 and compaction cap exemptions are preserved.

> Decision record: [ADR-0023](decisions/ADR-0023-ultra-reasoning-level.md)

> Decision record: [ADR-0024](decisions/ADR-0024-ultra-reasoning-level.md)

> Decision record: [ADR-0025](decisions/ADR-0025-ultra-reasoning-level.md)

> Decision record: [ADR-0026](decisions/ADR-0026-ultra-reasoning-level.md)

Codex display-cache expiry, retained blocking main-policy evidence, and reset history follow the
[quota cache contract](providers/openai-tiers.md#quota-cache-and-short-window-history).

Usage consumers preserve positive incomplete-history metadata as specified in [usage accounting](dashboard-and-usage.md#usage-accounting); readable totals are not represented as a complete ledger. Upstream API-key usage follows the [physical-attempt account attribution contract](dashboard-and-usage.md#upstream-key-account-attribution), independently of subscription quota observations.

Connected CLI usage follows the [client-scoped hub usage contract](dashboard-and-usage.md#usage-accounting); local management and account data remain separate.

Remote Workspace uses a separate, explicitly enabled server surface with structural WebSocket callbacks and awaited per-server cleanup; [its contract](remote-workspace.md) owns that integration.

Listener startup diagnostics follow [the runtime lifecycle contract](runtime.md#lifecycle); malformed optional listener blocks follow [config loading](config.md#config-surface).
Chat helper admission in `src/server/responses/core.ts` follows the
[deferred stored-main contract](providers/openai-tiers.md): only a needed Direct OpenAI helper
claims stored main, after terminal vision, routed vision and search exclusions.

Account-qualified catalog routes bypass automatic plan exclusions while retaining credential and entitlement checks; see [automatic pool plan exclusions](providers/openai-accounts.md#automatic-pool-plan-exclusions).

The management quota DTO keeps Combo editing aligned with scoped inference evidence;
see [Combo editor routing quota](dashboard-and-usage.md#combo-editor-routing-quota).

Optional Codex transport-hint suppression is scoped to canonical Responses client output;
its defaults and exclusions are owned by [Responses transport](transports/responses.md).

Provider `showThinkingSummary` is a Responses request default; it does not rewrite catalog summary defaults or client configuration. See [Google summaries](providers/google.md).

Paginated and migration-capable history follows the [authoritative writer contract](codex-home.md#paginated-history-writer-boundary); this document adds no independent writer guarantee.

Codex pool settings and their consumers follow the [reset-first ordering contract](providers/openai-accounts.md#reset-first-account-ordering), including independent-quota fallback, preserved affinity, strategy-specific threshold summaries, and shared short-observation freshness for switch warnings.

Claude replay carries [Go conversation affinity](data-planes/inbound-compat.md#claude-affinity-at-final-go-dispatch)
privately to final dispatch; preliminary route selection does not inject Go-only headers.
Private pool credential metadata follows the [quota-history publication identity contract](providers/openai-accounts.md#quota-history-publication-identity); credential-only and account DTO projections omit it.

Pool quota producers and account commands follow the [bounded raw-observation contract](providers/openai-accounts.md#bounded-pool-quota-observations), separate from the latest display snapshot and capacity estimates.

The account history response can include a [low-confidence effective capacity estimate](providers/openai-accounts.md#observed-effective-token-capacity); usage normalization retains local-answer provenance so local responses cannot supply samples.

Account quota surfaces use [safe probe diagnostics](transports/inventory.md#account-quota-failure-diagnostics) separately from quota validity, credential health and routing authority.

Live sideband admission and its bounded upstream handshake follow the [runtime contract](runtime.md#live-sideband-handshake); the ordinary Responses WebSocket exchange remains separate.

## Provider-scoped approval reviewer

`src/codex/catalog/auto-review.ts` resolves exact case-preserving provider/model reviewer selectors against the final catalog in both retained sync and `src/codex/convergence.ts`. Valid per-model selection wins over valid provider-wide selection, then the root selector supplies fallback. Native root stamps retain the observed original value and applied selector bound to their slug; removal restores the original only while the applied value is unchanged. The native provenance remains after restoration so an equal provider reviewer cannot trigger legacy reclassification on the next sync. Ambiguous legacy unmarked catalogs retain their existing heuristic cleanup. Provider stamps do not change routing or credentials.

The [explicit model-capability contract](config.md#explicit-per-model-capability-declarations) preserves operator declarations through provider storage and catalog capture; it does not infer upstream capability or change this surface's routing behavior.

Exact [model input declarations](config.md#explicit-per-model-capability-declarations) now feed text-only eligibility and catalog hints; existing image-description/omission handling consumes them before the main upstream send.

## Renamed destination reasoning metadata

`src/providers/derive.ts` fills missing reasoning tables for renamed providers accepted by the existing fixed-key destination matcher. Model entries are cloned and explicit user entries (including empty arrays) win, matched case-insensitively. Provider-wide effort defaults fill only when undefined; Command Code unknown models therefore keep the registry's empty picker policy unless overridden. Identity, transport and other capability axes are unchanged. The gathered row drives client exports; this metadata contract does not prove arbitrary gateway routing.

Shared response-log retention and native SSE inspection pacing follow the [bounded inspection contract](transports/byte-accounting.md#response-log-inspection); other subsystem behavior remains unchanged.

Native steering retains fixed phase deadlines and reconciled replay output; see the [steering stability contract](transports/streaming-health.md#steering-deadlines-and-replay-completeness).

Native steering generation overrides, explicit public-API eligibility and the consent-gated wire probe follow the [shared control contract](transports/streaming-health.md#steering-settings-public-api-and-diagnostic-probe); this owner does not change routing or execute diagnostic tools.

Dashboard Fast-row persistence and client refresh follow the [Fast selector rows setting contract](gui-and-management-api.md#fast-selector-rows-setting).

Compaction routing selects its configured model at Responses ingress under the
[compaction routing contract](transports/responses-failover.md#compaction-routing-overrides). Catalog selection remains conversation-owned.
Subagent account previews and live routing share the [priority failback](providers/openai-accounts.md#ongoing-priority-failback) decision; model eligibility and fixed catalog selectors retain their existing meaning.

## Reasoning metadata refresh

Startup and explicit catalog synchronization in `src/codex/sync.ts` refresh the optional
`src/providers/reasoning-metadata.ts` effort snapshot for supported destinations before catalog
gathering. Each sync waits at most two seconds for a fresh or shared fetch, then continues with
the existing snapshot; the fetch retains its own abort deadline. Routed effort reads in
`src/reasoning-effort.ts` use a snapshot immediately and request a best-effort background refresh
only when an existing snapshot answers with an expired ladder. Missing or corrupt snapshots do
not fetch on the request path; catalog sync owns their bootstrap.
