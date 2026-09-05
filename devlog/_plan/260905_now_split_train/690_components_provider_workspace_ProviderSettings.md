# S20 L3/5 — ProviderSettings

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: pure-move. C3 architecture, docs-only delegated preparation; parent owns all orchestration/loop/goal state.
- Goal: split `gui/src/components/provider-workspace/ProviderSettings.tsx` into 2 cohesive sibling leaves, each ≤400 lines, with a projected 392-line residual and every existing export still importable from the old path.
- Non-goals: no behavior, copy, CSS, locale, request payload, exported name/signature, effect lifetime, auth/consent, or dependency changes. No source edits, test runs, Git mutation, PR creation or orchestration in this planning task. Existing long functions are not silently rewritten to satisfy a second metric.
- Verifier: `002_layer_map.md` → **Per-layer gate**, instantiated in Verification below (the 000 reference to “003” is stale; 002 is authoritative).
- Stop: plan complete when inventory/partition/export/state/oracle/gate records are internally consistent. Implementation stops on any failed gate or non-pure-move delta; completion later requires exact-tip checks and exact-head green CI, never a cached green check.
- Escalation: Stop if 40-line replacement budget is exceeded enough to leave the original above 400, total added+deleted source lines exceed 500, or a field extraction would move auth confirmation/save validation. Parent must resolve a size exception or additional part rather than allowing opportunistic controller/auth changes.

Source basis: `origin/dev = 1362b1a3841b4de20177e5d65865a513dd7936c4`; docs HEAD `4cc219549eafbf9cd2efd651482fbfefd88944d5`. Read with `git show origin/dev:gui/src/components/provider-workspace/ProviderSettings.tsx`; the working-tree copy was byte-compared and identical. All source ranges below are inclusive at this origin/dev revision. Read 000_plan.md, 001_stale_check.md, S20 rows / Per-layer gate in 002_layer_map.md, and the matching section in `../260905_modular_debt_ledger/015_lane_gui.md`.

Structural decision (ARCH-DECISION-01 / ARCH-MAP-01): Context: state/save logic and 132 lines of form sections share a 514-line file. Rejected moving the default 456-line component intact: relocates the violation. Rejected independent pacing controller: changes the single save transaction. Reuse base-url-choice.ts, ProviderRail.authModeLabel and provider-workspace/types.ts. Chosen move: pure draft helpers plus stateless field views with explicit typed values/events. ProviderDetails.tsx and four public-path tests remain the callers; blast radius is provider-workspace presentation, with auth behavior deliberately retained.

## Symbol inventory

Inventory uses installed ast-grep: `sg run --kind <function_declaration|interface_declaration|type_alias_declaration|lexical_declaration|variable_declaration|import_statement> --json=compact gui/src/components/provider-workspace/ProviderSettings.tsx`, filtered to top-level declarations and checked against `git show origin/dev:gui/src/components/provider-workspace/ProviderSettings.tsx | nl -ba`. Imports are included for completeness but are not newly owned declarations.

