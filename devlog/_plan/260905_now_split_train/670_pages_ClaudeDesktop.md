# S20 L1/5 — ClaudeDesktop

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: pure-move. C3 architecture, docs-only delegated preparation; parent owns all orchestration/loop/goal state.
- Goal: split `gui/src/pages/ClaudeDesktop.tsx` into 3 cohesive sibling leaves, each ≤400 lines, with a projected 374-line residual and every existing export still importable from the old path.
- Non-goals: no behavior, copy, CSS, locale, request payload, exported name/signature, effect lifetime, auth/consent, or dependency changes. No source edits, test runs, Git mutation, PR creation or orchestration in this planning task. Existing long functions are not silently rewritten to satisfy a second metric.
- Verifier: `002_layer_map.md` → **Per-layer gate**, instantiated in Verification below (the 000 reference to “003” is stale; 002 is authoritative).
- Stop: plan complete when inventory/partition/export/state/oracle/gate records are internally consistent. Implementation stops on any failed gate or non-pure-move delta; completion later requires exact-tip checks and exact-head green CI, never a cached green check.
- Escalation: BLOCKED FOR IMPLEMENTATION on changeset size: even the theoretical minimum 289-line extraction to reach 400 costs at least 578 added+deleted source lines; this concrete plan moves 370 lines before glue. 002's ≤500 changed-source-lines policy cannot coexist with its single L1 allocation. Parent must explicitly approve a pure-move size exception or revise the topology with a ClaudeDesktop #b in another stack (S20 is already at its five-layer cap). This document does not approve that exception or add a sixth layer.

Source basis: `origin/dev = 1362b1a3841b4de20177e5d65865a513dd7936c4`; docs HEAD `4cc219549eafbf9cd2efd651482fbfefd88944d5`. Read with `git show origin/dev:gui/src/pages/ClaudeDesktop.tsx`; the working-tree copy was byte-compared and identical. All source ranges below are inclusive at this origin/dev revision. Read 000_plan.md, 001_stale_check.md, S20 rows / Per-layer gate in 002_layer_map.md, and the matching section in `../260905_modular_debt_ledger/015_lane_gui.md`.

Structural decision (ARCH-DECISION-01 / ARCH-MAP-01): Context: 689-line page mixes profile/cache DTOs with two presentation blocks. Rejected do-nothing/config/delete: none reduces executable file size without losing features. Rejected moving the entire 539-line default component: it only relocates the violation. Reuse claude-desktop-lane.ts and collapse-store.ts unchanged; their helpers already own filtering and persistence. Chosen move: sibling data + stateless lane/status leaves, while the original remains the resource/save owner. Blast radius is the Claude Desktop feature; Claude.tsx and its two direct test importers retain the default boundary.

## Symbol inventory

Inventory uses installed ast-grep: `sg run --kind <function_declaration|interface_declaration|type_alias_declaration|lexical_declaration|variable_declaration|import_statement> --json=compact gui/src/pages/ClaudeDesktop.tsx`, filtered to top-level declarations and checked against `git show origin/dev:gui/src/pages/ClaudeDesktop.tsx | nl -ba`. Imports are included for completeness but are not newly owned declarations.

