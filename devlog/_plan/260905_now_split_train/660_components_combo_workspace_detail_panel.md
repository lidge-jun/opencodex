# S19 L4 — Controlled Config contents inside the stable detail shell

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: **pure-move**, C3, docs-only delegated task; parent owns implementation and orchestration/loop state.
- Goal: reduce `gui/src/components/combo-workspace-detail-panel.tsx` (401 lines) below 400 by moving its Config form contents into one controlled sibling component. Keep the exported detail component, both mounted panel shells and all state lifetimes unchanged.
- Non-goals: tab/ARIA changes, styling, copy, component-state redesign, a hook extraction, save/validation changes, cleanup of existing callback dependencies, or removing the About content.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below with combo DOM/dirty/native-alias tests and source guards.
- Stop: pure-move layer diff, preserved export/DOM and state ownership, ≤400-line outputs, focused/build/privacy proof and remote exact-head full-suite/CI evidence; no merge.
- Escalation: prop behavior changes, a source guard needing unplanned weakening, new cycle, source drift, >400-line output, >500 raw source lines, or a requirement to move state beyond the approved JSX seam. Do not add a #b layer without the parent.
- Basis: docs `4cc219549`; code `origin/dev = 1362b1a3841b4de20177e5d65865a513dd7936c4`. These line ranges are at origin/dev and were byte-verified against the working tree. Read train 000/001/002 and `260905_modular_debt_ledger/015_lane_gui.md`: its prescribed seam keeps tablist/panel shells at the old boundary and moves contents through typed draft/events.

## Symbol inventory

All top-level declarations from `rg` reconciled with `sg run --kind <function_declaration|lexical_declaration|type_alias_declaration> --json=compact gui/src/components/combo-workspace-detail-panel.tsx`. Imports are covered below, not declaration rows. Consumers are distinct importing files from `rg -l 'from ["\x27][^"\x27]*/combo-workspace-detail-panel(\.tsx?)?["\x27]' src gui/src gui/tests tests scripts`, then `rg -l -w '<symbol>'` within those files. R is the original path; F is `gui/src/components/combo-workspace-detail-config.tsx`.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| DetailTab | type | 21–21 | no | 0 | R |
| DETAIL_TABS | const array | 23–23 | no | 0 | R |
| detailTabDomId | const arrow function | 30–30 | no | 0 | R |
| detailPanelDomId | const arrow function | 31–31 | no | 0 | R |
| DetailPanel | function component | 33–401 | yes | 3 | R; nested Config JSX 251–378 moves to F |

There are no existing independent top-level form components to move wholesale. The new `ComboDetailConfigFields` declaration and leaf-private `ComboDetailConfigFieldsProps` describe the extracted nested JSX only; they do not rename an existing public symbol.

## Leaf partition

Structural decision: retain controller, header, About content and accessibility shell; extract the existing `cwi-form-grid` at `gui/src/components/combo-workspace-detail-panel.tsx:251`. Current direction: `ComboWorkspace.tsx:12` and two direct tests → DetailPanel → data/controls/i18n/UI. Intended: same consumers → DetailPanel → F → data/controls/types; no F → DetailPanel import. Blast radius: combo presentation feature.

Rejected alternatives: deleting a blank line only satisfies the size number, not the seam; moving the entire 369-line function creates a ~401-line leaf and loses shell locality; moving the tablist makes the source and ARIA guards needlessly migrate; lifting draft state into a new hook changes a lifetime the task must preserve. Reuse the existing StrategySeg/EffortSelect/TargetEditor/ComboCapabilities rather than create replacements. Sibling naming/props convention is present in `combo-workspace-controls.tsx`, `combo-workspace-overview-panel.tsx`, `combo-workspace-add-modal.tsx` and `combo-workspace-types.ts`.

One NEW file: `gui/src/components/combo-workspace-detail-config.tsx`.

- Symbols: exported `ComboDetailConfigFields`, leaf-private `ComboDetailConfigFieldsProps`.
- Body: copy original 251–378 (**128 lines**) as the component's returned root `<div className="cwi-form-grid">`. Preserve every field, event updater, label, condition and child component prop. The surrounding Config panel at original 243–249/380 and About shell at 386–398 remain in R, with the original always-mounted/hidden semantics.
- Expected **165 lines**, including imports and one props signature, not an unmeasured moved 401-line component. No hooks or new local draft state in F. `t` is passed from the existing owner, not replaced with an extra subscription.
- Its own imports:

```ts
import {
  type ComboItem, type ComboEffort, type ProviderQuotaStates,
  comboModelId, comboPublicModelId, updateComboAliasDraft,
  COMBO_STRATEGY_HINT_KEYS, COMBO_TARGETS_HINT_KEYS,
} from "../combo-workspace-data";
import type { TFn } from "../i18n/shared";
import type { ModelOption, ProviderOption } from "./combo-workspace-types";
import { ComboCapabilities, EffortSelect, StrategySeg, TargetEditor } from "./combo-workspace-controls";
import { clampedNumberInput } from "./combo-workspace-utils";
```

