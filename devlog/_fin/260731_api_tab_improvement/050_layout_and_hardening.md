# 050 — Phase 5: layout and hardening

Final phase. It removes the API tab's fixed-viewport exception and closes the
remaining correctness/accessibility defects after phase 4 has stabilized the detail,
matrix, and protocol-test markup. The page returns to normal document scrolling;
the model table is the only vertically capped region.

Dependency position: after `040_gui_detail_and_matrix.md`. At this phase's P gate,
re-read the actual phase-4 diff and rebase every context block below. In particular,
do not overwrite phase 4's auth matrix, async delete/rename contracts, protocol chips,
or the client-config unit's panel insertion. The current-code citations in this plan
are from base `33caf3364`.

## Scope

IN

- Remove the large-desktop `100dvh`/`overflow:hidden` shell and all vertical inner
  scrollers except the model table.
- Change the model table to the settled Usage rule: bounded height,
  `overscroll-behavior:auto`, sticky header.
- Distinguish an empty catalog from an empty filtered result (W9).
- Give model loading failures an in-place retry (W13).
- Render every usage example in the document instead of a closed disclosure (W16).
- Delete the dead `api.workspace.selectKeyHint` key (W10).
- Replace the current eight-key locale smoke with exact parity for every `api.*` key
  across all six dictionaries.
- Prove wheel handoff in a rendered browser, not by CSS inspection.

### Moved into phase 4 (000_plan.md §Where the small correctness fixes go)

W4 (clipboard failure), W14 (live region on test results) and W15 (name
`maxLength`) are **not** in this phase. They belong beside the markup that owns
them: phase 4 rewrites the copy handlers, builds the per-protocol result chips,
and adds the rename input. Splitting them out into a later "hardening" pass was
effort-bucketing — it grouped by size rather than by dependency, and it would
have shipped a rename field in phase 4 that phase 5 then had to revisit to add
one attribute.

What remains here genuinely depends on this phase: W9 and W13 sit in the models
panel this phase restyles, W16 and W10 are the disclosure/dead-key cleanup that
the scroll rewrite touches anyway, and the parity test can only assert totals
once every string in the unit exists.

OUT

- No phase-4 contract or component redesign.
- No expiry, scopes, rotation, forwarded-header/public-origin, routing, adapter,
  catalog, or provider-registry work (`000_plan.md` §Scope boundary, OUT).
- No panel addition/removal/reorder in `awi-overview-left`
  (`000_plan.md` §Coordination). Usage changes from `<details>` to an open `<section>` in
  the same third position.
- No cap on the key rail, detail pane, overview column, auth matrix, curl examples,
  or page shell. Horizontal overflow for tables/code is not a vertical content cap.
- No new scroll library, observer, or dependency.

## Settled layout rule

The API stylesheet still describes itself as natural-scroll with a desktop lock
exception (`gui/src/styles-apikeys-workspace.css:1-8`). Storage records why that
exception was removed: nested `contain` scrollers kept the wheel from reaching the
page (`gui/src/styles-storage-workspace.css:11-23`). Usage then set the bounded-list
rule: cap the genuinely long table and hand the wheel back with `auto`
(`gui/src/styles-usage-workspace.css:149-182`). This phase applies those decisions;
it does not invent a fourth scroll model.

The two-column API rail/detail layout may remain on wide screens. “Converge” means
normal page ownership of vertical scroll and a single justified inner cap, not a
copy of Storage's information architecture. Phase 4's attribution makes the API rail
comparative and therefore worth retaining (`003_ux_direction.md` §2).

## File change map

| Path | Action |
|------|--------|
| `gui/src/pages/ApiKeys.tsx` | MODIFY — model count/retry plumbing |
| `gui/src/pages/api-keys-panels.tsx` | MODIFY — retry/empty states, open usage section |
| `gui/src/styles-apikeys-workspace.css` | MODIFY — remove viewport lock and nested vertical scrollers; cap/stick model table; open usage styles |
| `gui/src/i18n/{en,ko,ja,zh,de,ru}.ts` | MODIFY — the empty-vs-filtered strings; delete the dead key in all six |
| `gui/tests/apikeys-layout.test.ts` | MODIFY — exact six-locale `api.*` parity and scroll/source guards |
| `gui/tests/apikeys-actions.test.tsx` | MODIFY — empty/filter distinction and model retry |

