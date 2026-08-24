# 030 — Latest-Only Default Preset per Provider

Status: design proposal (no code). Scope: shipped preset registry, preset mode semantics, reconciliation on upgrade, API/CLI/GUI.

## Motivation

Adding openrouter exposes 400+ models to Codex's picker on day one; adding an Anthropic provider exposes every historical snapshot (`claude-3-*` through current). The useful set is a handful of current flagships. Today the burden is inverted: the user must build `selectedModels` by hand from hundreds of rows. The default for a newly added provider should be a curated "latest/core" preset, with "everything" one click away.

## Current behavior (verified)

- Per-provider allowlist `providers.<name>.selectedModels` (src/types/provider.ts:262-268): non-empty = only these ship to the Codex catalog and /v1/models; empty/absent = all. Managed by `GET/PUT /api/selected-models` (src/server/management/model-routes.ts:531-562); PUT with an empty list deletes the allowlist ("all on", line 557-558).
- The admin `/api/models` list is deliberately unfiltered so pickers can offer the full set (provider.ts:266 comment).
- `deriveProviderPresets` (src/providers/derive.ts:346) exists but is a different concept — dashboard provider-setup presets (which providers to offer), not model curation. Naming must not collide; this design uses "model preset".
- Provider registry rows already carry curated static `models` arrays and per-model metadata (src/providers/registry.ts, e.g. ANTIGRAVITY_MODELS at line 1600), so a code-maintained per-provider list is an established pattern.
- There is no record of whether a user ever edited `selectedModels` — absence is indistinguishable from "user chose all". Preset reconciliation needs an explicit marker (below).

## Design

### Shipped preset registry

New module `src/providers/model-presets.ts`, keyed by registry provider id, values are ID PATTERNS so vendor snapshot suffixes don't stale the preset between releases:

```ts
export interface ModelPresetRule { pattern: RegExp; }
export const MODEL_PRESETS: Readonly<Record<string, { version: number; rules: ModelPresetRule[] }>> = {
  openrouter: { version: 3, rules: [
    { pattern: /^anthropic\/claude-(opus|sonnet)-[45]/ },
    { pattern: /^google\/gemini-3(\.\d+)?-(pro|flash)/ },
    { pattern: /^openai\/gpt-5/ },
    { pattern: /^deepseek\/deepseek-v4/ },
    { pattern: /^x-ai\/grok-[45]/ },
  ]},
  claude: { version: 2, rules: [
    { pattern: /^claude-opus-5/ }, { pattern: /^claude-sonnet-5/ }, { pattern: /^claude-haiku-4/ },
  ]},
  // ...one entry per high-volume provider; providers without an entry have no preset (mode "all").
};
```

`version` bumps whenever a provider's rules change; it drives upgrade reconciliation. Patterns match native ids (and, for aggregators, the full vendor-prefixed id). Curation cadence: same release train as the provider registry.

### Config schema

```jsonc
{
  "providers": {
    "openrouter": {
      "selectedModels": ["anthropic/claude-opus-4.6", "..."],   // existing field, seeded by the preset
      "modelPreset": {                                          // NEW marker object
        "mode": "preset",                 // "preset" | "all" | "custom"
        "appliedVersion": 3,              // MODEL_PRESETS version materialized into selectedModels
        "appliedAt": "2026-08-24T00:00:00Z"
      }
    }
  }
}
```

Semantics — the preset is a SEED, not a lock:

- `mode: "preset"`: `selectedModels` was materialized from the preset rules against the then-current catalog and the user has not diverged. The proxy may re-materialize on upgrade (below).
- `mode: "custom"`: the user edited the selection after seeding. The proxy never touches `selectedModels` again. Any write through `PUT /api/selected-models` or `/api/model-visibility` that changes the list while mode is "preset" flips it to "custom" automatically — divergence is detected at the write path, not by diffing.
- `mode: "all"` (or the whole `modelPreset` object absent): no allowlist management; empty `selectedModels` = everything visible, exactly today's semantics.
- Materialization: evaluate rules against the provider's discovered catalog at apply time and store CONCRETE ids in `selectedModels`. Concrete ids keep `filterCatalogVisibleModels` (src/codex/catalog/provider-fetch.ts:1555) and every existing consumer byte-compatible — no pattern matching enters the visibility hot path, and older binaries see a plain allowlist.

### When the preset applies

- Newly added provider (fresh install or existing install adding a provider): if `MODEL_PRESETS` has an entry, seed `mode:"preset"` and materialize on the first successful live fetch (static-catalog providers materialize immediately from registry `models`). The add-provider GUI/CLI flow states it plainly: "Showing the N current core models — switch to All to see everything."
- Existing configured providers on upgrade: untouched (mode stays absent = "all"). Opt-in via GUI/CLI below. Silently narrowing an existing user's catalog is a behavior break; a one-time dashboard hint ("openrouter exposes 412 models — apply the core preset?") is the migration nudge instead.
- Preset updates on upgrade: on catalog convergence, if a provider is in `mode:"preset"` and `MODEL_PRESETS[provider].version > appliedVersion`, re-materialize (new rules against current catalog, replace `selectedModels`, update marker). Because any user edit flips mode to "custom", auto-re-apply only ever happens for users who never diverged — the reconciliation question collapses to a version compare. A "custom" provider with a newer preset shows a non-blocking GUI hint ("Preset updated — apply and discard your edits?") that requires explicit confirmation.
- Re-materialization on ordinary refresh (no version bump): also allowed in `mode:"preset"` — when a NEW model matches the rules (e.g. claude-opus-5.1 ships), it is added to `selectedModels` automatically. This is the "latest" promise: preset mode tracks flagships as they arrive. Models that stop matching are removed only on version bumps, not on refresh (rules are stable between releases, so refresh-time changes are additive by construction).

