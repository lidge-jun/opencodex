# 260926 Models page: luna 6 shadow source + settings fold + sticky rail

## Objective

One PR to `dev` that (A) moves the shadow-call intercept's primary source model from
`gpt-5.6-luna` to `gpt-6-luna` and (B) makes the GUI Models catalog readable on wide
screens: a pinned provider rail, and a single collapsible "Model settings" panel lifted
above the rail/list workspace.

## Evidence that motivates A

- Codex CLI 0.154.0 is installed locally. The last 3000 rows of `~/.opencodex/usage.jsonl`
  hold 588 `gpt-6-luna` rows against 256 `gpt-5.6-luna` rows, so helper calls moved to
  GPT-6 Luna while at least one client still sends 5.6 Luna.
- `DEFAULT_SHADOW_SOURCE_MODELS` (`src/lib/shadow-call.ts:10`) is the only runtime default;
  the GUI mirrors it in `gui/src/pages/shadow-call-source.ts:9` for runtimes that omit
  `sourceModels`. No migration rewrites persisted `shadowCallIntercept.sourceModels`.
- Matching is a bare-slug prefix test with no request-origin check
  (`shouldInterceptShadowCall`, `src/lib/shadow-call.ts:78-96`). The default subagent roster
  now contains `gpt-6-luna` (`src/config/subagent-models.ts:7`), so a `gpt-6-luna` prefix
  would also rewrite explicitly spawned Luna children. Codex marks those children exactly
  (`isThreadSpawnRequest`, `src/server/effort-policy.ts:33`), and request-prepare already
  computes it (`src/server/responses/request-prepare.ts:552`).

## Decisions

| ID | Decision | Rejected alternative |
|----|----------|----------------------|
| D1 | Default sources become `["gpt-6-luna", "gpt-5.6-luna"]`: GPT-6 first (badge shows it first), 5.6 kept as a legacy prefix. | `["gpt-6-luna"]` only: silently stops intercepting the client still sending 5.6 Luna. |
| D2 | A request carrying Codex's spawned-child markers is never shadow-intercepted, at both intercept sites (early combo rewrite and late route rewrite). | Slug-only matching: the GPT-6 roster default would hijack explicit `gpt-6-luna` subagents. |
| D3 | GUI fallback list mirrors D1; the badge drops the `gpt-` prefix and shows `6-luna, 5.6-luna`. | Hard-code one label. |
| D4 | Other `gpt-5.6-luna` defaults (vision/web-search sidecar, warmup, pricing, registries, adapters) stay unchanged and are listed as follow-up in the PR. They are real upstream model ids, not shadow labels. | Global rename: changes upstream traffic for unrelated features. |
| D5 | Model settings move into one native `<details>` panel rendered full width above `.models-workspace-root`; its summary line lists the current state of the folded controls, so folding never hides state. Open state persists in localStorage. | Per-row accordions; a modal; keeping settings inside the right column. |
| D6 | The provider rail becomes `position: sticky` below the sticky quota bar, with the internal list filling the viewport height instead of a fixed 640px cap. Breakpoints that stack the rail keep it static. | JS scroll listeners; the Combos full-height shell (changes the page scroll model). |
| D7 | The catalog tab widens `.main-inner` to 1320px, as the routing tab already does for 1200px. | Full-bleed: long help lines become unreadable. |
| D8 | `Models.tsx` sits 5 lines under its ratchet cap (2787/2792). New JSX lives in `gui/src/pages/models-settings-panel.tsx`; the custom-count IIFE moves there too, so `Models.tsx` shrinks. | Growing `Models.tsx`. |

## Design read (dashboard domain)

Reading this as a repeated-work admin tool for one operator who returns daily. Density D5,
variance 3, motion 2 (disclosure chevron rotation only). One primary region: the model
list. Settings are expert controls, demoted by progressive disclosure and never removed;
the folded summary states what is hidden and its current values.

