# 600 — S17 L3/3: Storage part b

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

Archetype: **pure-move**; C3 module-boundary planning, docs-only delegated mode.
Non-goals: no cache/poll rewrite, changed validation, endpoint, deadline, cancellation,
outcome precedence, i18n key, page loading behavior, or new service abstraction.
Goal: finish Storage's decomposition by moving automatic-policy ownership and
cleanup composition, retaining the page report resource in the original.
Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below.
Stop: final files ≤400, all mechanical checks green, and parent resolution of
size/pure-move interpretation; eventual open exact-head-green PR, never merge.
Escalate if the parent interprets pure-move as whole-declaration-only: the
619-line AutoCleanupPolicyPanel cannot be relocated whole into a ≤400-line leaf.
This plan names the minimal JSX render seam and explicit lexical dependencies;
it does not grant permission for arbitrary controller redesign.
**Escalation S17-SIZE-01:** 002 fixes only two Storage layers at ≤500 changed
source lines each, but 1469 − 400 = 1069 original lines must leave the page even
before import/wrapper overhead. Thus no honest two-layer partition can satisfy
that cap, even under the generous count-once definition of a move. Ordinary
added+deleted diff accounting is larger still. This document supplies the
requested concrete partition, not an approved exception. Parent must authorize
a size exception or expand/remap the stack; do not invent a fourth document,
change 002, or claim this layer is implementation-ready.

Source basis: `origin/dev = 1362b1a3841b4de20177e5d65865a513dd7936c4`;
docs HEAD `4cc219549eafbf9cd2efd651482fbfefd88944d5`. All source ranges below
are inclusive origin/dev ranges, not post-move positions. Read with `git show
origin/dev:<path>`; `git diff origin/dev -- gui/src/pages/Storage.tsx
gui/src/components/storage-workspace/StorageWorkspace.tsx` was empty.
Declaration endpoints were checked with `sg run --kind <function_declaration|
interface_declaration|type_alias_declaration|lexical_declaration> --json=compact
<file>`, and top-level starts with anchored rg. No code or test execution occurred.

Read predecessor 590 first. Evidence: `015_lane_gui.md:131–143,508,511,604`.
Current at #a tip: page contains policy component and cleanup-card; manual and
quarantine leaves already exist. Intended: page → cleanup-card → panels;
policy-panel → policy-model and stateless policy-view; view → policy-model type.
Existing resource/cache modules remain dependencies, not new state owners.
Rejected: move all 619 lines to an oversized leaf; extract a new global service;
move the report resource away from the source oracle; or split rendering into
nested component definitions that remount on every render.
Chosen: keep hooks together in the same named component, move its hook-free
render tail to a plain named render function with an explicit argument record.
Consequence: internal argument glue only, zero public contract change; behavior
verification must cover lexical captures, timing, and outcome ordering.

## Symbol inventory

