# 000 — 260726-gui-grok-improvements: Plan

## Objective

Fix four reported defects and add one surface, all traced to a concrete line of
source before planning. Baseline: `dev` = `origin/dev` = `1540ad4a`.

### The five items, with the cause located in code

**1. Language dropdown punches through the sidebar bottom** (screenshot 1).
`gui/src/App.tsx:262-270` renders the locale `Select` with `portal={false}` and
`placement="right"`. The `portal={false}` path never reaches the viewport-aware
flip logic in `gui/src/select-position.ts:41-61`; instead the menu is pinned by
CSS at `gui/src/styles.css:334` and `:666` — `.select-dropdown-beside { top: 0 }`.
With six locales the menu is taller than the space below the trigger, so it runs
off the bottom. The flip logic to fix this already exists; the dropdown simply
cannot see it.

**2. `profile: unknown field "appliedFingerprint"`** (screenshot 2).
`src/types.ts:437-445` declares `appliedFingerprint` and `appliedAt` on
`OcxClaudeDesktopProfile`, and `src/server/management/agent-settings-routes.ts:84`
and `:450` write both after a successful apply. But
`src/claude/desktop-profile.ts:79` validates with
`assertExactKeys(value, ["version", "assignments", "defaults"], "profile")`, which
rejects them. So the write path stores fields the read path refuses. Any user who
has applied once has a permanently broken Desktop tab — exactly the screenshot.
This is the highest-severity item: it is a data-shape contradiction inside our own
code, and it hard-fails a page rather than degrading it.

**3. Desktop model management does not scale.**
`gui/src/pages/ClaudeDesktop.tsx:307-345` renders every model as a card inside one
of four family lanes, with no search, no pagination, and no collapse. The lanes are
a 4-column grid (`gui/src/styles.css` `.claude-lanes`). At a handful of models this
reads well; at thirty it is an unnavigable wall, which is what the user hit.

**4. Grok shows Sol at 200k.**
`src/grok/sync.ts:38-43` builds the model list as
`visibleNativeSlugs(config).map(id => ({ id }))` for native models — no
`contextWindow` — while routed models do pass theirs. `src/grok/inject.ts:161-162`
only emits a `context_window` line when the field is present, so native
`gpt-5.6-sol` reaches Grok with no context window and Grok falls back to its own
200k default. The correct value already exists in the repo:
`src/codex/catalog/metadata.ts:57` `NATIVE_GPT56_CONTEXT_WINDOW = 372_000`,
reachable via `nativeOpenAiContextWindow(slug)`.

**5. Grok tab.** No GUI surface exposes the Grok Build integration; it is
CLI/config-only today.

## Design Read — Desktop model management (item 3)

```yaml
---
name: opencodex-claude-desktop
surface: expert control panel inside a local dashboard
---
```

Reading this as: a **repeated-work operator tool** for a developer who already
knows what a model is, embedded in an existing dashboard with its own settled
language. Not a consumer surface, not a place for personality.

```
DESIGN_VARIANCE: 3
MOTION_INTENSITY: 1
Product density profile: D5
Reasoning: dense repeated-work assignment UI inside an existing admin shell; the
brief is "hard to handle when models grow", which is a density problem, not a
visual one. UX-DIAL-PRESET-01 Dashboard/SaaS admin is 3/2/5; motion drops to 1
because every interaction here is a discrete assignment, not a narrative.
```

**The lazy-user gate (UX-LAZY-01) decides the shape.** Applying it in order:

1. *Do nothing* — no. The wall of cards is the reported problem.
2. *Delete* — no. Every lane is a real Claude family the user must fill.
3. *Absorb* — yes, partially: the system can rank and hide instead of asking. Show
   assigned/available models first, and keep the long tail behind one control.
4. *Demote* — the rest goes behind search, which appears only when the list is
   long enough to need it.

**Do not invent a new pattern.** `gui/src/pages/Models.tsx:583-599` already solves
the identical problem in this same app: a search input that appears only past a
row-count threshold, a stable sort floating active rows to the top, and a
`Show {n} more` pager. Reusing it means the two densest pages behave the same way
and the i18n keys (`models.search`, `models.showMore`) already exist in all six
locales. Inventing a second idiom here would be the worse outcome even if it
looked nicer in isolation.

Do's: reuse the Models search/pager idiom; keep lanes as the assignment metaphor;
preserve drag-and-drop and keyboard move for the models that stay visible.
Don'ts: no new visual language, no motion flourish, no collapsing the four lanes
into a wizard (that is the inverse failure for a repeated-work tool), no emoji.

## Loop-spec

- Loop archetype: verifier-defined. Items 1, 2, 4 have exact pass/fail tests;
  item 3 is judged but bounded by reusing an existing in-app pattern; item 5 is
  structural.
- Write scope: `gui/src/`, `gui/tests/`, `src/claude/`, `src/grok/`,
  `src/server/management/`, `tests/`, `devlog/_plan/260726_gui_grok_improvements/`.
- Out of scope: security-boundary PR merges, `dev2-go`, `feat/macos-app`,
  release/version bumps, `main`/`preview` promotion.
- Bounds: local gates only. No push without explicit approval (LOOP-GIT-01).

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| WP0 | `000` (this doc) | Roadmap + Design Read | — |
| WP1 | `010_desktop_profile_parser.md` | Fix the `appliedFingerprint` parser rejection | — |
| WP2 | `020_locale_dropdown_viewport.md` | Fix the dropdown overflow | — |
| WP3 | `030_grok_native_context_window.md` | Pass native context windows to Grok | — |
| WP4 | `040_desktop_model_density.md` | Search + pager for the Desktop lanes | WP1 |
| WP5 | `050_grok_tab.md` | Grok tab surface | WP3 |
| WP6 | `060_final_gates.md` | Full gates and close-out | WP1–WP5 |

Ordering is dependency-driven (PHASE-SPLIT-01), most-broken first: WP1 is a hard
page failure, WP2 a visible layout break, WP3 a wrong number shipped to a client.
WP4 depends on WP1 because the Desktop page must load before its density can be
improved. WP5 follows WP3 so the tab reports correct context windows.

## Accept criteria

- `c-roadmap` — every item above cites the actual source location, and the
  Desktop UX direction is justified rather than asserted.
- `c-parser` — a profile carrying `appliedFingerprint`/`appliedAt` round-trips;
  regression test mutation-verified.
- `c-dropdown` — the locale menu stays inside the viewport at six locales.
- `c-grok-ctx` — native models reach Grok with their real context window.
- `c-density` — the Desktop lanes stay navigable as model count grows.
- `c-grok-tab` — the Grok surface renders and is reachable.
- `c-gates` — `bun run typecheck`, `bun run test`, `gui bun run test`,
  `bun run lint:gui`, `bun run privacy:scan`, zero new failures.
