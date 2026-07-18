# Codex App Model Catalog Integration

Date: 2026-06-20

> **Archive note.** This is a dated design-rationale record, not current behavior
> documentation. For up-to-date behavior see the published docs at
> [lidge-jun.github.io/opencodex](https://lidge-jun.github.io/opencodex/) and the
> maintainer source-of-truth under [`structure/`](../structure). The current injected
> provider table name is `"OpenCodex Proxy"` (see `src/codex/inject.ts`).

This document records why opencodex routed models can appear in Codex App's model picker without
patching Codex App itself.

## Summary

Codex CLI, TUI, and App share the Codex home configuration surface. opencodex integrates by writing
Codex-native config and catalog files under the resolved `CODEX_HOME`:

- `$CODEX_HOME/config.toml`
- `$CODEX_HOME/opencodex.config.toml`
- `$CODEX_HOME/opencodex-catalog.json`
- `$CODEX_HOME/models_cache.json`

When Codex App reads the same config/catalog state, routed opencodex models are visible because they
look like valid Codex catalog entries.

## Required config shape

The global provider must be a root TOML key:

```toml
model_provider = "opencodex"
```

It must not be appended under whichever TOML table happened to be last. TOML root keys after a table
header become part of that table, which makes Codex ignore the provider as a global setting.

The custom model catalog path must also be a root TOML key:

```toml
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
```

The provider block must advertise a Responses-compatible provider:

```toml
[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://localhost:10100/v1"
wire_api = "responses"
requires_openai_auth = true
```

`requires_openai_auth = true` is important for Codex App/TUI account-gated behavior. Codex derives
ChatGPT-account capability from the active provider; without this flag, fast-related UI can stay
hidden even when the user has ChatGPT auth.

## Catalog entry shape

opencodex does not generate minimal JSON entries. It clones a native Codex model catalog entry and
then changes the routed fields:

```text
slug = "<provider>/<model>"
display_name = "<provider>/<model>"
description = "Routed via opencodex -> <provider> ..."
priority = <picker priority>
visibility = "list"
```

Slash-containing native ids: some providers namespace their own model ids
(zenmux `moonshotai/kimi-k3-free`, openrouter `anthropic/...`, nvidia `moonshotai/...`).
Codex's models-manager metadata lookup tolerates exactly one "/", so opencodex aliases
inner slashes to "-" in the Codex-facing slug (`zenmux/moonshotai-kimi-k3-free`) and
decodes back to the native id in the proxy via an exact known-id lookup
(`src/providers/slug-codec.ts`). Raw full-slash selectors keep working; upstream
requests, logs, usage, and metadata always carry the native id.

Cloning a native entry preserves fields Codex's strict parser expects, including:

- `base_instructions`
- `supported_reasoning_levels`
- `default_reasoning_level`
- `shell_type`
- `supported_in_api`

This is why routed entries can behave like normal picker-visible Codex models.

### Reasoning effort ladder

The recognized Codex effort ladder is `low < medium < high < xhigh < max < ultra`
(`src/reasoning-effort.ts` `CODEX_REASONING_LEVELS`), matching the upstream codex-rs
`ReasoningEffort` enum order. Semantics ported from upstream (df1199fdd, 80f54d126):

- `ultra` is a client-facing selection: maximum reasoning plus proactive multi-agent delegation
  (derived in codex-rs core, not by the proxy). Upstream converts it to `max` at the inference
  boundary; ocx mirrors that in two places — the Responses parser normalizes `ultra -> max` at
  ingest, and `mapReasoningEffort` converts any direct `ultra` caller to the `max` wire value.
- Routed models default to the `low..max` ladder. `ultra` is per-model opt-in via the
  `reasoningEfforts` provider config; when opted in it renders its canonical description.
- Native `gpt-5.6-*` slugs are emitted from the pinned upstream models.json snapshot
  (`src/codex/data/upstream-models.json`, openai/codex PR #31684): exact per-slug ladders
  (`sol`/`terra` end at `ultra`, `luna` ends at `max` — no ultra), default efforts
  (`sol` = `low`, `terra`/`luna` = `medium`), real display names/descriptions/NUX, and
  `multi_agent_version` (`sol`/`terra` v2, `luna` v1). ocx adaptations: `minimal_client_version`
  is stripped (it would hide the model from older installed clients) and
  `prefer_websockets`/`supports_websockets` follow the central websocket gate. A future
  `gpt-5.6-*` slug the snapshot predates falls back to template synthesis plus
  `ensureGpt56ReasoningLevels` (appends `max`+`ultra`).
- Snapshot scope is deliberately gpt-5.6-only: the bundled upstream entries for
  `gpt-5.5`/`gpt-5.4` are staler than the installed catalog's live entries (e.g. snapshot
  gpt-5.5 carries `tool_mode: null`), so substituting them would downgrade real data. On-disk
  sync also self-heals fallback-quality 5.6 entries (display_name stamped with the bare slug)
  by upgrading them to the snapshot entry; genuine entries from a newer installed codex are
  preserved untouched.
- Snapshot refresh: replace `src/codex/data/upstream-models.json` with the latest
  `codex-rs/models-manager/models.json` from openai/codex (e.g. the periodic
  "Update models.json" bot PR) and re-run the catalog test suite.

## Fast tier handling

Codex uses a split between config spelling and runtime/catalog spelling:

| Surface | Value |
|---|---|
| `config.toml` persistence | `service_tier = "fast"` |
| catalog/request tier id | `priority` |
| feature gate | `[features].fast_mode = true` |
| provider/account gate | `requires_openai_auth = true` |

Native OpenAI passthrough models can keep fast metadata. Routed non-OpenAI models must not inherit
that metadata from the native template:

```text
delete additional_speed_tiers
delete service_tier
delete service_tiers
delete default_service_tier
```

This prevents fast from appearing for providers where Codex/OpenAI priority processing is not a valid
request option.

## Cache invalidation

Codex caches models in:

```text
$CODEX_HOME/models_cache.json
```

After changing providers, hidden models, featured models, or service-tier metadata, opencodex should
delete that cache so the next Codex process or model refresh sees the updated catalog.

## Native GPT enable/disable

`disabledModels` is the single enable/disable choke point for BOTH model families:

- Routed ids stay namespaced (`provider/model`) and are excluded from the catalog and
  `/v1/models` entirely.
- Bare ids (no `/`) are native GPT passthrough slugs. Their catalog entries are NOT removed —
  the on-disk sync and the `/v1/models?client_version` shape flip them to `visibility: "hide"`
  (codex-rs keeps hidden entries out of the picker itself), so the template/backup/restore
  paths survive and re-enabling restores the exact entry. Only the bare OpenAI list shape of
  `/v1/models` omits disabled natives.
- The dashboard Models page lists natives from the static supported set
  (`nativeModelRows`), independent of catalog visibility, so a disabled model stays visible
  in the GUI for re-enabling. The visibility flip runs as the LAST sync pass
  (`applyNativeVisibility`) so the gpt-5.6 snapshot-upgrade branch can never clobber it.

## Verification

Useful probes:

```bash
codex doctor --json
codex debug models
ocx sync
ocx status
```

Expected high-level result:

- active model provider is `opencodex`
- provider uses ChatGPT auth reachability semantics
- native `gpt-*` entries keep fast support
- routed `<provider>/<model>` entries are `visibility = "list"`
- routed entries have no fast/service-tier metadata