For every row, ranges refer to `gui/src/pages/Storage.tsx` at origin/dev.
Consumer notation `E / R`: E = distinct external importing files, R = local
identifier-reference occurrences from `git show origin/dev:<path> | rg -o -w
<symbol>`, excluding the declaration. Non-exported symbols have E=0; R is
lexical evidence, not a claim that every token is a runtime call. Path importer
search `rg -l 'from .*pages/Storage["\x27]' src gui/src gui/tests scripts tests`
found 3 files: `gui/src/App.tsx:9`, `gui/tests/storage-loading-race.test.tsx:7`,
`gui/tests/storage-policy-metadata-warning.test.tsx:7`.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---|---|
| useCallback, useEffect, useRef, useState, KeyboardEvent | import bindings | 1–1 | no | dependency bindings | redistribute by own-import lists |
| useI18n, TFn, Locale | import bindings | 2–2 | no | dependency bindings | redistribute by own-import lists |
| EmptyState | import binding | 3–3 | no | dependency binding | original |
| IconRefresh | import binding | 4–4 | no | dependency binding | original |
| formatBytes | import binding | 5–5 | no | dependency binding | panel leaves |
| NumberStepper | import binding | 6–6 | no | dependency binding | #b storage-policy-view.tsx |
| clampNumberDraft | import binding | 7–7 | no | dependency binding | #b storage-policy-view.tsx |
| StorageWorkspace, StorageReport | import bindings | 8–10 | no | dependency bindings | original, unchanged public path |
| readSessionListCache, writeSessionListCache | import bindings | 11–11 | no | dependency bindings | original + #b storage-policy-panel.tsx |
| useDataSurface | import binding | 12–12 | no | dependency binding | original + #a storage-quarantine-panel.tsx |
| DataSurfaceSkeleton, DataSurfaceStatus | import bindings | 13–13 | no | dependency bindings | original + #a storage-quarantine-panel.tsx |
| CleanupPreview | interface | 16–22 | no | 0 / 2 | #a storage-archived-panel.tsx |
| CleanupResult | interface | 24–32 | no | 0 / 2 | #a storage-archived-panel.tsx |
| TrashEntry | interface | 34–41 | no | 0 / 9 | #a storage-cleanup-contracts.ts |
| TrashList | interface | 43–45 | no | 0 / 1 | #a storage-quarantine-panel.tsx |
| RestoreResult | interface | 47–54 | no | 0 / 2 | #a storage-quarantine-panel.tsx |
| GB | const | 56–56 | no | 0 / 4 | #b storage-policy-model.ts |
| CleanupPolicy | interface | 58–83 | no | 0 / 22 | #b storage-policy-model.ts |
| PRESETS | const tuple | 85–85 | no | 0 / 1 | #a storage-archived-panel.tsx |
| localizedCatch | const arrow function | 87–100 | no | 0 / 3 | #a storage-cleanup-error.ts |
| ArchivedCleanupPanel | component | 102–344 | no | 0 / 1 | #a storage-archived-panel.tsx |
| QuarantineTrashPanel | component | 346–569 | no | 0 / 1 | #a storage-quarantine-panel.tsx |
| policyFieldsFromResponse | function | 571–575 | no | 0 / 3 | #b storage-policy-model.ts |
| CachedCleanupPolicy | type | 577–583 | no | 0 / 2 | #b storage-policy-model.ts |
| draftsFromPolicyResponse | function | 585–603 | no | 0 / 1 | #b storage-policy-model.ts |
| sleep | async function | 605–607 | no | 0 / 1 | #b storage-policy-model.ts |
| AutoCleanupPolicyPanel | component | 609–1227 | no | 0 / 1 | #b storage-policy-panel.tsx + extracted storage-policy-view.tsx |
| StorageCleanupTab | type | 1229–1229 | no | 0 / 3 | #b storage-cleanup-card.tsx |
| StorageCleanupCard | component | 1231–1343 | no | 0 / 1 | #b storage-cleanup-card.tsx |
| Storage | default component | 1345–1469 | default | 3 / 0 | original |

Both #a and #b reproduce the complete origin inventory intentionally. Rows marked
#a are already moved at #b's base, not a second move. #a takes zero-external-consumer
manual/quarantine leaves first; the policy's 22-reference contract and page resource
remain for #b. Each panel itself has one local JSX caller; ties are resolved by
dependency direction and preserving a complete panel lifetime.

## Leaf partition

New files are `gui/src/pages/` siblings; four #a leaves are reused, not recreated.

