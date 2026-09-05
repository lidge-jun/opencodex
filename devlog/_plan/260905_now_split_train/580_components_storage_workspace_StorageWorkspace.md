# 580 — S17 L1/3: storage workspace diagnostic boundary

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

Archetype: **pure-move**. Class C3 boundary plan, docs-only delegated mode.
Non-goals: no new API client, data deletion behavior, label change, hook lifetime
change, export removal, dependency installation, or runtime fix.
Goal: keep workspace dispatch/reconciliation in its current owner while moving
diagnostic rendering and DTO definitions into two feature-local leaves.
Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below.
Stop: all accept criteria and parent-approved diff budget satisfied; an open
exact-head-green PR is the eventual train outcome, never a merge.
Escalation: stop implementation for stale source, changed public signatures,
unexpected oracle/cycle, or a >500-line diff. L1 moves 309 source lines; ordinary
additions+deletions exceed 500, so the parent must explicitly settle move-aware
accounting or approve/reslice it. Do not silently call a 600+ line diff ≤500.

Source basis: `origin/dev = 1362b1a3841b4de20177e5d65865a513dd7936c4`;
docs HEAD `4cc219549eafbf9cd2efd651482fbfefd88944d5`. All source ranges below
are inclusive origin/dev ranges, not post-move positions. Read with `git show
origin/dev:<path>`; `git diff origin/dev -- gui/src/pages/Storage.tsx
gui/src/components/storage-workspace/StorageWorkspace.tsx` was empty.
Declaration endpoints were checked with `sg run --kind <function_declaration|
interface_declaration|type_alias_declaration|lexical_declaration> --json=compact
<file>`, and top-level starts with anchored rg. No code or test execution occurred.

Evidence: `015_lane_gui.md:262–271`. Current map:
`Storage.tsx + three GUI tests → StorageWorkspace → React/i18n/format-bytes`.
Intended map: those callers retain the original path; original → DTO leaf and
diagnostic leaf; diagnostic → DTO leaf and existing i18n/formatting modules.
Blast radius: feature-local GUI, no backend/public protocol changes.
Decision: reject deleting/configuring away diagnostic UI or importing backend
scanner DTOs (the scanner contract at `src/storage/scanner.ts:33–59` is not the
GUI log-guard response contract). Choose colocation, not a generic utils module.
Sibling convention: `gui/src/pages/startup-sections.tsx:1–13` and
`gui/src/pages/claude-code-types.ts:1–7`; kebab-case named feature leaves.

## Symbol inventory

All ranges below refer to
`gui/src/components/storage-workspace/StorageWorkspace.tsx` at origin/dev.
E / R = distinct external importer files / local rg identifier-reference count,
excluding the declaration (and the file-header mention of StorageWorkspace).
Path search `rg -l 'from .*storage-workspace/StorageWorkspace["\x27]'
src gui/src gui/tests scripts tests` returned four files: Storage.tsx and the
three GUI test files listed below. Only StorageReport and the default are used
externally; similarly named server scanner symbols are not consumers.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---|---|
| useMemo, useState | import bindings | 8–8 | no | dependency bindings | original; panel also imports useState |
| IconChevron, IconHardDrive | import bindings | 9–9 | no | dependency bindings | original |
| useT, TFn, TKey, Locale | import bindings | 10–10 | no | dependency bindings | original; leaf types as listed below |
| logGuardLabel | import | 11–11 | no | dependency binding | original + diagnostic |
| logGuardOperationLabel | import | 12–12 | no | dependency binding | original + diagnostic |
| logGuardProtectionModeLabel, logGuardProtectionStateLabel, logGuardSchemaStateLabel | imports | 13–17 | no | dependency bindings | diagnostic |
| formatBytes | import | 18–18 | no | dependency binding | original + diagnostic |
| StorageLargestEntry | interface | 20–23 | yes | 0 / 2 | storage-workspace-types.ts |
| StorageBucket | interface | 25–34 | yes | 0 / 3 | storage-workspace-types.ts |
| LogGuardReason | type | 36–36 | no | 0 / 1 | storage-workspace-types.ts |
| LogGuardCapability | type | 37–37 | no | 0 / 3 | storage-workspace-types.ts |
| LogGuardSchema | type | 38–42 | no | 0 / 1 | storage-workspace-types.ts |
| CodexLogGuardProtection | interface | 44–48 | yes | 0 / 1 | storage-workspace-types.ts |
| CodexLogGuardReport | interface | 50–78 | yes | 0 / 5 | storage-workspace-types.ts |
| StorageReport | interface | 80–88 | yes | 4 / 1 | storage-workspace-types.ts |
| CodexLogGuardAction | type | 90–94 | yes | 0 / 3 | storage-workspace-types.ts |
| BUCKET_TKEYS | const record | 97–105 | no | 0 / 1 | original |
| bucketLabel | function | 107–110 | yes | 0 / 4 | original |
| formatDate | function | 112–114 | no | 0 / 2 | original |
| rowsDisplay | function | 116–120 | no | 0 / 1 | original |
| mutationErrorLabel | function | 122–141 | no | 0 / 1 | original |
| CodexLogGuardPanel | component | 143–357 | no | 0 / 1 | codex-log-guard-panel.tsx |
| CodexLogGuardUnavailablePanel | component | 359–366 | no | 0 / 1 | codex-log-guard-panel.tsx |
| StorageWorkspaceProps | interface | 368–374 | yes | 0 / 1 | storage-workspace-types.ts |
| GenerationScopedLogGuardReport | type | 376–379 | no | 0 / 1 | original |
| GenerationScopedError | type | 381–384 | no | 0 / 1 | original |
| GenerationScopedCompaction | type | 392–395 | no | 0 / 1 | original |
| StorageWorkspace | component | 397–668 | default | 4 / 0 | original |

