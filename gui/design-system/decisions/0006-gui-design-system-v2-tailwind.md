# ADR 0006: GUI design system v2 on Tailwind v4 with registry components

## Status

Accepted. Supersedes the styling-stack and font parts of ADR 0005; the role-based token idea of
ADR 0005 carries over into v2.

## Context

The dashboard is being redesigned as a whole: new palette, type, controls (segmented controls,
proxy power and restart, switches), and page layouts. The component sources we want to build from
are the React Bits Pro Application UI blocks and the Aceternity UI (Pro) components. Both are
distributed through the shadcn registry protocol and are written as React + Tailwind CSS v4, with
`motion` for animation. ADR 0005 ruled out a utility framework and bundled fonts, which would mean
re-authoring every block by hand in plain CSS.

## Decision

- Add **Tailwind CSS v4** (`@tailwindcss/vite`) to `gui/`, importing only its `theme` and
  `utilities` layers. Tailwind's preflight reset is **not** loaded, so v1 pages keep rendering.
- Order the cascade as `theme, legacy, bridge, components, utilities` (`src/design/theme.css`):
  - `legacy`: every v1 stylesheet (`styles.css` and the files `main.tsx` used to import);
  - `bridge`: `src/design/bridge.css` re-points the v1 tokens and the most visible v1 classes at the
    v2 palette, so unmigrated pages already read as v2;
  - `components`: the v2 base for elements marked `ui-v2` (the slice of preflight they need);
  - `utilities`: Tailwind, so a migrated component always wins.
- A v1 stylesheet that a component imports itself (`import "./x.css"`) wraps its whole body in
  `@layer legacy { … }`. Unlayered CSS outranks every layer, so an unwrapped file silently beats
  both the bridge and Tailwind; fourteen such files did until this rule.
- v2 tokens are CSS custom properties (`--ocx-*`) in `src/design/theme.css`, mapped into Tailwind's
  theme (`bg-surface`, `text-fg-muted`, `rounded-control`, `shadow-glow`, …). They remain the runtime
  source of truth; new visual values must use them.
- Dark mode keeps the existing `data-theme` switch: a pinned attribute wins, no attribute follows
  the OS. Tailwind's `dark:` variant is defined to match.
- Self-host **Geist**, **Geist Mono** and **Wanted Sans** (Hangul) from npm packages. Fonts are
  bundled with the app, never loaded from a CDN, so the offline guarantee of ADR 0005 holds.
- Registry components (React Bits Pro, Aceternity Pro) are added with the shadcn CLI through
  `gui/components.json`. Their license keys come from `gui/.env.local` (git-ignored) and are never
  committed. Added code is owned and adapted here: copy, translate every visible string through
  `useT()`, and replace hard-coded colours with v2 tokens.
- v2 primitives live in `src/components/ui-v2/` (`Button`, `SegmentedControl`, `ProxyControls`, …).
  Pages migrate one at a time; each migration deletes the bridge rules it no longer needs.

## Alternatives considered

- **Keep plain CSS and port blocks by hand:** respects ADR 0005 but turns every block into a manual
  rewrite and makes the registry sources hard to update.
- **Load Tailwind with preflight:** simplest setup, but resets every v1 element at once and would
  break all unmigrated pages in one step.
- **Leave v1 stylesheets unlayered:** v1 element rules would beat Tailwind utilities and silently
  override migrated components.

## Consequences

- Build adds Tailwind and `motion`; bundle size is watched per migrated page.
- Tests that read v1 CSS declarations stay valid for v1 classes; tests for migrated components
  assert v2 structure instead.
- `design-system/foundations.md` documents the v2 tokens; the v1 sections stay until the last page
  migrates.
