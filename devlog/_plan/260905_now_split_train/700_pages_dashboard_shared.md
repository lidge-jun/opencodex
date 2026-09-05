# S20 L4/5 — dashboard-shared

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: pure-move. C3 architecture, docs-only delegated preparation; parent owns all orchestration/loop/goal state.
- Goal: split `gui/src/pages/dashboard-shared.ts` into 1 cohesive sibling leaves, each ≤400 lines, with a projected 332-line residual and every existing export still importable from the old path.
- Non-goals: no behavior, copy, CSS, locale, request payload, exported name/signature, effect lifetime, auth/consent, or dependency changes. No source edits, test runs, Git mutation, PR creation or orchestration in this planning task. Existing long functions are not silently rewritten to satisfy a second metric.
- Verifier: `002_layer_map.md` → **Per-layer gate**, instantiated in Verification below (the 000 reference to “003” is stale; 002 is authoritative).
- Stop: plan complete when inventory/partition/export/state/oracle/gate records are internally consistent. Implementation stops on any failed gate or non-pure-move delta; completion later requires exact-tip checks and exact-head green CI, never a cached green check.
- Escalation: Stop if a leaf imports dashboard-shared even type-only, any public type/function is dropped or renamed, focus listeners change evaluation timing, or actual source diff exceeds 500. Changes to server vision contracts are outside this layer.

Source basis: `origin/dev = 1362b1a3841b4de20177e5d65865a513dd7936c4`; docs HEAD `4cc219549eafbf9cd2efd651482fbfefd88944d5`. Read with `git show origin/dev:gui/src/pages/dashboard-shared.ts`; the working-tree copy was byte-compared and identical. All source ranges below are inclusive at this origin/dev revision. Read 000_plan.md, 001_stale_check.md, S20 rows / Per-layer gate in 002_layer_map.md, and the matching section in `../260905_modular_debt_ledger/015_lane_gui.md`.

Structural decision (ARCH-DECISION-01 / ARCH-MAP-01): Context: option construction contributes 141 lines to a 488-line shared dashboard module. Rejected moving only update-label helpers: insufficient size reduction. Rejected moving focus hooks: unnecessary side-effect timing risk. Reuse shadow-call-source.ts unchanged. Chosen move: colocate selection functions and their eight DTO types in a sibling named dashboard-sidecar-options.ts, preserving every original export through explicit named re-exports. Blast radius is the dashboard helper boundary, with 15 current importer files remaining on the original path. Existing dashboard-core-poll.ts/dashboard-dialogs.tsx show the sibling domain naming convention.

## Symbol inventory

Inventory uses installed ast-grep: `sg run --kind <function_declaration|interface_declaration|type_alias_declaration|lexical_declaration|variable_declaration|import_statement> --json=compact gui/src/pages/dashboard-shared.ts`, filtered to top-level declarations and checked against `git show origin/dev:gui/src/pages/dashboard-shared.ts | nl -ba`. Imports are included for completeness but are not newly owned declarations.