`api-keys-utils.ts` and `ApiKeysWorkspace.tsx` are **not** in this phase's map:
the name-length constant and the rename input's `maxLength` moved to phase 4 with
the rest of the moved fixes above.

No docs-site change belongs to phase 5. Phase 4 owns the auth documentation
correction; these changes alter interaction/layout, not setup semantics.

## CSS diffs

### `gui/src/styles-apikeys-workspace.css:79-85,175-180` — page owns rail/detail scroll

Current rail list:

```css
.apikeys-workspace-rail-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  max-height: min(420px, 50vh);
}
```

After:

```css
.apikeys-workspace-rail-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
}
```

Current detail body:

```css
.awi-detail-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding-top: 14px;
}
```

After:

```css
.awi-detail-body {
  min-height: 0;
  padding-top: 14px;
}
```

Also remove the mobile/container `max-height: 220px` declarations at
`styles-apikeys-workspace.css:489-525`. A long key list must extend the document;
“cap only the model table” is literal.

### `styles-apikeys-workspace.css:230-255` — model table is the one cap

Current code, quoted in full because this is the scroll boundary being replaced:

```css
.awi-overview-right > .api-models-panel {
  display: flex;
  flex-direction: column;
  /* Non-desktop fallback only — desktop media query clears this. */
  max-height: min(34rem, 70vh);
  overflow: hidden;
  flex: 0 0 auto;
}

.awi-overview-right .api-models-panel > .input,
.awi-overview-right .api-models-panel > .api-panel-head,
.awi-overview-right .api-models-panel > .muted {
  flex: 0 0 auto;
}

/* Flat table — scroll inside the panel, no nested bordered box. */
.awi-overview-right .api-models-panel > .api-models-scroll {
  margin-top: 0.5rem;
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: auto;
  overflow-y: scroll;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  box-shadow: inset 0 -14px 14px -14px color-mix(in srgb, var(--text) 22%, transparent);
}
```

After, adapted from the settled Usage table rule at
`styles-usage-workspace.css:149-182`:

```css
.awi-overview-right > .api-models-panel {
  display: flex;
  flex-direction: column;
  flex: 0 0 auto;
}

.awi-overview-right .api-models-panel > .input,
.awi-overview-right .api-models-panel > .api-panel-head,
.awi-overview-right .api-models-panel > .muted,
.awi-overview-right .api-models-panel > .api-models-error {
  flex: 0 0 auto;
}

/* The catalog is the only unbounded region on this tab. */
.awi-overview-right .api-models-panel > .api-models-scroll {
  margin-top: 0.5rem;
  min-width: 0;
  max-height: min(574px, 58vh);
  overflow-x: auto;
  overflow-y: auto;
  overscroll-behavior: auto;
  scrollbar-gutter: stable;
}

.awi-overview-right .api-models-scroll thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--surface);
  border-bottom-color: transparent;
  box-shadow: inset 0 -1px 0 var(--border);
}
```

Unlike Usage's `.tbl-wrap`, this wrapper has no top padding, so its sticky offset is
`0`, not `calc(-1 * var(--space-3))`. Keep a partially visible last row as the
scroll affordance; do not reintroduce the current inset fade shadow as a substitute
for wheel behavior.

### `styles-apikeys-workspace.css:531-652` — delete the desktop shell wholesale

Current code begins:

```css
/*
  Desktop: fill the viewport. Models card stretches to the bottom (with
  main-inner bottom padding as spacing). Left column scrolls so expanded
  usage examples are not clipped mid-panel.
*/
@media (min-width: 1100px) and (min-height: 700px) {
  .main-inner:has(.apikeys-workspace-shell) {
    height: 100dvh;
    min-height: 0;
    padding: 16px 28px 20px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-sizing: border-box;
  }

  .api-page {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
```

