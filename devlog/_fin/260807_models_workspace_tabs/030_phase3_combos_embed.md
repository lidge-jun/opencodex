# Phase 3 — Combos as a panel

Combos is the only surface in the GUI that opts out of the normal 980px scrolling
column: it is a full-bleed `100dvh` workspace whose rail and detail pane scroll
independently. Making it a tab means reconciling that with a page header and a tab
strip that must stay visible above it.

**Scope changed after audit round 1.** The CSS below **ships in phase 2**, in the same
commit that inserts the wrapper — repairing it a phase later would mean phase 2
knowingly ships a broken layout. It stays documented here because this is where the
reasoning belongs. What remains phase-3 work: the draft-preserving `active` path, the
abort signal, the inner-tab demotion, and the count callback.

## The selector that actually breaks

```css
.main-inner.main-inner--combos > .combos-workspace-shell { flex: 1 1 auto; min-height: 0; height: 100%; ... }
```

`gui/src/styles.css:399`. It is a **direct-child** selector. Today `Combos` returns
`.combos-workspace-shell` as `.main-inner`'s immediate child, so it matches.

As a tab, the shell sits inside a panel wrapper:

```
.main-inner--combos
├─ .page-head          (header, stays visible)
├─ .page-tabs          (strip, stays visible)
└─ #models-panel-combos   ← new wrapper
   └─ .combos-workspace-shell   ← no longer a direct child
```

The rule stops matching, the shell loses `flex: 1 1 auto` and `min-height: 0`, and the
workspace collapses to content height inside a clipped `100dvh` parent — rail and
detail scrolling both die.

An investigation pass reported that inserting siblings keeps the selector intact. That
is true for *siblings*, and false for the structure this phase actually builds, because
the panel wrapper adds a level. Verified by reading `gui/src/styles.css:399-405`
directly. Recording it because the wrong version of this claim would have shipped a
broken layout that typecheck and tests cannot see.

### Fix

Make the panel wrapper the flex child and let the shell fill it:

```diff
-.main-inner.main-inner--combos > .combos-workspace-shell {
+.main-inner.main-inner--combos > .models-tab-panel--fill,
+.main-inner.main-inner--combos .models-tab-panel--fill > .combos-workspace-shell {
   flex: 1 1 auto;
   min-height: 0;
   height: 100%;
   display: flex;
   flex-direction: column;
 }
```

The header and strip need horizontal padding back, since `.main-inner--combos` zeroes
the container's:

```css
.main-inner--combos > .page-head,
.main-inner--combos > .page-tabs,
.main-inner--combos > .page-sub { padding-inline: 36px; flex-shrink: 0; }
@media (max-width: 760px) {
  .main-inner--combos > .page-head,
  .main-inner--combos > .page-tabs,
  .main-inner--combos > .page-sub { padding-inline: 18px; }
}
```

`flex-shrink: 0` matters: without it the header is a flex item in a fixed-height column
and gets squeezed when the workspace wants room.

`.page-sub` is in that list because phase 2 moves the subtitle per tab. The first draft
padded only the header and strip, which would have left the Combos subtitle flush
against the viewport edge (audit B5).

### The 1200px selector

`.main-inner:has(.models-workspace-shell)` (`styles-models-workspace.css:8`) widens the
column, and a lazily-mounted **hidden** catalog panel still satisfies `:has()`. So
Routing would render at 980px on a direct visit and 1200px after the catalog had been
opened once — a width that depends on browsing history. The selector must require a
visible catalog panel (`:has(.models-tab-panel:not([hidden]) .models-workspace-shell)`
or equivalent). Ships in phase 2 with the rest of the CSS.

The two mobile rules (`gui/src/styles.css:1983`, `2020`) need no change — they set the
container height and padding, and both still apply.

## Why the modifier stays in App

`.main-inner` belongs to `App.tsx`; a page cannot add a class to its own container
without a callback or a portal. So App keeps the modifier and reads the tab (phase 2),
which is the smallest coupling available. The alternative — Models rendering its own
full-height wrapper inside the 980px column — does not work, because `.main-inner` has
`max-width: 980px` and normal padding until the modifier removes them.

## Inactive panels

The other two panels are `hidden`, which is `display: none` in the UA stylesheet, so
they occupy no flex space. No extra rule needed.

## MODIFY `gui/src/pages/Combos.tsx`

### Props

```diff
-export default function Combos({ apiBase }: { apiBase: string }) {
+export default function Combos({ apiBase, active = true }: { apiBase: string; active?: boolean }) {
```

Default `true` keeps every existing call site and test honest.

### Gate the fetch

`Combos` fires three parallel fetches (`/api/combos`, `/api/config`, `/api/models`) on
subscription. It does **not** poll — no `pollMs` — so the risk of a permanently mounted
panel is a wasted cold load, not a background traffic leak. Still worth gating:

```diff
 const resource = useDataSurface<CachedCombosPage>(
   `combos-workspace:${apiBase}`,
   [apiBase],
   loadCombos,
-  { ... },
+  { ..., enabled: active },
 );
```

### The trap the first draft walked into

A disabled resource yields `data: undefined` with no skeleton and no error
(`data-surface.ts:59`), and the existing fallback arrays would make `ComboWorkspace`
paint as a first-run empty state. The first draft's answer was "render the skeleton
instead" — which is wrong in a way that defeats the whole point: the skeleton
*replaces* `ComboWorkspace` (`Combos.tsx:223`), unmounting the editor and destroying the
unsaved draft this design exists to protect (audit B3).

