# 160.10 — Phase 1: Dashboard Redesign (light + dark)

- **Status:** Done
- **Date:** 2026-06-20
- **Work class:** C2–C3 (gui/ visual system; reversible, token-driven)
- **Resolves:** Open Q2 in [00_overview.md](00_overview.md)

## Direction (Q2 resolved by user)

> "너무 둥글고 가독성도 안좋고 dashboard 느낌도 안나고 dev 스킬 미감에도 안맞고 화이트모드도 지원을 안해"

Concrete complaints → concrete fixes. Kept the dense devtool category (audit 01 confirmed it
is the right surface), refined the skin:

| Complaint | Fix |
|-----------|-----|
| 너무 둥글다 (too round) | radius `12/8/6` → **`8/5/4`** — crisp console corners |
| 가독성 안좋다 (low readability) | near-black/near-white text + real muted grays; WCAG-AA status colors per theme |
| dashboard 느낌 안난다 | metric tiles (uppercase tracked labels, larger values, hover), white cards on a distinct canvas, hover-able model grid |
| dev 스킬 미감 안맞다 | dropped the generic neon-purple `#7c5cff` (audit 01 §"#1 generic-dark signal") for a single intentional **indigo** accent; neutral zinc/slate base; off-black not pure black |
| 화이트모드 미지원 | full **light + dark + system** with a persistent toggle |

## How the theming works (single-source tokens)

Used the native CSS `light-dark()` function so every color token is authored **once**:

```css
:root { color-scheme: light dark; --bg: light-dark(#f6f7f9, #0c0d11); … }
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"]  { color-scheme: dark; }
```

- Default = follow the OS. An explicit choice pins `color-scheme` via `data-theme`, which is
  what `light-dark()` obeys — no duplicated dark block, no media-query fork.
- **FOWT guard** (`gui/index.html`): a <200-byte inline script applies a stored light/dark
  choice before first paint; `system` leaves the attribute off. Mirrored by `App.tsx`.
- Toggle: sidebar-foot button cycles light → dark → system, persisted to `localStorage["ocx-theme"]`.

## Files

- `gui/src/styles.css` — token system rewrite (light-dark), `8/5/4` radius, AA contrast,
  metric-tile `.stat`, new `.model-card` + `.theme-toggle`, theme-aware `--hover` / glow /
  scrollbar / switch / modal scrim (removed all dark-only `rgba(255,…)` hardcodes). 262 lines.
- `gui/index.html` — `color-scheme: light dark` meta + FOWT script.
- `gui/src/App.tsx` — `Theme` state, apply/persist effect, cycle toggle in the sidebar foot.
- `gui/src/icons.tsx` — `IconSun` / `IconMoon` / `IconMonitor`.
- `gui/src/pages/Dashboard.tsx` — model grid uses the new `.model-card` (sharper, hover-able).

All other pages (Providers/Models/Subagents/Logs) were already 100% CSS-variable driven, so
they re-theme automatically — no per-page edits needed.

## Verification

- `bun run build` (gui: `tsc -b && vite build`) → clean.
- Visual: real proxy on :10199 serving `gui/dist`, screenshotted in **light and dark** — both
  render correctly; toggle cycles system→light→dark; `data-theme` applied; no flash.
- Lint: no **new** issues introduced (the one `set-state-in-effect` in `Dashboard.tsx` is the
  pre-existing models-loading effect, untouched by this work).

## Not done (out of scope by Q1)

No capability/modality badges. The user's media-model request was "hide", not "surface" —
see [20_hide-media-models.md](20_hide-media-models.md). Per-model context-window/vision badges
remain a possible future `30_*` if requested.