Consumer count = distinct external source/test files importing that binding from the original module, not identifier occurrences or documentation mentions. Command candidate set: `rg -l 'ProviderSettings' src gui/src scripts tests gui/tests`; inspect matched import clauses for each symbol and deduplicate files. Private declarations/import bindings have zero external consumers by definition; local uses are preserved through the explicit imports below. Module fan-in is **5 files** (including type/test imports); added leaf imports do not replace existing consumer imports.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `import { useEffect, useMemo, useRef, useState } from "react";` | import declaration | 10–10 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { baseUrlForChoice, matchChoiceId, resolvedBaseUrlForChoice } from "../../base-url-choice";` | import declaration | 11–11 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { readJsonIfOk } from "../../fetch-json";` | import declaration | 12–12 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { createBoundedFetch } from "../../bounded-fetch";` | import declaration | 13–13 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { startVisibilityPoll } from "../../visibility-poll";` | import declaration | 14–14 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { useT } from "../../i18n/shared";` | import declaration | 15–15 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { IconLock } from "../../icons";` | import declaration | 16–16 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { isCatalogProviderId } from "../../provider-icons";` | import declaration | 17–17 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { openAiAccountProviderState } from "../../provider-payload";` | import declaration | 18–18 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { providerSupportsLiveModelDiscovery } from "../../provider-workspace/catalog";` | import declaration | 19–19 | no | 0 external | allocation in Leaf partition / residual imports |
| `import type { CatalogPreset } from "../provider-catalog/provider-presets";` | import declaration | 20–20 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { authModeLabel } from "./ProviderRail";` | import declaration | 21–21 | no | 0 external | allocation in Leaf partition / residual imports |
| `import type { WorkspaceItem, ProviderUpdatePatch, ProviderUpdateResult } from "./types";` | import declaration | 22–22 | no | 0 external | allocation in Leaf partition / residual imports |
| `ADAPTERS` | lexical declaration | 24–24 | no | 0 | `gui/src/components/provider-workspace/ProviderSettings.tsx` |
| `EMPTY_MODELS` | lexical declaration | 25–25 | no | 0 | `gui/src/components/provider-workspace/ProviderSettings.tsx` |
| `ChoicesStatus` | type alias declaration | 27–27 | no | 0 | `gui/src/components/provider-workspace/ProviderSettings.tsx` |
| `PacingRule` | type alias declaration | 28–28 | no | 0 | `gui/src/components/provider-workspace/provider-settings-draft.ts` |
| `PacingStatus` | type alias declaration | 29–29 | no | 0 | `gui/src/components/provider-workspace/provider-settings-draft.ts` |
| `CursorHttpVersion` | type alias declaration | 30–30 | no | 0 | `gui/src/components/provider-workspace/provider-settings-draft.ts` |
| `effectiveCursorHttpVersion` | function declaration | 32–34 | no | 0 | `gui/src/components/provider-workspace/provider-settings-draft.ts` |
| `numberDraft` | function declaration | 36–36 | no | 0 | `gui/src/components/provider-workspace/provider-settings-draft.ts` |
| `positiveRpm` | function declaration | 37–41 | no | 0 | `gui/src/components/provider-workspace/provider-settings-draft.ts` |
| `positiveInteger` | function declaration | 42–46 | no | 0 | `gui/src/components/provider-workspace/provider-settings-draft.ts` |
| `pacingSignature` | function declaration | 47–57 | no | 0 | `gui/src/components/provider-workspace/provider-settings-draft.ts` |
| `ProviderSettings` | function declaration | 59–514 | default | 5 | `gui/src/components/provider-workspace/ProviderSettings.tsx` (residual; JSX ranges below move) |

Current direct importer files (same import paths after the move):

- `gui/tests/provider-settings-cursor-transport.test.tsx`
- `gui/tests/provider-settings-live-models-provenance.test.tsx`
- `gui/tests/provider-settings-request-pacing.test.tsx`
- `gui/tests/provider-settings-account-mode.test.tsx`
- `gui/src/components/provider-workspace/ProviderDetails.tsx`

## Leaf partition

Reuse decision: no parallel infrastructure, utility barrel, controller or cache is introduced. The source-owned definitions above move rather than being copied; existing helpers named in Loop spec remain canonical. Sibling convention is feature-qualified lowercase helper filenames and PascalCase component files (e.g. `gui/src/pages/claude-desktop-lane.ts`, `gui/src/pages/dashboard-core-poll.ts`, `gui/src/components/provider-workspace/ProviderRail.tsx`). No `index.ts`, `utils.ts` or `common.ts` is created.

### gui/src/components/provider-workspace/provider-settings-draft.ts

- Symbols: PacingRule PacingStatus CursorHttpVersion effectiveCursorHttpVersion numberDraft positiveRpm positiveInteger pacingSignature.
- Expected physical lines: 34 (including imports and new prop signatures; maximum 400).
- Move lines 28–57 (30 physical lines). Export the three types and five helpers unchanged. ChoicesStatus, ADAPTERS and EMPTY_MODELS stay with the stateful form.
- Own imports:

