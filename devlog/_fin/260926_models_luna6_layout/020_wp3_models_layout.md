# wp3 — Models page: settings fold, sticky rail, wide layout

## File change map

| Path | Change |
|------|--------|
| `gui/src/pages/models-settings-panel.tsx` | NEW: `ModelsSettingsPanel` (details + summary + persisted open state) and `CustomModelsSummary` |
| `gui/src/pages/Models.tsx` | MODIFY: render panel above `.models-workspace-root`; replace custom-count IIFE with `<CustomModelsSummary>`; net line count must go down |
| `gui/src/styles-models-workspace.css` | MODIFY rail sticky + list height; ADD `.models-settings*` rules; widen catalog `.main-inner` |
| `gui/src/i18n/{en,de,fr,ko,zh,zh-TW,ru,ja,tr,vi}.ts` | ADD `models.settingsPanel.*` keys |
| `gui/tests/models-settings-panel.test.tsx` | ADD: summary lists state; open state persists |

## Component contract

```tsx
export interface SettingsSummaryItem { id: string; label: string; value: string }
export function ModelsSettingsPanel(props: {
  title: string;
  summary: SettingsSummaryItem[];
  children: ReactNode;
  storage?: StorageLike; // test seam
}): JSX.Element
```

- Native `<details className="models-settings">` with `<summary>`: chevron, title, then the
  summary items as compact `label value` pairs, ellipsized on one line.
- Open-state key `ocx.models.settingsOpen.v1` ("1"/"0"); default closed; `onToggle` writes.
- Body `.models-settings-body` renders `children` (the existing `controlsBlock`) unchanged, so
  every save/load handler is untouched.

Summary items are computed in `Models.tsx` in one expression: shadow (off or target model),
sub-agent mode, default window, picker order.

## Models.tsx diff sketch

```diff
+      <ModelsSettingsPanel title={t("models.settingsPanel.title")} summary={settingsSummary}>{controlsBlock}</ModelsSettingsPanel>
       <div className="models-workspace-root" ...>
 ...
         <section className="models-workspace-main" ...>
-          {controlsBlock}
           {collapseControls}
-      {(() => { const customCount = ...; return (<div ...>...</div>); })()}   // 12 lines
+      <CustomModelsSummary models={models} />
```

## CSS

```css
.main-inner:has(#models-panel-catalog:not([hidden])) { max-width: 1320px; }
.models-workspace-root { align-items: start; }
.models-workspace-rail {
  position: sticky; top: calc(<quota bar height> + var(--space-3));
  max-height: calc(100dvh - <quota bar height> - var(--space-6));
}
.models-workspace-rail-list { max-height: none; flex: 1 1 auto; }
@media (max-width: 768px) { .models-workspace-rail { position: static; max-height: none; } }
.models-settings { border: 1px solid var(--border); border-radius: var(--radius-md); }
@container models-workspace (min-width: 1000px) {
  .models-settings-body { two-column grid for the control rows }
}
```

The exact offset, and whether the quota bar exposes a height variable, are verified in B
against the rendered page; the rail must never slide under the quota bar.

## Acceptance (with activation)

- 1440x1000 viewport, scroll 1500px: rail `getBoundingClientRect().top` stays constant and
  below the quota bar while the model list scrolls.
- Settings closed by default: the first provider card starts within the first viewport;
  the summary reads like `Shadow off · Sub-agent v1 · Window 350k · Order Default`.
- Toggle open, reload: stays open. Controls still save (spot-check the sub-agent control on
  the dev server, then restore the original value).
- 1170px: two columns, no horizontal overflow. 720px: rail stacks and is not sticky.
- `Models.tsx` line count < 2787; file-size ratchet green; `gui/tests/i18n-locales.test.ts` green.

## Revision 2 (wp3 P re-verification, folds A2 and A4-A9)

Re-verified at the wp2 close commit: Models.tsx 2787 lines (cap 2792), controlsBlock
1956-2175, aliases table inside the main section, custom-count IIFE ~2158, collapse controls
~2177, rail 2561-2600; the rail stacks in both `@container models-workspace (max-width: 720px)`
and `@media (max-width: 768px)`; the quota bar is `position: sticky; top: 0` with
`min-height: 34px` and wraps.

Amended file map:

| Path | Change |
|------|--------|
| `gui/src/pages/models-settings-panel.tsx` | NEW: `ModelsSettingsPanel`, `modelsSettingsSummary()`, `CustomModelsSummary` |
| `gui/src/components/quota-summary-bar/QuotaSummaryBar.tsx` | MODIFY: ResizeObserver publishes `--ocx-sticky-top` on `document.documentElement`; removed on unmount |
| `gui/src/pages/Models.tsx` | MODIFY: panel wraps `controlsBlock` + aliases table above the workspace grid; `orderHint`, `pickerOrder.hint` and `setAllHint` become info tooltips; custom count + order tooltip join the collapse toolbar |
| `gui/src/styles-models-workspace.css` | MODIFY as below |
| `gui/src/styles.css` | MODIFY: compact `.codex-stale-banner` padding |
| i18n x10 | ADD `models.settingsPanel.title`, `models.settingsPanel.off`, `models.settingsPanel.attention` |
| `gui/tests/models-settings-panel.test.tsx` | NEW test (registered per gui test layout, if any) |

Summary contract (`modelsSettingsSummary(t, state)` returns ordered items):
1. `models.v2Label` -> `models.v2Mode_<mode>` (omitted while v2 settings load).
2. `models.shadowCallIntercept` -> target model id when enabled, else `models.settingsPanel.off`.
3. `models.contextCapLabel` -> `fmtK(value)` when the default window is on, else off.
4. `models.pickerOrder.label` -> label of the saved mode.
5. `models.newPolicyGlobal` only when the policy is `off` (non-default).
`warn` = v2 thread conflict || picker-order load failure. A warn renders an amber dot with
`models.settingsPanel.attention` as its accessible name and opens the panel without
persisting that choice.

Open state: localStorage `ocx.models.settingsOpen.v1` = "1" | "0"; default closed.
The summary element contains text only (no buttons); the panel precedes the rail in DOM order.

CSS additions:
- `.main-inner:has(#models-panel-catalog:not([hidden])) { max-width: 1320px }`
- `.models-workspace-root { align-items: start }`; rail `position: sticky; top: calc(var(--ocx-sticky-top, 0px) + var(--space-3)); max-height: calc(100dvh - var(--ocx-sticky-top, 0px) - var(--space-6))`; list `max-height: none; flex: 1 1 auto`.
- Both stacking rules (720px container, 768px media) add `position: static; max-height: none`.
- `.models-settings` bordered card; summary one line, ellipsized key/value pairs separated by
  a faint middle dot; chevron rotation is the only motion.
- `@container models-workspace (min-width: 1000px)`: body is a 2-column grid; the top control
  row, v2 detail row, picker-order editor and aliases table span both columns; window and
  picker order pair in one row; fast rows card takes one column.

Reflection dispositions (layout architect, rev2): aliases table stays inside the same panel body,
so `showAliases` keeps its single owner; each hint tooltip keeps the full localized text as
both tooltip content and the trigger's `aria-label` (same pattern as the shadow row); the quota
bar observer is created in a mount effect on the bar's root ref, observes that element, writes
`--ocx-sticky-top` from `getBoundingClientRect().height`, and on cleanup disconnects and calls
`document.documentElement.style.removeProperty("--ocx-sticky-top")`; the panel test asserts the
open-state key does not touch `ocx-models-collapsed:v2`.

Micro-audit folds (UI/UX reviewer, rev2 NEAR-PASS): `warn` also includes a non-empty
`v2Note` (server warnings from `data.warnings`); `onToggle` persists only user toggles — a
ref marks the forced auto-open so its toggle event is not written, and the test asserts that
a warning opens the panel without changing storage.

B-phase correction: D7 is withdrawn. `gui/tests/models-tab-layout.test.ts` pins every Models
tab (catalog, routing, compatibility) to one 1200px column so switching tabs never jumps, and
the catalog already had that width; the 980px reading in the first baseline was a screenshot
scaling artefact. `gui/tests/models-status-toast.test.tsx` asserted the toast is the element
directly above the workspace; it now asserts the toast is a shell sibling and the settings
panel sits directly above the workspace, which is the same intent.

wp4 CI correction: the repository rejects new lint suppressions (`new_suppression` in the
`hygiene` and `enforce-target` gates). The quota bar now publishes a unitless
`--ocx-sticky-top-h` and the rail applies the unit in CSS (`calc(var(--ocx-sticky-top-h, 0) * 1px ...)`),
so no `px` literal needs a disable comment.
