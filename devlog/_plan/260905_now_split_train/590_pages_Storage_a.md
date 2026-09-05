# 590 — S17 L2/3: Storage part a

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

Archetype: **pure-move**. C3 module-boundary plan, docs-only delegated task.
Non-goals: no new cleanup/restore behavior, changed confirmations, public
signature changes, cache replacement, polling changes, or backend DTO reuse.
Goal: extract the low-fan-in manual/quarantine panels and their private data
dependencies while leaving automatic policy and page composition in place.
Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below.
Stop: mechanical acceptance plus parent resolution of the size gate; eventual
open exact-head-green PR, never merge. Escalate any stale source, ownership
collision, weakened test, state lifetime change, or required out-of-scope file.
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

Structural evidence: `015_lane_gui.md:131–143,604`.
Current: App/tests → Storage → cleanup panels + workspace + resource/cache.
Chosen: original → two panel leaves; both → cleanup-error; original/quarantine
→ cleanup-contracts. Later #b cleanup-card consumes the same leaves.
Reject a shared storage service or generic helpers module: no new behavior is
needed, and backend types are not the existing GUI DTOs. Reuse kebab-case page
siblings (`startup-sections.tsx:1`, `claude-code-types.ts:1`); no index barrel.
Blast radius is the storage feature plus one existing source-oracle scan list.

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

All new leaves are siblings under `gui/src/pages/`, matching existing page-leaf
conventions. Preserve declarations, comments, endpoint strings, and hook order.

| NEW file | symbols / origin body ranges | expected lines | own imports |
|---|---|---:|---|
| gui/src/pages/storage-archived-panel.tsx | CleanupPreview, CleanupResult (16–32); PRESETS (85); ArchivedCleanupPanel (102–344) | 268 | useCallback/useEffect/useRef/useState from react; Locale/TFn types from ../i18n/shared; formatBytes from ../format-bytes; localizedCatch from ./storage-cleanup-error |
| gui/src/pages/storage-quarantine-panel.tsx | TrashList, RestoreResult (43–54); QuarantineTrashPanel (346–569) | 246 | useCallback/useEffect/useRef/useState from react; Locale/TFn types from ../i18n/shared; formatBytes from ../format-bytes; TrashEntry type from ./storage-cleanup-contracts; localizedCatch from ./storage-cleanup-error; useDataSurface from ../data-surface; DataSurfaceSkeleton/DataSurfaceStatus from ../components/data-surface |
| gui/src/pages/storage-cleanup-contracts.ts | TrashEntry (34–41), named type export for internal consumers | 8 | none |
| gui/src/pages/storage-cleanup-error.ts | localizedCatch (87–100), named export for both panels | 14 | none |

Line budgeting uses original body lines plus imports and separators, not compacted
code: archived 17 + 1 + 243 + 7 = 268; quarantine 12 + 224 + 10 = 246.
Residual `gui/src/pages/Storage.tsx` **947 expected lines**:
1469 − 40 (16–55) − 486 (85–570) + 4 (three imports and separator) = 947.
All original imports still used by policy/page/card stay in this intermediate
file. Original 56–84 (GB/CleanupPolicy), 571–1344 (policy helpers/panel/card)
and 1345–1469 (page) remain. **#b doc 600 takes the rest**, ending at 140
expected residual lines. L2 source total: 947 + 268 + 246 + 8 + 14 = 1483.
The >400 residual is temporary and explicit; none of the four new files exceeds
400. The 526 original lines removed also independently exceed the 500 cap:
S17-SIZE-01 must be resolved, not hidden by ignoring types/comments/glue.

## Re-export block

Storage.tsx currently exports **only its default component** at 1345.
It remains declared there. Exact required re-export block: **empty**; adding
exports for formerly private panels/types would broaden the public API.

Required local imports in Storage.tsx (re-exports would not bind these):

```ts
import { ArchivedCleanupPanel } from "./storage-archived-panel";
import { QuarantineTrashPanel } from "./storage-quarantine-panel";
import type { TrashEntry } from "./storage-cleanup-contracts";
```

Leaf exports are `export function ArchivedCleanupPanel`,
`export function QuarantineTrashPanel`, `export interface TrashEntry`,
and `export const localizedCatch`. They are internal direct-import seams;
do not re-export them from the page. Existing workspace default/StorageReport
imports remain at the public L1 path.

