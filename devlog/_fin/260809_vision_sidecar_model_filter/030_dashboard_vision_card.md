# 030 — phase 3: the dashboard vision card

Layer 3 of the stack. Branch `codex/260809-vision-sidecar-card`, base
`codex/260809-vision-sidecar-api`.

Thesis: **the card shows only what the server allows, in the delegation panel's
form factor, with the effort select reading its raw wire values.**

Two review comments drive this layer:

- comment 1, on the vision card: "여기 프런트 양식을 위의 서브에이전트 위임 처럼
  만들게 해주고" — adopt the delegation panel's layout.
- comment 2, on the delegation panel: "여기처럼 i18n 하지말고 추론창은 컴팩트하게"
  — the delegation panel's effort control shows a bare `high`, and the vision card
  should match that instead of rendering `낮음`.

Comment 2 is anchored ON the delegation panel but is a **pattern reference**, not
a request to change it: that panel already maps efforts to raw values
(`dashboard-overview-sections.tsx:119-122`, `injectionEfforts.map(e => ({ value: e,
label: e }))`). Verified in audit round 1 — the delegation panel needs no edit.

## Files

| Path | Action |
|---|---|
| `gui/src/pages/dashboard-shared.ts` | MODIFY (types + option helper) |
| `gui/src/pages/use-dashboard-data.ts` | MODIFY (prefer server list) |
| `gui/src/pages/dashboard-overview-sections.tsx` | MODIFY (card markup) |
| `gui/src/styles-dashboard-workspace.css` | MODIFY (compact-select + copy-block rules) |
| `gui/src/i18n/vision-reasoning-labels.ts` | DELETE if no importer remains |

## `dashboard-shared.ts`

```ts
 export interface SidecarSetting { backend?: SidecarBackend; model: string; reasoning?: VisionReasoning }
-export interface SidecarData { webSearch: SidecarSetting; vision: SidecarSetting }
+export interface VisionModelOption { value: string; label: string; backend: SidecarBackend; baseline?: boolean }
+export interface SidecarData {
+  webSearch: SidecarSetting;
+  vision: SidecarSetting;
+  /** Server-computed eligible describers. Optional: an older server omits it and
+   *  the client falls back to the legacy provider-name list rather than showing
+   *  an empty picker. */
+  visionModels?: VisionModelOption[];
+}
```

and a selector that encodes the fallback once:

```ts
/** Server list when present, else the legacy openai+anthropic list. */
export function visionModelOptions(
  serverOptions: VisionModelOption[] | undefined,
  models: ModelInfo[],
  current: string | undefined,
): Array<{ value: string; label: string }> {
  const options = serverOptions && serverOptions.length > 0
    ? serverOptions.map(option => ({ value: option.value, label: option.label }))
    : sidecarModelOptions(models);
  if (current && !options.some(option => option.value === current)) {
    options.unshift({ value: current, label: current });
  }
  return options;
}
```

`sidecarModelOptions` stays exactly as it is — web-search still uses it, and this
unit does not change the web-search picker.

## `use-dashboard-data.ts`

The existing `sidecarModels` memo (lines 454-462) keeps serving web-search. Add a
sibling and export it from the hook's return object next to `sidecarModels`:

```ts
+  const visionModels = useMemo(
+    () => visionModelOptions(sidecar?.visionModels, models, sidecar?.vision.model),
+    [sidecar?.visionModels, models, sidecar?.vision.model],
+  );
```

`saveSidecar` enumerates fields explicitly at **three** write sites, so a new
field is silently dropped unless all three are edited (audit round 1, blocker 3):

1. the optimistic `next` object (lines 467-470) — add
   `...(sidecar.visionModels ? { visionModels: sidecar.visionModels } : {})` so the
   picker does not blank for the in-flight frame;
2. the success writeback (line 480) — `setSidecar` currently names only
   `webSearch` and `vision`; it must also carry `data.visionModels`, otherwise
   every successful save falls back to the legacy openai+anthropic list until the
   next poll, undoing requirement 2 on the exact interaction the user performs;