Consumer count = distinct external source/test files importing that binding from the original module, not identifier occurrences or documentation mentions. Command candidate set: `rg -l 'ClaudeDesktop' src gui/src scripts tests gui/tests`; inspect matched import clauses for each symbol and deduplicate files. Private declarations/import bindings have zero external consumers by definition; local uses are preserved through the explicit imports below. Module fan-in is **3 files** (including type/test imports); added leaf imports do not replace existing consumer imports.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";` | import declaration | 1–1 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { LANE_PAGE, defaultCollapsedFamilies, laneView, rowStartsOpen } from "./claude-desktop-lane";` | import declaration | 2–2 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { makeCollapseStore, toggleInSet } from "./collapse-store";` | import declaration | 3–3 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { IconChevron } from "../icons";` | import declaration | 4–4 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { EmptyState, Notice } from "../ui";` | import declaration | 5–5 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { LOCALES, useI18n, type TFn, type TKey } from "../i18n/shared";` | import declaration | 6–6 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { readJsonIfOk, readJsonOrThrow } from "../fetch-json";` | import declaration | 7–7 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { readSessionListCacheEntry, writeSessionListCacheEntry } from "../session-list-cache";` | import declaration | 8–8 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { useDataSurface } from "../data-surface";` | import declaration | 9–9 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { DataSurfaceSkeleton } from "../components/data-surface";` | import declaration | 10–10 | no | 0 external | allocation in Leaf partition / residual imports |
| `FAMILIES` | lexical declaration | 12–12 | no | 0 | `gui/src/pages/claude-desktop-data.ts` |
| `Family` | type alias declaration | 13–13 | no | 0 | `gui/src/pages/claude-desktop-data.ts` |
| `FAMILY_COLLAPSE` | lexical declaration | 19–19 | no | 0 | `gui/src/pages/ClaudeDesktop.tsx` |
| `Assignment` | interface declaration | 21–24 | no | 0 | `gui/src/pages/claude-desktop-data.ts` |
| `DesktopProfile` | interface declaration | 26–33 | no | 0 | `gui/src/pages/claude-desktop-data.ts` |
| `DesktopModel` | interface declaration | 35–43 | no | 0 | `gui/src/pages/claude-desktop-data.ts` |
| `DesktopStatus` | interface declaration | 45–57 | no | 0 | `gui/src/pages/claude-desktop-data.ts` |
| `DesktopResponse` | interface declaration | 59–64 | no | 0 | `gui/src/pages/claude-desktop-data.ts` |
| `PendingAction` | type alias declaration | 66–66 | no | 0 | `gui/src/pages/claude-desktop-data.ts` |
| `FAMILY_KEYS` | lexical declaration | 68–73 | no | 0 | `gui/src/pages/claude-desktop-data.ts` |
| `cloneProfile` | function declaration | 75–88 | no | 0 | `gui/src/pages/claude-desktop-data.ts` |
| `normalizeProfile` | function declaration | 90–109 | no | 0 | `gui/src/pages/claude-desktop-data.ts` |
| `errorMessage` | function declaration | 111–114 | no | 0 | `gui/src/pages/claude-desktop-data.ts` |
| `formatContextWindow` | function declaration | 116–124 | no | 0 | `gui/src/pages/claude-desktop-data.ts` |
| `CachedDesktop` | type alias declaration | 126–126 | no | 0 | `gui/src/pages/claude-desktop-data.ts` |
| `readDesktopCache` | function declaration | 128–130 | no | 0 | `gui/src/pages/claude-desktop-data.ts` |
| `readDesktopCachedAt` | function declaration | 132–134 | no | 0 | `gui/src/pages/claude-desktop-data.ts` |
| `seedDesktop` | function declaration | 136–149 | no | 0 | `gui/src/pages/claude-desktop-data.ts` |
| `ClaudeDesktop` | function declaration | 151–689 | default | 3 | `gui/src/pages/ClaudeDesktop.tsx` (residual; JSX ranges below move) |

Current direct importer files (same import paths after the move):

- `gui/tests/claude-desktop-vertical.test.tsx`
- `gui/tests/claude-desktop-row-disclosure.test.tsx`
- `gui/src/pages/Claude.tsx`

## Leaf partition

Reuse decision: no parallel infrastructure, utility barrel, controller or cache is introduced. The source-owned definitions above move rather than being copied; existing helpers named in Loop spec remain canonical. Sibling convention is feature-qualified lowercase helper filenames and PascalCase component files (e.g. `gui/src/pages/claude-desktop-lane.ts`, `gui/src/pages/dashboard-core-poll.ts`, `gui/src/components/provider-workspace/ProviderRail.tsx`). No `index.ts`, `utils.ts` or `common.ts` is created.

### gui/src/pages/claude-desktop-data.ts