```ts
import type { WorkspaceItem } from "./types";
```

### gui/src/components/provider-workspace/ProviderSettingsFields.tsx

- Symbols: ProviderConnectionFields (new extraction 329–407); ProviderAdvancedFields (new extraction 445–473); ProviderPacingFields (new extraction 474–497).
- Expected physical lines: 235 (including imports and new prop signatures; maximum 400).
- Move 79 + 29 + 24 = 132 original JSX lines into three named stateless components in one settings-presentation leaf. Use inline typed props, with fragments rather than extra DOM wrappers. Connection fields receive providerName, t, adapter/isPreset/adapterOptions, hasEndpointPicker/baseUrlChoices/endpointChoice/baseUrl/plainBaseUrlLocked, cursorHttpVersion, modelOptions/defaultModel, authMode/authModeDisplay, endpointLabel and the corresponding setter callbacks. Keep endpoint selection's setEndpointChoice then setBaseUrl(baseUrlForChoice(...)) order. Advanced fields receive t, supportsApiKeyTransport/apiKeyTransport, note, allowPrivateNetwork, liveModels/liveModelDiscoverySupported and setters. Pacing fields receive providerName, t, availableModels, pacingEnabled/pacingRpm/pacingDelay/pacingStatus, pacingModelId/pacingModelRpm/pacingModelDelay/pacingModels, corresponding setters and addPacingModel. Type setPacingModels as Dispatch<SetStateAction<Record<string, PacingRule>>> to preserve its existing functional removal updater. Do not pass the whole WorkspaceItem or a controller bag. authModeDisplay is authModeLabel(item,t), computed in the residual. The save/discard bar (498–506), message (507–511), account-mode confirmation (408–444), every hook (71–180) and all mutations (225–307) stay in ProviderSettings.
- Own imports:

```ts
import type { Dispatch, SetStateAction } from "react";
import type { TFn } from "../../i18n/shared";
import { IconLock } from "../../icons";
import { baseUrlForChoice } from "../../base-url-choice";
import type { CatalogPreset } from "../provider-catalog/provider-presets";
import type { PacingRule, PacingStatus, CursorHttpVersion } from "./provider-settings-draft";
```

Residual `gui/src/components/provider-workspace/ProviderSettings.tsx`: **392 expected lines**. 514 − 30 (draft types/helpers) − 132 (three JSX regions) + 40 (imports and replacement prop-call budget) = 392 residual lines. Leaves 34 + 235 = 269; aggregate 661 = 514 + 147 net extraction overhead. No #b allocated. The residual has only eight lines of budget headroom: count actual formatted output before declaring this split complete. These are explicit physical-line budgets, not measured implementation output: reject a formatted result above the budget/400 rather than minifying it. The exact moved source blocks are disjoint; every original declaration has exactly one target in the inventory. Preserve associated comments, including i18n/lint exceptions.

## Re-export block

The only public export is default ProviderSettings (59–514); keep it in the residual. Exact new re-export block: empty. All current private helpers stay private to this feature's direct-import leaves; no new original-path exports.

Explicit local bindings needed in the residual (a re-export binds nothing):

```ts
import { effectiveCursorHttpVersion, numberDraft, positiveRpm, positiveInteger, pacingSignature } from "./provider-settings-draft";
import type { PacingRule, PacingStatus, CursorHttpVersion } from "./provider-settings-draft";
import { ProviderConnectionFields, ProviderAdvancedFields, ProviderPacingFields } from "./ProviderSettingsFields";
```

Retain original external imports still used by residual declarations; remove only moved-only bindings after reference checks. The listed leaf imports use verified existing modules or the exact new owners defined in this plan. Internal leaves import each other directly, never through the preserved original-path compatibility boundary. No wildcard re-export.

## Module-level state and cycles

