# 010 — Provider & Model Aliases

Status: design proposal (no code). Scope: config schema, request-time resolution, catalog exposure, management API, CLI, GUI.

## Motivation

X feedback: "add customized model name, since some model names can be very long." Real routed slugs today are things like `google-antigravity/gemini-3-pro-preview-11-2025` or `openrouter/anthropic-claude-opus-4.6`. Users type these into Codex's model picker, `/model`, CLI flags, and combo targets. A short, user-chosen alias (`agy/opus`) removes friction on every one of those surfaces. Combos already prove the concept: `OcxComboConfig.alias` (src/types/config.ts:626 area, src/combos/types.ts:43) gives a combo a public short id that resolves at request time. This design generalizes that to providers and individual models.

## Current behavior (verified)

- `OcxCustomModel.displayName` exists (src/types/config.ts:190) and combo `displayName` (src/types/config.ts:626). Both are display-only: src/codex/catalog/effort.ts:118-124 sets `entry.display_name` and explicitly never touches routing.
- Combo aliases are the only *resolvable* aliases today: `comboPublicModelId` (src/combos/types.ts:76), uniqueness + reserved-namespace validation (src/combos/types.ts:123-165), resolved in `routeModelInternal` before provider namespaces (src/router.ts:627-636).
- Request routing order in `routeModelInternal` (src/router.ts:558-706): policy namespace → Codex account namespace → combo alias → explicit `<provider>/<model>` for a *configured* provider name → bare native OpenAI family → provider `defaultModel` match → known-model-pattern → provider `models` list → `defaultProvider` fallback.
- Codex-facing slugs are `routedSlug(provider, id)` with inner slashes encoded to `-` and an exact bijective decode against known ids (src/providers/slug-codec.ts:28-82).
- Live-catalog providers (`liveModels: true`, src/providers/registry.ts:165; e.g. openrouter with 400+ models) have model ids that never appear in static config — any per-model alias store must key by model id on the provider, not by config model rows.
- Provider names are validated by `isValidProviderName` (src/config/provider-name.ts:15) with `RESERVED_PROVIDER_NAMES` (prototype-pollution guards + system namespaces).

## Design

### Config schema

```jsonc
{
  "providers": {
    "google-antigravity": {
      "alias": "agy",                       // NEW: provider alias (id-shaped, no "/")
      "modelAliases": {                     // NEW: per-model aliases keyed by NATIVE model id
        "gemini-3-pro-preview-11-2025": "g3p"
      },
      "defaultAliases": true                // NEW: opt into built-in alias set for this provider
    }
  },
  "defaultModelAliases": true               // NEW: global opt-in, applied across ALL providers
}
```

Field semantics:

