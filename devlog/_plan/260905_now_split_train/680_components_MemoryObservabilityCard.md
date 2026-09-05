# S20 L2/5 — MemoryObservabilityCard

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: pure-move. C3 architecture, docs-only delegated preparation; parent owns all orchestration/loop/goal state.
- Goal: split `gui/src/components/MemoryObservabilityCard.tsx` into 2 cohesive sibling leaves, each ≤400 lines, with a projected 356-line residual and every existing export still importable from the old path.
- Non-goals: no behavior, copy, CSS, locale, request payload, exported name/signature, effect lifetime, auth/consent, or dependency changes. No source edits, test runs, Git mutation, PR creation or orchestration in this planning task. Existing long functions are not silently rewritten to satisfy a second metric.
- Verifier: `002_layer_map.md` → **Per-layer gate**, instantiated in Verification below (the 000 reference to “003” is stale; 002 is authoritative).
- Stop: plan complete when inventory/partition/export/state/oracle/gate records are internally consistent. Implementation stops on any failed gate or non-pure-move delta; completion later requires exact-tip checks and exact-head green CI, never a cached green check.
- Escalation: Stop for any proposed restart-controller extraction, changed poll interval/cancellation semantics, duplicated formatter cache, or actual source diff over 500 lines; report to parent instead of extending L2.

Source basis: `origin/dev = 1362b1a3841b4de20177e5d65865a513dd7936c4`; docs HEAD `4cc219549eafbf9cd2efd651482fbfefd88944d5`. Read with `git show origin/dev:gui/src/components/MemoryObservabilityCard.tsx`; the working-tree copy was byte-compared and identical. All source ranges below are inclusive at this origin/dev revision. Read 000_plan.md, 001_stale_check.md, S20 rows / Per-layer gate in 002_layer_map.md, and the matching section in `../260905_modular_debt_ledger/015_lane_gui.md`.

Structural decision (ARCH-DECISION-01 / ARCH-MAP-01): Context: the 527-line card combines reusable scalar rendering with an effectful restart controller. Rejected delete/configure/no-op: does not address size. Rejected hook extraction: would disturb cancellation and drain/PID lifetime unnecessarily. Reuse formatUptime and existing bounded-fetch/visibility-poll owners. Chosen move is metrics/cache ownership plus stat views. Card's dashboard-overview-panels.tsx caller and public test import remain unchanged; blast radius is one component feature.

## Symbol inventory

Inventory uses installed ast-grep: `sg run --kind <function_declaration|interface_declaration|type_alias_declaration|lexical_declaration|variable_declaration|import_statement> --json=compact gui/src/components/MemoryObservabilityCard.tsx`, filtered to top-level declarations and checked against `git show origin/dev:gui/src/components/MemoryObservabilityCard.tsx | nl -ba`. Imports are included for completeness but are not newly owned declarations.

