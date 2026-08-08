# Catalog And Subagents SOT

## Shared catalog

`src/codex/catalog.ts` builds a shared Codex-shaped catalog for CLI, TUI, App, and SDK. It:

- preserves native OpenAI entries from the live catalog or static fallback, and emits
  gpt-5.6 natives from the pinned upstream models.json snapshot
  (`src/codex/data/upstream-models.json` — exact per-slug ladders: luna has no ultra);
- clones a native template for routed `provider/model` entries;
- forces strict Codex catalog fields required by the current parser;
- hides `disabledModels` without blocking direct routing (routed provider ids are excluded;
  account-qualified native ids hide only that selector row; BARE native slugs hide the bare row
  and all account-selector clones and drop that model family from raw `/v1/models`);
- applies exact provider/model compatibility exclusions after live discovery and metadata
  augmentation, so upstream-advertised but uncallable rows never enter dashboard or Codex pickers;
- strips native-only service tier and WebSocket metadata unless explicitly enabled;
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

## Startup readiness

Each `startServer` invocation owns a private, one-shot readiness gate created before the listener
binds. `handleStart` supplies its gate and transitions it after the shared catalog sync settles.
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
base instructions, modalities, auto-compact fields, and strict parser booleans. The public slug and
display name use `provider/model`.

## Native passthrough

Native bare OpenAI entries form one `openai` group. The provider's Pool(default)/Direct option
changes account selection without changing those ids; `openai-apikey/<model>` creates the separate
API-key identity. The API GPT-5.6 rows use 1,050,000 context / 922,000 max input; their `*-pro` virtual rows
rewrite to the base upstream model with `reasoning.mode: "pro"` while public state keeps the virtual
slug. Routed non-OpenAI models must not
inherit native-only service tier or WebSocket metadata unless the user explicitly enables that
capability. Detailed invariants live in [`08_openai-provider-tiers.md`](08_openai-provider-tiers.md).

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

## Multi-agent surface mode (3-state)

`OcxConfig.multiAgentMode` controls the `multi_agent_version` field stamped on catalog entries:

| Mode | Behavior |
| --- | --- |
| `"v1"` | Force ALL entries to `multi_agent_version = "v1"` — overrides upstream pins (sol/terra included). |
| `"default"` (install default) | Respect upstream model pins (sol/terra=v2, luna=v1, others=null → codex feature flag decides). On sync, stale forced values are cleared and upstream pins restored. |
| `"v2"` | Force ALL entries to `multi_agent_version = "v2"` — overrides upstream pins (luna included). |

The override is applied as a final pass in both `buildCatalogEntries` (live `/v1/models` path) and
`mergeCatalogEntriesForSync` (on-disk sync), AFTER all normalization and visibility processing. This
ensures `normalizeRoutedCatalogEntry` (which deletes `multi_agent_version` from routed entries) does
not clobber the forced value.

CLI: `ocx v2 mode v1|default|v2`. GUI: segmented control on the Models page. API: `GET/PUT /api/v2`
with `multiAgentMode` field.

The `multi_agent_v2` feature flag and the logical maximum thread count are separate from
`multiAgentMode` (`src/codex/features.ts`): the mode decides which surface Codex advertises, while
the flag and thread count decide what the native runtime allows.

## Ultra reasoning level

Ultra is always advertised in the catalog regardless of the `multi_agent_v2` toggle. The v2 toggle
controls only the multi-agent collab surface, not ultra visibility. The `nativeEffortClamp` function
wire-clamps ultra/max to each model's real top rung (e.g. gpt-5.5 ultra → xhigh on the wire).

`effortCap` and `subagentEffortCap` are hard ceilings applied on the V2 path
(`src/server/effort-policy.ts`): they lower or preserve the requested effort rather than rejecting
the request, and they never raise it.

[Decision Log]
- 목적과 의도: bare `defaultModel` selectors that route into third-party providers must keep their
  adapter-owned effort ladder; only true ChatGPT-native requests should receive the mock-max repair.
- 기존 구현 및 제약 조건: `nativeEffortClamp` already needed the original request id because
  routing strips `provider/`, but bare third-party selectors like `glm-5.2-fast-preview` still look
  native after that strip.
- 검토한 주요 대안: (1) infer nativeness from the bare slug prefix alone, (2) gate clamping by the
  resolved provider identity, (3) disable the clamp for all off-snapshot slugs.
- 선택한 방식: request-time clamp entry is allowed only when the resolved route is the canonical
  built-in OpenAI/Codex forward provider and the original request id is still bare.
- 다른 대안 대신 이 방식을 선택한 이유: provider identity is the only durable signal that
  distinguishes true native ChatGPT traffic from third-party `defaultModel` routes when both share a
  bare model id shape.
- 장점, 단점 및 영향: preserves `gpt-5.5 max -> xhigh` repair for native traffic, removes false
  clamps for bare routed models, and keeps adapter-specific effort mapping as the single source of
  truth for third-party providers.

## Subagents

Codex `spawn_agent` advertises only the highest-priority first five picker-visible catalog rows.
Use at most five configured `subagentModels` ids; they may contain bare catalog ids, routed
`provider/model` ids, or exact account-qualified `<selector>/<native-openai-model>` ids. The
dashboard offers bare native and routed choices; exact account-qualified choices are configured
through `ocx agent subagents set` or the opencodex configuration.

When account selectors are active, one featured bare native id expands into a complete selector row
group. Catalog priorities use the selector count as a stride so each group stays together without
widening Codex's five-row advertisement window. Startup seeds bare native GPT defaults only when
`subagentModels` is unset; an explicit empty list persists.

Quota-aware fallback walks a configured chain when the featured model is exhausted, probing
availability on a bounded interval (default 60 s, `src/codex/subagent-model-fallback.ts`). It rewrites
the requested model id only; effort remains owned by the caps described under
[Ultra reasoning level](#ultra-reasoning-level).

`injectionModel` and `injectionEffort` are shared selections with two independent consumers.
`multiAgentGuidanceEnabled` controls only OpenCodex-authored delegation guidance.
`syncCodexSubagentDefaults` is a separate, default-off opt-in that applies the selected values to
Codex's native `[agents]` defaults on sync/restart for newly created Codex tasks when OpenCodex owns
the active Codex routing; external user-managed provider configs remain untouched. It does not itself
cause delegation. The TOML edit owns only marker-tagged values, preserves existing unmarked
user-owned `[agents]` defaults rather than overwriting them, and rejects ambiguous table shapes
without changing the file.

Claude Code `ocx-*` agent definitions consume the same effective `claudeCode.blockedSkills` policy
as inbound bundle elision. When the list is non-empty (default: `claude-api`), generated definitions
whose marker-stripped model resolves to a routed id receive a preventive instruction not to invoke
those skills. Direct `provider/model` selectors are routed even when their inbound resolution is
identity. The only unguarded `ocx-self` case is an identity-resolved `claude|anthropic` model while
native passthrough is enabled; `modelMap` claims and `nativePassthrough:false` restore the guard. The
guard avoids creating oversized skill messages before the proxy can intervene; inbound elision remains
the fallback if a client still sends a blocked bundle. An explicit empty list disables both routed-model
behaviors.
