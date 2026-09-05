# S19 L2 — Matrix presentation without moving request lifetimes

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: **pure-move**, C3, bounded docs-only delegation; implementation and loop state belong to the parent.
- Goal: reduce `gui/src/pages/CompatibilityMatrix.tsx` from 628 to ≤400 lines by moving existing view components and page-local supporting declarations into two siblings. Preserve the default page export and every existing prop.
- Non-goals: changing layout, labels, request ownership, hooks, filter behavior, polling, cancellation, selection, pagination semantics, or resource keys; no new controller hook or context.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below, plus the GUI build and text-oracle red proof. No tests run in this docs task.
- Stop: only this layer's pure-move diff, complete export/cycle/size evidence, preserved source and DOM oracles, exact-tip remote full suites and CI; no merge.
- Escalation: new source readers, source drift, changed JSX/props or hook lifetimes, size >400, or an unapproved >500-line raw source diff. The planned 238-line move produces about 476 add/delete lines before imports; expected raw diff around 520 can exceed 002's 500-line gate. **Parent must explicitly decide a move-only budget exception or revise 002 to add a part; this document does not silently change the four-layer stack.**
- Basis: docs `4cc219549`; `origin/dev` code `1362b1a3841b4de20177e5d65865a513dd7936c4`. Source ranges below are at that revision, verified equal to the working tree. Inputs: `000_plan.md`, `001_stale_check.md`, S19 in `002_layer_map.md`, and `260905_modular_debt_ledger/015_lane_gui.md` (DetailPane/summary seam at original lines 81–269).

## Symbol inventory

Exact inclusive spans: top-level `rg` declarations reconciled with `sg run --kind <function_declaration|lexical_declaration|type_alias_declaration> --json=compact gui/src/pages/CompatibilityMatrix.tsx`. Imports are enumerated as dependency edges below, not declarations. Consumers = distinct external importing files from `rg -l 'from ["\x27][^"\x27]*/CompatibilityMatrix(\.tsx?)?["\x27]' src gui/src gui/tests tests scripts`, followed by `rg -l -w '<symbol>'` within that set; private declarations have zero external consumers.

V = `gui/src/pages/compatibility-matrix-views.tsx`; S = `gui/src/pages/compatibility-matrix-page-state.ts`; R = original path.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| LAYER_LABEL | const record | 30–34 | no | 0 | V |
| LAYER_COLUMN | const record | 36–40 | no | 0 | V |
| VERDICT_LABEL | const record | 42–50 | no | 0 | V |
| ARTIFACT_STATUS_LABEL | const record | 52–56 | no | 0 | V |
| ExtraVerdictPage | type | 58–64 | no | 0 | S |
| LoadMoreFailure | type | 66–70 | no | 0 | S |
| localizedFetchError | function | 72–79 | no | 0 | S |
| VerdictBadge | function component | 81–103 | no | 0 | V |
| VerdictCell | function component | 105–126 | no | 0 | V |
| StatusCards | function component | 128–151 | no | 0 | V |
| CommunityEvidencePanel | function component | 153–171 | no | 0 | V |
| DetailPane | function component | 173–269 | no | 0 | V |
| CompatibilityMatrix | function component | 271–628 | default | 3 | R |

## Leaf partition

Structural decision: retain the entire `CompatibilityMatrix` function at `gui/src/pages/CompatibilityMatrix.tsx:271`, extract the already-top-level renderers, and give its two pagination result types/error formatter a small page-state sibling. Rejected alternatives: moving the whole page leaves a new 628-line problem; moving only DetailPane leaves >500 lines; moving types into a renderer or importing them back from the page creates misleading ownership or a cycle. Do nothing/delete/configure cannot resolve this file's modular debt. Existing `compatibility-matrix-shared.ts` is the DTO/parser owner, not a home for page request state.

Current map: `Models.tsx:22` and two mounted tests → page → React/i18n/data-surface/API/shared DTOs. New map: same entry → page → V and S; V and S → API/shared DTOs, never back to page. V also → i18n/UI/data-surface presentation. Local GUI-feature blast radius; no routing, backend or public prop changes. Existing sibling naming is demonstrated by `dashboard-overview-head.tsx`, `dashboard-overview-panels.tsx`, and `compatibility-matrix-shared.ts`.

NEW files:

1. `gui/src/pages/compatibility-matrix-views.tsx`: all V rows, original 30–56 plus 81–269 = **216 moved lines**. Expected **235 lines** including imports and separation. Export the three page-used label maps and five existing components from this leaf. `ARTIFACT_STATUS_LABEL` remains leaf-private. Components keep their original signatures and JSX byte-equivalent; `VerdictCell` calls the local `VerdictBadge`, not a facade re-export.
2. `gui/src/pages/compatibility-matrix-page-state.ts`: all S rows, original 58–79 = **22 moved lines**. Expected **27 lines** with its type-only imports and separators. Export both types and `localizedFetchError` for direct use by R. It owns no effects, stores or hooks; this is the value/error representation accompanying a page request, not a new controller abstraction.

