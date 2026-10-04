# 010 Phase 1 - Claude Code single page (design A)

## Problem

`gui/src/pages/ClaudeCode.tsx` renders a `claudecode-workspace-root` grid with an
`aside.claudecode-workspace-rail` of five buttons and one visible pane chosen by
`selectedSection`. The Save button sits in the pane head and hides itself on read-only
panes. Inside Connect this is a second sidebar next to the app sidebar.

## Change

### MODIFY gui/src/pages/ClaudeCode.tsx

- DELETE `selectedSection` state, the `sections[]` array, `selected`, `sectionEditable`,
  the `<aside className="claudecode-workspace-rail">` block and the `ccw-main-head` save.
- Render, in this order, inside `<div className="claudecode-workspace-shell claudecode-doc">`:
  1. status / load-error notices (unchanged);
  2. CLI 1P card, intercept start, 1P notices (unchanged, still first);
  3. `<CcwSection id="quickstart" title={t("claude.quickstart")}>` with
     `ClaudeCodeQuickstartSection` (ocx claude + manual env disclosure);
  4. `<CcwSection id="settings" title={t("claude.workspace.settings")}>` with
     `ClaudeCodeSettingsCard` **without** `footer`;
  5. `<CcwSection id="smallFast" title={t("claude.smallFastModel")}>` with
     `SmallFastModelSetting`;
  6. `<CcwSection id="modelMap" title={t("claude.modelMap")} count={rows.length}>`
     with `ClaudeCodeModelMapSection`;
  7. `<CcwSection id="aliases" title={t("claude.aliases")} count={state.aliases.length}>`
     with `ClaudeCodeAliasesSection`;
  8. `<div className="card claudecode-connection-card claudecode-master-card">`
     holding the existing `connectionRow` (immediate commit, last on the page);
  9. sticky save bar:
     ```tsx
     <div className="ccw-savebar" role="region" aria-label={t("common.save")}>
       <span className="ccw-savebar-state" aria-live="polite">
         {dirty ? t("claude.saveBar.dirty") : t("claude.saveBar.clean")}
       </span>
       <button className="btn btn-ghost btn-sm" disabled={!dirty} onClick={revert}>{t("claude.saveBar.revert")}</button>
       <button className="btn btn-primary btn-sm" onClick={() => void save()}>{t("common.save")}</button>
     </div>
     ```
     Save stays enabled when clean (same as before; re-saving is harmless and existing
     tests save without edits).
- `CcwSection` is a local component: `<section className="ccw-section" aria-labelledby>`
  with `<h3 className="ccw-section-title">` and an optional `.count` chip.
- Dirty and save: see "Amendments" below; they are authoritative for draft, baseline and
  the Save body (`enabled` is not sent by Save).

### NEW gui/src/pages/claude-code-save.ts

Pure `claudeCodeSaveBody(state, rows)`: trims and filters `rows` into `modelMap`, serializes
sidecars with `serializeSidecarOverride`, and returns authMode, systemEnv, fastMode,
autoContext, autoCompactWindow, injectAgents, smallFastModel, modelMap,
webSearchSidecar, visionSidecar.

### MODIFY gui/src/pages/claude-code-sections.tsx

Comments that mention "rail pane" / "ccw-main-head" now say the section heading lives
in ClaudeCode's `CcwSection`. No behavior change.

### MODIFY gui/src/styles-claudecode-workspace.css

DELETE rail/grid rules (`.claudecode-workspace-root`, `-rail*`, `-main`, `.ccw-main-*`,
`.claudecode-workspace-save*`, `.ccw-body` and the narrow-width rail override). ADD
`.claudecode-doc` (max-width ~880px, gap), `.ccw-section`, `.ccw-section-title`,
`.ccw-savebar` (position: sticky; bottom: 0; background fade from `--bg`; z-index above
cards), `.claudecode-master-card` (subtle danger border token). Tokens only from
`gui/design-system`.

### i18n (all 12 locales)

`claude.saveBar.dirty` "Unsaved changes", `claude.saveBar.clean` "No changes",
`claude.saveBar.revert` "Revert".

### Tests

- MODIFY `gui/tests/claudecode-layout.test.ts`: assert no `claudecode-workspace-rail` and no
  `selectedSection`; keep the source-order test, extended so the master switch row
  renders after `<ClaudeCodeAliasesSection` and the save bar is last.
- MODIFY `gui/tests/claudecode-fetch-errors.test.tsx`: the helper-model test no longer clicks a
  rail row; the combobox is on the page directly.
- NEW case (mounted) in `gui/tests/claudecode-fetch-errors.test.tsx` or a sibling: editing a
  setting shows "Unsaved changes"; Revert restores the server value; the master switch is
  the last `.setting-row` before the save bar.

## Verification

`cd gui && bun test tests/claudecode-layout.test.ts tests/claudecode-fetch-errors.test.tsx tests/claude-code-*.test.tsx tests/claude-page.test.tsx && bun run lint:i18n && bun run build`,
then render `#claude` in the in-app browser against the QA proxy (desktop and ~760px width).

## Amendments after architect consultation

- Replace `draftState`/`draftRows`/`hasDraftRows` with ONE state object
  `edit: { draft: {state, rows}, baseline: {state, rows} } | null`, so a read updates draft and
  baseline in the same functional update (no ref needed, no torn pair).
- `claude-code-save.ts` exports: `EDITABLE_KEYS`, `claudeCodeSaveBody(state, rows)` (no `enabled`;
  modelMap trimmed, last duplicate wins, keys sorted), `isClaudeCodeDraftDirty(draft, baseline)`
  (body differs OR raw row `[from, to]` list differs), `mergeServerRead(draftState, nextState)`
  (server state with editable keys from the draft), `revertEditable(draftState, baseState)`.
- `fetchCode`: `setEdit(cur => !cur || !isDirty(cur.draft, cur.baseline) ? { draft: next, baseline: next }
  : { draft: { state: mergeServerRead(cur.draft.state, next.state), rows: cur.draft.rows }, baseline: next })`.
  Save acknowledgement (audit blocker 1): `edit` also carries `adoptNextRead: boolean`. When a
  Save succeeds and the current draft still equals the submitted draft (raw rows included),
  set `adoptNextRead = true`; any later edit resets it to false. `fetchCode` adopts the server
  copy wholesale when the draft is clean OR `adoptNextRead` is true, so trimmed, blank or
  duplicate rows normalize after a successful Save instead of staying dirty forever; edits
  made during the Save keep the merge path.
- `save()` body is `claudeCodeSaveBody(state, rows)` only; a `saving` flag disables Save and
  Revert while in flight. Immediate toggles merge only `enabled` / 1P fields into both draft
  and baseline.
- Save bar: opaque `--bg` background, `scroll-padding-bottom` on the scroller so a focused
  control is not hidden under it, status node `aria-live="polite" aria-atomic="true"`.
- NEW tests in `gui/tests/claude-code-save.test.ts` (pure) and mounted cases: dirty + revert,
  a trimmed/blank/duplicate row Save that ends clean, an edit during Save that survives, and
  a dirty draft surviving the 1P toggle's re-read.
- Layout test (audit blocker 2): rewrite `gui/tests/claudecode-layout.test.ts` order to
  Quickstart, Settings card, SmallFastModelSetting, ModelMap, Aliases, connection row, save
  bar; delete the `ccw-body`, `ccw-main-head`, `selectedSection` and `data-visible` assertions.
- Locales: add keys to every locale file `gui/src/i18n/shared.ts` registers (currently 11),
  not a fixed count.