The rule is: **gate the network, never the tree.**

An earlier draft said "hold the last payload in a ref and read it during render." Audit
round 2 rejected that mechanism, correctly: this repository avoids render-time ref reads
under React Compiler / `react-hooks/refs` (`client-resource.ts:353`), so it can fail lint
and is unsound under concurrent rendering. A rule is not a mechanism, and the one I wrote
would not have survived the linter.

The concrete design:

```tsx
const [retainedData, setRetainedData] = useState<CachedCombosPage | null>(() => seed);

// loadCombos already assembles one coherent payload from three responses; retain there.
const data = resource.state.data ?? retainedData;
```

- `retainedData` lives in **state**, seeded from the session cache.
- It is written where `loadCombos` produces its coherent payload — one place, never a
  render side effect.
- Render `state.data ?? retainedData`.
- The cold skeleton appears only when **both** are absent.
- `active` going false never replaces an already-rendered `ComboWorkspace`.

Proven by a mounted test: open a combo, type into the draft, switch to Models, switch
back, expect the typed value still there. Not by a source-string assertion.

### Pre-existing defect found while reading

`loadCombos` takes no `AbortSignal` and none of its three `fetch` calls pass one, so
resource cleanup cannot cancel them. Harmless today because the page only unmounts on
navigation; more visible once the panel mounts lazily. Threading the signal through is
a two-line change and belongs here rather than in a separate unit — it is the same code
being touched, and leaving a known un-cancellable fetch behind while explicitly adding
lifecycle control would be incoherent.

### Dialogs

Add, Remove, and Unsaved use native `showModal()`. A dialog in the browser's top layer
is not clipped by an ancestor's `hidden`. Whether an open dialog can survive a tab
switch depends on whether `hidden` on an ancestor closes it — **this must be checked in
the browser, not reasoned about.** If a modal does survive, the fix is to close open
dialogs when `active` goes false.

## MODIFY `gui/src/components/combo-workspace-detail-panel.tsx` — inner tabs

Currently `combos-workspace-tabs` / `combos-workspace-tab` with `role="tablist"` and
`aria-selected`. Not `.page-tabs`, but visually the same underline vocabulary, so under
the page strip it reads as two stacked underline rows — the pattern Primer names
directly.

Demote to a pill, following `.segmented.models-segmented` at `Models.tsx:924`:

```diff
-<div className="combos-workspace-tabs" role="tablist">
-  <button role="tab" aria-selected={tab === "config"}
-          className={`combos-workspace-tab${tab === "config" ? " combos-workspace-tab--active" : ""}`}>
+<div className="segmented combos-workspace-segmented" role="tablist">
+  <button role="tab" aria-selected={tab === "config"}
+          className={`btn btn-sm ${tab === "config" ? "btn-primary" : "btn-ghost"}`}>
```

**Roles stay `tablist`/`tab`/`aria-selected`.** The existing markup controls a real
`role="tabpanel"`, so this is a tab set wearing pill styling — not a filter. The
`radiogroup` precedent in `models-segmented` is for filters that control no panel; using
it here would misdescribe the widget. Pills are a visual change only.

`.segmented` has no standalone declaration in the GUI; every use pairs it with a
concrete class. So `styles-combos-workspace.css` gets `.combos-workspace-segmented`
mirroring `.models-segmented` (`styles-models-workspace.css:274-291`), and the four
underline rules at `styles-combos-workspace.css:220-248` are removed.

## Tests

Correcting a claim left standing in this document from the first draft: `#combos` **is**
covered — `gui/tests/page-loading-contract.test.tsx` boots at that hash (`:136`) and
asserts `.combos-workspace-shell-body` (`:183`). It is updated in wp02b. What follows is
additional coverage, not first coverage.

Behavioural, in `gui/tests/` (run with `cd gui && bun test tests` — the root
`bun run test` does not reach that suite):

- Type into a combo draft, switch tabs, switch back — the draft survives (audit B3).
- With Combos hidden, no `/api/combos` request fires.
- The detail panel renders no element carrying both `role="tab"` and an underline class.
- After creating or deleting a combo, the tab count updates (audit B7).

Source-string checks (`segmented` present, `models-tab-panel--fill` in the CSS) are kept
as cheap supplements only. The CSS one is unavoidable — a stylesheet rule has no other
unit-testable surface — which is exactly why the browser observation below is required
rather than optional.

## Tab count plumbing (audit B7)

Models' combo summary uses a different resource key than the Combos workspace
(`Models.tsx:143` vs `Combos.tsx:157`), and combo mutations refresh only their own
(`Combos.tsx:186`). So a create or delete leaves the tab count stale.

Fix: `Combos` takes an `onCountChange?: (n: number) => void` and calls it whenever its
list changes, including after mutations. The shell holds the count. Same shape for
Routing in phase 4, which otherwise has no channel to report `profiles.length` at all —
without this the promised "the tab carries a profile count" mitigation cannot ship.

Call it from an **effect keyed on the authoritative list length**, never during render,
and keep the parent callback stable with `useCallback` so the effect does not refire on
every parent render.

## Verification

Four gates, plus browser observation focused on this phase's two unknowns: does the
workspace still fill the viewport under the header and strip, and does an open modal
survive a tab switch. Both are invisible to typecheck and tests.
