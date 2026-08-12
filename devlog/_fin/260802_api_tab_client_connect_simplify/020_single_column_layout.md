# 020 — Single-column layout

Dependency position: **first**. Revised at the A gate — see `000` §"Why the
layout phase runs first". This phase treats `ClientConfigPanel` as an opaque
child: it moves the node without reading it, so it does not depend on `010`,
while `010` does depend on the final container width this phase establishes.

Base: `eeef7012`. At this phase's P gate, re-read the current tree — which for
this phase is the **pre-`010`** source, since this phase runs first — and rebase
every citation. The original instruction to read "the landed `010` diff" was an
artifact of the superseded ordering.

## Scope

IN

- Collapse `.awi-overview` from two columns to one.
- Model catalog and auth matrix render at full main-track width (708px, not the
  976px shell — the rail keeps its 240px).
- Remove the stacked-chip workaround now that the row has width.
- Rail disposition (see §Rail decision — measured at the P gate; the rail stays).
- Section ordering. The `SectionTabs` decision is deferred to `010`.
- Update `gui/tests/apikeys-layout.test.ts` contracts.

OUT

- Panel internals. This phase runs before `010`, so what it moves is the
  **current** `ClientConfigPanel`, unchanged and unread; `010` then rebuilds that
  panel's internals inside the container this phase establishes.
- The catalog's `min(574px, 58vh)` cap and its `overscroll-behavior: auto`
  wheel-handoff rule. Both stay exactly as they are.
- Attribution semantics, key CRUD contracts, the auth matrix's data source.
- Any `src/` change.

## Rail decision

`002` §7 left this open with a stated lean. It is resolved **here**, at this
phase's P, with the reviewer's verdict recorded — not assumed now.

The decision rule, fixed in advance so the outcome is not rationalized after the
fact:

> Fold the rail into a table if and only if the table can carry every fact the
> rail row carries (name, 7-day requests, last used) plus the two the detail
> pane adds (prefix, created), without a horizontal scroller at 1280x720, and
> with delete/rename reachable in at most one extra interaction.

If it can, the rail goes and the tab is genuinely one column — the literal ask.
If it cannot, the rail stays and this phase delivers a single-column *overview*
with the rail retained, which still removes one of the three bands.

A five-column table of `name · prefix · 7d requests · last used · actions` at
~1130px of usable width is not a demanding layout, so the expected outcome is
fold. That expectation is not evidence; the P-phase measurement is.

### Measurement (P gate, 2026-08-02, corrected after audit)

A first pass at this measurement reached 1128px and concluded the rail folds.
That was wrong twice over, and the audit caught both errors. The corrected
arithmetic is below; the first pass is left described rather than deleted so the
failure mode stays visible.

**Error 1: the app sidebar was omitted.** `.app` is
`grid-template-columns: 232px 1fr` (`styles.css:241`). At a 1280px viewport the
main column is 1048px, so the 1200px shell cap is never reached at all.

**Error 2: the `created` column was dropped.** The rule names five data facts —
name, prefix, 7-day requests, last used, **created** — plus actions. The budget
counted four.

Everything is `border-box` (`styles.css:154`), so each shell subtracts from the
one above it.

| Step | Width |
|---|---|
| Viewport | 1280 |
| − app sidebar (`styles.css:241`) | 1048 |
| − `.main-inner` padding 36×2 (`styles.css:393`) | **976 shell content** |
| − `.api-panel` border 1×2 | 974 |
| − `.api-panel` padding 18×2 | 938 |
| − `.tbl-wrap` border 1×2 (`styles.css:919`) | 936 |
| − `.tbl-wrap` padding 12×2 (`styles.css:925`) | **912 table interior** |

Six-column budget, with `.tbl` cell padding of 24px per column
(`styles.css:914-915`):