Consumer count = distinct external source/test files importing that binding from the original module, not identifier occurrences or documentation mentions. Command candidate set: `rg -l 'dashboard-shared' src gui/src scripts tests gui/tests`; inspect matched import clauses for each symbol and deduplicate files. Private declarations/import bindings have zero external consumers by definition; local uses are preserved through the explicit imports below. Module fan-in is **15 files** (including type/test imports); added leaf imports do not replace existing consumer imports.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `import type { RefObject } from "react";` | import declaration | 1–1 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { useEffect, useRef } from "react";` | import declaration | 2–2 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { DEFAULT_VISION_TIMEOUT_MS, MAX_VISION_TIMEOUT_MS, MIN_VISION_TIMEOUT_MS, } from "../../../src/vision/timeout-bounds";` | import declaration | 3–7 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { readJsonOrThrow } from "../fetch-json";` | import declaration | 8–8 | no | 0 external | allocation in Leaf partition / residual imports |
| `import type { TKey } from "../i18n/shared";` | import declaration | 9–9 | no | 0 external | allocation in Leaf partition / residual imports |
| `import type { StartupHealthStatus } from "../startup-health-ui";` | import declaration | 10–10 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { shadowSourceModelList } from "./shadow-call-source";` | import declaration | 11–11 | no | 0 external | allocation in Leaf partition / residual imports |
| `DashboardSection` | type alias declaration | 13–13 | yes | 2 | `gui/src/pages/dashboard-shared.ts` |
| `DASHBOARD_UPDATE_HASH` | lexical declaration | 20–20 | yes | 0 | `gui/src/pages/dashboard-shared.ts` |
| `readDashboardSectionFromHash` | function declaration | 22–27 | yes | 1 | `gui/src/pages/dashboard-shared.ts` |
| `hashRequestsUpdateDialog` | function declaration | 30–32 | yes | 1 | `gui/src/pages/dashboard-shared.ts` |
| `dashboardHashForSection` | function declaration | 35–37 | yes | 1 | `gui/src/pages/dashboard-shared.ts` |
| `requireJson` | function declaration | 40–44 | yes | 4 | `gui/src/pages/dashboard-shared.ts` |
| `HealthData` | interface declaration | 46–46 | yes | 2 | `gui/src/pages/dashboard-shared.ts` |
| `ProviderInfo` | interface declaration | 47–47 | yes | 3 | `gui/src/pages/dashboard-shared.ts` |
| `ModelInfo` | interface declaration | 48–48 | yes | 5 | `gui/src/pages/dashboard-sidecar-options.ts` |
| `SettingsData` | interface declaration | 49–64 | yes | 2 | `gui/src/pages/dashboard-shared.ts` |
| `SidecarBackend` | type alias declaration | 65–65 | yes | 0 | `gui/src/pages/dashboard-sidecar-options.ts` |
| `VisionBackend` | type alias declaration | 73–73 | yes | 0 | `gui/src/pages/dashboard-sidecar-options.ts` |
| `VisionReasoning` | type alias declaration | 74–74 | yes | 0 | `gui/src/pages/dashboard-sidecar-options.ts` |
| `SidecarSetting` | interface declaration | 75–84 | yes | 1 | `gui/src/pages/dashboard-sidecar-options.ts` |
| `VisionModelOption` | interface declaration | 85–85 | yes | 1 | `gui/src/pages/dashboard-sidecar-options.ts` |
| `WebSearchModelOption` | interface declaration | 86–92 | yes | 0 | `gui/src/pages/dashboard-sidecar-options.ts` |
| `WebSearchPickerOption` | interface declaration | 93–98 | yes | 0 | `gui/src/pages/dashboard-sidecar-options.ts` |
| `SidecarData` | interface declaration | 99–110 | yes | 3 | `gui/src/pages/dashboard-shared.ts` |
| `SidecarPatch` | interface declaration | 111–121 | yes | 3 | `gui/src/pages/dashboard-shared.ts` |
| `ShadowCallData` | interface declaration | 122–122 | yes | 2 | `gui/src/pages/dashboard-shared.ts` |
| `UsageSummary30d` | interface declaration | 123–123 | yes | 2 | `gui/src/pages/dashboard-shared.ts` |
| `UpdateChannel` | type alias declaration | 124–124 | yes | 2 | `gui/src/pages/dashboard-shared.ts` |
| `Installer` | type alias declaration | 125–125 | yes | 0 | `gui/src/pages/dashboard-shared.ts` |
| `UpdateJobStatus` | type alias declaration | 126–126 | yes | 0 | `gui/src/pages/dashboard-shared.ts` |
| `SyncResult` | interface declaration | 127–138 | yes | 1 | `gui/src/pages/dashboard-shared.ts` |
| `ProjectCodexConfigWarning` | interface declaration | 139–144 | yes | 0 | `gui/src/pages/dashboard-shared.ts` |
| `ProjectCodexConfigGroup` | interface declaration | 145–149 | yes | 2 | `gui/src/pages/dashboard-shared.ts` |
| `UpdateCheckData` | interface declaration | 150–160 | yes | 1 | `gui/src/pages/dashboard-shared.ts` |
| `UpdateJob` | interface declaration | 161–173 | yes | 1 | `gui/src/pages/dashboard-shared.ts` |
| `EFFORT_CAP_LEVELS` | lexical declaration | 175–175 | yes | 1 | `gui/src/pages/dashboard-shared.ts` |
| `UPDATE_CHECK_MAX_AUTO_RETRIES` | lexical declaration | 176–176 | yes | 1 | `gui/src/pages/dashboard-shared.ts` |
| `UPDATE_CHECK_RETRY_BASE_MS` | lexical declaration | 177–177 | yes | 1 | `gui/src/pages/dashboard-shared.ts` |
| `defaultUpdateChannel` | function declaration | 179–181 | yes | 1 | `gui/src/pages/dashboard-shared.ts` |
| `updateReasonLabel` | function declaration | 183–190 | yes | 1 | `gui/src/pages/dashboard-shared.ts` |
| `updateJobLabel` | function declaration | 192–199 | yes | 1 | `gui/src/pages/dashboard-shared.ts` |
| `mergeSidecarSetting` | function declaration | 201–223 | yes | 3 | `gui/src/pages/dashboard-shared.ts` |
| `visionReasoningPatch` | function declaration | 226–228 | yes | 3 | `gui/src/pages/dashboard-shared.ts` |
| `visionEnabledPatch` | function declaration | 230–232 | yes | 2 | `gui/src/pages/dashboard-shared.ts` |
| `visionMaxDescriptionsPatch` | function declaration | 234–236 | yes | 2 | `gui/src/pages/dashboard-shared.ts` |
| `visionTimeoutPatch` | function declaration | 238–240 | yes | 2 | `gui/src/pages/dashboard-shared.ts` |
| `VISION_TIMEOUT_MS_DEFAULT` | lexical declaration | 246–246 | yes | 3 | `gui/src/pages/dashboard-shared.ts` |
| `VISION_TIMEOUT_MS_MAX` | lexical declaration | 247–247 | yes | 3 | `gui/src/pages/dashboard-shared.ts` |
| `VISION_TIMEOUT_MS_MIN` | lexical declaration | 248–248 | yes | 3 | `gui/src/pages/dashboard-shared.ts` |
| `VISION_MAX_DESCRIPTIONS_DEFAULT` | lexical declaration | 250–250 | yes | 3 | `gui/src/pages/dashboard-shared.ts` |
| `parsePositiveInteger` | function declaration | 252–258 | yes | 2 | `gui/src/pages/dashboard-shared.ts` |
| `parseVisionTimeoutMs` | function declaration | 260–264 | yes | 2 | `gui/src/pages/dashboard-shared.ts` |
| `VISION_REASONING_LEVELS` | lexical declaration | 266–266 | yes | 1 | `gui/src/pages/dashboard-shared.ts` |
| `visionReasoningLadder` | function declaration | 268–274 | yes | 2 | `gui/src/pages/dashboard-shared.ts` |
| `visionReasoningOptionsFor` | function declaration | 277–280 | yes | 2 | `gui/src/pages/dashboard-shared.ts` |
| `clampVisionReasoningToLadder` | function declaration | 283–300 | yes | 2 | `gui/src/pages/dashboard-shared.ts` |
| `sidecarModelOptions` | function declaration | 302–310 | yes | 0 | `gui/src/pages/dashboard-sidecar-options.ts` |
| `webSearchModelOptionsForPicker` | function declaration | 318–351 | yes | 2 | `gui/src/pages/dashboard-sidecar-options.ts` |
| `visionModelOptions` | function declaration | 368–381 | yes | 2 | `gui/src/pages/dashboard-sidecar-options.ts` |
| `shadowCallModelOptions` | function declaration | 384–407 | yes | 3 | `gui/src/pages/dashboard-sidecar-options.ts` |
| `sidecarBackendForModel` | function declaration | 409–411 | yes | 1 | `gui/src/pages/dashboard-sidecar-options.ts` |
| `webSearchSidecarSelectionForModel` | function declaration | 414–424 | yes | 2 | `gui/src/pages/dashboard-sidecar-options.ts` |
| `visionSidecarBackendForModel` | function declaration | 433–442 | yes | 2 | `gui/src/pages/dashboard-sidecar-options.ts` |
| `lastInputWasKeyboard` | lexical declaration | 444–444 | no | 0 | `gui/src/pages/dashboard-shared.ts` |
| `focusTriggerQuietly` | function declaration | 450–461 | no | 0 | `gui/src/pages/dashboard-shared.ts` |
| `useModalDialog` | function declaration | 463–486 | yes | 1 | `gui/src/pages/dashboard-shared.ts` |
| `StartupHealthStatus` | existing type re-export | 488–488 | yes | 0 | `dashboard-shared.ts` → `../startup-health-ui` (unchanged) |
| guarded keydown/pointerdown listener registration | top-level side-effect statement | 445–448 | no | 0 external | `gui/src/pages/dashboard-shared.ts` (unchanged) |