No module-level mutable Map/Set/WeakMap, let, lock or timer exists. ADAPTERS at 24 remains one read-only array; EMPTY_MODELS at 25 remains one stable fallback array in ProviderSettings.tsx (never inline [] into default props). Pacing model copies at 96 and Set at 204 are component/useMemo-local. All draft setters, account-mode synchronization, saveRef (268) and pacing visibility polling remain in the residual. Fields → draft/types and UI primitives; residual → fields/draft; no leaf imports ProviderSettings. Pure functions and explicit field events are functional coupling, not shared mutable state.

Cycle proof for the implementation gate: resolve static import/export edges, including type-only edges, from this original and its new leaves; fail if any leaf reaches the original (directly or transitively), or the changed induced graph has an SCC. Run the lane-015 read-only sg/import-resolution + Tarjan method; preserve the allow-edge and forbidden-back-edge evidence. No new graph tool/dependency installation is authorized. The plan records an acyclic intended edge map, not a claim that future source has been scanned.

## Tests

Direct importing tests — `rg -l` candidate list narrowed to actual imports of this module; **4 files**, all **unchanged**:

- `gui/tests/provider-settings-cursor-transport.test.tsx` — unchanged original-path import.
- `gui/tests/provider-settings-live-models-provenance.test.tsx` — unchanged original-path import.
- `gui/tests/provider-settings-request-pacing.test.tsx` — unchanged original-path import.
- `gui/tests/provider-settings-account-mode.test.tsx` — unchanged original-path import.

Text-oracle disposition: No literal or extensionless source reader targets ProviderSettings.tsx. All four direct test files import the component at line 5 and remain unchanged; no retarget-to-leaf/add-leaf-to-scan-list required. ProviderDetails source-reading tests inspect ProviderDetails, whose import and JSX remain unchanged.

Guards to drive red once during implementation C verification: No retargeted text guard. Temporarily change positiveRpm to return parsed + 1 for valid inputs in the draft leaf; gui/tests/provider-settings-request-pacing.test.tsx:39 must fail its exact 38/10 RPM patch assertion (70–76), then restore. This existing test does not prove the 1/60 lower bound. Keep the liveModels provenance, transport dirty/save and confirm-gated account-mode cases unchanged; execute only mocked requests. Record the named failing assertion and restored green result; do not commit mutations. Do not weaken assertions, replace source guards with export-existence checks, or retarget behavioral tests away from the compatibility boundary. No guard has been executed during this documentation task.

## Verification

Future executor commands only — not run by this delegated author. In a dedicated layer worktree at its tip, instantiate 002 Per-layer gate:

```sh
bun run typecheck
bun test gui/tests/provider-settings-request-pacing.test.tsx gui/tests/provider-settings-live-models-provenance.test.tsx gui/tests/provider-settings-cursor-transport.test.tsx gui/tests/provider-settings-account-mode.test.tsx
bun run privacy:scan
wc -l gui/src/components/provider-workspace/provider-settings-draft.ts gui/src/components/provider-workspace/ProviderSettingsFields.tsx gui/src/components/provider-workspace/ProviderSettings.tsx
rg -l 'from "[^"]*/ProviderSettings(\.tsx?)?"' src gui/src scripts tests gui/tests
# GUI TypeScript/bundler proof and scoped lint, required by gui/AGENTS.md:
(cd gui && bun run build && bun run lint)
# Whole repository suite only on the approved remote host:
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-components-provider-workspace-ProviderSettings && git checkout -q FETCH_HEAD && git rev-parse HEAD && bun install --frozen-lockfile && bun run test'
# Full GUI PR-ready suite also remote, never substitute it for the root suite:
ssh lidge 'cd ~/ocx-ci/opencodex/gui && bun install --frozen-lockfile && bun test tests'
```

Focused domains: `gui/tests`; only the listed files run locally. The core-Lab boundary gate is N/A: no `src/server`, `src/router`, or `src/lib` source is touched; never edit its protected roots. Unchanged UI copy means no locale churn; if copy unexpectedly changes, stop the pure-move layer rather than manufacturing new translations.