V imports:

```ts
import type { TKey } from "../i18n/shared";
import { labSupplement, type LabSupplementKey } from "../i18n/lab-translations";
import { Notice } from "../ui";
import { DataSurfaceStatus } from "../components/data-surface";
import type { CommunityEvidenceContextDto, LabPageData, VerdictDetailData } from "./compatibility-matrix-api";
import {
  formatAsOf, shortSubjectId,
  type ArtifactStatus, type CompatibilityVerdict, type EvidenceLayer, type VerdictDto,
} from "./compatibility-matrix-shared";
```

S imports:

```ts
import type { LabPageData } from "./compatibility-matrix-api";
import type { VerdictDto } from "./compatibility-matrix-shared";
```

Residual `gui/src/pages/CompatibilityMatrix.tsx`: **expected 395 lines**. Arithmetic: 628 − 216 − 22 = 390 retained original lines including the old imports; remove unused `TKey`, `LabSupplementKey`, `CommunityEvidenceContextDto`, `ArtifactStatus` imports and add the three explicit leaf imports below. Keep readable formatting; the implementation's `wc -l` is authoritative. All state and the 358-line page function remain intact. This intentionally does not claim to eliminate existing function-length debt; slicing that controller is a different behavior-risk task. No residual >400 or #b is planned; only the raw diff budget may require parent-authorized topology expansion.

## Re-export block

**No re-export statement is needed:** the only current export is `export default function CompatibilityMatrix` at original line 271, and it stays in R. Do not expose previously private renderers/types from the page just to create a barrel. The exact public export block is therefore unchanged (one default function, no named exports).

The residual requires these local imports; re-exports would not bind these names:

```ts
import { LAYER_LABEL, LAYER_COLUMN, VERDICT_LABEL, VerdictBadge, VerdictCell, StatusCards, CommunityEvidencePanel, DetailPane } from "./compatibility-matrix-views";
import { localizedFetchError } from "./compatibility-matrix-page-state";
import type { ExtraVerdictPage, LoadMoreFailure } from "./compatibility-matrix-page-state";
```

Retain its React hooks, `IconRefresh`, `useI18n`, `labSupplement`, `EmptyState`/`Notice`/`Select`, `useDataSurface`, data-surface components, three API functions and page/detail DTO types. Retain shared constants/matrix/format/query helpers plus `CompatibilityVerdict`, `EvidenceLayer`, `VerdictDto`, `VerdictFilters`. No leaf exports added to the old public path; existing default imports in Models and tests remain untouched.

## Module-level state and cycles

- No top-level `let`, Map, Set, WeakMap, lock, subscription or effect. Four label records at `gui/src/pages/CompatibilityMatrix.tsx:30`, `:36`, `:42`, `:52` move to V once; their read-only usage is preserved without introducing freezes or changing types.
- Component-local `expectedEventCount` Set at original line 182 moves inside `DetailPane`; it must not become shared module state.
- All `useState` values at 277–284, request refs at 286–288, callback/effect lifetimes at 292–332, request identity checks at 334–343 and 362–424 remain in R. The `baseData` object identity is not replaced by a value comparison.
- Potential V → R cycle for labels or DTOs is avoided by owning labels in V and importing DTO types from the existing API/shared modules. S imports only existing DTO types, not R or V. API from L1 must never import this page or either leaf. New edges are functional props and type-only contracts, not shared mutable state.

## Tests

Every directly importing test from `rg -l` (unchanged default imports):

```text
gui/tests/compatibility-lab.test.tsx
gui/tests/compatibility-lab-followup.test.tsx
```

Imports occur at lines 8 and 7 respectively. The third importing file is `gui/src/pages/Models.tsx:22`, unchanged. These mounted tests cover selection, refresh, abort/races, inactive-tab behavior and rendering through the original boundary.

Every discovered source-text reader of the page:

| test/read location at origin/dev | disposition | exact action |
|---|---|---|
| `gui/tests/compatibility-matrix-layout.test.ts:7`, `Bun.file(new URL("../src/pages/CompatibilityMatrix.tsx", import.meta.url)).text()` | add-leaf-to-scan-list | retain this page read and all Models/routing/tabs/CSS reads; additionally read `../src/pages/compatibility-matrix-views.tsx` and include it in `readSources` |