Use existing `TFn` from `gui/src/i18n/shared.ts:59`, not a duplicated translator signature. The exact private prop contract is:

```ts
type ComboDetailConfigFieldsProps = {
  t: TFn;
  draft: ComboItem;
  busy: boolean;
  isCreate: boolean;
  allowedEfforts: ComboEffort[];
  updateDraft: (updater: (prev: ComboItem) => ComboItem) => void;
  providers: ProviderOption[];
  models: ModelOption[];
  providerQuotaStates: ProviderQuotaStates;
};
```

All nine values already exist in the original function (props at 33–63, state/memos at 64–107). Pass them explicitly at the original form location:

```tsx
<ComboDetailConfigFields
  t={t}
  draft={draft}
  busy={busy}
  isCreate={isCreate}
  allowedEfforts={allowedEfforts}
  updateDraft={updateDraft}
  providers={providers}
  models={models}
  providerQuotaStates={providerQuotaStates}
/>
```

Residual `gui/src/components/combo-workspace-detail-panel.tsx`: **expected 285 lines**. Arithmetic: 401 − 128 + 11 call-site lines = 284 before import cleanup/new leaf import; removing form-only imports creates additional margin. Keep the original parentheses and both panel wrappers, headerModel, About section, all hooks/callbacks and current return structure. No #b required. Expected raw source additions/deletions about 310, below 500; verify at implementation, never minify to meet a limit.

## Re-export block

**No re-export is required.** `export function DetailPanel` remains at the original import path with the full unchanged public prop signature. No named or default export is moved out of R; do not expose the new private form component through R merely to create a barrel. Exact original public export remains `DetailPanel` only.

Explicit residual import:

```ts
import { ComboDetailConfigFields } from "./combo-workspace-detail-config";
```

Drop form-only imports from R: `comboModelId`, `updateComboAliasDraft`, the four controls, `COMBO_STRATEGY_HINT_KEYS`, `COMBO_TARGETS_HINT_KEYS` and `clampedNumberInput`. Keep `comboPublicModelId` for save/header derivation at original 151 and 171. Keep `ComboItem`, `ProviderQuotaStates`, `comboQuotaState`, `draftEquals`, `intersectComboEfforts`, `validateComboDraft`, both icons, `useT`, `Notice`, option types and React hooks; they are still used by R. The imported names from the data facade resolve through L3's preserved exports.

## Module-level state and cycles

- No top-level mutable `let`, Map, Set, WeakMap, lock, cache or timer in this source. `DETAIL_TABS` at `gui/src/components/combo-workspace-detail-panel.tsx:23` stays a single read-only-used array in R. DOM-ID arrows at 30/31 also stay R.
- Tab state 65, draft/busy/message/copied state 84–87, the `baselineSyncKey:90`, effortMap's per-memo Map at 92, and `allowedEfforts:98` all remain in R. Do not recreate them per F mount.
- `updateDraft:103`, delayed baseline reset at 109–119, clipboard reset timer at 121–129 and save logic at 131–168 remain unchanged. The callback closes over the same draft/baseline as before; this plan does not opportunistically rewrite it to a functional state setter.
- F is controlled and stateless. No `useState`, effect, memo, new provider or default model/target allocation. Existing updater expressions move inside the same rendered form context; no React `memo`, keys or conditional mounting are added.
- Avoid R → F → R (including props type imports): define the small props type in F from the pre-existing neutral option/data/i18n contracts, never `Parameters<typeof DetailPanel>`. With L3, data facade → quota → contracts stays inward; controls/options do not import DetailPanel. No new type-only or runtime cycle.

## Tests

Complete direct test-import `rg -l` list (unchanged):

```text
gui/tests/combos-detail-tabs-dom.test.tsx
gui/tests/combo-native-alias-editor.test.tsx
```

Import lines 14 and 6 respectively. Third importer: `gui/src/components/ComboWorkspace.tsx:12`, unchanged. Add focused integration coverage via the existing indirect `gui/tests/combo-workspace-dirty.test.tsx` (mounts ComboWorkspace); it protects editing/revert/navigation and exhausted-quota save gating.

Every discovered source-text reader:

| test/read location at origin/dev | disposition | reason/action |
|---|---|---|
| `gui/tests/combos-detail-segmented.test.ts:15` starts `Bun.file`, line 16 names `../src/components/combo-workspace-detail-panel.tsx` | unchanged | all asserted tablist/tab/tabpanel/segmented markup remains in R; no retarget and no scan-list expansion |