3. the session cache write (line 484) — same two named fields, same fix, or a
   reload serves a list-less snapshot.

Also add `visionModels` to the hook's returned object next to `sidecarModels`, or
the card cannot read it. The polling path (lines 333-343) assigns `data.sidecar`
wholesale and needs no change.

## `dashboard-overview-sections.tsx`

Replace the vision branch of `DashboardSidecarPanels` (lines 288-311). Before —
a `dash-sidecar-card` whose title, two selects, and hint stack vertically. After —
the delegation shape.

**The form factor is the panel, not an inner row** (audit round 1, blocker 6).
`DashboardInjectionPanel` puts `dash-delegation-summary` on the panel itself
(line 102); `.dash-sidecar-card__row` already carries the same flex rules
(`styles-dashboard-workspace.css:91-98`), so adding the class there would be
redundant and would not reproduce the shape. The edit below therefore:

- makes the panel `className="panel dash-delegation-summary dash-vision-card"`.
  **`dash-sidecar-card` is dropped from the vision panel, not combined with it**
  (audit round 2, N1). Keeping both would silently produce a COLUMN panel:
  `.dash-sidecar-card` declares `flex-direction: column`
  (`styles-dashboard-workspace.css:84-89`) and `.dash-delegation-summary`
  (`styles.css:2245-2250`) never resets that property, so the two classes do not
  compete — column simply survives, regardless of import order. A new
  `.dash-vision-card { min-width: 0; }` supplies the only thing the grid cell
  actually needed from the old class;
- drops the inner `dash-sidecar-card__row` wrapper entirely;
- moves the hint into a left copy block `<div className="dash-sidecar-copy">`
  holding the title and `dash.visionSidecarHint`, since the panel is now a row
  and the old trailing hint would land beside the controls. The trailing
  `<div className="muted setting-hint">` after the row is deleted in the same
  edit.

The web-search card is deliberately left alone: the request was anchored on the
vision card, and restyling both would exceed the comment's scope.

```tsx
-        <div className="panel dash-sidecar-card" aria-busy={!sidecar || undefined}>
-          <div className="dash-sidecar-card__row">
-            <div className="font-semibold">{t("dash.visionSidecar")}</div>
-            <div className="dash-delegation-controls">
-              <Select
-                value={visionModel}
-                options={sidecarModels}
-                onChange={model => { /* unchanged */ }}
-                disabled={!sidecar || sidecarSaving}
-                label={t("dash.sidecarModel")}
-              />
-              <Select
-                value={visionReasoning}
-                options={visionReasoningOptionsFor(visionLadder, visionReasoning)
-                  .map(value => ({ value, label: visionReasoningLabel(locale, value) }))}
-                onChange={reasoning => { /* unchanged */ }}
-                disabled={!sidecar || sidecarSaving}
-                label={`${t("dash.visionSidecar")} — ${t("dash.injectionEffortLabel")}`}
-              />
-            </div>
-          </div>
-          <div className="muted setting-hint">{t("dash.visionSidecarHint")}</div>
-        </div>
+        {/* Same shell as DashboardInjectionPanel: the PANEL is the flex row. */}
+        <div className="panel dash-delegation-summary dash-vision-card" aria-busy={!sidecar || undefined}>
+          <div className="dash-sidecar-copy">
+            <div className="font-semibold">{t("dash.visionSidecar")}</div>
+            <div className="muted setting-hint">{t("dash.visionSidecarHint")}</div>
+          </div>
+          <div className="dash-delegation-controls">
+            <Select
+              value={visionModel}
+              options={visionModels}
+              onChange={model => { /* unchanged */ }}
+              disabled={!sidecar || sidecarSaving}
+              label={t("dash.sidecarModel")}
+            />
+            <Select
+              value={visionReasoning}
+              // Raw wire value (low…max), matching the delegation panel's bare `high`.
+              options={visionReasoningOptionsFor(visionLadder, visionReasoning)
+                .map(value => ({ value, label: value }))}
+              onChange={reasoning => { /* unchanged */ }}
+              disabled={!sidecar || sidecarSaving}
+              align="right"
+              label={`${t("dash.visionSidecar")} — ${t("dash.injectionEffortLabel")}`}
+            />
+          </div>
+        </div>
```