Current direct importer files (same import paths after the move):

- `gui/src/pages/dashboard-core-poll.ts`
- `gui/src/pages/use-subagent-delegation.ts`
- `gui/src/pages/dashboard-providers-section.tsx`
- `gui/src/pages/dashboard-models-section.tsx`
- `gui/tests/vision-sidecar-controls.test.ts`
- `gui/tests/vision-reasoning-contract.test.ts`
- `gui/tests/vision-sidecar-dashboard.test.tsx`
- `gui/tests/vision-model-options.test.ts`
- `gui/tests/shadow-call-model-options.test.ts`
- `gui/src/pages/dashboard-overview-sections.tsx`
- `gui/src/pages/dashboard-dialogs.tsx`
- `gui/src/pages/Dashboard.tsx`
- `gui/src/pages/Models.tsx`
- `gui/src/pages/use-dashboard-data.ts`
- `tests/gui/vision-sidecar-timeout-bounds.test.ts`

## Leaf partition

Reuse decision: no parallel infrastructure, utility barrel, controller or cache is introduced. The source-owned definitions above move rather than being copied; existing helpers named in Loop spec remain canonical. Sibling convention is feature-qualified lowercase helper filenames and PascalCase component files (e.g. `gui/src/pages/claude-desktop-lane.ts`, `gui/src/pages/dashboard-core-poll.ts`, `gui/src/components/provider-workspace/ProviderRail.tsx`). No `index.ts`, `utils.ts` or `common.ts` is created.