| Column | Content |
|---|---|
| name | 200 |
| prefix | 130 |
| 7d requests | 110 |
| last used | 150 |
| created | 150 |
| actions | 180 |
| content subtotal | 920 |
| + cell padding 24 × 6 | 144 |
| **total** | **1064** |

**1064 > 912 — overflows by 152px.** And that is the optimistic case: the
`7d requests` header is "Requests, last 7 days" in English, "Anfragen, letzte 7
Tage" in German, "Запросы за 7 дней" in Russian (`en.ts:1375`, `de.ts:927`,
`ru.ts:1365`), none of which fit 110px on one line. Key names are valid to 64
characters (`api-keys-utils.ts:63`) with legacy 200-character names preserved
server-side, and no truncation contract exists.

### Decision: the rail STAYS

The rule was written to be binding, and it binds against the outcome this phase
expected. The table cannot carry all six columns without a horizontal scroller
at 1280×720, so the fixed rule's own fallback applies:

> If it cannot, the rail stays and this phase delivers a single-column
> *overview* with the rail retained, which still removes one of the three bands.

That is the delivered scope, and the geometry is worth stating exactly, since an
earlier draft used a ~426px estimate that the same sidebar omission inflated:

| | Today | After this phase |
|---|---|---|
| Shell content | 976 | 976 |
| Rail + root gap | 252 | 252 |
| Main track (− 8×2 pad) | 708 | 708 |
| Overview tracks | **339 / 357** (`1fr / 1.05fr`) | **708**, one track |
| Panel interior | ~301 / ~319 | **~670** |

Panel interior slightly more than doubles. That is the whole defect: 300px is
why the four-column auth matrix clips and why the catalog stacks its chips.

The maintainer's "3분할은 진짜 없애고 싶어" is satisfied in the sense that
matters — the three-band geometry becomes rail + one content band, and the split
that clips the matrix and wraps the chips is gone. It does **not** satisfy a
stricter reading of "remove the rail entirely", and that distinction is stated
here rather than blurred.

This is worth stating plainly rather than burying: **going to a literal single
column would require either dropping a key fact, adding a horizontal scroller,
or a card layout instead of a table.** All three are worse than keeping a rail
that now has attribution data to justify it. If the maintainer wants the rail
gone regardless, that is a scope decision for them, not an arithmetic one, and
it should be raised rather than assumed.

### Consequences of the reversal

- `ApiKeyDetailDialog.tsx` is **not** added. The existing detail pane stays.
- No key-table headers are added, so `lint:i18n` returns to conditional and this
  phase makes **no locale change at all**.
- The §Rail-fold test ledger does not fire. `apikeys-workspace.test.tsx`,
  `apikeys-mutation-timeout.test.tsx`, and `apikeys-refresh-preserve.test.tsx`
  are untouched — which also disposes of the audit's finding that the ledger was
  incomplete: the three rail-dependent files the first draft never mapped
  (`apikeys-mutation-timeout.test.tsx:132/161/206`,
  `apikeys-refresh-preserve.test.tsx:196`) now need no mapping.
- `apikeys-layout.test.ts:32` keeps its overview/`showKeyList={false}`/detail
  toolbar/back-chevron assertions verbatim; only the breakpoint values move.
- The interaction, keyboard-focus, and 375px table contracts the audit demanded
  are moot: no table and no new dialog ship in this phase.

### What this phase still delivers

Unchanged by the reversal, and still the whole point:

1. `.awi-overview` collapses to one column — the 339/357px tracks become one
   708px track, roughly doubling panel interior from ~300px to ~670px.
2. The auth matrix renders all four columns without a horizontal scroller.
3. Catalog rows fit `Copy ID` plus every protocol chip on one line.
4. Sections gain a deterministic reading order.

## File change map