| NEW file | symbols / exact origin ranges | expected lines | own imports |
|---|---|---:|---|
| gui/src/pages/storage-policy-model.ts | GB/CleanupPolicy (56–83), policyFieldsFromResponse/CachedCleanupPolicy/draftsFromPolicyResponse/sleep (571–607) | 66 | none; window in sleep remains a call-time global |
| gui/src/pages/storage-policy-panel.tsx | AutoCleanupPolicyPanel signature + hooks/handlers (609–925); new call to renderAutoCleanupPolicyView | 331 | useCallback/useEffect/useRef/useState from react; Locale/TFn types from ../i18n/shared; readSessionListCache/writeSessionListCache from ../session-list-cache; formatBytes from ../format-bytes; GB/policyFieldsFromResponse/draftsFromPolicyResponse/sleep and CleanupPolicy/CachedCleanupPolicy types from ./storage-policy-model; renderAutoCleanupPolicyView from ./storage-policy-view |
| gui/src/pages/storage-policy-view.tsx | NEW renderAutoCleanupPolicyView enclosing unchanged render tail 926–1227, including local formatWhen and early returns | 350 | Locale/TFn types from ../i18n/shared; formatBytes from ../format-bytes; NumberStepper from ../components/NumberStepper; clampNumberDraft from ../clamp-draft; CleanupPolicy type from ./storage-policy-model |
| gui/src/pages/storage-cleanup-card.tsx | StorageCleanupTab and StorageCleanupCard (1229–1343) | 122 | useRef/useState and KeyboardEvent type from react; Locale/TFn types from ../i18n/shared; TrashEntry type from ./storage-cleanup-contracts; ArchivedCleanupPanel from ./storage-archived-panel; QuarantineTrashPanel from ./storage-quarantine-panel; AutoCleanupPolicyPanel from ./storage-policy-panel |

Model budget = 28 + 37 + one separator = 66.
Policy component budget = 317 preserved signature/body lines + 14 import/call
glue = 331. Render budget = 302 preserved tail lines + 48 signature/import glue
= 350. Card budget = 115 + 7 = 122. These are expected physical counts, not
permission to compress existing code; final wc must verify ≤400 for each.

The view argument record lists **all** lexical captures:
`locale, t, policy, loading, saving, running, status, error, targetMode, percent,
reduceGb, thresholdGb, setTargetMode, setPercent, setReduceGb, setThresholdGb,
markDirty, setEditing, savePolicy, runNow`.
Use the existing types: policy is `CleanupPolicy | null`, status/error
`string | null`, targetMode `"percent" | "reduce"`, draft strings remain
strings; setters take their respective value type, markDirty returns void,
setEditing takes boolean, savePolicy takes `Partial<CleanupPolicy>?` and
returns Promise<void>, runNow returns Promise<void>. Locale and TFn come from
the existing i18n owner. Define this argument type inline in the view signature,
not as a second state model. Call the function after all hooks, passing the
same render's bindings. It has no hooks or state and must not be defined inside
the policy component. Do not memoize, debounce, reorder, or rewrite event closures.

Residual `gui/src/pages/Storage.tsx`: **140 expected lines**:
#a's 947 − 29 (56–84) − 774 (571–1344) − 5 obsolete import lines + 1
cleanup-card import = 140. Replace line-1/2 imports in place to drop now-unused
useEffect/KeyboardEvent/TFn/Locale, remove formatBytes/NumberStepper/clampNumberDraft
and the two #a panel imports. Keep TrashEntry, useI18n, EmptyState, IconRefresh,
workspace public imports, session cache, useDataSurface, skeleton/status.
Original default page body 1345–1469 remains unchanged.

Consistent stack accounting: Storage 1469 → #a 947 → #b 140; #a leaves
268 + 246 + 8 + 14 = 536; #b leaves 66 + 331 + 350 + 122 = 869.
Final Storage family estimate 140 + 536 + 869 = 1545 (76 net glue lines versus
1469); workspace family 358 + 85 + 232 = 675. **Ten new files total for S17**;
zero final residual files >400; one temporary >400 residual after #a.
#b removes 803 original lines before import cleanup, so cannot meet 002's 500
cap even if a moved line is counted only once. No further #c is silently assumed.

## Re-export block

The exact required re-export block is **empty**: the only current export,
`export default function Storage`, remains at the original path.

Residual local imports added/retained:

```ts
import { StorageCleanupCard } from "./storage-cleanup-card";
import type { TrashEntry } from "./storage-cleanup-contracts";
```

The card imports its three panels directly as listed above. Model named exports:
GB, policyFieldsFromResponse, draftsFromPolicyResponse, sleep, and type exports
CleanupPolicy/CachedCleanupPolicy; the private StorageCleanupTab stays in its
card leaf. The view exports renderAutoCleanupPolicyView; the panel exports
AutoCleanupPolicyPanel. None is re-exported from Storage.tsx and none imports
Storage.tsx. Keep the existing workspace default/type import unchanged.
Re-exporting any internal name would neither provide the card's local binding nor
preserve the original public surface accurately.

