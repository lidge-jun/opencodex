# 260711 — Model ordering: document the logic on every user-facing surface

## Preflight note

- `cxc` CLI not on PATH in this session and no SessionStart binding line exists in
  context, so the PABCD FSM could not be armed (SESSION-IDENTITY-01). This unit runs
  the HITL P->A->B->C->D discipline manually; this doc is the P artifact.

## Objective

The Codex model-picker ordering logic (priority-based catalog ordering) is fully
implemented but documented NOWHERE user-facing. Three surfaces were missing it:

1. **docs-site** — no article explains why the picker shows models in this order.
2. **GUI Subagents page** — the chosen order silently controls picker top placement
   (priority 0..4) but the page never says so.
3. **GUI Models tab** — shows the model list without explaining the effective
   ordering rule (subagent picks first, then provider/id alphabetical, then native).

This unit adds the explanation to all three surfaces and records the gap here.

## Verified facts (source of truth for all copy)

Codex's models-manager sorts the catalog by `priority` ASC; array order is discarded
(`src/codex/catalog.ts:881` comment). Effective priorities produced by opencodex:

| Slot | Priority | Source |
|------|----------|--------|
| `subagentModels[i]` (max 5) | `i` (0..4) | `buildCatalogEntries` rank map, `src/codex/catalog.ts:885` |
| Other routed models | `5` | `src/codex/catalog.ts:892` |
| Native gpt slugs (default) | `9` | `src/codex/catalog.ts:887` |
| Non-selected native when featured exist | `featured.length + 100+` | `src/codex/catalog.ts:1348` |

Tie-break inside a priority group: `gatherRoutedModels()` sorts provider alpha, then
model id alpha (`src/codex/catalog.ts:1269`). `orderForSubagents()`
(`src/codex/catalog.ts:1313`) stable-sorts featured picks to the front. The 5-model
cap on `subagentModels` is enforced at `src/server/management-api.ts:629`
(`slice(0, 5)`). `selectedModels` / `disabledModels` are exposure filters only —
`filterCatalogVisibleModels` converts to `Set` (`src/codex/catalog.ts:1227`); their
array order never affects ordering. No `modelOrder` / `providerOrder` /
priority-map config exists today.

Net picker order: `subagentModels` order -> remaining routed provider/id alphabetical
-> native slugs.

## File change map

- `docs-site/src/content/docs/guides/model-ordering.md` (en, NEW)
- `docs-site/src/content/docs/ko/guides/model-ordering.md` (ko, NEW, "모델 정렬에 관하여")
- `docs-site/src/content/docs/zh-cn/guides/model-ordering.md` (zh-CN, NEW)
- `docs-site/astro.config.mjs` (sidebar entry after "Codex App Model Picker")
- `gui/src/pages/Subagents.tsx` (ordering-effect notice: chosen order = picker top order)
- `gui/src/pages/Models.tsx` (ordering-rule notice on the model list)
- `gui/src/i18n/{en,ko,zh,de}.ts` (new keys for both notices)

## Out of scope

- NO change to sorting behavior, priorities, or catalog sync logic.
- NO new config fields (`modelOrder` etc.) — docs describe today's behavior and its
  limits honestly.
- NO server/management-api changes.
- Pre-existing dirty worktree changes (cli.md docs, Models.tsx, v2.ts, features.ts,
  management-api.ts, tests) are user-owned: never reverted.

## Accept criteria

- `docs-site`: `bun run build` passes; the new page renders in all 3 locales and
  appears in the sidebar.
- `gui`: `tsc`/`bun run build` passes; Models tab and Subagents page each show the
  ordering explanation in en/ko/zh/de.
- Render grounding: dev-server screenshot (or built-page inspection) confirming both
  notices render without layout breakage.
- Devlog D report records the previously missing surfaces + evidence.

## Dispatch

- Worker A (gpt-5.6-sol high): docs-site scope only.
- Worker B (gpt-5.6-sol high): gui scope only.
- Main session: plan, verification, devlog (this unit).
