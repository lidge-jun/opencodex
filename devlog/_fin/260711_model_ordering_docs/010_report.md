# 010 — D report: model-ordering explanation shipped to all 3 missing surfaces

Outcome: **DONE** (verified). One work-phase, HITL P->A->B->C->D run manually
(`cxc` CLI unavailable in session — preflight noted in 000_plan.md).

## Surfaces that were missing the ordering explanation (now covered)

1. **docs-site** — no article existed on picker ordering. Added "Model Ordering" /
   "모델 정렬에 관하여" / "模型排序":
   - `docs-site/src/content/docs/guides/model-ordering.md`
   - `docs-site/src/content/docs/ko/guides/model-ordering.md`
   - `docs-site/src/content/docs/zh-cn/guides/model-ordering.md`
   - Sidebar entry after "Codex App Model Picker" in `docs-site/astro.config.mjs`.
   Content covers: priority-ASC sorting + array-order discard (catalog.ts:881),
   priority table (featured 0..4 / routed 5 / native 9 / non-selected native 100+),
   alphabetical tie-break (catalog.ts:1269), orderForSubagents stable sort
   (catalog.ts:1313), 5-pick cap (management-api.ts:629 slice(0,5)),
   selectedModels/disabledModels = filter-only (catalog.ts:1227), example picker
   table, and the honest limitation: no modelOrder/providerOrder config exists.
2. **GUI Subagents page** (`gui/src/pages/Subagents.tsx`) — the chosen order silently
   was the picker 1-5 order + spawn_agent candidates. Added `sub.orderHint` notice
   (IconInfo row) above the Featured list.
3. **GUI Models tab** (`gui/src/pages/Models.tsx`) — added `models.orderHint` caption
   above the model list: subagent picks first -> routed provider/id alphabetical ->
   native; visibility toggles filter only. i18n keys added in en/ko/zh/de.

## Dispatch

- Worker A "Ampere" (gpt-5.6-sol, high): docs-site scope. Worker B "Planck"
  (gpt-5.6-sol, high): gui scope. Disjoint write sets, no collisions; pre-existing
  user worktree changes (Models.tsx v2 gating, cli.md docs, v2.ts, features.ts,
  management-api.ts, tests) preserved untouched.

## C evidence (main-session verification, fresh runs)

- `docs-site`: `bun run build` exit 0, 52 pages; `dist/{,ko/,zh-cn/}guides/model-ordering/index.html`
  all exist; ko page contains the title string (rg count 3).
- `gui`: `bun run build` (tsc -b && vite build) exit 0. Worker additionally ran
  `npm exec tsc --noEmit` exit 0 and a browser render check of both pages
  (render-grounding observation recorded in worker report; main reviewed diffs —
  reused existing row/muted/IconInfo/Trans patterns, no layout risk).
- Factual copy cross-checked by main against src/codex/catalog.ts and
  src/server/management-api.ts (verified in the prior investigation turn).

## Residual / not done

- No sorting-behavior change was made (out of scope by design). A general
  `modelOrder` config remains a possible future unit; candidate touch points are
  recorded in 000_plan.md and the docs article.
- Changes are uncommitted; commit left to the user (worktree carries unrelated
  user-owned v2-gating work in the same files).