Do not replace the page read with only V: the Models mount and page table markup must remain guarded. The combined source string also contains CSS, so merely appending V can leave a vacuous badge assertion. Add a separate assertion against V's own source for the `const className =` declaration whose template starts with `lab-verdict-badge`; preserve all existing assertions. No source read of S is necessary for those layout tokens. The CSS-only second test remains unchanged.

Drive the migrated guard red once by changing the actual badge class prefix only in V while leaving page/CSS/test expectations intact. It must fail independently of CSS containing `.lab-verdict-badge`. Restore, then require green. Also exercise existing follow-up race tests unchanged; a pure-move claim cannot be based solely on text tokens. No tests or negative mutations are performed by this draft task.

## Verification

Future L2 worktree commands, 002 Per-layer gate with GUI compatibility domain:

```sh
bun run typecheck
bun test gui/tests/compatibility-lab.test.tsx gui/tests/compatibility-lab-followup.test.tsx gui/tests/compatibility-matrix-layout.test.ts
bun run privacy:scan
(cd gui && bun run lint && bun run build)
wc -l gui/src/pages/CompatibilityMatrix.tsx gui/src/pages/compatibility-matrix-views.tsx gui/src/pages/compatibility-matrix-page-state.ts
rg -l 'from ["\x27][^"\x27]*/CompatibilityMatrix(\.tsx?)?["\x27]' src gui/src gui/tests tests scripts
sg run --kind import_statement --json=compact gui/src/pages/compatibility-matrix-views.tsx gui/src/pages/compatibility-matrix-page-state.ts
git diff --check
git diff --numstat codex/split-pages-compatibility-matrix-api...HEAD
```

Importer set remains exactly three; leaf imports match the inward graph including type edges. All outputs ≤400; default export and JSX signatures unchanged; focused checks/privacy/lint/build exit 0. Compare extracted bodies with `git diff --color-moved` and original line ranges. No backend protected roots touched, hence no conditional core-Lab boundary run. Obtain parent budget decision before publishing if raw source additions + deletions exceed 500; no unilateral branch/map changes.

Full suites on the parent's exclusively allocated lidge checkout only:

```sh
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-pages-CompatibilityMatrix && git checkout -q FETCH_HEAD && bun install --frozen-lockfile && bun run test && (cd gui && bun install --frozen-lockfile && bun test tests)'
```

Record remote SHA equal to the PR tip, full log and actual test exit status, exact-head CI rollup and unchanged-UI screenshot (matrix, selected detail, empty/error states). Never run full suites locally; no live service restart/deploy is implied. The parent executes and reports these checks, not this docs task.

## Accept criteria

1. All 13 top-level declarations retain one owner; the default page and its props remain importable from the original path with exactly three original importers.
2. V, S and R are ≤400 physical lines; all 358 lines of the original page function are unchanged apart from relocated references resolving through imports.
3. Labels/JSX and existing renderer signatures are byte-equivalent; no hook, state, callback, signal, request identity or timer is moved to a new lifetime.
4. No runtime or type cycle enters R from either leaf; no additional internal barrel is created.
5. The source oracle still reads R, adds V and fails on the specified leaf-only badge mutation; two mounted test files keep their original imports and pass.
6. Typecheck, focused tests, privacy, GUI lint/build, remote suites and exact-head CI have fresh successful evidence; raw diff >500 has an explicit parent disposition before execution/publishing.
7. PR base is L1's branch, all lower-layer changes are cascaded by the parent, and no merge occurs.

## PR

Title: `refactor(gui): separate matrix presentation from request state (split S19 L2/4)`

Branch: `codex/split-pages-CompatibilityMatrix`. Base: `codex/split-pages-compatibility-matrix-api`. Closes: none.

Fill Summary / Verification / Checklist in the repository PR template, include screenshot evidence for unchanged GUI, document the raw-diff budget disposition. DEV-STACK-03 map:

| # | PR | Branch | Base | Review focus |
|---|---|---|---|---|
| 1 | #TBD-S19-L1 | codex/split-pages-compatibility-matrix-api | dev | pagination/error owner |
| 2 | #TBD-S19-L2 | codex/split-pages-CompatibilityMatrix | codex/split-pages-compatibility-matrix-api | matrix presentation leaves; this layer |
| 3 | #TBD-S19-L3 | codex/split-combo-workspace-data | dev | quota evidence and combo contracts |
| 4 | #TBD-S19-L4 | codex/split-components-combo-workspace-detail-panel | codex/split-combo-workspace-data | controlled Config contents |

Depends on #TBD-S19-L1; review this diff only. Parent cascades edits to `codex/split-pages-compatibility-matrix-api` into this layer and refreshes evidence (DEV-STACK-02). Merge after that parent only with separate user authorization; no auto-merge.