## Module-level state and cycles

There is no module-level mutable state, let, Map, Set, WeakMap or lock in
Storage.tsx. `GB:56` stays in the page until #b; `PRESETS:85` moves once to
storage-archived-panel.tsx. The arrow constant `localizedCatch:87` is stateless
code, owned only by storage-cleanup-error.ts.
Archived state/refs at 113–122 and effects at 130–146 move as one component.
Quarantine state/refs at 361–367, focus effect at 375–387, and resource at
389–404 move as one component. Keep callbacks/dependency arrays and active
resource keys intact. The page still owns report/trash coordination at
1347–1404; no singleton is created from these component-local refs.

Potential cycles: panel → Storage for TrashEntry or localizedCatch would close
original → panel → original. Both dependencies therefore live in downward-only
leaves; neither leaf imports Storage or a component. Do not type-import through
the original. Existing session-list-cache stays its own owner, untouched.
Coupling is functional props/events; focus restore and busyRef effect ordering
are temporal and preserved, not rewritten. Card stays mounted/inert exactly as
before (1300–1335), preserving hidden panel state.

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

#b must keep the added quarantine scan entry. Existing tests do not directly
import private manual/quarantine components; do not claim source pinning alone
proves digest, focus restoration, or restore behavior. At implementation add
focused page-driven cases in existing `gui/tests/storage-loading-race.test.tsx`
for stale preview → re-preview, cancel/focus restoration, restore success →
onDone refresh, and hidden quarantine state preservation. Use fake fetch/DOM
fixtures only, never real cleanup endpoints. These are proposed coverage, not
already-existing tests or a new test-file requirement.

## Verification

Future executor only; no test/build/scanner was run in this docs task.

```sh
bun run typecheck
bun test gui/tests/storage-loading-race.test.tsx gui/tests/storage-policy-metadata-warning.test.tsx gui/tests/page-loading-contract.test.tsx
bun run privacy:scan
wc -l gui/src/pages/Storage.tsx gui/src/pages/storage-archived-panel.tsx gui/src/pages/storage-quarantine-panel.tsx gui/src/pages/storage-cleanup-contracts.ts gui/src/pages/storage-cleanup-error.ts
rg -l 'from .*pages/Storage["\x27]' src gui/src gui/tests scripts tests
git diff --check
git diff --numstat codex/split-components-storage-workspace-StorageWorkspace...HEAD
(cd gui && bun run build && bun run lint)
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-pages-Storage-a && git checkout -q FETCH_HEAD && bun install --frozen-lockfile && bun run test && cd gui && bun test tests && bun run lint && bun run build'
```

002's conditional core-lab test: not applicable (GUI only; protected roots
untouched). Domains: GUI storage/loading contracts; full repository/GUI suite
only on lidge. Parent checks remote worktree ownership before using that runner,
records remote HEAD equal to layer tip, retains full logs/exit status, and
requires exact-head CI. Original-path importers remain the same three files.
Walk resolved static import and export edges, including type-only edges, for the
page and four new leaves; no SCC may include them. Fresh browser smoke covers
manual/quarantine tabs, modal cancel/focus and rescan without real deletion.
No UI copy/locale changes; preserve all current keys.

## Accept criteria

1. Four new leaves ≤400 lines each; original expected 947 with doc 600 explicitly
   responsible for the remaining >400 residual.
2. Every origin top-level definition has exactly one owner; private DTOs and
   localizedCatch are moved, not duplicated; default export stays at original.
3. Three existing public importer files unchanged; no circular static/type-only
   dependency and no leaf → Storage import.
4. Six loading source guards retain their assertions; quarantine added to scan
   list, red once then green; page source entry unchanged.
5. Focused behavioral/negative cases, typecheck, GUI build/lint, privacy,
   remote full suite and exact-head CI all recorded at this layer tip.
6. Parent resolves S17-SIZE-01 before this can be marked implementation-ready.
   No external mutation, extra layer, or 002 edit is authorized by this draft.

## PR

Title: `refactor(gui-storage): isolate manual cleanup and quarantine panels (split S17 L2/3)`
Base: `codex/split-components-storage-workspace-StorageWorkspace`.
Branch: `codex/split-pages-Storage-a`.

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