- `providers.<name>.alias?: string` — one alias per provider. Must pass `isValidProviderName` (same pattern, same reserved set) and must not equal any configured provider name, any other provider's alias, `policy`, `combo`, or a Codex account namespace. Validated at config load and at the write API.
- `providers.<name>.modelAliases?: Record<string, string>` — native model id → alias. Keys are native ids (may contain "/", e.g. openrouter's `anthropic/claude-opus-4.6`), matching the `modelContextWindows` / `modelCosts` convention (src/types/provider.ts:272-296). This is why it lives on the provider and not on model rows: live-catalog models have no config row, but a Record keyed by id survives catalog refresh untouched.
- `providers.<name>.defaultAliases?: boolean` and top-level `defaultModelAliases?: boolean` — enable the built-in alias set per provider or globally. Per-provider value wins over global when both are set. Default: off (aliases are additive surface area; opt-in keeps zero behavior change).
- Alias value pattern for models: `^[A-Za-z0-9][A-Za-z0-9._-]*$`, no "/". A model alias is always used as the segment after the provider segment (or bare, see resolution), so it must be slash-free — same constraint custom-model `displayName` already enforces (model-routes.ts:407).

### Built-in default alias set

Shipped in code as a new module `src/providers/default-aliases.ts`:

```ts
/** Native-model-id pattern -> alias. First match wins; ordered most-specific first. */
export const DEFAULT_MODEL_ALIASES: ReadonlyArray<{ match: RegExp; alias: string }> = [
  { match: /^claude-opus-5/, alias: "opus" },
  { match: /^claude-sonnet-5/, alias: "sonnet" },
  { match: /^claude-haiku/, alias: "haiku" },
  { match: /^gemini-3(\.\d+)?-pro/, alias: "g3p" },
  { match: /^gemini-3(\.\d+)?-flash/, alias: "g3f" },
  { match: /^deepseek-v4/, alias: "ds4" },
  { match: /^grok-4/, alias: "grok" },
  // ...curated, extended over releases; also matches after stripping a vendor prefix
  // ("anthropic/claude-opus-5" on openrouter matches the opus rule).
];
```

Vendor-prefixed ids (aggregators) are matched against both the full id and the segment after the last "/". Built-ins are patterns, not exact ids, so snapshot suffixes (`-20260115`) keep their alias across provider refreshes. Precedence: user `modelAliases` entry > built-in rule. Within built-ins, when two models on the SAME provider both match one rule (e.g. two opus snapshots), the built-in alias binds to none of them — ambiguity disables the built-in for that provider and the models list shows a hint; the user resolves it with an explicit `modelAliases` entry. Deterministic and safe over "latest wins" guessing.

### Request-time resolution

Two hook points in `routeModelInternal` (src/router.ts), not one — the qualified and bare forms live at different depths of the existing resolution ladder:

- **Qualified (`head/tail`) aliases** extend the explicit provider-namespace step (src/router.ts:640-665): when the head matches no configured provider name, try provider aliases before falling through; within a resolved provider, when the tail matches no known id/encoded slug, try model aliases. This stays below combo aliases (src/router.ts:627-636), so any name a combo already claims keeps its current meaning.
- **Bare model aliases** are a LATE step: after every existing bare-resolution step (native OpenAI family, provider defaultModel, known-model pattern, provider models list — src/router.ts:672-698) and immediately BEFORE the `defaultProvider` fallback (src/router.ts:699-703).

One deliberate, documented behavior change follows from the bare-alias slot: a bare id that today reaches the `defaultProvider` fallback resolves via alias instead when it matches an enabled one. This only triggers for alias values the user defined (or a built-in set the user explicitly turned on), which is exactly the intent of defining the alias; the design accepts this as opt-in shadowing of the fallback, and the collision rules below keep aliases from shadowing anything that resolves earlier in the ladder.

Rules for an incoming model id `X`:

1. If `X` contains "/": split at the first "/". Resolve the head as a provider: exact configured-provider name first, else a provider whose `alias` matches. Resolve the tail within that provider: exact known model id / encoded slug first, else a `modelAliases` value match, else an enabled built-in alias match. `agy/opus` → provider `google-antigravity`, model `claude-opus-5-...` — resolved in one pass, both segments may be aliases independently. Note the current slash-path already has partial-match fallbacks (src/router.ts:659-665), so "exact first" describes ordering within the extended step, not a claim that the whole step is untouched.
2. If `X` is bare (no "/"): existing steps run first (native OpenAI family, provider defaultModel, pattern, models list). If ALL miss, a bare model alias resolves — ahead of the `defaultProvider` fallback (src/router.ts:699-703) — iff exactly one enabled (provider, model) pair carries that alias; two providers sharing alias `opus` make the bare form an error listing both candidates ("model alias 'opus' is ambiguous: agy/opus, claude/opus"), while the qualified forms keep working. A bare provider alias alone never routes.
3. Aliases resolve for main requests, combo target strings, and subagent model fields — anywhere `routeModel` runs. Resolution happens once, before adapters; upstream always receives the native id. Usage logs and request logs record the native slug plus a `requestedAlias` field so log rows stay joinable.

Collision rules (validated at write time, enforced again defensively at load):

- Provider alias vs real provider name: rejected (409 from API, config-load warning + alias ignored for hand-edited config).
- Provider alias vs another provider alias: rejected.
- Model alias vs a real model id on the same provider: rejected for user-set; built-in rule silently skipped (catalog drift must not break startup).
- Two models on one provider with the same user alias: rejected at write time (last write loses, 409 "alias already used by <id>").
- Case sensitivity: aliases are stored as typed but matched case-insensitively. Rationale: aliases are typed by hand (the whole point is typing less), so `Opus`/`opus` diverging silently would be a trap; the reserved-name guard already normalizes with `name.toLowerCase()` (src/config/provider-name.ts), and matching follows that convention. Two aliases differing only by case collide.

### Catalog exposure (/v1/models and Codex catalog)

Two options considered:

- (a) Alias replaces the id: shortest picker entries, but breaks log/usage continuity, breaks any client that persisted the old slug, and makes disabledModels/selectedModels matching ambiguous.
- (b) Alias as an additional resolvable id; display uses alias: canonical slug `provider/model` stays the row id everywhere; the catalog row gains `display_name` = `alias` (provider-alias-qualified: `agy/opus`) via the existing display_name path (src/codex/catalog/effort.ts:118-124); /v1/models additionally lists the alias id as its own entry marked `"alias_of": "google-antigravity/claude-opus-5"` so scripted clients can request it directly.

Recommendation: (b). Persistence (selectedModels, disabledModels, combos, usage) keeps canonical slugs only; aliases are a resolution/display layer that can be renamed or removed without touching stored state. `slugEquals` and the visibility filters (src/codex/catalog/provider-fetch.ts:1555-1577) are unchanged.

### Management API

- `PUT /api/providers/:name/alias` body `{"alias": "agy"}` → `{"ok":true,"provider":"google-antigravity","alias":"agy"}`; `{"alias": null}` clears. 409 on collision with `{"error":"alias conflicts with provider 'x'"}`.
- `PUT /api/providers/:name/model-aliases` body `{"set": {"gemini-3-pro-preview-11-2025": "g3p"}, "remove": ["old-id"]}` → `{"ok":true,"aliases":{...}}`. Partial-update semantics like other model-keyed Records; 409 per-entry collisions reported as `{"error":"...","conflicts":[{"alias":"g3p","heldBy":"..."}]}`.
- `PUT /api/default-aliases` body `{"enabled": true, "provider": "openrouter"}` (provider omitted = global) → `{"ok":true}`.
- `GET /api/aliases` → effective view: `{"providers":{"google-antigravity":"agy"},"models":{"google-antigravity":{"gemini-3-pro-preview-11-2025":{"alias":"g3p","source":"user"}}},"defaults":{"global":false,"providers":{"openrouter":true}},"ambiguousBuiltins":{"claude":["opus"]}}`. The GUI and CLI both read this one endpoint.
- All writes go through `saveConfigPreservingClaudeCode` and end with `convergeCodexCatalog()` like the existing model routes (model-routes.ts:172, 277-279), so display_name changes reach Codex on the next turn.

### CLI

Namespace: `ocx alias` (top-level; aliases span providers and models, and `ocx models` is already eight subcommands deep — src/cli/models.ts:415).

```
ocx alias list [--json]                          # effective table: kind, target, alias, source (user|builtin)
ocx alias set <provider> <alias>                 # provider alias:  ocx alias set google-antigravity agy
ocx alias set <provider>/<modelId> <alias>       # model alias:     ocx alias set openrouter/anthropic/claude-opus-4.6 opus
ocx alias rm <provider>[/<modelId>]              # clear
ocx alias defaults on|off [--provider <name>]    # built-in set, global or per provider
```

`<provider>/<modelId>` splits at the FIRST "/" (provider names cannot contain "/"); the remainder is the native id, slashes included. Implemented in `src/cli/alias.ts` following the models-runtime.ts pattern (runtimeRequest against the management API, offline config fallback like `ocx models add`).

### GUI

- Models window (gui/src/pages/Models.tsx): pencil icon after the provider group header sets the provider alias; pencil on each model row sets/clears the model alias (inline edit, Enter saves, shows 409 conflicts inline). Rows show `alias · canonical-id` with alias emphasized.
- Provider header overflow menu gains "Use default aliases" toggle (per provider); a global toggle sits in the Models window toolbar next to the existing visibility controls. Built-in-derived aliases render with a subtle "auto" badge; clicking one pre-fills the edit field to promote it to a user alias.
- Bulk view: toolbar "Aliases" button opens a filterable table (provider, model, alias, source) with inline editing — the GET /api/aliases payload verbatim.

## Resolution & edge cases

- Catalog refresh: `modelAliases` keys pointing at ids no longer discovered are kept (snapshot churn is temporary); `GET /api/aliases` marks them `"stale": true` and the GUI dims them. Nothing auto-deletes user intent.
- Export/import: aliases live inside config.json, so existing config export/import carries them. Client config export (`/api/client-config`, ocx export) emits canonical ids; a follow-up may add `--use-aliases`.
- Combos: combo target strings may use aliases (resolved through routeModel); the combo `alias` field itself is unchanged and keeps winning at its earlier resolution slot. Collision checks are bidirectional: a provider/model alias colliding with an existing combo alias is rejected at write time, and combo alias validation (src/combos/types.ts:123-165) gains the mirror check against existing provider/model aliases.
- Native OpenAI models: bare native family ids (src/router.ts:672) resolve before alias lookup, so a built-in alias can never shadow `gpt-5.6-sol`; a user alias equal to a native family id is rejected (same guard combos apply via nativeAlias, src/combos/types.ts:146-152).
- Codex account namespaces resolve before aliases (src/router.ts:598); an alias equal to a configured account namespace is rejected.
- Renaming a provider (config key change) orphans its alias with it — aliases are stored inside the provider object, so they move or die with the provider entry atomically.

## Migration & compatibility

- No migration: all fields optional, absent = today's behavior exactly. Old binaries reading a new config ignore unknown keys (config parse is tolerant; `safeConfigDTO` should include the new fields for the GUI).
- Requests by canonical slug are untouched at every step — alias resolution only runs where today's resolution would already have missed or after exact matches fail. The one intentional exception is the bare-alias-over-defaultProvider shadowing documented in Request-time resolution above.

## Out of scope

- Aliases for combos (exists), policies, or Codex accounts.
- Alias-based filtering in usage/cost summaries (logs store canonical + requestedAlias; summary UX later).
- Per-client alias sets (different aliases for Claude Code vs Codex).

## Open questions

1. Should /v1/models list alias entries as separate rows or only annotate? Proposed: separate row with `alias_of`, gated behind a query param `?aliases=1` initially to avoid confusing existing clients. Default recommendation: annotate-only in v1, separate rows once a client asks.
2. Bare model alias (`opus` with no provider) — allow when globally unique? Proposed: yes (rule 2 above); it is the highest-value typing shortcut and the ambiguity error is deterministic.
3. Built-in alias list curation cadence — proposed: update alongside the provider registry in normal releases; no runtime fetch.