- Symbols: FAMILIES Family Assignment DesktopProfile DesktopModel DesktopStatus DesktopResponse PendingAction FAMILY_KEYS cloneProfile normalizeProfile errorMessage formatContextWindow CachedDesktop readDesktopCache readDesktopCachedAt seedDesktop.
- Expected physical lines: 145 (including imports and new prop signatures; maximum 400).
- Move origin/dev lines 12–13 and 21–149 (131 physical lines, including separators). Keep the collapse adapter at the original path. Export only the types/values actually consumed by the page or the two presentation leaves; readDesktopCache stays private. These are the existing DTOs, not aliases to server contracts: normalizing DesktopResponse must remain identical.
- Own imports:

```ts
import type { TFn, TKey } from "../i18n/shared";
import { readSessionListCacheEntry } from "../session-list-cache";
```

### gui/src/pages/claude-desktop-lanes.tsx

- Symbols: ClaudeDesktopLanes (new extraction of ClaudeDesktop lines 498–686).
- Expected physical lines: 250 (including imports and new prop signatures; maximum 400).
- Move the complete group-stack JSX and family/row map (189 lines). No hooks or state migrate. Inline typed props carry t, modelsByFamily, profile (assignments/defaults), effectiveDefaults, destinations, laneSearch, laneLimit, collapsedFamilies, openRows; use narrow callbacks onDrop(event, family), onToggleFamily(family), onSearch(family, query), onMore(family), onToggleRow(route, next), onDefault(family, route), onDestination(route, family), onMove(route, family). The page retains the exact functional updater bodies from lines 558–564, 593, 641, 653 and 675. Key by family/route exactly as before; filtering stays downstream of modelsByFamily/effectiveDefaults. No extra DOM wrapper.
- Own imports:

```ts
import type { DragEvent } from "react";
import type { TFn } from "../i18n/shared";
import { IconChevron } from "../icons";
import { LANE_PAGE, laneView, rowStartsOpen } from "./claude-desktop-lane";
import { FAMILIES, FAMILY_KEYS, formatContextWindow } from "./claude-desktop-data";
import type { Family, DesktopModel, DesktopProfile } from "./claude-desktop-data";
```

### gui/src/pages/claude-desktop-status.tsx

- Symbols: ClaudeDesktopStatus (new extraction of ClaudeDesktop lines 426–475).
- Expected physical lines: 70 (including imports and new prop signatures; maximum 400).
- Move the 50-line status-bar block with its leading comment. Props are status: DesktopStatus | null, statusFailed: boolean, localeTag: string | undefined, and t: TFn. Retain the pending strut, activeProfile precedence, aria-busy expression and health copy exactly. No polling, effects or new state.
- Own imports:

```ts
import type { TFn } from "../i18n/shared";
import type { DesktopStatus } from "./claude-desktop-data";
```

Residual `gui/src/pages/ClaudeDesktop.tsx`: **374 expected lines**. 689 − 131 (data) − 189 (lanes) − 50 (status) + 55 (replacement calls, callback bindings and import budget) = 374 residual lines. Leaf budgets 145 + 250 + 70 = 465; aggregate 839 = original 689 + 150 net extraction overhead. No #b is currently allocated. These are explicit physical-line budgets, not measured implementation output: reject a formatted result above the budget/400 rather than minifying it. The exact moved source blocks are disjoint; every original declaration has exactly one target in the inventory. Preserve associated comments, including i18n/lint exceptions.

## Re-export block

The only existing export is the default ClaudeDesktop declaration (151–689); keep it declared/exported in the residual. Exact new re-export block: empty (no existing exported symbol moves). Do not add named exports for formerly private helpers.

Explicit local bindings needed in the residual (a re-export binds nothing):

```ts
import { FAMILIES, FAMILY_KEYS, cloneProfile, normalizeProfile, errorMessage, readDesktopCachedAt, seedDesktop } from "./claude-desktop-data";
import type { Family, DesktopProfile, DesktopModel, DesktopStatus, DesktopResponse, PendingAction, CachedDesktop } from "./claude-desktop-data";
import { ClaudeDesktopLanes } from "./claude-desktop-lanes";
import { ClaudeDesktopStatus } from "./claude-desktop-status";
```