and continues through these scroll owners:

```css
  .api-page .apikeys-workspace-shell {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .api-page .apikeys-workspace-root {
    flex: 1 1 auto;
    min-height: 0;
    height: 100%;
    overflow: hidden;
    align-items: stretch;
  }

  .apikeys-workspace-rail-list {
    flex: 1 1 auto;
    min-height: 0;
    max-height: none;
    overflow-y: auto;
  }

  .apikeys-workspace-main {
    min-height: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .awi-overview {
    flex: 1 1 auto;
    min-height: 0;
    height: 100%;
    align-items: stretch;
    overflow: hidden;
  }

  .awi-overview-left {
    min-height: 0;
    height: 100%;
    overflow-x: hidden;
    overflow-y: scroll;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
    padding-bottom: 2.75rem;
  }
```

The block also stretches/clips the right model column and resets model/usage heights
at `styles-apikeys-workspace.css:618-651`. Delete the entire media query from line
536 through its closing brace at line 652. There is no replacement desktop media
query. The base rules at `:10-55` already provide width, padding, grid, and natural
document height.

Acceptance includes source guards for the absence of `height: 100dvh` and
`overscroll-behavior: contain` from this stylesheet, but those guards are not the
rendered wheel proof.

### `styles-apikeys-workspace.css:257-366` — open usage styles

Current markup-specific rules describe a collapsed disclosure:

```css
/* Usage examples: collapsed by default. Curl blocks must not trap wheel scroll. */
.awi-usage-fold .api-example-copy-btn.ocx-tooltip,
.awi-usage-fold .api-example-copy-btn { /* width rules */ }

.awi-usage-fold .api-example-pre { /* horizontal scroll, vertical visible */ }

.awi-usage-fold,
.awi-inline-fold {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  padding: 0;
  min-width: 0;
}

.awi-usage-fold > summary,
.awi-inline-fold > summary { /* disclosure trigger */ }

.awi-usage-fold-body,
.awi-inline-fold-body { /* folded body */ }
```

Phase 4 has already removed `.awi-inline-fold` for the auth matrix. Replace the
remaining usage selectors with an ordinary panel body:

```css
/* Unscoped on purpose: every copyable code block on this tab gets the same
   behavior, including the ClientConfigPanel that 260731_client_config_export
   mounts into this same workspace. Scoping these to .awi-usage-panel would let
   that panel's JSON block fall back to trapping the wheel. */
.api-example-copy-btn.ocx-tooltip,
.api-example-copy-btn {
  display: block;
  min-width: 0;
  width: 100%;
  max-width: 100%;
}

.api-example-pre {
  min-height: 0;
  max-height: none;
  overflow-x: auto;
  overflow-y: visible;
  overscroll-behavior: auto;
  white-space: pre;
  font-size: var(--text-label);
  line-height: var(--leading-relaxed);
  padding: 9px 11px;
  box-sizing: border-box;
  pointer-events: auto;
}

.awi-usage-panel-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}
```

Delete summary chevrons, `[open]` rules, folded borders, and the desktop
`.awi-overview-left > .awi-usage-fold` special case. The existing
`.awi-usage-example*` row/title rules remain.

This is the cross-unit contract, not a style preference:
`260731_client_config_export/040_gui_panel.md:63-65` says its JSON block "reuses
`api-code`/`api-example-pre` and inherits the existing wheel-scroll rules". If
phase 5 narrows those selectors to the usage panel, that inheritance silently
stops and the export panel reintroduces exactly the trapping this phase removes.
A source guard in the phase-5 test asserts the two rules stay unscoped.

## TSX diffs

### `ApiKeys.tsx:126-140,278-326` — model retry and total count

Before, the model resource's refresh is not retained:

```ts
const refreshKeys = keysResource.refresh;
```

and failure is a notice with no action:

```tsx
{modelsState.showError && keysData && <Notice tone="err">{t("api.modelsLoadFailed")}</Notice>}
```

After:

```ts
const refreshKeys = keysResource.refresh;
const refreshModels = modelsResource.refresh;
```

