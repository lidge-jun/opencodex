# 160.01 — Current Design Audit (the "10100" dashboard)

Honest audit of what the proxy serves at `http://localhost:10100`. Evidence-based; every
claim points at a file. Goal: separate **what is fine** (keep) from **what reads as dated /
generic** (the actual target of "너무 구리다").

## What the 10100 page is

A Vite + React SPA under `gui/`, served as static files by the proxy (`src/server.ts:692`,
`serveGuiFile` at `src/server.ts:58-67`). Build output goes to `gui/dist` and is bundled
into the npm package.

```
gui/src/
  App.tsx              # shell: 232px sidebar + main, 5 nav items        (58 lines)
  main.tsx             # React root                                      (10)
  ui.tsx               # Switch, Notice, EmptyState primitives           (31)
  icons.tsx            # 20 inline Lucide-style SVG icons, no dependency (29)
  styles.css           # the whole design system, CSS custom properties  (242)
  pages/
    Dashboard.tsx      # status stats + provider table + model cards     (114)
    Providers.tsx      # OAuth login panel + provider cards + JSON edit   (240)
    Models.tsx         # per-provider collapsible model toggles          (122)
    Subagents.tsx      # pick/order up to 5 spawn_agent models           (149)
    Logs.tsx           # request log table, auto-refresh                 (73)
  components/
    AddProviderModal.tsx                                                 (282)
```

## Design tokens (current — `gui/src/styles.css:7-43`)

| Token | Value | Note |
|-------|-------|------|
| `--bg` | `#0b0b0f` | off-black canvas (good — not pure `#000`) |
| `--surface` / `--raised` | `#14141a` / `#1c1c25` | flat dark greys |
| `--accent` | `#7c5cff` (purple) | single accent + `--accent-hover` `#9077ff` |
| status | green `#34d399`, red `#f87171`, amber `#fbbf24` | only used for status dots / log codes |
| `--radius` | 12 / 8 / 6px | rounded |
| fonts | system sans + `ui-monospace` stack | mono for ids/urls |
| bg accent | one faint radial purple glow top-left | the only "decoration" |

## What is already good (keep)

- **No AI-slop tells:** real inline SVG icons (`icons.tsx`), **no emoji as UI** (dev-frontend §5 STRICT ✓),
  all colors are CSS custom properties (theme-ready), off-black not pure black.
- **Accessibility baseline mostly present:** semantic `<button>`/`<nav>`/`<table>`, `aria-pressed` /
  `aria-current` / `aria-label`, `:focus-visible` ring, `prefers-reduced-motion` guard (`styles.css:215`),
  responsive sidebar→topbar collapse at 760px (`styles.css:234-242`).
- **Domain-correct surface:** it is a dense devtool/admin console, not a marketing page — the
  restrained direction is the *right* category (dev-frontend §0: "build the working surface, not a hero").

## What reads as dated / generic (the redesign target)

1. **Purple-on-near-black is the #1 generic-dark-SaaS signal.** `#7c5cff` accent on `#0b0b0f`
   is the most common LLM/dashboard default. Personality is near zero — it could be any tool.
2. **Everything is the same flat card.** `Dashboard`, `Models`, `Subagents` all render rows of
   equal `--surface` cards/tables with 1px borders. No size/weight/grouping variation → reads
   as template (dev-frontend §5: "equal cards read as generic"; visual-hierarchy levers unused).
3. **Dashboard has no actual dashboard-ness.** `Dashboard.tsx:60-111` = 4 identical stat tiles +
   a provider table + a grid of bland model cards (`id` + `provider` string only, `:104-109`).
   No charts, no request throughput, no at-a-glance health beyond a dot — the Logs data
   (`Logs.tsx`) is never visualized.
4. **Model cards carry no capability.** Both the Models page (`Models.tsx:99-107`) and Dashboard
   cards show only the id + a strike-through when disabled. No context window, no reasoning flag,
   no vision/modality — all of which already exist in metadata (see 02). This is *why* the
   "grok image/video" request lands here.
5. **Typography is monotone.** One weight jump (650/700), one size ramp; mono used well but the
   hierarchy is carried almost entirely by color, not type scale or spacing rhythm.
6. **Brand presence is a 26px `logo.png` + text.** No favicon/identity system (no `DESIGN.md`,
   confirmed absent). `App.tsx:27-31`.

## Design Read (current state → mini DESIGN.md)

```yaml
---
name: opencodex-dashboard
kind: developer tool / local management console
audience: developers running the opencodex proxy locally
colors:
  background: "#0b0b0f"
  surface: "#14141a"
  accent: "#7c5cff"   # single purple
typography:
  heading: { fontFamily: system-sans, weight: 650-700, scale: compact }
  body:    { fontFamily: system-sans, size: 14px }
  mono:    { fontFamily: ui-monospace, use: model ids + urls }
density: D4-D5 (SaaS/admin), VISUAL_DENSITY ~6
---
Reading this as: a dense local devtool console with a generic dark-SaaS skin.
Do's: keep it fast, dense, keyboard/aria-correct, theme-via-CSS-vars.
Don'ts: no hero text, no marketing motion, no emoji, no pure-black.
```

### Dials (current)
```
DESIGN_VARIANCE: 3   (low — appropriate for a console)
MOTION_INTENSITY: 1  (status spinner only — appropriate)
Product density profile: D4-D5 (admin/ops console)
Reasoning: dashboards want clarity+density, not variance/motion (dev-uiux-design §2).
```

## Redesign opportunities (options, not decisions — see 00 Open Q2)

Keeping the dark devtool category but giving it identity. Candidate moves:

- **Recolor for identity:** drop the default purple for an intentional accent + a real neutral
  ramp (e.g. cool slate/zinc base with one sharper signal color), or commit to a distinctive
  dark like a near-teal/amber terminal feel. (dev-frontend §4: max 1 accent, neutral base.)
- **Give the Dashboard real signal:** request throughput / latency / error-rate from the Logs
  feed, model-count by capability, provider health — actual at-a-glance state.
- **Capability-rich model rows:** modality (text / vision / image-gen / video-gen), context
  window, reasoning badge — directly enables Workstream B (see 02).
- **Hierarchy via type + spacing, not just color:** a real size ramp, section rhythm, varied
  card spans instead of uniform grids.
- **Keep all objective gates:** the current a11y/responsive/no-slop wins are not up for
  regression — the redesign must preserve them (dev-frontend §14 checklist).

> Direction (refine-the-dark vs change-direction, and exact palette) is **Open Q2 in 00** —
> resolve via the dev-uiux-design intent flow before writing the `10_*` phase doc.
