# 160.11 — Phase 1.1: Dashboard Refinements (follow-up)

- **Status:** Done
- **Date:** 2026-06-20
- **Work class:** C2–C3 (gui/ only, reversible, no public contract change)
- **Mode:** PABCD under an active goal (self-advancing gates with evidence checkpoints)
- **Follows:** [10_dashboard-redesign.md](10_dashboard-redesign.md)

## Part 1 — Plain summary

Second polish pass on the 10100 dashboard from user feedback, grounded in
dev-frontend / dev-uiux-design:

1. **Remove the "Auth" column** from the Dashboard providers table — it only showed
   "has api key?" and read as confusing UX.
2. **Group "Available models" by provider** (provider sub-header + that provider's cards),
   instead of one flat grid — easier to scan, and each card drops the now-redundant provider line.
3. **Lighten the boxes** — flatten stat tiles (drop their shadow), denser/lighter model cards,
   theme-correct hover borders (remove two leftover dark-only hex hovers).
4. **Fix mobile tab readability** — the sidebar→topbar nav currently wraps into a cramped block.
   Replace with a proper top bar (brand + theme toggle) over a horizontal **scrollable tab strip**
   with ≥44px touch targets; hide the secondary GitHub link on mobile.
5. **Keep system-default theming** (user confirmed ": system (OS 따라감)") — no change, verify only.

Design Read (unchanged from 10): dense developer console (D4–D5), VARIANCE 3, MOTION 1,
neutral base + single indigo accent, sharp 8/5/4 radius. These refinements *reduce* chrome
(fewer/lighter boxes, less repeated text) — they do not add variance or motion.

## Part 2 — Diff-level plan

### MODIFY `gui/src/pages/Dashboard.tsx`
- Import: `useState, useEffect` → add `useMemo`. Drop `IconCheck, IconX` (only used by the Auth column); keep `IconAlert`.
- Providers table: remove the `<th>Auth</th>` header cell and the `<td>` rendering `hasApiKey ? IconCheck : IconX`. Columns become Name / Adapter / Base URL / Model.
- Available models: replace the flat grid with a per-provider grouping (same pattern as `Models.tsx:29-33`):
  ```tsx
  const grouped = useMemo(() => {
    const g: Record<string, ModelInfo[]> = {};
    for (const m of models) (g[m.provider] ??= []).push(m);
    return Object.entries(g).sort(([a], [b]) => a.localeCompare(b));
  }, [models]);
  ```
  Render each `[provider, rows]` as `.model-group` → `.model-group-head` (provider + count) → `.model-grid` of `.model-card`s. Card shows `.id`; `.prov` only when `owned_by` differs from the group provider (kills redundant repetition).

### MODIFY `gui/src/styles.css`
- `.stat` — remove `box-shadow: var(--shadow-sm)` (flat, lighter tiles).
- New: `.model-group`, `.model-group-head` (+ `.count`), `.model-grid` (`repeat(auto-fill, minmax(220px,1fr))`, gap 8). Move the grid columns off the Dashboard inline style.
- `.model-card` — trim padding `11px 13px` → `10px 12px`.
- `.list-row:hover` — `border-color: #34343f` → `var(--accent-ring)` (theme-correct, matches stat/model-card hover).
- Rewrite the `@media (max-width: 760px)` block: sticky top bar via flex `row wrap` + `order`; `.brand` grows left, `.sidebar-foot` (theme toggle) sits right, `nav` is a full-width horizontal scroll tab strip (`overflow-x:auto`, hidden scrollbar); `.nav-item` `min-height:44px`, `white-space:nowrap`, font 14px; hide `.sidebar-foot .sidebar-link` (GitHub) and `.theme-toggle .mode` label on mobile (icon-forward).

### No other files
- `App.tsx` DOM order (brand, nav, sidebar-foot) supports the mobile reflow via flex `order` — no JSX change.
- Theme default already = system (10_) — verify only, no change.
- No backend, no `/api/*`, no generated-contract changes → not a media-models or routing concern.

## Build-phase refinement (B)

Screenshot review showed each grouped card still printed `owned_by` ("opencode"), near-
duplicating the "OPENCODE-GO" group header — exactly the clutter the user flagged. Since the
group header already names the provider, the card's second line was dropped → clean single-id
cards. `.model-card .prov` CSS and the card's `owned_by` render removed (`owned_by` stays in
the `ModelInfo` type as it documents the API).

## Verification (C) — results

- `bun run build` (gui: tsc -b && vite build) → **clean**; `styles.css` 283 lines.
- `bun x tsc --noEmit` → exit 0; `bun test tests` → **94 pass / 0 fail** (backend untouched).
- Screenshots vs live proxy (:10199): desktop **light + dark** (grouped single-id cards, no
  Auth column, flat tiles) and **mobile 390px** (sticky top bar + horizontal scroll tab strip,
  readable 14px labels, 44px targets, icon-only theme toggle, GitHub hidden). All correct.
- Independent read-only review (Frontend employee, dev-frontend ruleset): **DONE — no issues**
  (Auth removal clean, grouping via useMemo with hooks before early return, mobile 44px targets,
  no hardcoded dark hex, single accent, off-black, AA contrast, no emoji).

## Audit (A) result
Focused self-audit (C2–C3, gui-only, no contract/arch/persistence risk → employee plan-audit not required):
- `IconCheck`/`IconX` usage is confined to the Dashboard Auth column (grep) → safe to drop imports.
- Grouping pattern mirrors the verified `Models.tsx` implementation.
- Mobile selectors (`.sidebar`, `.brand`, `.sidebar nav`, `.nav-item`, `.sidebar-foot`, `.theme-toggle`) all exist in current DOM/CSS.
- `ProviderInfo.hasApiKey` stays in the type (documents the API); only its rendering is removed.
→ PASS.