| Path | Action |
|------|--------|
| `gui/src/styles-apikeys-workspace.css` | MODIFY — see §CSS action map; the range is **split**, not deleted wholesale |
| `gui/src/components/apikeys-workspace/ApiKeysWorkspace.tsx` | MODIFY — one ordered section list; rail per §Rail decision |
| ~~`gui/src/pages/api-keys-endpoints-panel.tsx`~~ | **NOT MODIFIED** — see below |
| `gui/tests/apikeys-layout.test.ts` | MODIFY — per §Test changes |

That is the **complete** write set: two source files and one test file.

`api-keys-endpoints-panel.tsx` was in an earlier draft on the theory that a
wider matrix no longer needs `.api-auth-matrix-scroll`. The audit rejected that
and it was right: a `overflow-x: auto` wrapper shows no scrollbar once its
content fits, so widening the column removes the scrollbar by itself. Deleting
the wrapper would only remove the safety net that keeps the nowrap matrix from
overflowing the page at 375px. The fix here is CSS width, not JSX surgery.

Explicitly NOT touched, because the P-gate measurement refused the rail fold:

| Path | Why not |
|------|---------|
| `gui/src/pages/api-keys-panels.tsx` | No key table is built |
| `gui/src/components/apikeys-workspace/ApiKeyDetailDialog.tsx` | Not created; the existing detail pane stays |
| `gui/src/i18n/*` | This phase changes no copy |
| `gui/tests/apikeys-workspace.test.tsx` | The rail is unchanged, so its assertions hold |
| `gui/tests/apikeys-mutation-timeout.test.tsx` | Same |
| `gui/tests/apikeys-refresh-preserve.test.tsx` | Same |

Acceptance criterion 7 turns that table into a guard: touching any row in it
means the phase exceeded its scope.

## CSS action map

The first draft said "delete `:183-268`". The audit caught that this range
contains load-bearing rules the same document promises to preserve. Split
explicitly:

Line ranges verified against `styles-apikeys-workspace.css` at `eeef7012`. The
audit found two errors in the first split — a block of column-agnostic shared
rules swept into a REMOVE bucket, and a sticky block whose end line was short by
four — so each range below is stated separately rather than in a sweep.

| Range | Selector | Action | Why |
|-------|----------|--------|-----|
| `:183-190` | `.awi-overview` grid | REPLACE — single track | The two-column split itself |
| `:192-198` | `.awi-overview-left, .awi-overview-right` flex | REMOVE | Column containers cease to exist |
| `:200-203` | `.awi-overview-left > .panel, .awi-overview-right > .panel` margin reset | RETARGET to the single container | Still needed; the selector is column-named |
| `:205-207` | `.awi-overview-left > .panel` flex | REMOVE | Column-scoped |
| **`:209-220`** | `.awi-overview .api-panel`, `.api-auth-list`, `.api-endpoints` | **KEEP UNCHANGED** | Column-agnostic — these are scoped to `.awi-overview` itself, not to a side. Touching them changes panel padding and endpoint spacing for no reason |
| `:222-225` | `.awi-overview-left > .panel > p.muted.small` | RETARGET | Prose spacing; selector rename only |
| `:227-230` | `.awi-overview-right > .panel:not(.api-models-panel)` | REMOVE | Column-scoped |
| **`:231-241`** | `.awi-overview-right > .api-models-panel { overflow: visible }` | **RETARGET, NEVER DELETE** | The browser-measured wheel-handoff fix. Deleting it silently re-traps the wheel and no static test catches it |
| `:243-248` | models-panel flex children | RETARGET | Selector rename only |
| **`:254-262`** | `.api-models-scroll` cap + `overscroll-behavior: auto` + `scrollbar-gutter` | **RETARGET, NEVER DELETE** | The tab's only legitimate cap; the scroll test asserts its exact value |
| **`:265-272`** | sticky `thead th` | **RETARGET, NEVER DELETE** | A long catalog without it becomes unlabelled columns |
| `:405-419` | `.api-model-actions` | MODIFY — see §The chip rule | Not a plain deletion |