## Leaf partition

1. **NEW `gui/src/components/storage-workspace/storage-workspace-types.ts`**:
   definitions 20–94 and 368–374 (all DTOs and props in the inventory);
   expected **85 lines** = 75 + 7 body lines + 3 import/separator lines.
   Own import: `import type { Locale } from "../../i18n/shared";`.
   Preserve private LogGuardReason/Capability/Schema as private dependencies of
   the exported report; preserve the seven existing exported type names.
2. **NEW `gui/src/components/storage-workspace/codex-log-guard-panel.tsx`**:
   CodexLogGuardPanel and CodexLogGuardUnavailablePanel, 143–366;
   expected **232 lines** = 224 body + 8 import/separator lines.
   Own imports: useState from react; Locale/TFn types from ../../i18n/shared;
   logGuardLabel from ../../i18n/log-guard-labels; logGuardOperationLabel from
   ../../i18n/log-guard-operation-labels; the three state-label functions from
   ../../i18n/log-guard-state-labels; formatBytes from ../../format-bytes;
   CodexLogGuardReport/CodexLogGuardAction types from ./storage-workspace-types.
   Export both components by name only for the original's internal imports.

Residual **`gui/src/components/storage-workspace/StorageWorkspace.tsx`: 358
expected lines**, using single-line named import/re-export declarations:
668 − 76 (20–95) − 225 (143–367) − 8 (368–375) − 5 (old state-label
import) + 4 (two local imports, re-export, separator) = 358.
Formatting may vary; every file must be ≤400 at verification. No #b required.
Total planned physical lines: 358 + 85 + 232 = 675, seven lines of net glue.
Large pre-existing functions remain: this pure-move file-size layer does not
claim to resolve every >50-line function in the debt ledger.

## Re-export block

At the original path, preserve every current named type export exactly:

```ts
export type { StorageLargestEntry, StorageBucket, CodexLogGuardProtection, CodexLogGuardReport, StorageReport, CodexLogGuardAction, StorageWorkspaceProps } from "./storage-workspace-types";
import type { StorageLargestEntry, StorageBucket, CodexLogGuardReport, CodexLogGuardAction, StorageWorkspaceProps } from "./storage-workspace-types";
import { CodexLogGuardPanel, CodexLogGuardUnavailablePanel } from "./codex-log-guard-panel";
```

Keep existing `export function bucketLabel` (107) and `export default function
StorageWorkspace` (397) in place: no value re-export is necessary because neither
moves. Re-exporting the DTOs does not bind them locally; the explicit type
import above is required. Do not expose the formerly private diagnostic
components or private report aliases through the original public path.
Keep the existing react-refresh suppression with bucketLabel; no new index barrel.

## Module-level state and cycles