The same test's CSS read at 18–20 remains unchanged. `gui/tests/combos-detail-tabs-dom.test.tsx:139` reads only `styles-combos-workspace.css`, not this TSX file. Searches for full basename and extensionless stem across `tests` and `gui/tests` found no other source reader. Do not retarget the shell guard to F: F owns no tab roles.

Drive guards red once during implementation: remove/mistype `role="tablist"` in the retained shell and require the segmented test to fail; restore it. Temporarily miswire the moved alias input's update callback in F and require `combo-native-alias-editor.test.tsx`'s edit/metadata case to fail; restore it. Mounted tab tests must still prove both IDREF targets exist, exactly one panel is exposed, roving tabindex works and About is focusable. No test runs or mutations happen in the docs task.

## Verification

Future L4 worktree gate, domains GUI combo controls, tabs, native alias and dirty navigation:

```sh
bun run typecheck
bun test gui/tests/combos-detail-segmented.test.ts gui/tests/combos-detail-tabs-dom.test.tsx gui/tests/combo-native-alias-editor.test.tsx gui/tests/combo-workspace-dirty.test.tsx
bun run privacy:scan
(cd gui && bun run lint && bun run build)
wc -l gui/src/components/combo-workspace-detail-panel.tsx gui/src/components/combo-workspace-detail-config.tsx
rg -l 'from ["\x27][^"\x27]*/combo-workspace-detail-panel(\.tsx?)?["\x27]' src gui/src gui/tests tests scripts
sg run --kind import_statement --json=compact gui/src/components/combo-workspace-detail-config.tsx
git diff --check
git diff --numstat codex/split-combo-workspace-data...HEAD
```

All checks exit 0 / tests zero failures; both files ≤400. DetailPanel importer set stays exactly three. The data facade's importer set intentionally grows from thirteen to fourteen because F now imports it; no existing consumer is redirected. Compare the new graph including type edges and ensure F never imports R. No protected backend path is touched, so conditional core-Lab test is not required. GUI-copy/i18n keys are unchanged; lint/build still apply. Check the layer-only moved JSX and wrapper diff against original spans and capture unchanged Config/About screenshots.

Full suites remotely only, using a parent-allocated checkout without concurrent stack checkout changes:

```sh
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-components-combo-workspace-detail-panel && git checkout -q FETCH_HEAD && bun install --frozen-lockfile && bun run test && (cd gui && bun install --frozen-lockfile && bun test tests)'
```

Record remote SHA equal to PR tip, actual exit status/full log and exact-head CI rollup. No local full suite, deployment or live service restart is authorized by this plan. None of the test/build commands were run while drafting.

## Accept criteria

1. All five original declarations remain in R; its sole export `DetailPanel` and public prop contract are unchanged, with three unchanged importing files.
2. Exactly one new F file, expected 165 lines, contains the original 128-line form and the explicit typed props only; both files are ≤400 and raw source diff ≤500.
3. F contains no state/effects; all state, timers, save/copy handlers, request callbacks and baseline synchronization stay in R.
4. Both tabpanel shells remain mounted with the same ids, hidden conditions and About focusability; no extra DOM wrapper or ARIA/CSS/i18n change.
5. There is no F → R runtime/type dependency; L3 data exports remain intact. Existing component public imports are not rewritten.
6. The unchanged shell text guard and alias behavior guard fail under their specified negative probes and pass when restored; all four focused test files, typecheck/privacy/GUI lint/build, remote full suites and exact-head CI have fresh success evidence.
7. PR targets L3's branch, upper/lower ancestry is parent-verified, all four stack links are present, and no merge occurs.

## PR

Title: `refactor(gui): extract controlled combo configuration fields (split S19 L4/4)`

Branch: `codex/split-components-combo-workspace-detail-panel`. Base: `codex/split-combo-workspace-data`. Closes: none.

Use the full repository PR-template Summary / Verification / Checklist; attach unchanged Config/About GUI screenshots. DEV-STACK-03 map:

| # | PR | Branch | Base | Review focus |
|---|---|---|---|---|
| 1 | #TBD-S19-L1 | codex/split-pages-compatibility-matrix-api | dev | pagination/error owner |
| 2 | #TBD-S19-L2 | codex/split-pages-CompatibilityMatrix | codex/split-pages-compatibility-matrix-api | matrix presentation leaves |
| 3 | #TBD-S19-L3 | codex/split-combo-workspace-data | dev | quota evidence and combo contracts |
| 4 | #TBD-S19-L4 | codex/split-components-combo-workspace-detail-panel | codex/split-combo-workspace-data | controlled Config contents; this layer |

Depends on #TBD-S19-L3; review this layer only. Parent cascades edits to `codex/split-combo-workspace-data` into this layer before refreshing review/CI (DEV-STACK-02). Merge after that parent only on separate user authorization; no auto-merge.