### API

- `GET /api/model-presets` → `{"providers":{"openrouter":{"mode":"preset","appliedVersion":3,"availableVersion":3,"presetIds":["..."],"presetCount":9,"totalCount":412}}}` — preview without applying (`presetIds` = rules evaluated against the current catalog).
- `PUT /api/model-presets` body `{"provider":"openrouter","mode":"preset"|"all"|"custom"}` → applies/clears; `mode:"preset"` materializes immediately and returns `{"ok":true,"selected":[...],"catalogRefresh":...}`. `mode:"all"` deletes `selectedModels` + marker (same effect as today's empty-list PUT, model-routes.ts:557-558).
- Existing `PUT /api/selected-models` and `PUT /api/model-visibility` gain one line of behavior: mutating `selectedModels` for a provider whose marker says `mode:"preset"` sets `mode:"custom"`. No request/response shape changes.

### CLI

```
ocx models preset show [--provider <name>] [--json]   # mode, applied/available version, id preview per provider
ocx models preset apply <provider>                    # switch to preset mode, materialize now
ocx models preset apply <provider> --all              # back to "all" (clears allowlist + marker)
```

Slots into the existing runtime dispatch (src/cli/models.ts:415 subcommand list; handler beside `selected` in src/cli/models-runtime.ts). `ocx models selected <provider> --set ...` keeps working and flips mode to custom via the API-side rule.

### GUI

- Provider group header in Models.tsx gains a compact segmented selector: **Preset / All / Custom** ("프리셋 / 전체 / 커스텀"). Custom is not directly clickable — it activates automatically on edit and shows as the current state; clicking Preset from Custom shows the confirm dialog ("replaces your selection with N preset models").
- Preset mode shows "9 of 412 shown — core preset v3"; stale version shows an "update available" chip that re-materializes on click (only reachable in Custom mode, per auto-apply rule above).
- Add-provider flow: providers with a preset default the selector to Preset and say so before the first save.

## Resolution & edge cases

- Preset matches zero models (catalog drift outran rules): keep the previous `selectedModels` untouched, log a warning, surface a GUI chip ("preset matched nothing — showing previous selection"). Never write an empty allowlist from a preset, because empty means ALL (model-routes.ts:556-558) and would silently un-curate. For a freshly added provider there is no previous selection to keep: zero matches at first materialization falls back to `mode:"all"` (marker records `fallback:"preset-empty"`), the add flow says so, and the next convergence retries materialization while the fallback marker is present.
- Custom models (`config.customModels`) and combo rows are outside preset scope — visibility for those already has its own paths; preset materialization only writes provider-catalog ids.
- Interaction with 020 (new-model policy): preset mode maintains a non-empty allowlist, so 020's blocklist-append branch never fires for preset providers (its allowlist case is a no-op by design). A new flagship arrives ON in preset mode iff it matches the rules — that is the point of preset mode, and 020's policy explicitly yields to it: allowlisted providers are governed by their allowlist. Providers in "all" mode remain 020's territory.
- Interaction with 010 (aliases): orthogonal. Preset governs which rows exist; aliases govern how rows are named/resolved. Built-in default aliases target flagship patterns, so preset-mode catalogs get near-complete alias coverage for free.
- Disabled providers, providers with `liveModels:false`: preset materializes from the registry's static `models` list; no live fetch needed.
- Export/import of config: marker + materialized ids are plain config fields; an import onto a newer binary reconciles by version like any upgrade.

## Migration & compatibility

- Zero change for every existing provider (mode absent = "all"). Fresh installs and newly added providers get preset mode by default only when a registry preset exists.
- Downgrade: older binaries ignore `modelPreset` and honor `selectedModels` as a plain allowlist — the materialized-concrete-ids decision makes downgrade lossless. Re-upgrading resumes reconciliation from the stored marker.
- The marker travels inside the provider object, so provider deletion/rename carries or removes it atomically.

## Out of scope

- User-defined preset rules (custom regex sets) — the marker structure leaves room (`mode:"preset"` could later carry a `rules` override) but v1 ships code-maintained presets only.
- Cross-provider "global preset" (one switch curating every provider at once) — expressible later as a bulk PUT.
- Cost/quality-based automatic curation.

## Open questions

1. Should refresh-time additive re-materialization (new flagship auto-ON) be a sub-toggle? Proposed: no — it is the defining behavior of preset mode; a user who dislikes it is by definition Custom.
2. Preset for the native `openai` provider (hide old gpt snapshots)? Proposed: exclude in v1 — native rows flow through a different catalog path (nativeModelRows) and the blocklist already handles them; revisit if users ask.
3. Naming collision with `deriveProviderPresets` (provider-setup presets): rename risk is docs-only; proposed to consistently say "model preset" in code (`MODEL_PRESETS`, `modelPreset`) and UI copy.