`BUCKET_TKEYS:97–105` is the sole top-level data object, read-only by usage;
its only owner remains the original. No top-level let, Map, Set, WeakMap or
lock exists. `new Map` at 436 is component-local useMemo state, not a singleton.
Generation-tagged state at 405–409 and the action dispatcher at 440–531 stay
together; do not move fetching into the renderer. Confirmation state at 169
moves with CodexLogGuardPanel, preserving that component's identity/lifetime.
Do not nest a new component definition inside the residual component.

Avoid original → panel → original by importing report/action types directly from
the DTO leaf. DTOs must not import the panel or original, including type-only
imports. Existing i18n and format modules are downstream dependencies, not
consumers of the workspace. Coupling: typed props/events (functional); generation
and compaction receipt order (temporal) remain within the original owner.
The lane's static-relative SCC scan found no cycle; implementation must freshly
walk static import/export edges including type-only edges for these three files.

## Tests

`rg -l 'from .*storage-workspace/StorageWorkspace["\x27]' gui/tests tests` list:
- `gui/tests/storage-log-guard.test.tsx:4` — unchanged.
- `gui/tests/storage-log-guard-protection.test.tsx:4` — unchanged.
- `gui/tests/storage-log-guard-compact.test.tsx:7` — unchanged.

No source-text reader for StorageWorkspace found with either literal
`StorageWorkspace.tsx` or extensionless name searches in tests/gui/tests.
No retarget-to-leaf or add-leaf-to-scan-list is required for this layer.
Existing behavioral guards to drive red once during implementation:
disable the new panel's compact confirmation gate and require
`storage-log-guard-compact.test.tsx:110` to fail, then restore; suppress the
metrics-skipped notice and require `storage-log-guard.test.tsx:141` to fail.
These prove the unchanged public imports execute the moved panel. Preserve
unsupported-schema controls, compaction receipts after failed refresh, and
generation reconciliation; do not mutate actual user storage for verification.

## Verification

Future executor only; none of these commands ran in this docs task.
Instantiate 002's Per-layer gate at this layer's exact tip:

```sh
bun run typecheck
bun test gui/tests/storage-log-guard.test.tsx gui/tests/storage-log-guard-protection.test.tsx gui/tests/storage-log-guard-compact.test.tsx
bun run privacy:scan
wc -l gui/src/components/storage-workspace/StorageWorkspace.tsx gui/src/components/storage-workspace/storage-workspace-types.ts gui/src/components/storage-workspace/codex-log-guard-panel.tsx
rg -l 'from .*storage-workspace/StorageWorkspace["\x27]' src gui/src gui/tests scripts tests
git diff --check
git diff --numstat dev...HEAD
(cd gui && bun run build && bun run lint)
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-components-storage-workspace-StorageWorkspace && git checkout -q FETCH_HEAD && bun install --frozen-lockfile && bun run test && cd gui && bun test tests && bun run lint && bun run build'
```

Domain: GUI storage/log-guard. Original-path importer list stays four files,
with the same imported names; TypeScript resolves re-exported types.
No src/server, src/router, or src/lib edits, so the conditional core-lab test
does not apply and PROTECTED roots remain untouched. Full suite runs only on
lidge, not locally; capture full output and remote HEAD equality, not just a
tail pipeline's status. Resolve remote checkout ownership through the parent
before its shared runner is used. Fresh exact-head CI and static cycle check
are also required. No copy/locale changes, so no new i18n strings are permitted.

## Accept criteria

1. Exactly two new leaves; physical line counts ≤400 and original ≤400.
2. Seven named type exports, bucketLabel, and default component remain available
   from the original path; all four existing consumer files remain unchanged.
3. AST-normalized moved bodies are identical except export/import glue; no new
   request, validation, mutation, label, or state lifetime.
4. No leaf imports the original; static import/export SCC containing these
   files is empty, including type-only edges.
5. Focused guards show red-once/restored-green evidence; typecheck, build, lint,
   privacy, remote suite, and exact-head CI are green.
6. Parent resolves the >500 ordinary-diff accounting before implementation/PR
   readiness. Never claim the gate was satisfied using deleted-lines-only math.

## PR

Title: `refactor(gui-storage): isolate workspace diagnostics and contracts (split S17 L1/3)`
Base: `dev`. Branch: `codex/split-components-storage-workspace-StorageWorkspace`.

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