## Work-phase map (dependency order)

1. wp1 — this roadmap (docs only).
2. wp2 — `010_wp2_shadow_source_luna6.md`: runtime contract first, GUI mirror, docs, tests.
3. wp3 — `020_wp3_models_layout.md`: settings panel, sticky rail, width, i18n.
4. wp4 — `030_wp4_integration_pr.md`: full gates, rendered QA, PR with screenshot, CI.

## Out of scope

Merge, release, deploy; intercept target resolution; vision/web-search/warmup model
defaults; Combos/Routing/Compatibility tabs.

## SoT sync target

`structure/gui-and-management-api.md` (shadow-call default sentence, ~line 192).

## Architect consultation (P, revision 1)

- Architects: sol subagent `01a0d9b4-b355` (shadow-call inventory) and `01a0d9b4-b4b4`
  (layout map). Both proposals received before this plan; both reflections received on it.
- Shadow architect: ALIGNED. Correction folded: `req` is in scope at both sites; `threadSpawn`
  is computed only at request-prepare.ts:552, so B hoists one `const spawnedChild =
  isThreadSpawnRequest(req.headers)` above the early combo site (~231) and reuses it at the
  late site and at 552.
- Layout architect: MISALIGNED only against its own earlier proposal (it had kept the 640px
  list cap and had no persisted state); the plan's D5/D6/D8 supersede those. Open gap
  accepted: the quota bar has `min-height: 34px` and wraps, so its height is not a constant.
  Disposition, D6 amended: `QuotaSummaryBar` publishes its measured height as
  `--ocx-sticky-top` on `document.documentElement` through a ResizeObserver (cleared on
  unmount); the rail uses `top: calc(var(--ocx-sticky-top, 0px) + var(--space-3))`.
  Verified in C by the rail staying below the bar at 1440 (one bar row) and 1170 (two rows).

## A-phase audit folds (revision 2)

Auditors: correctness `01a0d9be-8ff4` (NEAR-PASS), UI/UX `01a0d9be-90ee` (NEAR-PASS).

| # | Finding | Disposition |
|---|---------|-------------|
| A1 | `gui/tests/shadow-call-source.test.ts:25,61` assert the old fallback/badge | Folded into wp2 file map |
| A2 | Rail also stacks at `@container models-workspace (max-width: 720px)` (css:604-612) | Folded: sticky reset lives in that container query as well as the 768px media query |
| A3 | Docs say the intercept applies to every matching request (`docs-site/.../reference/configuration/server.md:664`) | Folded: qualify with the spawned-child exemption in English + all translated config/CLI pages; #1684 (turn-labelled helpers still intercepted) and #2706 (self-target no-op) stay explicit |
| A4 | Aliases table would stay outside when its toggle folds | Folded: table renders inside the panel body |
| A5 | Warnings (`models.v2Conflict`, `v2Note`, `pickerOrder.loadFailed`) hidden when folded | Folded: `SettingsSummaryItem.warn`; any warn shows an amber dot in the summary and forces the panel open on mount |
| A6 | Summary order and content | Folded: Sub-agent, Shadow (off / target), Window, Order; `New models off` only when non-default |
| A7 | Custom count is list state, not a setting | Folded: `CustomModelsSummary` joins the collapse toolbar row (space-between) |
| A8 | Grid for open panel at >=1000px container; pairs rows | Folded with the auditor's CSS |
| A9 | Long hint paragraphs -> tooltips; subtitle/banner compaction; drop the warning glyph from the shadow badge | Accepted partially: `orderHint` and `pickerOrder.hint` become info tooltips beside their labels; banner padding compacted; the ⚠ glyph removed from `models.shadowCallOriginal` in all locales. Subtitle rewrite rejected for this PR (10-locale copy churn, low gain) |
| A10 | wp4 gates miss `cd gui && bun test tests` and `bun run lint:i18n` | Folded into wp4 |
