# 010 — Model on/off from Providers, and an Overall tab in Models

Lane fb-models. Base `origin/dev` @ d61cca122d. Branch `codex/fb2100-models-toggle`. Class C3 (GUI, two
surfaces sharing one persisted state; no server or wire change).

## Problem

Turning a model on or off works only on the Models page catalog tab. The Providers page model list
hides disabled models and offers a one-way Hide button, so re-enabling a model means leaving for the
Models page. There is also no single searchable list of every model across providers.

## Persisted state both surfaces must agree on

- Write: `PUT /api/model-visibility {scope:"models", provider, targets:[{id, native}], enabled}`
  (`gui/src/model-visibility.ts` `putModelVisibility`). The server updates the provider allowlist
  (`selectedModels`) and the shared `disabledModels` list in one write
  (`src/server/management/model-routes.ts` ~L734).
- Read: final visibility = `modelVisible(selected, provider, id, native, row.disabled)`
  (`gui/src/model-visibility.ts`), the same rule Models.tsx applies through
  `collectDisabledNamespaced` + `savedModelVisible`.
- Optimistic, ordered, single-flight writes with one authoritative re-read when the queue drains:
  `gui/src/use-model-visibility.ts`. Models.tsx feeds its `onBusy` into `catalogMutationRef`,
  which stops the 10 s catalog poll from repainting rows mid-flight.

## Changes

1. **Shared toggle helper** — new `gui/src/model-visibility-switch.tsx`:
   `rowVisibilityTarget(row)`, `rowSavedVisible(selected, row)` (wraps `modelVisible`), and
   `ModelVisibilitySwitch({ row, on, disabled, onToggle })` rendering `Switch` from `ui.tsx`
   (`role="switch"`, `aria-checked`, constant label = model id or namespaced id). Used by 3a and 3b.
2. **3a Providers** — `gui/src/components/provider-workspace/ProviderModels.tsx` +
   `ProviderModelChip.tsx`:
   - list every provider row (disabled rows included, dimmed); free-only/search apply to all rows;
   - each chip gets `ModelVisibilitySwitch`; the Hide (eye) button is removed, Delete stays for owned
     custom rows; the confirm dialog only guards Delete (a switch is reversible, NN/G guidance);
   - writes go through `useModelVisibility`; its `refresh` calls the existing `retry()` (paired
     /api/selected-models + /api/models parent read and ownership read) and resolves when a newer
     `modelRevision` becomes ready (true) or fails (false); abort resolves false;
   - switch disabled when the row is `initialSelectionPending`, the Delete/Add flight is busy, or the
     inventory is not ready (except while the visibility queue itself is pending); Delete/Add blocked
     while the visibility queue is pending, so the two flights never interleave;
   - header count becomes `models.active` ({on}/{total} visible); settle error shows inline
     (`models.saveFailed` / `models.networkError`).
3. **3b Overall tab** — new tab id `overall` (hash `#models/overall`, after `catalog`):
   - `gui/src/pages/models-tab.ts`: union, `MODELS_TABS`, `readModelsTab`; `models-tab-strip.tsx` label;
   - new `gui/src/pages/models-overall/ModelsOverallPanel.tsx`: Subagents-picker layout (`Frame`,
     search input with icon, count pill, scrollable ruled list), All/On/Off filter buttons
     (`aria-pressed`), rows = provider mark + model label + provider slug + switch, stable server
     order (rows do not jump on toggle), render cap with "Show N more" (`models.showMore`), cold /
     failed states passed in;
   - `Models.tsx` wiring only (~20 lines, cap 2792, now 2738): panel shell like the other tabs,
     `SUBTITLE_TKEY.overall`, `tabMeta.overall`, catalog resource `enabled` also on the overall tab,
     the action toast rendered for catalog and overall, and the panel receives the SAME
     `modelVisible`/`applyVisibility`/`busy` so both tabs share one queue and one poll guard;
   - `gui/src/styles-models-workspace.css`: overall panel gets the 1200 px column like catalog.
4. **Copy** — new `gui/src/i18n/models-overall-copy.ts` (11 locales, one row per key), spread into
   the 11 locale files (one import + one spread line each). Keys: `models.tab.overall`,
   `modelsOverall.lede`, `.title`, `.search`, `.filterLabel`, `.filter.all|on|off`, `.empty`,
   `.noModels`, `.providerColumn` (as needed).
5. **Docs** — `docs-site/src/content/docs/guides/web-dashboard.md` (and providers guide if it
   describes the Hide button): one short paragraph for the Overall tab and the provider switches.

## Tests (written first, must fail before the change)