Compare the importer list with the 5-file baseline above (count files, not lines; compare existing callers, excluding newly added internal leaves). Compare exported name/kind/signature inventory and explicit local bindings, inspect `git diff --numstat origin/dev...HEAD -- gui/src` against the 500 added+deleted source-line cap, and perform the changed-graph cycle check described above. The remote checkout SHA must equal this PR head; serialize the shared lidge checkout or arrange parent-owned isolation before running it. Do not accept a later remote GUI run on another layer's SHA. Require actual exit statuses and full-suite totals: the command deliberately avoids 002's unguarded `| tail -15`, which could hide failure. Record exact-head CI for the layer and do not merge.

Docs-only verification for this author: inspect only these five requested output documents for nine exact ordered headings, complete declaration coverage, ≤400 projected leaf/residual budgets, correct branch/base/stack map, and whitespace with `git diff --no-index --check /dev/null <doc>`. No runtime, build, privacy or test-pass result is claimed here.

## Accept criteria

1. Every top-level declaration in the origin/dev inventory has one canonical owner; moved blocks match original behavior and no unlisted source file is changed.
2. Existing default/named/type exports and signatures remain importable from `gui/src/components/provider-workspace/ProviderSettings.tsx`; all 5 existing importer files retain their paths. Re-exported symbols used locally have explicit imports.
3. Exactly 2 new leaves appear at the paths above, each ≤400 physical lines; residual ≤400 (budget 392); actual formatted counts and source diff size are recorded. Exceeding the 500-line source diff or residual budget escalates before publication.
4. State lifetime/ownership and side-effect timing match Module-level state and cycles; changed graph has no new value or type cycle and no upward leaf → original path.
5. Every listed behavioral/text oracle keeps its specified target/disposition; the named guard mutation produces the expected failure and restoration yields green focused tests.
6. Typecheck, focused checks, GUI build/lint, privacy scan, remote whole-suite and remote GUI PR-ready suite pass at the exact layer head, with exit codes and CI SHA evidence; no repository-wide local suite.
7. PR contains all repository template sections and the five-layer stack map; correct base/head, no merge, no release, no unrelated cleanup. If title/body says GUI, attach a real unchanged-UI screenshot as required by the repository gate; never fabricate an image link.

## PR

Title: `refactor(gui): extract provider draft helpers and stateless settings fields (split S20 L3/5)`

Head: `codex/split-components-provider-workspace-ProviderSettings`. Base: `dev`. Closes: none.

Fill `.github/PULL_REQUEST_TEMPLATE.md` Summary, Verification, Checklist; pure move only. Review only this layer's diff; publish later under parent authorization. Placeholder PR numbers below are intentional until PR creation, not fabricated existing PRs.

| Layer | PR | Head branch | Base | Review focus |
|---|---|---|---|---|
| 1 | #TBD-S20-L1 | `codex/split-pages-ClaudeDesktop` | `dev` | isolate Claude Desktop profile data and lane views |
| 2 | #TBD-S20-L2 | `codex/split-components-MemoryObservabilityCard` | `dev` | separate memory metrics and stat views from restart polling |
| 3 | #TBD-S20-L3 | `codex/split-components-provider-workspace-ProviderSettings` | `dev` | extract provider draft helpers and stateless settings fields ← this layer |
| 4 | #TBD-S20-L4 | `codex/split-pages-dashboard-shared` | `dev` | isolate dashboard sidecar option contracts and selection |
| 5 | #TBD-S20-L5 | `codex/split-components-QuotaBars` | `dev` | extract quota reset date and locale formatting |

DEV-STACK-03: each of the five layers carries its own gates and this complete map. S20 groups execution order and PR navigation only; all five layers are independent under STACK-INDEPENDENCE-01.

Base: dev — no dependency on the layers below; no cascade obligation.

Merge remains forbidden here (DEV-STACK-04).