### gui/src/pages/dashboard-sidecar-options.ts

- Symbols: ModelInfo SidecarBackend VisionBackend VisionReasoning SidecarSetting VisionModelOption WebSearchModelOption WebSearchPickerOption sidecarModelOptions webSearchModelOptionsForPicker visionModelOptions shadowCallModelOptions sidecarBackendForModel webSearchSidecarSelectionForModel visionSidecarBackendForModel.
- Expected physical lines: 184 (including imports and new prop signatures; maximum 400).
- Move ModelInfo at 48, sidecar types 65–98 and the complete option/selection block 302–442: 1 + 34 + 141 = 176 physical lines. Export all existing exported identifiers identically. Reasoning/timeout patches, merged settings, update presentation and modal focus ownership remain in dashboard-shared. Types travel with option selection to avoid a leaf → original type cycle; the original imports the moved types for SidecarData/SidecarPatch/mergeSidecarSetting and reasoning helpers.
- Own imports:

```ts
import { shadowSourceModelList } from "./shadow-call-source";
```

Residual `gui/src/pages/dashboard-shared.ts`: **332 expected lines**. 488 − 176 moved source lines + 20 (type imports/re-export/spacing budget) = 332 residual lines. Leaf 184; aggregate 516 = 488 + 28 net overhead. No #b required. These are explicit physical-line budgets, not measured implementation output: reject a formatted result above the budget/400 rather than minifying it. The exact moved source blocks are disjoint; every original declaration has exactly one target in the inventory. Preserve associated comments, including i18n/lint exceptions.

## Re-export block

```ts
export type { ModelInfo, SidecarBackend, VisionBackend, VisionReasoning, SidecarSetting, VisionModelOption, WebSearchModelOption, WebSearchPickerOption } from "./dashboard-sidecar-options";
export { sidecarModelOptions, webSearchModelOptionsForPicker, visionModelOptions, shadowCallModelOptions, sidecarBackendForModel, webSearchSidecarSelectionForModel, visionSidecarBackendForModel } from "./dashboard-sidecar-options";
```

All other current exported declarations remain in the residual unchanged. In particular keep `export type { StartupHealthStatus };` at the original boundary with its existing type import.

Explicit local bindings needed in the residual (a re-export binds nothing):

```ts
import type { ModelInfo, SidecarBackend, VisionBackend, VisionReasoning, SidecarSetting, VisionModelOption, WebSearchModelOption } from "./dashboard-sidecar-options";
```