- `gui/tests/provider-model-switches.test.tsx` (new): enabled, disabled and allowlist-excluded rows all
  render with switches whose `aria-checked` follows allowlist AND disabled; a click flips the switch
  immediately, sends one PUT with the exact body, and the switch stays on after the parent re-read;
  while that write and its re-read run every switch is disabled and a second click sends nothing
  (Providers is single-write, see round 4); Delete is blocked while a toggle is pending.
- `gui/tests/models-overall-tab.test.tsx` (new): `#models/overall` selects the Overall tab; models from
  two providers listed; search narrows the list; On/Off filters; a click sends the PUT and the
  catalog tab shows the same state afterwards; a held catalog read during the write does not revert
  the switch.
- Update `provider-model-management.test.tsx` / `provider-model-custom-add.test.tsx` cases that pin the
  removed Hide button: replace Hide with the switch where the case is about identity/visibility,
  keep every Delete case unchanged.

## Verification

`bun run typecheck`; `bun run lint:gui`; `cd gui && bun run lint:i18n`; `cd gui && bun test` on every
touched/new test file (whole files); `cd gui && bun run build`; `bun run test:changed`;
`bun test tests/repo-health/file-size*` (ratchet); full `bun run test` if the host has headroom.
Screenshots: isolated `OPENCODEX_HOME`, `bun run src/cli/index.ts start --port <free>`, GOAT browser.

## Risks

- Provider tab switch remounts ProviderModels and aborts an in-flight PUT client-side; the server may
  still commit it, and the next view re-reads. Same contract as Models on a server change.
- Removing Hide changes a tested behavior on purpose; Delete keeps its confirm and single flight.


## Audit round 1 (terra, FAIL) — resolutions

1. **Router.** Add `"models/overall"` to `MODELS_TAB_HASHES` in `gui/src/app-routing.ts` (and its comment), so
   `resolveHashRoute` keeps `#models/overall`. Test: app-routing resolves `models/overall` with no
   replace, and Models mounted at `#models/overall` selects the Overall tab.
2. **One rule.** Shared helper `savedRowVisible(selected, disabledSet, row)` =
   `modelVisible(selected, row.provider, row.id, row.native === true, disabledSet.has(row.namespaced))`,
   where `disabledSet = collectDisabledNamespaced(allRows)` — exactly the catalog rule. Overall reads it
   with Models.tsx's own `selectedModelMap`/`disabled` set + `visibility.visible` overrides; Providers
   reads it in the shell with the shell's full `modelSnapshot.rows` and full selection map. Overall
   switches are disabled for `initialSelectionPending` and `(busy && !visibility.pending)`, identical to
   catalog L1711. Test: native/custom/allowlist-excluded rows agree between Catalog and Overall.
3. **Settlement and lifetime.** The provider queue moves to the shell: new
   `gui/src/provider-workspace/use-provider-model-visibility.ts` wraps `useModelVisibility`, is called in
   `ProviderWorkspaceShell` (which owns the paired /api/selected-models + /api/models read and does not
   remount on a provider switch), and is handed down as `DetailSlotData.modelVisibility`
   (Providers.tsx -> ProviderDetails -> ProviderModels). `refresh(signal)` records the current revision,
   calls the shell's `retryModels()` (always bumps `modelsLoadEpoch`, so the revision always changes),
   and resolves `true` when a newer revision is `modelRowsReady`, `false` when that newer revision
   fails or the signal aborts (waiter removed). No optional callback: the shell always has `retryModels`;
   when `ProviderModels` gets no `modelVisibility` (other hosts) the switches are not rendered. Leaving
   the Providers page unmounts the shell and aborts like leaving the Models page does today (same
   contract as the existing hook); a provider switch no longer aborts anything. Ownership (custom
   definitions) is not part of visibility, so settlement does not wait on it; the stale-ownership guard
   below disables a switch until ownership for the current revision is ready.
4. **Synchronous gates both ways.** Switch handler returns early when `flight.current` (Delete/Add,
   claimed before the dialog and held through reconciliation) is set; Delete/Add return early when
   `modelVisibility.isRunning()` (ref-backed). Switch disabled for `initialSelectionPending`, for the
   stale custom-override case kept from `actionFor` (non-native, non-custom row whose id has a stored
   custom definition), and while ownership for the current revision is not ready unless the visibility
   queue itself is pending. Tests: Delete dialog open -> switch click sends nothing; switch pending ->
   Delete sends nothing; stale ownership -> switch disabled.
