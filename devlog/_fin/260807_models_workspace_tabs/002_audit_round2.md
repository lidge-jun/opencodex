# Audit round 2 — VERDICT: FAIL

Round 1's eight blockers came back as three resolved, four partially resolved, and one
resolved-with-a-caveat, plus five new findings. Accepted in full again. The pattern is
consistent and worth naming: round 1 caught *missing* work, round 2 caught **rules
written where mechanisms were required.** "Gate the network, never the tree" is a
correct invariant and not an implementation.

## The finding that invalidates the verification plan

**`bun run test` does not run `gui/tests/`.** `scripts/test.ts:122` defaults to
`["./tests/"]`, so the 116-file GUI suite needs `cd gui && bun test tests`. Confirmed by
running it: `gui/tests/routing-profiles.test.tsx` passes 6/6 under the GUI command and
is never reached by the root one.

Round 1 taught me the directory existed. I then wrote into `000_plan.md` that the root
command covers both — an assumption, stated as fact, in the document that defines what
"green" means. Every phase gate now names both commands explicitly.

## Blockers

**B3 (drafts) — the mechanism is unsafe as written.** I specified a ref read during
render. This repository avoids exactly that under React Compiler / `react-hooks/refs`
(`client-resource.ts:353`), so it can fail lint and is unsound under concurrent
rendering. The reviewer supplied the correct shape and I am adopting it verbatim:
`retainedData` in **state**, seeded from the session cache, updated when `loadCombos`
produces a coherent payload, rendered as `state.data ?? retainedData`, cold skeleton
only when both are absent, and never replacing a rendered `ComboWorkspace` because
`active` went false.

**B4 (cancellation) — ownership was never assigned.** `load` in `RoutingProfiles` has
four entry points: the initial effect (`:243`), Retry (`:426`), post-save (`:291`),
post-delete (`:321`). An effect-local controller cancels only the first; a Retry or
mutation reload keeps running after the tab hides. Generation invalidation blocks the
*write* but not the *work*.
→ `load` owns a component-level `loadAbortRef`: each call aborts and replaces the
previous controller, every fetch takes that signal, deactivation aborts and bumps the
generation, and the ref is cleared only by the request that still owns it.

And Models is worse than I recorded: `fetchCatalog` **accepts** a signal and passes it to
none of its four requests (`Models.tsx:212`). Disabling the resource stops the state
write, not the network. Phase 2 must thread it and gate all four workers — catalog
resource, combo-summary resource, shadow-call load, V2 load *and* interval. My phase-2
text named only two.

**B5 (`.page-sub`) — I wrote two incompatible designs.** Phase 2 moves the subtitle
*inside* each panel; phase 3's CSS targets `.main-inner--combos > .page-sub`, a direct
child. Those cannot both be true, and the selector would simply never match.
→ Locking the reviewer's recommendation: **one subtitle for the active tab, rendered as
a direct sibling between the strip and the panels.** The documented selector then works
and the fill panel gets the remaining height. A subtitle per panel buys nothing when
only one panel is visible.

**B8 (test scheduling) — one edit lands two phases early.** Phase 2 scheduled changing
`gui/tests/routing-profiles.test.tsx`, but the heading it asserts is removed in phase 4.
Editing it early means either a red wp02 or coverage deleted two phases before the
behaviour changes.
→ That mounted test is untouched through wp03 and changes atomically with the heading in
wp04. Also fixing the stale "no existing test references `#combos`" line still sitting in
`030` — round 1 disproved it and I corrected the claim in one document but not the other.

**NEW — `Models 0/0` on a cold direct load.** Phase 2 stops catalog work while the
catalog is hidden, but the header and tab meta read `effectiveVisibleCount` /
`models.length`, which start empty. Land directly on `#models/combos` and the strip
confidently reports `Models 0/273` → `0/0`. That is the exact failure my own rule warns
about: "a wrong count is worse than none."
→ Track catalog-count readiness explicitly and omit the meta until a session seed or a
successful response exists.

## The split I should have found myself

The reviewer's judgement that wp02 is now too large to verify as one unit is correct, and
the proposed split is better than anything I had, because it never creates a broken
intermediate:

**wp02a — additive.** Build the whole nested workspace *while the legacy pages keep
working*: tab i18n, tab shell, nested panels, per-panel boundaries, active-aware CSS,
catalog gating. `Page` keeps `combos` and `routing`; their App branches and the Routing
NAV row stay. The full-bleed modifier accepts either condition:
`page === "combos" || (page === "models" && modelsTab === "combos")`. Both routes render.
Every existing Routing test stays valid.

**wp02b — the cutover.** Remove the union members, the standalone branches and imports,
the Routing NAV row and `IconRoute`; add the legacy redirects; repoint the three
`href="#combos"` links; simplify the modifier; update the root routing tests.

The old form dies only once the new form is proven in the same tree. That is strictly
better than my "atomic big phase," which was atomic in the sense of *unreviewable*.

## Document drift, fixed

- `000_plan.md` still said Routing polls analytics — disproved in round 1, corrected in
  `040` only.
- `000_plan.md` still credited wp01 with the `Page` union removal, which moved to wp02.
- `040` still repeated the tab-key table that now ships in wp02.

Three separate cases of correcting a claim in one document and leaving it standing in
another. The roadmap is the artifact the build phase executes from, so a contradiction
between its pages is a defect in the deliverable, not an editing slip.

## Revised phase map

| Phase | Scope |
|-------|-------|
| wp01 | Additive hash contract + `models-tab.ts` (unchanged) |
| wp02a | Nested workspace alongside the legacy pages; both routes render |
| wp02b | Route cutover: union removal, redirects, links, Routing NAV row |
| wp03 | Combos panel: `retainedData` state path, abort signal, inner tabs, count callback |
| wp04 | Routing panel: shared abort controller, heading removal + its test, Claude row, subtitles, render grounding |

Five implementation phases plus this roadmap cycle. Gate for every one:
`bun run typecheck` **and** `bun run test` **and** `cd gui && bun test tests` **and**
`bun run lint:gui` **and** `bun run build:gui`.
