# 000 — PR #31684 upstream 5.6 parity + native GPT toggles

## Loop-spec header (C3, spec-satisfaction, 2 work-phases)

- **Loop archetype:** spec-satisfaction repair (verifier defines done).
- **Trigger:** user request — reflect openai/codex PR #31684 (`bot/update-models-json`,
  `codex-rs/models-manager/models.json`) into the ocx gpt-5.6 patch, and make native
  GPT models toggleable on/off in the Models surface.
- **Goal:** (WP1) ocx's synthesized gpt-5.6 native entries match the upstream bundled
  models.json snapshot; (WP2) native GPT slugs can be disabled/enabled from the GUI
  Models page through the existing `disabledModels` choke point.
- **Non-goals:** codex-rs changes; gpt-5.4 1M context override change (deliberate ocx
  decision, upstream says 272k — keep); routed-model behavior; account pool.
- **Verifier:** `bun x tsc --noEmit`; `bun test tests/codex-catalog.test.ts
  tests/codex-catalog-golden.test.ts tests/codex-catalog-sync-hardening.test.ts`; full
  `bun test`; GUI build + render observation (C-RENDER-GROUNDING-01) for WP2.
- **Stop condition:** all gates green + SoT docs synced + D summaries in this unit.
- **Memory artifact:** this unit + goalplan `pr-openai-codex-31684-upstream-models-json-openc`.
- **Expected terminal outcomes:** DONE / BLOCKED / NEEDS_HUMAN.
- **Escalation:** LOOP-REPAIR-01 (2 same-failure repairs -> RCA mode; 3 -> replan).
- **HOTL resource bounds:** writes confined to this repo; subagents read-only
  (explorer/reviewer), fan-out <= 3; ~60 min tool wall-clock.

## Evidence (upstream snapshot, fetched 2026-07-09)

Source: `gh api repos/openai/codex/contents/codex-rs/models-manager/models.json?ref=bot%2Fupdate-models-json`
(PR #31684, OPEN, saved to /tmp/models_new.json). Slug facts:

| slug | prio | default effort | efforts | multi_agent | ctx |
|------|------|----------------|---------|-------------|-----|
| gpt-5.6-sol | 1 | **low** | low..max,ultra | v2 | 372000 |
| gpt-5.6-terra | 2 | medium | low..max,ultra | v2 | 372000 |
| gpt-5.6-luna | 3 | medium | low..max (**no ultra**) | v1 | 372000 |
| gpt-5.5 | 7 | medium | low..xhigh | — | 272000 |

Shared 5.6 fields: `display_name` "GPT-5.6-Sol/Terra/Luna", descriptions ("Latest
frontier agentic coding model." / "Balanced agentic coding model for everyday work." /
"Fast and affordable agentic coding model."), `availability_nux` (sol only),
`tool_mode: code_mode_only`, `use_responses_lite: true`, `comp_hash: "3000"`,
`reasoning_summary_format: experimental`, `supports_image_detail_original: true`,
`default_verbosity: low`, `truncation_policy {tokens,10000}`, `prefer_websockets: true`,
`minimal_client_version: "0.142.2"`, `auto_compact_token_limit: null`, service tier
priority/Fast + `additional_speed_tiers ["fast"]`, own `base_instructions` +
`model_messages` (with new `approvals: null` key), effort descriptions (canonical):
low "Fast responses with lighter reasoning", medium "Balances speed and reasoning depth
for everyday tasks", high "Greater reasoning depth for complex problems", xhigh "Extra
high reasoning depth for complex problems", max "Maximum reasoning depth for the
hardest problems", ultra "Maximum reasoning with automatic task delegation".

## ocx gaps (evidence)

- **G1 ladder wrong for luna:** `ensureGpt56ReasoningLevels` (src/codex/catalog.ts:517)
  appends max+ultra for ALL `gpt-5.6-*`; upstream luna has NO ultra.
- **G2 default effort wrong for sol:** synthesis inherits template default (medium);
  upstream sol = low.
- **G3 identity/metadata drift:** synthesized entries carry `display_name = slug`,
  generic description, gpt-5.5 `base_instructions`/`model_messages`, no NUX, no
  `multi_agent_version`/`tool_mode`/`use_responses_lite`, comp_hash from template,
  `supports_image_detail_original` false via template.
- **G4 effort descriptions drift:** `CODEX_REASONING_LEVELS` (src/reasoning-effort.ts:4)
  medium/xhigh/max/ultra wordings differ from upstream canonical.
- **G5 no native toggle:** `disabledModels` filters only namespaced routed ids
  (`filterCatalogVisibleModels`, catalog.ts:884); native bare slugs always ship. GUI
  `/api/models` (management-api.ts:284) returns routed only.

## Mechanism notes (read evidence)

- "Bundled catalog" = `codex debug models --bundled` from the INSTALLED binary
  (catalog.ts:413). Installed codex predates PR #31684, so 5.6 entries are synthesized:
  `mergeCatalogEntriesForSync` backfill (catalog.ts:1020) + `buildCatalogEntries`
  native path (server/index.ts:259) both call `deriveEntry(template=gpt-5.5, slug)`.
- codex-rs `ModelVisibility = { List, Hide, None }`
  (protocol/src/openai_models.rs:248). `filterSupportedNativeSlugs` already keys on
  `visibility === "list"`. Hide keeps the entry (template + restore-safe) while
  removing it from the picker -> WP2 mechanism.
- Sync source for default-path users is the binary's bundled catalog EVERY sync, so
  visibility flips are re-applied deterministically from config each sync (sync
  rewrites the file from source + config every time).
- ocx synthesis signature: `display_name === slug` (deriveEntry sets it). Real upstream
  entries use "GPT-5.6-Sol" style -> used as the replace-vs-preserve discriminator.

## Work-phase map (dependency order)

1. **WP1 (010):** upstream snapshot bundled into ocx + catalog synthesis parity.
   Foundations: the data + build paths WP2 filters operate on.
2. **WP2 (020):** native GPT on/off toggles across sync, /v1/models, management API,
   GUI. Consumes WP1's entry sources.

## SoT sync targets (SOT-SYNC-01)

`docs/codex-app-model-catalog.md`, `structure/03_catalog-and-subagents.md` (ladder +
native list mentions), README.md / README.ko.md / README.zh-CN.md (GPT-5.6 lines),
docs-site guides (`codex-app-models.md`) where the same claims appear.