## Module-level state and cycles

No top-level let/Map/Set/WeakMap/lock exists. GB at 56 moves once into
storage-policy-model.ts; PRESETS at 85 already belongs to the #a archived leaf.
localizedCatch at 87 already belongs to #a cleanup-error; it is stateless.
The policy cacheKey at 620 is per render; read/writeSessionListCache keeps its
existing external owner and invocation timing. No new module singleton or
module-initialization browser access is introduced.

All policy hooks/refs 620–642 remain in AutoCleanupPolicyPanel:
hasCacheRef, policy/loading/saving/running/status/error/drafts, runAbortRef,
dirtyRef, editingRef, loadGenerationRef. Effects at 688–705 and handlers at
644–924 remain together. Keep delayed load cancellation, generation increments,
dirty/focused-draft protection, 250ms polling and 120000ms deadline. Preserve
runNow's save → start → observe order and metadata-warning precedence at
890–915 exactly. These are temporal dependencies, not a new shared-state contract.
Card refs/tab state at 1250–1255 move together; hidden panels stay mounted/inert.
Report/trash coordination remains in Storage (1347–1404).

Avoid card → panel → card and panel → view → panel: share CleanupPolicy directly
through policy-model, pass callbacks and values to the renderer, and never
import the panel's type via the original/card. The view's argument object is
functional coupling with all fields actually used, not an entire page controller.
Recheck resolved static import/export SCCs including type-only edges for all
S17 leaves; lane evidence is a starting point, not a post-move proof.

## Tests

Importing test files, exact `rg -l 'from .*pages/Storage["\x27]' gui/tests tests`
result (both remain unchanged, importing the original default):
- `gui/tests/storage-loading-race.test.tsx:7` — aborted request/loading test at
  80 and cached-report failed-revalidation test at 155.
- `gui/tests/storage-policy-metadata-warning.test.tsx:7` — outcome warning at
  62. Must still exercise the page, not a replacement mock leaf.

The only source-text reader found by literal-path and extensionless searches is
`gui/tests/page-loading-contract.test.tsx`: path list entry at 43, actual
`Bun.file(new URL(path, import.meta.url)).text()` at 22, invoked at
51, 60, 67, 80, 95, and 111. Disposition: **unchanged** for Storage; the report
resource and its cold/stale/error/status rendering remain at
`gui/src/pages/Storage.tsx:1374–1453`. Do not retarget this entry to the policy
view (it does not own a data surface). **Add-leaf-to-scan-list**:
`../src/pages/storage-quarantine-panel.tsx` in MIGRATED, name
`StorageQuarantine`, to retain coverage of the resource moved from 397–402 and
the skeleton/status/error rendering moved from 473–485. Do not add the policy
panel to MIGRATED: its existing custom loading lifetime is not this contract.

Implementation-only red-once proof: temporarily remove `.showSkeleton` access
from the quarantine leaf; the added entry must fail the existing cold-skeleton
guard. Restore it and record green. Similarly remove the original page's
`useDataSurface` identifier to demonstrate the unchanged page guard still scans
the original file. Never weaken the six assertions or concatenate unrelated
sources just to satisfy them. There is no source reader to retarget-to-leaf.

In this layer the #a quarantine scan-list addition is already present and stays
unchanged. Retarget-to-leaf: none. The policy view does not replace the original
page source in any existing test.

Drive `gui/tests/storage-policy-metadata-warning.test.tsx:62` red once by
temporarily suppressing the metadataPersistenceError branch at original 892–894
in the moved controller, restore, then record green. Extend the existing file's
fake-fetch cases for disabled policy remaining disabled, 409 already-running,
invalid draft preventing PUT/start, run polling cancellation on unmount, stale
GET not overwriting edits, and matched-job completion. These are proposed focused
coverage additions, not claims that current tests cover every policy branch.
The JSX-tail extraction must retain Enter/composition guards, blur-inside-wrapper
behavior, radio draft values, disabled controls and status/error live-region roles.
Retain #a page-driven manual/quarantine checks. No new test file is required.

