# 160.12 — Phase 1.2: Mobile Overflow Fix + Remaining-Page Audit

- **Status:** Done
- **Date:** 2026-06-20
- **Work class:** C2 (gui CSS only, reversible)
- **Follows:** [11_dashboard-refinements.md](11_dashboard-refinements.md)

## Why

The objective is console-wide ("전반적으로 ui ux ... 더 미려한"), but only the Dashboard had
been verified in light/dark/mobile. Audited the other four pages and stress-tested mobile.

## Audit result (Providers / Models / Subagents / Logs)

Screenshotted each in light desktop — all render cleanly and consistently via the shared token
system (indigo toggles, provider cards, login panel, featured/search lists). No per-page work
needed. **But mobile exposed a real bug.**

## Bug: global horizontal overflow on mobile (root-caused)

Every page (even Logs, which has no table) scrolled horizontally at ≤760px — stat tiles and
content cut off, page-level scrollbar. Diagnosis by elimination (Logs has no table yet
overflowed → not the table → global → the sidebar):

- The mobile top-bar `.sidebar nav` is a horizontal strip of 5 nowrap tabs (~500px of content)
  with `overflow-x: auto`. As a flex item with `flex: 1 1 100%` it was **not shrinking** — its
  content width fed the grid column's `auto` minimum. Since the sticky sidebar shares the single
  grid column with `.main`, that forced **every page's** content wider than the viewport.
- `.main` already had `min-width: 0`; `.sidebar` did not.

**Fix** (the classic flexbox overflow cure): `min-width: 0` on `.sidebar` (so its content can't
inflate the grid column) and on `.sidebar nav` (so the tab strip shrinks to the viewport and
scrolls internally instead of overflowing).

## Other mobile/polish fixes (same pass)

- `.tbl-wrap`: `overflow: hidden` → `overflow-x: auto`, plus mobile `.tbl { min-width: 460px }`
  — data tables (Dashboard providers, Logs) now **scroll horizontally within their card** on
  mobile instead of clipping the MODEL column (dev-frontend mobile-ux: "data table → horizontal scroll").
- `.stat-row` mobile: `repeat(2, 1fr)` → `repeat(2, minmax(0, 1fr))` — defensive guard against
  grid track blowout.
- `input[type=checkbox|radio] { accent-color: var(--accent) }` — native controls (Logs
  "Auto-refresh") now match the indigo accent instead of browser blue.

## Files
- `gui/src/styles.css` (CSS only; no TSX change).

## Verification
- `bun run build` (tsc -b && vite build) → clean.
- `bun x tsc --noEmit` exit 0; `bun test tests` → **94 pass / 0 fail**.
- Mobile (390px) re-screenshot: Dashboard tiles fit + providers table scrolls in-card; Logs
  title/empty-state fit with **no page scrollbar**. Confirmed both light layout and the grouped
  model list (ANTHROPIC 10 + OPENCODE-GO 20) render correctly.