Remove the page-level model Notice and pass these panel props through
`ApiKeysWorkspace`:

```tsx
modelCount={models.length}
hasModelData={modelsState.data !== undefined || cachedModels !== undefined}
onRetryModels={() => refreshModels({ forceLoading: true })}
```

The key error banners remain unchanged. The model panel owns its retry beside the
catalog it repairs, and last-good model rows remain visible during a failed refresh
instead of being replaced.


### `api-keys-panels.tsx:328-429` — retry, honest empty state, live protocol result

The current panel treats `modelsLoadFailed` as `null` and every zero filtered result
as `api.modelsEmpty` (`api-keys-panels.tsx:371-379`). Extend its contract:

```ts
modelCount: number;
hasModelData: boolean;
onRetryModels: () => void;
```

Replace the mutually exclusive failure/empty block with:

```tsx
{modelsLoadFailed && (
  <div className="api-models-error">
    <p className="muted small">{t("api.modelsLoadFailed")}</p>
    <button type="button" className="btn btn-ghost btn-sm" onClick={onRetryModels}>
      {t("common.retry")}
    </button>
  </div>
)}

{modelsLoading ? (
  <DataSurfaceSkeleton label={t("api.modelsLoading")} rows={3} />
) : !hasModelData ? (
  null
) : filteredModels.length === 0 ? (
  <p className="muted small api-models-empty">
    {modelCount === 0
      ? t("api.modelsEmpty")
      : t("api.modelsNoMatch", { query: modelQuery.trim() })}
  </p>
) : (
  <div className="api-models-scroll">{/* phase-4 table */}</div>
)}
```

`hasModelData` distinguishes a successful empty array from failed-cold. Do not make
`modelsLoadFailed` suppress a table when `hasModelData` is true: a failed refresh can
coexist with last-good rows, as the key resource already proves in
`apikeys-refresh-preserve.test.tsx:65-138`. Failed-cold renders the error/retry only,
not an additional false empty-catalog sentence.

### `api-keys-panels.tsx:467-489` — usage examples are ordinary document content

Before:

```tsx
return (
  <details className="awi-usage-fold">
    <summary>{t("api.workspace.usageExamples")}</summary>
    <div className="awi-usage-fold-body">
      {/* three existing .awi-usage-example blocks */}
    </div>
  </details>
);
```

After:

```tsx
return (
  <section className="panel api-panel awi-usage-panel">
    <h3 className="panel-title">{t("api.workspace.usageExamples")}</h3>
    <div className="awi-usage-panel-body">
      {/* same Chat, Responses, and gated Messages blocks, same order */}
    </div>
  </section>
);
```

No example is removed, paginated, tabbed, or placed in another disclosure. The
Messages gate at `api-keys-panels.tsx:481-486` remains exactly tied to
`claudeCodeEnabled`. This implements W16 and the “every row stays in the document”
decision (`003_ux_direction.md` §5) without changing left-column order.

## i18n contract

Add these exact English source strings and translate both in all six locale files:

| Key | English source |
|-----|----------------|
| `api.modelsNoMatch` | `No models match “{query}”.` |

`api.key.copyFailed` moved to phase 4 with the clipboard fix it belongs to.

`common.retry`, phase 4's `api.auth.*` result strings, and existing
`api.modelsLoadFailed` are reused; do not create synonyms.

Delete `api.workspace.selectKeyHint` from `en`, `ko`, `ja`, `zh`, `de`, and `ru`.
It is present but rendered nowhere (`001_surface_inventory.md` W10), and phase 4
does not make it live. Add an explicit source assertion for its absence so this is a
deliberate disposition, not an accidental omission.

The smart quotation marks in the English no-match sentence are prose, not code.
Translations own their natural quotation convention. Interpolate the user's query
as text; React escapes it, and no `dangerouslySetInnerHTML` is introduced.

## Locale parity test

The current test checks only eight literal keys in each file
(`gui/tests/apikeys-layout.test.ts:90-102`) even though the surface had 74 at the
inventory (`001_surface_inventory.md` §5). Replace that test, do not append
another partial list.