## Verification

Future executor only. All command results remain pending in this docs task.

```sh
bun run typecheck
bun test gui/tests/storage-loading-race.test.tsx gui/tests/storage-policy-metadata-warning.test.tsx gui/tests/page-loading-contract.test.tsx
bun run privacy:scan
wc -l gui/src/pages/Storage.tsx gui/src/pages/storage-policy-model.ts gui/src/pages/storage-policy-panel.tsx gui/src/pages/storage-policy-view.tsx gui/src/pages/storage-cleanup-card.tsx gui/src/pages/storage-archived-panel.tsx gui/src/pages/storage-quarantine-panel.tsx gui/src/pages/storage-cleanup-contracts.ts gui/src/pages/storage-cleanup-error.ts
rg -l 'from .*pages/Storage["\x27]' src gui/src gui/tests scripts tests
git diff --check
git diff --numstat codex/split-pages-Storage-a...HEAD
(cd gui && bun run build && bun run lint)
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-pages-Storage-b && git checkout -q FETCH_HEAD && bun install --frozen-lockfile && bun run test && cd gui && bun test tests && bun run lint && bun run build'
```

Domains: GUI storage policy/loading. No core protected root is touched; 002's
conditional core-lab test is not applicable. No local full suite. Parent verifies
remote runner ownership and exact HEAD before the full suite and retains full
logs/exit code; an output tail alone is insufficient. Require fresh exact-head
CI, unchanged three public importer files, and no S17 SCC including type-only
imports. Browser smoke/unchanged screenshot covers policy drafts, save feedback,
tab keyboard navigation and run status using safe fixtures, not real cleanup.
UI-copy changes are forbidden; any necessary new copy escalates out of pure-move.

## Accept criteria

1. Four new #b leaves ≤400 each; four #a leaves unchanged ≤400; Storage ≤400
   (140 expected), workspace residual ≤400 (358 expected). No final >400 residual.
2. Origin inventory owners are unique and match both part documents; only the
   default page export remains public and its three consumers do not change.
3. JSX tail and handlers preserve AST/ordering apart from wrapper/import glue;
   the view has exactly the listed 20 captures and introduces no hooks/state.
4. No circular import/export including type-only edges, no leaf → page import,
   no new module state/cache, and no changed component remount boundaries.
5. Source oracle remains at the original page plus #a quarantine scan entry;
   warning and loading guards have fresh red/restored-green evidence.
6. Typecheck, focused tests, build/lint, privacy, remote full suite, and exact-head
   CI are green at this layer tip; original route/loading behavior unchanged.
7. Parent explicitly resolves S17-SIZE-01 and accepts the pure JSX render
   extraction before implementation. Otherwise this is a blocked plan, not
   a claim that the three-layer map can satisfy all its own constraints.

## PR

Title: `refactor(gui-storage): isolate policy rendering and cleanup composition (split S17 L3/3)`
Base: `codex/split-pages-Storage-a`. Branch: `codex/split-pages-Storage-b`.

| Layer | PR | Branch | Base | Review focus |
|---|---|---|---|---|
| S17 L1/3 | #<S17-L1> | codex/split-components-storage-workspace-StorageWorkspace | dev | Diagnostic panel and workspace DTOs |
| S17 L2/3 | #<S17-L2> | codex/split-pages-Storage-a | codex/split-components-storage-workspace-StorageWorkspace | Manual cleanup and quarantine leaves |
| S17 L3/3 | #<S17-L3> | codex/split-pages-Storage-b | codex/split-pages-Storage-a | Policy ownership and cleanup composition |

Review only the diff against the named base. Merge bottom-up only with separate
authorization; no merge or auto-merge is authorized by this plan. A lower-layer
change requires a verified cascade and renewed exact-head gates for upper layers.
Fill Summary, Verification, and Checklist from the repository PR template; because
this is GUI scope, attach unchanged-layout screenshot evidence in the eventual PR.
Closes: none.
