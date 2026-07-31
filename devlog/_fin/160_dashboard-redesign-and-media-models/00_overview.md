# 160.00 — Overview / MOC: Dashboard Redesign + Media Models

- **Status:** Planning (scaffold) — not yet started
- **Date:** 2026-06-20
- **Work class:** C3 (cross-domain: `gui/` frontend redesign + possible `src/` registry/metadata/API change)
- **Owner:** boss (frontend redesign), pending direction confirmation

## Goal (plain language)

Two related pieces of work, tracked together because they touch the same surface — the
page the proxy serves at `http://localhost:10100`:

1. **Redesign the 10100 dashboard.** The current GUI works but the user finds it "too ugly"
   (구리다). Refresh the visual design of the management dashboard (`gui/`).
2. **Surface Grok's image/video models.** The user states Grok now has "image and video
   models on in the registry," and the dashboard should reflect that. Today the dashboard
   shows only a model id + provider — no capability/modality at all.

## Two workstreams

| # | Workstream | Primary surface | Risk |
|---|------------|-----------------|------|
| A | Dashboard visual redesign | `gui/src/**` (pages + `styles.css`) | C2–C3, reversible (prototype-friendly) |
| B | Model capability / media-model surfacing | `src/generated/jawcode-model-metadata.ts`, `src/server.ts` (`/api/models`), `gui/src/pages/{Models,Dashboard}.tsx` | C3 — touches a generated metadata contract; treat with extra care |

Workstream A can ship independently of B. B depends on resolving the open question below.

## Current state (evidence)

- The proxy serves the GUI at `GET /` → `src/server.ts:692` (`GET / → GUI dashboard`);
  static files via `serveGuiFile()` / `src/server.ts:58-67`.
- GUI is a Vite + React app: `gui/src/` — `App.tsx` (shell + 5-item sidebar nav,
  `App.tsx:13-19`), pages `Dashboard / Providers / Models / Subagents / Logs`, shared
  primitives in `ui.tsx`, design system in `styles.css` (242 lines, dark "terminal devtool"
  theme, single purple accent `#7c5cff`). Full audit → [01_current-design-audit.md](01_current-design-audit.md).
- Grok (`xai`) registry entry lists **text + vision chat** models only —
  `src/providers/registry.ts:41-54` (`grok-4.3`, `grok-4.20-*`, `grok-build-0.1`,
  `grok-composer-2.5-fast`; with `noVisionModels`).
- Model metadata schema tracks **input** modality only: `input?: ("text" | "image")[]`
  (`src/generated/jawcode-model-metadata.ts:9`). Several xai rows are `text,image`
  (vision input). There is **no `video` modality and no image/video generation concept**
  anywhere in `src/` (`grep -rn "video" src` → 0 hits).
- `/api/models` returns `{ provider, id, namespaced, disabled }` only — no modality field
  (`src/server.ts:419-426`). So the GUI cannot display capability today even though the
  metadata partially has it. Full analysis → [02_grok-media-models-and-registry-gap.md](02_grok-media-models-and-registry-gap.md).

## Open questions (must resolve before Workstream B)

1. **What does "image and video models on in the registry" mean concretely?**
   - (a) Vision = image **input** capability (already partly modeled as `text,image`), just
     not surfaced in the UI → pure surfacing task, no schema change; or
   - (b) Add Grok image-**generation** and video-**generation** models (e.g. Aurora /
     image / video endpoints) to the registry → needs a new modality concept + metadata
     schema extension + adapter support; or
   - (c) "Registry" refers to an upstream/jawcode bundle list, not `registry.ts`.
   Current code matches (a) partially; (b)/(c) are not implemented. **Do not assume — confirm.**
2. **Redesign direction** — keep the dark devtool theme and refine it, or change direction
   (e.g. light/dense, Linear-like, etc.)? See Design Read in 01.

## Document index

- [01_current-design-audit.md](01_current-design-audit.md) — current GUI inventory, design
  tokens, per-page audit, Design Read + dials, redesign opportunities.
- [02_grok-media-models-and-registry-gap.md](02_grok-media-models-and-registry-gap.md) —
  what the registry/metadata actually contain, the exact gap vs the request, options.
- `10_*` Phase 1 (redesign implementation) — **to be written in P after direction is confirmed.**
- `20_*` Phase 2 (media-model surfacing) — **to be written in P after Q1 is resolved.**

## Source-of-truth references (read, reused)

- `structure/05_gui-and-management-api.md` — existing SOT for the GUI + management API.
- `structure/03_catalog-and-subagents.md` — catalog/model routing.
- Prior catalog work: `devlog/130_provider-catalog-single-source/`,
  `devlog/140_remaining-provider-ports/`.

## Next steps

1. Confirm answers to the two open questions (design direction + media-model meaning).
2. `cli-jaw orchestrate P` → write `10_*` (redesign) and, if Q1 = option (b), `20_*`
   (schema + API + UI) diff-level phase docs.
3. Build redesign first (independent, low risk); media-model surfacing second.