Every RETARGET is a selector rename that must keep the declaration block
byte-identical. Re-verify these line numbers at this phase's P gate; the file
will have moved if any earlier work lands first.

## The chip rule

The first draft planned to assert "no `flex-direction: column`". The audit
demonstrated that assertion is **false-green**: `.api-model-actions` at `:409`
has no `flex-direction` today, so the test would pass against the unmodified tree
and prove nothing.

The actual mechanism is `flex-wrap: wrap` inside a ~300px panel interior. The fix is
width, and the observable is that the actions no longer wrap.

Required discipline: **drive the new assertion red first.** Write it, run it
against the pre-change tree, confirm it fails, then implement. An assertion that
has never been red is not evidence. The static test asserts the wrap rule is
removed or overridden; the rendered check at 1280px is what actually proves one
line, and it is mandatory.

## Section order

```
API Access  ·  base URL + primary action
─ Keys              (rail-backed detail — the rail stays, per §Rail decision)
─ Connect a client  (010's rows)
─ Endpoints & auth  (full-width matrix)
─ Models            (full-width catalog, capped, sticky header)
─ Examples          (curl)
```

Rationale: identity first (you need a key), then transport (where to point a
client), then reference (what the endpoints accept), then inventory (what to
call), then examples. Each step is a precondition of the next, which is also why
`ApiKeysUsagePanel` moves from third to last — its current position is an
artifact of column packing, not of reading order.

**`SectionTabs` is not decided in this phase.** The decision and its measurement
belong to `010` (accept criterion 11).

Reason: this phase runs first, so any page-height measurement it takes still
includes the full config JSON rendered at rest
(`ClientConfigPanel.tsx:182-190`). `010` replaces that block with compact rows,
which can move the page back under the threshold and reverse the answer. A strip
added here on a measurement `010` invalidates is a strip added for a page that
no longer exists.

## Test changes

| Test | Change | Guard carried |
|------|--------|---------------|
| `apikeys-layout.test.ts:157` "left column keeps its order" | REPLACE with a single ordered section-list assertion | Deterministic section order |
| `apikeys-layout.test.ts:118` "page owns vertical scroll" | KEEP verbatim | Exactly one cap, exact value, `overscroll-behavior: auto`, sticky header |
| `overflow: visible` assertion on the models panel | RETARGET to the new selector | The browser-measured wheel handoff |
| `apikeys-layout.test.ts:32` container-query assertions | UPDATE breakpoints | Stacking behavior at narrow widths |
| NEW "the overview is a single column" | ADD | The ask, made enforceable |
| NEW "catalog actions do not wrap" | ADD, **driven red first** | The real mechanism (`flex-wrap`), not the strawman (`flex-direction`) |

### Rail-fold test ledger — DOES NOT FIRE

Retained as a record of what the fold would have cost, and as the contract to
satisfy if a future unit revisits the decision. The P-gate measurement refused
the fold, so **none of the migrations below are performed** and the listed files
stay untouched. The audit also established this ledger was incomplete even as
written: it never mapped `apikeys-mutation-timeout.test.tsx:132/161/206`
(navigation locking during delete/rename) or
`apikeys-refresh-preserve.test.tsx:196` (last-good keys surviving a failed
post-delete refresh). Any future fold must map those too.

`gui/tests/apikeys-workspace.test.tsx` carries four behavioral contracts the
first draft did not map. Folding the rail without this ledger would delete them
silently. Each needs a named destination before any code moves:

| Existing contract | Destination after fold |
|---|---|
| Pending-secret preservation across selection | Same behavior in the table's row-activation path |
| Delete-confirm reset and return behavior | The key detail dialog's confirm flow |
| Stale selected-key fallback | Table selection state when the selected key disappears |
| Truncated-attribution wording | The detail dialog's attribution section |

If any contract has no honest destination, the rail does **not** fold — that
outcome is a legitimate result of the §Rail decision rule, not a failure.

## Accept criteria

