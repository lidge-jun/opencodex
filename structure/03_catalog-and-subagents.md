# Catalog And Subagents SOT

## Shared catalog

`src/codex/catalog.ts` builds a shared Codex-shaped catalog for CLI, TUI, App, and SDK. It:

- preserves native OpenAI entries from the live catalog or static fallback, and emits
  gpt-5.6 natives from the pinned upstream models.json snapshot
  (`src/codex/data/upstream-models.json` — exact per-slug ladders: luna has no ultra);
- clones a native template for routed `provider/model` entries;
- forces strict Codex catalog fields required by the current parser;
- hides `disabledModels` (routed namespaced ids are excluded; BARE native slugs flip the
  catalog entry to `visibility: "hide"` and drop from the bare `/v1/models` list);
- applies exact provider/model compatibility exclusions after live discovery and metadata
  augmentation, so upstream-advertised but uncallable rows never enter dashboard or Codex pickers;
- strips native-only service tier and WebSocket metadata unless explicitly enabled;
- backs up the pristine catalog once to `~/.opencodex/catalog-backup.json`;
- invalidates `$CODEX_HOME/models_cache.json` when model visibility changes.

Codex App model picker visibility comes from this shared catalog, not from patching the App.

## Entry shape

Routed entries keep Codex-required metadata such as reasoning levels, shell type, API support flags,
base instructions, modalities, auto-compact fields, and strict parser booleans. The public slug and
display name use `provider/model`.

## Native passthrough

Native OpenAI entries remain available for ChatGPT passthrough. Routed non-OpenAI models must not
inherit native-only service tier or WebSocket metadata unless the user explicitly enables that
capability.

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

## Ultra reasoning level

Ultra is always advertised in the catalog regardless of the `multi_agent_v2` toggle. The v2 toggle
controls only the multi-agent collab surface, not ultra visibility. The `nativeEffortClamp` function
wire-clamps ultra/max to each model's real top rung (e.g. gpt-5.5 ultra → xhigh on the wire).

## Subagents

Codex `spawn_agent` advertises only the highest-priority first five catalog models. `subagentModels`
is capped at five ids and may contain routed `provider/model` slugs or native model slugs. Startup
seeds native GPT defaults only when the field is unset; an explicit empty list persists.