Before:

```ts
test("apikeys workspace i18n keys exist in every locale", async () => {
  const locales = ["en", "de", "ja", "ko", "ru", "zh"] as const;
  for (const locale of locales) {
    const dict = await Bun.file(new URL(`../src/i18n/${locale}.ts`, import.meta.url)).text();
    expect(dict).toContain('"api.workspace.overview":');
    // six more literals
    expect(dict).toContain('"api.exampleCopied":');
  }
});
```

After:

```ts
import { DICTS, type Locale } from "../src/i18n/shared";

test("every locale has exactly the English api namespace", () => {
  const locales: Locale[] = ["en", "de", "ja", "ko", "ru", "zh"];
  const englishApiKeys = Object.keys(DICTS.en)
    .filter(key => key.startsWith("api."))
    .sort();

  expect(englishApiKeys.length).toBeGreaterThan(8);
  for (const locale of locales) {
    const localeApiKeys = Object.keys(DICTS[locale])
      .filter(key => key.startsWith("api."))
      .sort();
    expect(localeApiKeys).toEqual(englishApiKeys);
  }
  expect(englishApiKeys).not.toContain("api.workspace.selectKeyHint");
});
```

The greater-than-eight assertion is an activation guard: replacing the key
extraction with the old curated subset makes the test fail. Comparing imported
runtime dictionaries catches missing and extra keys across all six locales; it does
not merely search source text.

## Other focused tests

Extend `gui/tests/apikeys-actions.test.tsx`, using the real page and deferred fetch
style established in phase 4:

| # | Activation scenario | Observable proof |
|---|---------------------|------------------|
| 1 | GET `/v1/models` returns `[]` and query is blank | `api.modelsEmpty` renders; no no-match interpolation |
| 2 | GET returns two models, then type a query matching neither | `api.modelsNoMatch` renders with the query; empty-catalog copy is absent |
| 3 | First model GET returns 503, click Retry, second returns one row | fetch count becomes two, retry enters loading, then row renders and error clears |
| 4 | Last-good models exist, forced refresh fails | retry/error remains visible and prior rows remain mounted |

Clipboard rejection, the name-length assertions and the live-region announcement
are phase 4's tests, moved with their implementations.

`gui/tests/apikeys-actions.test.tsx` is NEW in phase 4, so there is no base-commit
before block to quote. At phase 5 P, preserve its fetch harness and append the four
activation scenarios above; do not replace protocol/header assertions with the
hardening cases.

Add source/CSS assertions to `apikeys-layout.test.ts`:

- `styles-apikeys-workspace.css` contains no `100dvh` and no
  `overscroll-behavior: contain`.
- It contains exactly one vertical `max-height` declaration for a content region,
  under `.api-models-scroll`; responsive breakpoint declarations must not add a
  second rail cap.
- `.api-models-scroll` contains `overscroll-behavior: auto`, and its `thead th`
  contains `position: sticky`.
- panel source contains no `<details className="awi-usage-fold">`; all three example
  title keys remain and Messages remains gated.
- the source order of `ApiKeysManagePanel`, `ApiKeysEndpointsPanel`, and
  `ApiKeysUsagePanel` in `awi-overview-left` is unchanged.
- `.api-example-pre` and `.api-example-copy-btn` appear as **unscoped** selectors,
  and no `.awi-usage-panel .api-example-pre` rule exists. This is the cross-unit
  guard for `260731_client_config_export` (see the CSS section above): narrowing
  those selectors would silently re-trap that unit's JSON block.

These guards activate the intended rules but do not replace browser observation.

## Render grounding and wheel-handoff proof

C-RENDER-GROUNDING-01 is mandatory because W17 was inferred from static CSS and has
never been driven in a browser (`001_surface_inventory.md` §6). Use the real
GUI renderer at **1280x720** against deterministic data: at least four keys, four
auth rows, 40+ models, and all usage examples. Build first, then serve the existing
Vite app (`gui/package.json:6-14`); use the repository's browser-control route rather
than installing a runner.