Consumer count = distinct external source/test files importing that binding from the original module, not identifier occurrences or documentation mentions. Command candidate set: `rg -l 'MemoryObservabilityCard' src gui/src scripts tests gui/tests`; inspect matched import clauses for each symbol and deduplicate files. Private declarations/import bindings have zero external consumers by definition; local uses are preserved through the explicit imports below. Module fan-in is **2 files** (including type/test imports); added leaf imports do not replace existing consumer imports.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `import { useEffect, useState } from "react";` | import declaration | 1–1 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { formatUptime } from "../formatUptime";` | import declaration | 2–2 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { IconActivity } from "../icons";` | import declaration | 3–3 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { useI18n, type Locale, type TFn } from "../i18n/shared";` | import declaration | 4–4 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { createBoundedFetch, type BoundedFetch } from "../bounded-fetch";` | import declaration | 5–5 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { startVisibilityPoll } from "../visibility-poll";` | import declaration | 6–6 | no | 0 external | allocation in Leaf partition / residual imports |
| `MemorySample` | interface declaration | 15–24 | no | 0 | `gui/src/components/memory-observability-metrics.ts` |
| `MemoryMetric` | type alias declaration | 26–26 | no | 0 | `gui/src/components/memory-observability-metrics.ts` |
| `ResponseState` | interface declaration | 28–40 | no | 0 | `gui/src/components/memory-observability-metrics.ts` |
| `SystemMemory` | interface declaration | 42–58 | no | 0 | `gui/src/components/memory-observability-metrics.ts` |
| `RestartPhase` | type alias declaration | 60–60 | no | 0 | `gui/src/components/MemoryObservabilityCard.tsx` |
| `byteNumberFormats` | lexical declaration | 69–69 | no | 0 | `gui/src/components/memory-observability-metrics.ts` |
| `byteNumberFormat` | function declaration | 70–81 | no | 0 | `gui/src/components/memory-observability-metrics.ts` |
| `plainNumberFormats` | lexical declaration | 82–82 | no | 0 | `gui/src/components/memory-observability-metrics.ts` |
| `plainNumberFormat` | function declaration | 83–90 | no | 0 | `gui/src/components/memory-observability-metrics.ts` |
| `formatBytes` | function declaration | 92–99 | no | 0 | `gui/src/components/memory-observability-metrics.ts` |
| `formatAge` | function declaration | 102–105 | no | 0 | `gui/src/components/memory-observability-metrics.ts` |
| `observedMemory` | function declaration | 107–110 | no | 0 | `gui/src/components/memory-observability-metrics.ts` |
| `observedMetric` | function declaration | 112–121 | no | 0 | `gui/src/components/memory-observability-metrics.ts` |
| `observedGrowthPerHour` | function declaration | 124–131 | no | 0 | `gui/src/components/memory-observability-metrics.ts` |
| `Stat` | function declaration | 134–142 | no | 0 | `gui/src/components/memory-observability-stats.tsx` |
| `MemoryPressure` | function declaration | 149–198 | no | 0 | `gui/src/components/memory-observability-stats.tsx` |
| `DRAIN_TIMEOUT_S` | lexical declaration | 200–200 | no | 0 | `gui/src/components/MemoryObservabilityCard.tsx` |
| `RECONNECT_POLL_MS` | lexical declaration | 201–201 | no | 0 | `gui/src/components/MemoryObservabilityCard.tsx` |
| `RECONNECT_GIVE_UP_MS` | lexical declaration | 202–202 | no | 0 | `gui/src/components/MemoryObservabilityCard.tsx` |
| `MemoryObservabilityCard` | function declaration | 204–527 | default | 2 | `gui/src/components/MemoryObservabilityCard.tsx` |

Current direct importer files (same import paths after the move):

- `gui/src/pages/dashboard-overview-panels.tsx`
- `gui/tests/memory-observability-card.test.tsx`

## Leaf partition

Reuse decision: no parallel infrastructure, utility barrel, controller or cache is introduced. The source-owned definitions above move rather than being copied; existing helpers named in Loop spec remain canonical. Sibling convention is feature-qualified lowercase helper filenames and PascalCase component files (e.g. `gui/src/pages/claude-desktop-lane.ts`, `gui/src/pages/dashboard-core-poll.ts`, `gui/src/components/provider-workspace/ProviderRail.tsx`). No `index.ts`, `utils.ts` or `common.ts` is created.

### gui/src/components/memory-observability-metrics.ts

- Symbols: MemorySample MemoryMetric ResponseState SystemMemory byteNumberFormats byteNumberFormat plainNumberFormats plainNumberFormat formatBytes formatAge observedMemory observedMetric observedGrowthPerHour.
- Expected physical lines: 120 (including imports and new prop signatures; maximum 400).
- Move lines 15–58 and 62–131 (114 physical lines). The two formatter Maps and their accessors move together. Export SystemMemory/MemoryMetric and consumed format/measurement functions; MemorySample/ResponseState and byteNumberFormat remain private unless a production import requires them. Keep Intl key semantics, binary units and the observed-memory precedence byte-for-byte.
- Own imports:

```ts
import type { Locale } from "../i18n/shared";
import { formatUptime } from "../formatUptime";
```

### gui/src/components/memory-observability-stats.tsx

- Symbols: Stat MemoryPressure.
- Expected physical lines: 70 (including imports and new prop signatures; maximum 400).
- Move lines 133–198 (66 physical lines) unchanged apart from export keywords/imports. Keep inline prop signatures, warn threshold, CSS custom property, and locale/translator passed by the card.
- Own imports:

```ts
import type { Locale, TFn } from "../i18n/shared";
import { formatBytes } from "./memory-observability-metrics";
import type { MemoryMetric } from "./memory-observability-metrics";
```

Residual `gui/src/components/MemoryObservabilityCard.tsx`: **356 expected lines**. 527 − 114 (DTO/metrics blocks) − 66 (stat views) + 9 (import/separator budget) = 356 residual lines. Leaves 120 + 70 = 190; aggregate 546 = 527 + 19 net overhead. No #b required. These are explicit physical-line budgets, not measured implementation output: reject a formatted result above the budget/400 rather than minifying it. The exact moved source blocks are disjoint; every original declaration has exactly one target in the inventory. Preserve associated comments, including i18n/lint exceptions.

## Re-export block

The sole public export is default MemoryObservabilityCard (204–527), retained in place. Exact new re-export block: empty. The moved metrics were private and must not be added to the original public surface.

Explicit local bindings needed in the residual (a re-export binds nothing):

```ts
import { plainNumberFormat, formatBytes, formatAge, observedMemory, observedMetric, observedGrowthPerHour } from "./memory-observability-metrics";
import type { SystemMemory } from "./memory-observability-metrics";
import { Stat, MemoryPressure } from "./memory-observability-stats";
```

Retain original external imports still used by residual declarations; remove only moved-only bindings after reference checks. The listed leaf imports use verified existing modules or the exact new owners defined in this plan. Internal leaves import each other directly, never through the preserved original-path compatibility boundary. No wildcard re-export.

## Module-level state and cycles

byteNumberFormats (69) and plainNumberFormats (82) each have one owner: memory-observability-metrics.ts. Never duplicate them in stats or the residual. DRAIN_TIMEOUT_S (200), RECONNECT_POLL_MS (201), RECONNECT_GIVE_UP_MS (202) remain immutable constants in the card. RestartPhase (60) stays there too. cancelled/inFlight/active at 230–232 and 293–295, started at 296, and the timers are effect-local, not globals; do not move any. Card → stats → metrics; card → metrics; metrics → formatUptime/i18n types. No upward import. Existing locale caches are encapsulated common state with one unchanged owner; all new intermodule calls are functional.

Cycle proof for the implementation gate: resolve static import/export edges, including type-only edges, from this original and its new leaves; fail if any leaf reaches the original (directly or transitively), or the changed induced graph has an SCC. Run the lane-015 read-only sg/import-resolution + Tarjan method; preserve the allow-edge and forbidden-back-edge evidence. No new graph tool/dependency installation is authorized. The plan records an acyclic intended edge map, not a claim that future source has been scanned.

## Tests

Direct importing tests — `rg -l` candidate list narrowed to actual imports of this module; **1 files**, all **unchanged**:

- `gui/tests/memory-observability-card.test.tsx` — unchanged original-path import.

Text-oracle disposition: No test reads MemoryObservabilityCard.tsx as source: literal basename and extensionless path searches return only the behavioral importer. No retarget-to-leaf or add-leaf-to-scan-list action. `gui/tests/memory-observability-card.test.tsx:6` remains an unchanged public-path import, not a text oracle.

Guards to drive red once during implementation C verification: No retargeted text guard exists. Drive gui/tests/memory-observability-card.test.tsx:111 red once by perturbing the binary unit selection in the metrics leaf, then restore. Preserve existing unmount (128), unavailable (140), confirm/restart (155), reconnect-management-health (189) and old-payload (230) assertions. Do not trigger a real server restart. Record the named failing assertion and restored green result; do not commit mutations. Do not weaken assertions, replace source guards with export-existence checks, or retarget behavioral tests away from the compatibility boundary. No guard has been executed during this documentation task.

## Verification

Future executor commands only — not run by this delegated author. In a dedicated layer worktree at its tip, instantiate 002 Per-layer gate:

```sh
bun run typecheck
bun test gui/tests/memory-observability-card.test.tsx
bun run privacy:scan
wc -l gui/src/components/memory-observability-metrics.ts gui/src/components/memory-observability-stats.tsx gui/src/components/MemoryObservabilityCard.tsx
rg -l 'from "[^"]*/MemoryObservabilityCard(\.tsx?)?"' src gui/src scripts tests gui/tests
# GUI TypeScript/bundler proof and scoped lint, required by gui/AGENTS.md:
(cd gui && bun run build && bun run lint)
# Whole repository suite only on the approved remote host:
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-components-MemoryObservabilityCard && git checkout -q FETCH_HEAD && git rev-parse HEAD && bun install --frozen-lockfile && bun run test'
# Full GUI PR-ready suite also remote, never substitute it for the root suite:
ssh lidge 'cd ~/ocx-ci/opencodex/gui && bun install --frozen-lockfile && bun test tests'
```

Focused domains: `gui/tests`; only the listed files run locally. The core-Lab boundary gate is N/A: no `src/server`, `src/router`, or `src/lib` source is touched; never edit its protected roots. Unchanged UI copy means no locale churn; if copy unexpectedly changes, stop the pure-move layer rather than manufacturing new translations.

Compare the importer list with the 2-file baseline above (count files, not lines; compare existing callers, excluding newly added internal leaves). Compare exported name/kind/signature inventory and explicit local bindings, inspect `git diff --numstat origin/dev...HEAD -- gui/src` against the 500 added+deleted source-line cap, and perform the changed-graph cycle check described above. The remote checkout SHA must equal this PR head; serialize the shared lidge checkout or arrange parent-owned isolation before running it. Do not accept a later remote GUI run on another layer's SHA. Require actual exit statuses and full-suite totals: the command deliberately avoids 002's unguarded `| tail -15`, which could hide failure. Record exact-head CI for the layer and do not merge.

Docs-only verification for this author: inspect only these five requested output documents for nine exact ordered headings, complete declaration coverage, ≤400 projected leaf/residual budgets, correct branch/base/stack map, and whitespace with `git diff --no-index --check /dev/null <doc>`. No runtime, build, privacy or test-pass result is claimed here.

## Accept criteria

1. Every top-level declaration in the origin/dev inventory has one canonical owner; moved blocks match original behavior and no unlisted source file is changed.
2. Existing default/named/type exports and signatures remain importable from `gui/src/components/MemoryObservabilityCard.tsx`; all 2 existing importer files retain their paths. Re-exported symbols used locally have explicit imports.
3. Exactly 2 new leaves appear at the paths above, each ≤400 physical lines; residual ≤400 (budget 356); actual formatted counts and source diff size are recorded. Exceeding the 500-line source diff or residual budget escalates before publication.
4. State lifetime/ownership and side-effect timing match Module-level state and cycles; changed graph has no new value or type cycle and no upward leaf → original path.
5. Every listed behavioral/text oracle keeps its specified target/disposition; the named guard mutation produces the expected failure and restoration yields green focused tests.
6. Typecheck, focused checks, GUI build/lint, privacy scan, remote whole-suite and remote GUI PR-ready suite pass at the exact layer head, with exit codes and CI SHA evidence; no repository-wide local suite.
7. PR contains all repository template sections and the five-layer stack map; correct base/head, no merge, no release, no unrelated cleanup. If title/body says GUI, attach a real unchanged-UI screenshot as required by the repository gate; never fabricate an image link.

## PR

Title: `refactor(gui): separate memory metrics and stat views from restart polling (split S20 L2/5)`

Head: `codex/split-components-MemoryObservabilityCard`. Base: `dev`. Closes: none.

Fill `.github/PULL_REQUEST_TEMPLATE.md` Summary, Verification, Checklist; pure move only. Review only this layer's diff; publish later under parent authorization. Placeholder PR numbers below are intentional until PR creation, not fabricated existing PRs.

| Layer | PR | Head branch | Base | Review focus |
|---|---|---|---|---|
| 1 | #TBD-S20-L1 | `codex/split-pages-ClaudeDesktop` | `dev` | isolate Claude Desktop profile data and lane views |
| 2 | #TBD-S20-L2 | `codex/split-components-MemoryObservabilityCard` | `dev` | separate memory metrics and stat views from restart polling ← this layer |
| 3 | #TBD-S20-L3 | `codex/split-components-provider-workspace-ProviderSettings` | `dev` | extract provider draft helpers and stateless settings fields |
| 4 | #TBD-S20-L4 | `codex/split-pages-dashboard-shared` | `dev` | isolate dashboard sidecar option contracts and selection |
| 5 | #TBD-S20-L5 | `codex/split-components-QuotaBars` | `dev` | extract quota reset date and locale formatting |

DEV-STACK-03: each of the five layers carries its own gates and this complete map. S20 groups execution order and PR navigation only; all five layers are independent under STACK-INDEPENDENCE-01.

Base: dev — no dependency on the layers below; no cascade obligation.

Merge remains forbidden here (DEV-STACK-04).