The wrapping `<Select>` keeps its `label` prop: that is the accessible name, not
visible text, so dropping the localized *option* labels does not make the control
anonymous to a screen reader. The visible option text becomes the wire value,
which is what comment 2 asks for.

Destructuring changes at the top of the component: `visionModels` in,
`sidecarModels` retained for the web-search card, and `locale` removed once
`visionReasoningLabel` is gone. Drop the now-unused imports
(`visionReasoningLabel`) in the same edit or `lint:gui` fails on
`no-unused-vars`.

### Effort select width

`.dash-sidecar-card__row .custom-select`
(`gui/src/styles-dashboard-workspace.css:104-110`) forces
`min-width: clamp(10rem, 24vw, 11.5rem)`, which is what makes the effort control
as wide as the model control. Add the narrower rule **immediately after it in
that same file**, not in `styles.css` (audit round 1, blocker 8) — the override
belongs beside the rule it overrides:

```css
/* The effort control holds one short wire value (low…max); it must not inherit
   the model select's reserved width. */
.dash-delegation-controls .custom-select:last-child {
  min-width: 6.5rem;
  max-width: 9rem;
}
```

`:last-child` is sound: `Select` renders each control as a sibling
`.custom-select` root, so the effort select really is the last child of
`.dash-delegation-controls`. The same selector also reaches the delegation
panel's controls, whose last child is a `<button>` and therefore does not match —
verify both cards during render grounding.

Add alongside it, mirroring `.dash-sync-copy` (`styles.css:684-687`):

```css
.dash-sidecar-copy { min-width: 0; flex: 1 1 auto; }
```

and the replacement for the class the vision panel no longer wears:

```css
/* The vision panel is a delegation-style ROW, so it must not inherit
   .dash-sidecar-card's flex-direction: column. It only ever needed min-width. */
.dash-vision-card { min-width: 0; }
```

## i18n cleanup

`visionReasoningLabel` has one importer today (`dashboard-overview-sections.tsx`).
After this edit, grep for it; if zero importers remain, delete
`gui/src/i18n/vision-reasoning-labels.ts` and its tests. If any other surface
(e.g. Claude Code overrides) imports it, keep the file and only stop using it
here — a shared helper is not this unit's to remove.

The `dash.visionSidecar` / `dash.visionSidecarHint` / `dash.sidecarModel` keys
stay localized. Comment 2 is about the effort *values*, not the card's prose;
deleting the Korean card title would be a scope overreach and would regress five
other locales.

## Render grounding (C-RENDER-GROUNDING-01)

This layer changes layout, so C is not complete on `lint:gui` alone:

1. `bun run build:gui`
2. serve the built dashboard (or point the running proxy at it) and open
   `#dashboard` at 1280x720
3. screenshot the overview and **read the screenshot back**, confirming: the
   vision card's title sits left with both controls right; the effort select is
   visibly narrower than the model select; the effort select reads `low` (not
   `낮음`); the model dropdown lists only eligible ids.
4. persist the screenshot into this unit's `evidence/` directory.

## Acceptance

| Row | Verifier | Covered? |
|---|---|---|
| filtered options reach the picker | `bun run test` (shared-helper unit test) | yes |
| no lint regressions | `bun run lint:gui` | yes |
| bundle builds | `bun run build:gui` | yes |
| layout + non-localized effort + compact width | screenshot read-back | yes — human/visual, not a gate |
| types | `bun run typecheck` | yes |