1. `.awi-overview` declares a single column track at every width.
2. At 1280x720 rendered: the auth matrix shows all four columns with no
   horizontal scrollbar.
3. At 1280x720 rendered: a catalog row shows `Copy ID` and every protocol chip
   on one line **and all of them are simultaneously visible**. Merely counting
   lines is not enough, and neither is checking the actions container alone:
   removing `flex-wrap` lets the cell grow to the buttons' min-content width, so
   `.api-model-actions` can report `scrollWidth === clientWidth` while the
   **ancestor** `.api-models-scroll` (`styles-apikeys-workspace.css:254`,
   `overflow-x: auto`) is the element actually overflowing and hiding the last
   chip. Assert on the ancestor:

   - `.api-models-scroll` has `scrollWidth === clientWidth`, and
   - every action button's bounding rect lies inside that scroller's viewport.

   Check with German or Russian labels, which are the longest.
4. The catalog remains the only `max-height` in the stylesheet, still
   `min(574px, 58vh)`, still `overscroll-behavior: auto`, still sticky-headed.
5. Wheel handoff at the end of the catalog still scrolls the page.
6. Sections appear in the §Section order sequence.
7. The rail and its detail pane are unchanged: `apikeys-workspace.test.tsx`,
   `apikeys-mutation-timeout.test.tsx`, and `apikeys-refresh-preserve.test.tsx`
   pass **without edits**. An edit to any of them means this phase exceeded its
   scope.
8. Zero keys still renders the honest "No API keys" empty state alongside a
   visible Generate action — the existing `api.noKeys` branch at
   `api-keys-panels.tsx:134`, preserved and asserted rather than narrowed to
   "Generate is visible".
9. Key order is whatever the route returns; this phase introduces no client-side
   sorting.
10. The GUI gate set passes: from `gui/`, `bun test tests`, `bun run lint`, and
    `bun run build`.

### Activation scenarios

| Conditional path | Trigger in C | Observable effect |
|------------------|--------------|-------------------|
| Narrow-width stacking | Render at 720px | Sections stack; no horizontal page scroll |
| Catalog wheel handoff | Scroll to the catalog's end, keep scrolling | Page scrolls; catalog does not trap |
| Narrow-width rail stacking | Render at 720px | Rail stacks above the main pane; no horizontal page scroll |
| Empty-keys state | Render with zero keys | Generate action visible without scrolling |

## Verifier commands

All commands run from `gui/` with this checkout's Bun
(`../node_modules/.bin/bun`), per `gui/AGENTS.md:42`.

| Command | Reads this phase's target? |
|---------|---------------------------|
| `bun test tests` | Yes — `apikeys-layout.test.ts` reads the stylesheet as text; `apikeys-workspace.test.tsx` mounts the workspace |
| `bun run lint` | Yes |
| `bun run build` | Yes — `tsc -b && vite build`; this, not root `typecheck`, is what typechecks the GUI |
| `bun run lint:i18n` | Not required — this phase changes no copy. It becomes required in `010`, which does |
| Rendered observation at 1280x720 | Yes, and it is the only check that can see criteria 2, 3, and 5 |

Root `bun run typecheck` is **not** listed: `tsconfig.json:15` includes only
`src`, so it cannot fail on a GUI change (`001` §7).

Criteria 2, 3, and 5 are unreachable by static gates. A green suite with a
clipped matrix is exactly the failure this phase exists to fix, so the rendered
observation is mandatory (C-RENDER-GROUNDING-01) and its screenshot is persisted
to this unit.

## Bypass record

- Tier: E8 (test suite).
- Executing surface: `bun run test`.
- Known bypass: the layout assertions read CSS as text, so a rule moved to an
  inline style or a different file passes them while the rendered page regresses.
- Residual risk: real; the rendered check is what actually covers it, and it is
  human-run.
- Wording: early warning, not enforcement. Final enforcement layer: none.