Record screenshots and the following measurements:

1. On Overview, evaluate `document.scrollingElement.scrollHeight > innerHeight` and
   capture initial `window.scrollY`.
2. Find `.api-models-scroll`, set its `scrollTop` to `scrollHeight`, and verify
   `scrollTop + clientHeight >= scrollHeight - 1`.
3. Place the pointer over the center of that exhausted model region and drive a
   downward wheel gesture of at least 500 CSS pixels.
4. Re-read both values. The inner `scrollTop` remains at its maximum and
   `window.scrollY` increases. This is the wheel-handoff observable.
5. Repeat upward with the model region at `scrollTop = 0`; page `scrollY` decreases.
6. Scroll through the now-open curl examples and below the API workspace. Confirm
   no left column, rail, detail body, code sample, or shell captures vertical wheel.
7. Capture Overview at page top and below the model panel, plus a key detail long
   enough to exceed one viewport. Read screenshots back and confirm the sticky model
   header stays legible, no content is clipped, no page-wide horizontal scrollbar
   appears, and the open examples remain in document order.

The proof fails if a synthetic `WheelEvent` is merely dispatched and no scroll
position changes; use an actual browser wheel input. It also fails if the page moves
only after moving the pointer outside the model region—the handoff must occur while
the pointer remains over the exhausted inner scroller.

## Accept criteria

1. The desktop shell no longer fixes itself to the viewport. **Activation:** render
   the deterministic 1280x720 fixture; observable is document height greater than
   viewport height and reachable content below the initial workspace without an
   inner-column scroll.
2. The model table is the only vertically capped content region. **Activation:**
   CSS ownership test plus rendered inspection; observable is bounded model rows,
   uncapped key/detail/examples, and no second vertical scrollbar.
3. Wheel handoff works at both ends of the model table. **Activation:** steps 1–5
   above; observable is unchanged exhausted inner position plus changed
   `window.scrollY` while the pointer remains over it.
4. The model header remains visible while model rows scroll. **Activation:** set the
   model region to mid-scroll; observable screenshot shows header cells at the
   region top and rows moving underneath.
5. Empty catalog and empty filter are distinguishable. **Activation:** scenarios 1
   and 2; observable is mutually exclusive source strings, with the query included
   only in the filtered state.
6. A model failure is recoverable without page reload and preserves last-good data.
   **Activation:** scenarios 3 and 4; observable is a second fetch, eventual row,
   and stale rows retained during failure.
7. The shared code-block selectors stay unscoped for the client-config unit.
   **Activation:** the source guard above; observable is the absence of any
   `.awi-usage-panel .api-example-pre` rule.
8. Auth rules and all usage examples are visible without opening a disclosure.
    **Activation:** rendered Overview and source guards; observable is no auth/usage
    `<details>`, all rows/examples present, and no changed left-panel order.
9. Every `api.*` key has exact six-locale parity and the dead select hint is gone.
    **Activation:** imported-dictionary parity test; observable is six arrays equal
    to English and explicit absence of `api.workspace.selectKeyHint`.
10. C-RENDER-GROUNDING-01 evidence records the 1280x720 screenshots, scroll
    measurements, pointer location, and both handoff directions. A CSS-only claim is
    not completion evidence.
11. Focused GUI tests pass, then all GUI gates required by `gui/AGENTS.md:42-58` are
    green: `cd gui && bun test tests`, `bun run lint`, `bun run lint:i18n`, and
    `bun run build`. The parent may run broader repository gates at the unit C phase;
    this delegated phase does not call the repository full suite itself.

## Risk

The easy regression is to remove the desktop media query but leave a base cap on the
rail or detail, producing a page that looks unlocked while still handing wheel input
between several regions. The “model table only” source guard and pointer-over-region
wheel proof exist to catch that half-fix.

The second risk is treating a failed model refresh as an empty catalog. Keep error,
empty, filtered-empty, and stale-success independent, matching the resource state's
existing distinction (`gui/src/data-surface.ts:71-131`). A retry button that clears
last-good rows would regress the preservation behavior already established for keys.