Retain original external imports still used by residual declarations; remove only moved-only bindings after reference checks. The listed leaf imports use verified existing modules or the exact new owners defined in this plan. Internal leaves import each other directly, never through the preserved original-path compatibility boundary. No wildcard re-export.

## Module-level state and cycles

lastInputWasKeyboard (444) stays solely in dashboard-shared.ts together with the guarded top-level listener-registration statement (445–448), focusTriggerQuietly (450–461) and useModalDialog (463–486). Do not move, duplicate or defer the keydown/pointerdown listeners. EFFORT_CAP_LEVELS (175), retry constants (176–177), VISION_TIMEOUT aliases/default (246–250), VISION_REASONING_LEVELS (266), and DASHBOARD_UPDATE_HASH (20) remain single original-path owners. invalidSelectors Set at 393 is function-local in shadowCallModelOptions and moves inside that function, not to module scope. Residual → option leaf → shadow-call-source.ts (which has no imports). Neither value nor type edges return to the original. Existing eager browser side effects remain attached to original-module evaluation.

Cycle proof for the implementation gate: resolve static import/export edges, including type-only edges, from this original and its new leaves; fail if any leaf reaches the original (directly or transitively), or the changed induced graph has an SCC. Run the lane-015 read-only sg/import-resolution + Tarjan method; preserve the allow-edge and forbidden-back-edge evidence. No new graph tool/dependency installation is authorized. The plan records an acyclic intended edge map, not a claim that future source has been scanned.

## Tests

Direct importing tests — `rg -l` candidate list narrowed to actual imports of this module; **6 files**, all **unchanged**:

- `gui/tests/vision-sidecar-controls.test.ts` — unchanged original-path import.
- `gui/tests/vision-reasoning-contract.test.ts` — unchanged original-path import.
- `gui/tests/vision-sidecar-dashboard.test.tsx` — unchanged original-path import.
- `gui/tests/vision-model-options.test.ts` — unchanged original-path import.
- `gui/tests/shadow-call-model-options.test.ts` — unchanged original-path import.
- `tests/gui/vision-sidecar-timeout-bounds.test.ts` — unchanged original-path import.

Text-oracle disposition: No literal or extensionless source-text reader of dashboard-shared.ts was found. Six direct importing test files listed below remain unchanged. `gui/tests/dashboard-contracts.test.ts` reads dashboard-core-poll.ts/use-dashboard-data.ts (24–25 and subsequent calls), not this file; unchanged adjacent guard. Source tests of Dashboard.tsx/Models.tsx keep their original imports and need no retarget or scan-list change.

Guards to drive red once during implementation C verification: No text guard is retargeted. Temporarily collapse an empty server option array to the legacy fallback in dashboard-sidecar-options.ts; vision-model-options.test.ts must fail, then restore. Also prove original-path export preservation by temporarily removing one moved re-export and observing its focused import fail, then restore. Never run a full suite locally for these checks. Record the named failing assertion and restored green result; do not commit mutations. Do not weaken assertions, replace source guards with export-existence checks, or retarget behavioral tests away from the compatibility boundary. No guard has been executed during this documentation task.

## Verification

Future executor commands only — not run by this delegated author. In a dedicated layer worktree at its tip, instantiate 002 Per-layer gate:

```sh
bun run typecheck
bun test gui/tests/vision-sidecar-controls.test.ts gui/tests/vision-reasoning-contract.test.ts gui/tests/vision-sidecar-dashboard.test.tsx gui/tests/vision-model-options.test.ts gui/tests/shadow-call-model-options.test.ts tests/gui/vision-sidecar-timeout-bounds.test.ts
bun run privacy:scan
wc -l gui/src/pages/dashboard-sidecar-options.ts gui/src/pages/dashboard-shared.ts
rg -l 'from "[^"]*/dashboard-shared(\.tsx?)?"' src gui/src scripts tests gui/tests
# GUI TypeScript/bundler proof and scoped lint, required by gui/AGENTS.md:
(cd gui && bun run build && bun run lint)
# Whole repository suite only on the approved remote host:
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-pages-dashboard-shared && git checkout -q FETCH_HEAD && git rev-parse HEAD && bun install --frozen-lockfile && bun run test'
# Full GUI PR-ready suite also remote, never substitute it for the root suite:
ssh lidge 'cd ~/ocx-ci/opencodex/gui && bun install --frozen-lockfile && bun test tests'
```