Retain original external imports still used by residual declarations; remove only moved-only bindings after reference checks. The listed leaf imports use verified existing modules or the exact new owners defined in this plan. Internal leaves import each other directly, never through the preserved original-path compatibility boundary. No wildcard re-export.

## Module-level state and cycles

FAMILY_COLLAPSE at 19 remains the one module-level persistence handle in ClaudeDesktop.tsx. makeCollapseStore is external-storage-backed (collapse-store.ts:35), not a new cache. FAMILIES (12) and FAMILY_KEYS (68–73) have one read-only owner in claude-desktop-data.ts. All Sets at 180/207 and draft hooks remain component-local. Neither view nor data leaf imports ClaudeDesktop.tsx; views → data and existing claude-desktop-lane, page → views/data. No leaf acquires the resource or save/apply lifetime. New edges are functional props/imports; no shared mutable module state is introduced.

Cycle proof for the implementation gate: resolve static import/export edges, including type-only edges, from this original and its new leaves; fail if any leaf reaches the original (directly or transitively), or the changed induced graph has an SCC. Run the lane-015 read-only sg/import-resolution + Tarjan method; preserve the allow-edge and forbidden-back-edge evidence. No new graph tool/dependency installation is authorized. The plan records an acyclic intended edge map, not a claim that future source has been scanned.

## Tests

Direct importing tests — `rg -l` candidate list narrowed to actual imports of this module; **2 files**, all **unchanged**:

- `gui/tests/claude-desktop-vertical.test.tsx` — unchanged original-path import.
- `gui/tests/claude-desktop-row-disclosure.test.tsx` — unchanged original-path import.

Text-oracle disposition: `gui/tests/page-loading-contract.test.tsx` — unchanged source target `gui/src/pages/ClaudeDesktop.tsx`: path entry at 42; actual reader at 22 and calls at 51, 60, 67, 80, 95, 111. All positive resource/skeleton/error predicates stay in the residual. Do not retarget them to stateless leaves or concatenate files to mask a missing resource owner. The `.loading` string in the retained skeleton at source 402 still satisfies the existing lexical field guard; do not claim that this regex proves loading behavior. No other literal/extensionless source reader was found. No add-leaf-to-scan-list needed for these stateless leaves.

Guards to drive red once during implementation C verification: Drive page-loading-contract's cold-skeleton guard red once by replacing the residual DataSurfaceSkeleton use/import, then restore it; drive the mounted row-disclosure assertion red once by inverting rowOpen in claude-desktop-lanes.tsx, then restore. Preserve the tests' full-model default and collapse semantics. Record the named failing assertion and restored green result; do not commit mutations. Do not weaken assertions, replace source guards with export-existence checks, or retarget behavioral tests away from the compatibility boundary. No guard has been executed during this documentation task.

## Verification

Future executor commands only — not run by this delegated author. In a dedicated layer worktree at its tip, instantiate 002 Per-layer gate:

```sh
bun run typecheck
bun test gui/tests/claude-desktop-row-disclosure.test.tsx gui/tests/claude-desktop-vertical.test.tsx gui/tests/page-loading-contract.test.tsx gui/tests/claude-desktop-lane.test.ts
bun run privacy:scan
wc -l gui/src/pages/claude-desktop-data.ts gui/src/pages/claude-desktop-lanes.tsx gui/src/pages/claude-desktop-status.tsx gui/src/pages/ClaudeDesktop.tsx
rg -l 'from "[^"]*/ClaudeDesktop(\.tsx?)?"' src gui/src scripts tests gui/tests
# GUI TypeScript/bundler proof and scoped lint, required by gui/AGENTS.md:
(cd gui && bun run build && bun run lint)
# Whole repository suite only on the approved remote host:
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-pages-ClaudeDesktop && git checkout -q FETCH_HEAD && git rev-parse HEAD && bun install --frozen-lockfile && bun run test'
# Full GUI PR-ready suite also remote, never substitute it for the root suite:
ssh lidge 'cd ~/ocx-ci/opencodex/gui && bun install --frozen-lockfile && bun test tests'
```