5. **Integration failures.** Extract the catalog's warning into
   `gui/src/components/integration-refresh-warning.tsx` (`IntegrationRefreshWarning({ failures })`,
   same copy `models.integrationRefreshWarning` + `describeIntegrationRefusalParts`), render it in the
   Catalog panel (replacing the inline block), the Overall panel, and ProviderModels (failures from the
   shell hook's `onResponse`). Test: a PUT answering `clientIntegrations:[{ok:false}]` shows the warning
   on Providers and on Overall.
6. **Gate.** `catalogActive` stays Catalog-only; a new `catalogDataActive = catalogActive || tab === "overall"`
   enables only the catalog resource. Picker, v2 and preset loaders stay Catalog-only.
7. **Test rewrites keep guarantees.** Hide cases become switch cases asserting the exact native PUT body
   and identity labels; Delete dismissal, platform-dialog traps, and single flight through both
   reconciliation reads stay; custom-add hidden-row cases assert `aria-checked="false"` while keeping
   duplicate and hidden-save checks.


## Audit round 2 (terra, FAIL) — resolutions

1. **Lock lifetime.** The Delete/Add lock moves to the shell with the visibility queue:
   `modelVisibility.mutationLock` (a shell-owned ref) replaces ProviderModels' local `flight` ref when
   present. Claim is unchanged (before the consent dialog). Release: on dismiss; in the reconcile effect
   when mounted; in `finish()` when the instance already unmounted (it already calls `onRetryModels`
   there); and in the unmount cleanup only when this instance is past its request (phase
   `reconcile`/idle — never while its dialog or request is open, those paths release themselves). The
   switch checks the same lock synchronously, and Delete/Add check `modelVisibility.isRunning()`, so
   the two flights exclude each other across provider and tab remounts. Tests: Delete in flight ->
   leave the Models tab and come back -> switch click sends nothing until the Delete settles.
2. **No ownership exception.** Switches are disabled whenever ownership for the current revision is not
   ready, including while the visibility queue is pending. Test: ownership read held after a toggle ->
   switches disabled until it lands.
3. **Page unmount.** Kept as the existing hook contract, with evidence that no committed write can be
   missed: `PUT /api/model-visibility` has no `await` between `readManagementJsonBody`
   (src/server/management/model-routes.ts:736) and `persistConfig` (:851). An aborted request either
   never delivered its body (no commit) or committed in the same server turn, before any later request
   is handled; remounting the shell always issues a fresh paired read (ProviderWorkspaceShell effect on
   `modelRevision`). Test: toggle, unmount the page before the response, the server commits, remount ->
   the switch shows the committed state.
4. **Residuals taken.** Router test uses `resolveAppHashChange` for direct load and Back/Forward. Extra
   tests: virtual combo rows toggle with provider `combo` on Overall, a failed revision waiter reports
   `models.networkError`, a click during the shell refresh sends nothing on Providers (single-write);
   the ordered multi-click queue stays covered by gui/tests/models-visibility-queue.test.tsx.


## Audit round 3 (terra, FAIL) — main-agent decision: NEAR-PASS

Three rounds narrowed to properties of the existing Delete/Add flow and of the existing
`useModelVisibility` unmount contract, not of the new surfaces. Decision (LOOP-DOOM: stop widening):

- **Taken:** the Delete consent dialog gets an unmount-scoped AbortSignal (`confirmAction` already
  supports `signal`, gui/src/action-dialogs.ts:34), so leaving the tab/provider dismisses it and
  releases the local lock. Test included.
- **Simplified (replaces round-2 item 1):** no shell-owned lock. ProviderModels keeps its local
  `flight` ref for Delete/Add exactly as today; the switch checks it synchronously, and Delete/Add check
  the shell queue's `isRunning()` synchronously. Within one mounted inventory the two flights exclude
  each other.
- **Residual A (accepted):** a Delete whose request was already sent before an unmount can overlap a
  switch write in the next mount. Each server request is atomic (one `persistConfig` per request) and
  both flows end in a full paired re-read, so state converges; Delete-then-Delete across a remount
  already behaves this way on dev.
- **Residual B (accepted):** leaving the Providers page mid-write aborts the client request, the same
  contract the Models page has today (use-model-visibility.ts:38). If the server is still suspended in
  the body read when the next mount's GET is served, that first read can predate the commit; any later
  read (provider re-open, Models poll, retry) converges. Fixing it belongs in the shared hook for both
  pages and is out of this lane's scope; it will be named in the PR.


## Audit round 4 (terra, FAIL) — resolution

- **Providers is single-write.** On the Providers surface every switch (and Delete/Add) is disabled, and
  the click handler returns early, while the shell queue `isRunning()` — from the click through the
  post-write paired read. The queue therefore never holds an accepted-but-unsent intent on this page,
  so leaving the page can lose at most the one request already sent (Residual B, unchanged from dev).
  The ordered multi-click queue stays a Models-page behavior (Catalog and Overall), as on dev.
  Test: first PUT held -> every switch disabled and a second click sends nothing; release -> after
  the re-read the switches enable again.