Focused domains: `tests/gui` and `gui/tests`; only the listed files run locally. The core-Lab boundary gate is N/A: no `src/server`, `src/router`, or `src/lib` source is touched; never edit its protected roots. Unchanged UI copy means no locale churn; if copy unexpectedly changes, stop the pure-move layer rather than manufacturing new translations.

Compare the importer list with the 15-file baseline above (count files, not lines; compare existing callers, excluding newly added internal leaves). Compare exported name/kind/signature inventory and explicit local bindings, inspect `git diff --numstat origin/dev...HEAD -- gui/src` against the 500 added+deleted source-line cap, and perform the changed-graph cycle check described above. The remote checkout SHA must equal this PR head; serialize the shared lidge checkout or arrange parent-owned isolation before running it. Do not accept a later remote GUI run on another layer's SHA. Require actual exit statuses and full-suite totals: the command deliberately avoids 002's unguarded `| tail -15`, which could hide failure. Record exact-head CI for the layer and do not merge.

Docs-only verification for this author: inspect only these five requested output documents for nine exact ordered headings, complete declaration coverage, ≤400 projected leaf/residual budgets, correct branch/base/stack map, and whitespace with `git diff --no-index --check /dev/null <doc>`. No runtime, build, privacy or test-pass result is claimed here.

## Accept criteria

1. Every top-level declaration in the origin/dev inventory has one canonical owner; moved blocks match original behavior and no unlisted source file is changed.
2. Existing default/named/type exports and signatures remain importable from `gui/src/pages/dashboard-shared.ts`; all 15 existing importer files retain their paths. Re-exported symbols used locally have explicit imports.
3. Exactly 1 new leaves appear at the paths above, each ≤400 physical lines; residual ≤400 (budget 332); actual formatted counts and source diff size are recorded. Exceeding the 500-line source diff or residual budget escalates before publication.
4. State lifetime/ownership and side-effect timing match Module-level state and cycles; changed graph has no new value or type cycle and no upward leaf → original path.
5. Every listed behavioral/text oracle keeps its specified target/disposition; the named guard mutation produces the expected failure and restoration yields green focused tests.
6. Typecheck, focused checks, GUI build/lint, privacy scan, remote whole-suite and remote GUI PR-ready suite pass at the exact layer head, with exit codes and CI SHA evidence; no repository-wide local suite.
7. PR contains all repository template sections and the five-layer stack map; correct base/head, no merge, no release, no unrelated cleanup. If title/body says GUI, attach a real unchanged-UI screenshot as required by the repository gate; never fabricate an image link.

## PR

Title: `refactor(gui): isolate dashboard sidecar option contracts and selection (split S20 L4/5)`

Head: `codex/split-pages-dashboard-shared`. Base: `dev`. Closes: none.

Fill `.github/PULL_REQUEST_TEMPLATE.md` Summary, Verification, Checklist; pure move only. Review only this layer's diff; publish later under parent authorization. Placeholder PR numbers below are intentional until PR creation, not fabricated existing PRs.

| Layer | PR | Head branch | Base | Review focus |
|---|---|---|---|---|
| 1 | #TBD-S20-L1 | `codex/split-pages-ClaudeDesktop` | `dev` | isolate Claude Desktop profile data and lane views |
| 2 | #TBD-S20-L2 | `codex/split-components-MemoryObservabilityCard` | `dev` | separate memory metrics and stat views from restart polling |
| 3 | #TBD-S20-L3 | `codex/split-components-provider-workspace-ProviderSettings` | `dev` | extract provider draft helpers and stateless settings fields |
| 4 | #TBD-S20-L4 | `codex/split-pages-dashboard-shared` | `dev` | isolate dashboard sidecar option contracts and selection ← this layer |
| 5 | #TBD-S20-L5 | `codex/split-components-QuotaBars` | `dev` | extract quota reset date and locale formatting |

DEV-STACK-03: each of the five layers carries its own gates and this complete map. S20 groups execution order and PR navigation only; all five layers are independent under STACK-INDEPENDENCE-01.

Base: dev — no dependency on the layers below; no cascade obligation.

Merge remains forbidden here (DEV-STACK-04).