Focused domains: `gui/tests`; only the listed files run locally. The core-Lab boundary gate is N/A: no `src/server`, `src/router`, or `src/lib` source is touched; never edit its protected roots. Unchanged UI copy means no locale churn; if copy unexpectedly changes, stop the pure-move layer rather than manufacturing new translations.

Compare the importer list with the 3-file baseline above (count files, not lines; compare existing callers, excluding newly added internal leaves). Compare exported name/kind/signature inventory and explicit local bindings, inspect `git diff --numstat dev...HEAD -- gui/src` against the 500 added+deleted source-line cap, and perform the changed-graph cycle check described above. The remote checkout SHA must equal this PR head; serialize the shared lidge checkout or arrange parent-owned isolation before running it. Do not accept a later remote GUI run on another layer's SHA. Require actual exit statuses and full-suite totals: the command deliberately avoids 002's unguarded `| tail -15`, which could hide failure. Record exact-head CI for the layer and do not merge.

Docs-only verification for this author: inspect only these five requested output documents for nine exact ordered headings, complete declaration coverage, ≤400 projected leaf/residual budgets, correct branch/base/stack map, and whitespace with `git diff --no-index --check /dev/null <doc>`. No runtime, build, privacy or test-pass result is claimed here.

## Accept criteria

1. Every top-level declaration in the origin/dev inventory has one canonical owner; moved blocks match original behavior and no unlisted source file is changed.
2. Existing default/named/type exports and signatures remain importable from `gui/src/pages/ClaudeDesktop.tsx`; all 3 existing importer files retain their paths. Re-exported symbols used locally have explicit imports.
3. Exactly 3 new leaves appear at the paths above, each ≤400 physical lines; residual ≤400 (budget 374); actual formatted counts and source diff size are recorded. Parent size-policy/topology resolution is mandatory before implementation; this plan alone is not approval.
4. State lifetime/ownership and side-effect timing match Module-level state and cycles; changed graph has no new value or type cycle and no upward leaf → original path.
5. Every listed behavioral/text oracle keeps its specified target/disposition; the named guard mutation produces the expected failure and restoration yields green focused tests.
6. Typecheck, focused checks, GUI build/lint, privacy scan, remote whole-suite and remote GUI PR-ready suite pass at the exact layer head, with exit codes and CI SHA evidence; no repository-wide local suite.
7. PR contains all repository template sections and the five-layer stack map; correct base/head, no merge, no release, no unrelated cleanup. If title/body says GUI, attach a real unchanged-UI screenshot as required by the repository gate; never fabricate an image link.

## PR

Title: `refactor(gui): isolate Claude Desktop profile data and lane views (split S20 L1/5)`

Head: `codex/split-pages-ClaudeDesktop`. Base: `dev`. Closes: none.

Fill `.github/PULL_REQUEST_TEMPLATE.md` Summary, Verification, Checklist; pure move only. Review only this layer's diff; publish later under parent authorization. Placeholder PR numbers below are intentional until PR creation, not fabricated existing PRs.

| Layer | PR | Head branch | Base | Review focus |
|---|---|---|---|---|
| 1 | #TBD-S20-L1 | `codex/split-pages-ClaudeDesktop` | `dev` | isolate Claude Desktop profile data and lane views ← this layer |
| 2 | #TBD-S20-L2 | `codex/split-components-MemoryObservabilityCard` | `dev` | separate memory metrics and stat views from restart polling |
| 3 | #TBD-S20-L3 | `codex/split-components-provider-workspace-ProviderSettings` | `dev` | extract provider draft helpers and stateless settings fields |
| 4 | #TBD-S20-L4 | `codex/split-pages-dashboard-shared` | `dev` | isolate dashboard sidecar option contracts and selection |
| 5 | #TBD-S20-L5 | `codex/split-components-QuotaBars` | `dev` | extract quota reset date and locale formatting |

DEV-STACK-03: each of the five layers carries its own gates and this complete map. S20 groups execution order and PR navigation only; all five layers are independent under STACK-INDEPENDENCE-01.

Base: dev — no dependency on the layers below; no cascade obligation.

Merge remains forbidden here (DEV-STACK-04).
