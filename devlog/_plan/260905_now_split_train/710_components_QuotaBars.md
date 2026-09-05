# S20 L5/5 — QuotaBars

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: pure-move. C3 architecture, docs-only delegated preparation; parent owns all orchestration/loop/goal state.
- Goal: split `gui/src/components/QuotaBars.tsx` into 1 cohesive sibling leaves, each ≤400 lines, with a projected 366-line residual and every existing export still importable from the old path.
- Non-goals: no behavior, copy, CSS, locale, request payload, exported name/signature, effect lifetime, auth/consent, or dependency changes. No source edits, test runs, Git mutation, PR creation or orchestration in this planning task. Existing long functions are not silently rewritten to satisfy a second metric.
- Verifier: `002_layer_map.md` → **Per-layer gate**, instantiated in Verification below (the 000 reference to “003” is stale; 002 is authoritative).
- Stop: plan complete when inventory/partition/export/state/oracle/gate records are internally consistent. Implementation stops on any failed gate or non-pure-move delta; completion later requires exact-tip checks and exact-head green CI, never a cached green check.
- Escalation: Stop if reset formatting behavior changes, the leaf imports the original, existing public row/tone/age exports move or disappear unintentionally, or actual source diff exceeds 500. No quota polling/provider-probe/backend changes.

Source basis: `origin/dev = 1362b1a3841b4de20177e5d65865a513dd7936c4`; docs HEAD `4cc219549eafbf9cd2efd651482fbfefd88944d5`. Read with `git show origin/dev:gui/src/components/QuotaBars.tsx`; the working-tree copy was byte-compared and identical. All source ranges below are inclusive at this origin/dev revision. Read 000_plan.md, 001_stale_check.md, S20 rows / Per-layer gate in 002_layer_map.md, and the matching section in `../260905_modular_debt_ledger/015_lane_gui.md`.

Structural decision (ARCH-DECISION-01 / ARCH-MAP-01): Context: the 452-line quota component also owns a cohesive 90-line reset-date subsystem. Rejected extracting all row construction/rendering: more churn than needed for the 400-line target. Rejected reusing generic uptime formatting: different date and locale semantics. Keep normalizeQuotaForPlan in its existing codex-quota-utils owner. Chosen move: one quota-reset.ts sibling, consistent with existing codex-account-pool-* helper naming; preserve the component and all other helper declarations. Six production component callers plus three test importer files remain on the original boundary.

## Symbol inventory

Inventory uses installed ast-grep: `sg run --kind <function_declaration|interface_declaration|type_alias_declaration|lexical_declaration|variable_declaration|import_statement> --json=compact gui/src/components/QuotaBars.tsx`, filtered to top-level declarations and checked against `git show origin/dev:gui/src/components/QuotaBars.tsx | nl -ba`. Imports are included for completeness but are not newly owned declarations.

Consumer count = distinct external source/test files importing that binding from the original module, not identifier occurrences or documentation mentions. Command candidate set: `rg -l 'QuotaBars' src gui/src scripts tests gui/tests`; inspect matched import clauses for each symbol and deduplicate files. Private declarations/import bindings have zero external consumers by definition; local uses are preserved through the explicit imports below. Module fan-in is **9 files** (including type/test imports); added leaf imports do not replace existing consumer imports.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `import type { CSSProperties } from "react";` | import declaration | 1–1 | no | 0 external | allocation in Leaf partition / residual imports |
| `import type { Locale, TFn } from "../i18n/shared";` | import declaration | 2–2 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { useI18n } from "../i18n/shared";` | import declaration | 3–3 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { IconAlert } from "../icons";` | import declaration | 4–4 | no | 0 external | allocation in Leaf partition / residual imports |
| `import { type AccountQuota, normalizeQuotaForPlan } from "../codex-quota-utils";` | import declaration | 5–5 | no | 0 external | allocation in Leaf partition / residual imports |
| `QuotaWindowKey` | type alias declaration | 10–10 | yes | 1 | `gui/src/components/QuotaBars.tsx` |
| `QuotaBarRow` | type alias declaration | 11–18 | yes | 0 | `gui/src/components/QuotaBars.tsx` |
| `rawCustomWindowRank` | function declaration | 25–30 | no | 0 | `gui/src/components/QuotaBars.tsx` |
| `localizeCustomQuotaLabel` | function declaration | 32–43 | no | 0 | `gui/src/components/QuotaBars.tsx` |
| `buildQuotaRows` | function declaration | 45–100 | yes | 1 | `gui/src/components/QuotaBars.tsx` |
| `maxQuotaUtilisation` | function declaration | 103–111 | yes | 2 | `gui/src/components/QuotaBars.tsx` |
| `bcp47` | function declaration | 113–138 | no | 0 | `gui/src/components/quota-reset.ts` |
| `isQuotaExhausted` | function declaration | 141–143 | yes | 1 | `gui/src/components/QuotaBars.tsx` |
| `isQuotaWarn` | function declaration | 145–147 | yes | 1 | `gui/src/components/QuotaBars.tsx` |
| `quotaBarTone` | function declaration | 149–151 | yes | 1 | `gui/src/components/QuotaBars.tsx` |
| `barWidth` | function declaration | 154–158 | yes | 1 | `gui/src/components/QuotaBars.tsx` |
| `barFillStyle` | function declaration | 160–162 | no | 0 | `gui/src/components/QuotaBars.tsx` |
| `formatObservedAge` | function declaration | 172–179 | yes | 1 | `gui/src/components/QuotaBars.tsx` |
| `QuotaBars` | function declaration | 181–304 | default | 7 | `gui/src/components/QuotaBars.tsx` |
| `QuotaRow` | function declaration | 306–340 | no | 0 | `gui/src/components/QuotaBars.tsx` |
| `StackedQuotaRow` | function declaration | 342–387 | no | 0 | `gui/src/components/QuotaBars.tsx` |
| `resetDate` | function declaration | 390–396 | no | 0 | `gui/src/components/quota-reset.ts` |
| `formatResetAt` | function declaration | 398–411 | no | 0 | `gui/src/components/quota-reset.ts` |
| `formatResetFuture` | function declaration | 414–452 | yes | 2 | `gui/src/components/quota-reset.ts` |

Current direct importer files (same import paths after the move):

- `tests/gui/quota-bars-rows.test.ts`
- `gui/tests/fr-localization.test.ts`
- `gui/tests/quota-observed-age.test.tsx`
- `gui/src/components/codex-account-pool-cards.tsx`
- `gui/src/components/provider-workspace/ProviderAuthPanel.tsx`
- `gui/src/components/provider-workspace/ProviderUsage.tsx`
- `gui/src/components/provider-workspace/ProviderCapacityQuota.tsx`
- `gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx`
- `gui/src/components/codex-account-pool-main-card.tsx`

## Leaf partition

Reuse decision: no parallel infrastructure, utility barrel, controller or cache is introduced. The source-owned definitions above move rather than being copied; existing helpers named in Loop spec remain canonical. Sibling convention is feature-qualified lowercase helper filenames and PascalCase component files (e.g. `gui/src/pages/claude-desktop-lane.ts`, `gui/src/pages/dashboard-core-poll.ts`, `gui/src/components/provider-workspace/ProviderRail.tsx`). No `index.ts`, `utils.ts` or `common.ts` is created.

### gui/src/components/quota-reset.ts

- Symbols: bcp47 resetDate formatResetAt formatResetFuture.
- Expected physical lines: 96 (including imports and new prop signatures; maximum 400).
- Move lines 113–138 and 389–452: 26 + 64 = 90 physical lines. bcp47 and resetDate remain private. Export formatResetAt for the residual row and retain formatResetFuture's existing signature/defaults as an explicit re-export. Keep Date creation inside calls and preserve second/millisecond normalization, locale mapping, DST/calendar-day logic and relative/future formatting.
- Own imports:

```ts
import type { Locale, TFn } from "../i18n/shared";
```

Residual `gui/src/components/QuotaBars.tsx`: **366 expected lines**. 452 − 90 (locale/reset blocks) + 4 (import/re-export/spacing budget) = 366 residual lines. Leaf 96; aggregate 462 = 452 + 10 net overhead. No #b required. These are explicit physical-line budgets, not measured implementation output: reject a formatted result above the budget/400 rather than minifying it. The exact moved source blocks are disjoint; every original declaration has exactly one target in the inventory. Preserve associated comments, including i18n/lint exceptions.

## Re-export block

```ts
export { formatResetFuture } from "./quota-reset";
```

All other current exported declarations remain in the residual unchanged.

Explicit local bindings needed in the residual (a re-export binds nothing):

```ts
import { formatResetAt, formatResetFuture } from "./quota-reset";
```

Retain original external imports still used by residual declarations; remove only moved-only bindings after reference checks. The listed leaf imports use verified existing modules or the exact new owners defined in this plan. Internal leaves import each other directly, never through the preserved original-path compatibility boundary. No wildcard re-export.

## Module-level state and cycles

No top-level mutable Map/Set/WeakMap/let/lock/timer. bcp47 is a pure mapping; Date/Intl.DateTimeFormat instances are call-local at original 393/402/404/422–439 and remain call-local. Residual → quota-reset → i18n types; never import QuotaBars (including its QuotaBarRow type) from quota-reset. The reset leaf does not need row types. Existing normalizeQuotaForPlan stays in the residual. Functional coupling only, no new side effects.

Cycle proof for the implementation gate: resolve static import/export edges, including type-only edges, from this original and its new leaves; fail if any leaf reaches the original (directly or transitively), or the changed induced graph has an SCC. Run the lane-015 read-only sg/import-resolution + Tarjan method; preserve the allow-edge and forbidden-back-edge evidence. No new graph tool/dependency installation is authorized. The plan records an acyclic intended edge map, not a claim that future source has been scanned.

## Tests

Direct importing tests — `rg -l` candidate list narrowed to actual imports of this module; **3 files**, all **unchanged**:

- `tests/gui/quota-bars-rows.test.ts` — unchanged original-path import.
- `gui/tests/fr-localization.test.ts` — unchanged original-path import.
- `gui/tests/quota-observed-age.test.tsx` — unchanged original-path import.

Text-oracle disposition: No source-text reader targets QuotaBars.tsx. The three direct importing tests remain unchanged; fr-localization.test.ts reads locale catalogs, not the component. No retarget-to-leaf or add-leaf-to-scan-list action is needed.

Guards to drive red once during implementation C verification: No retargeted text guard. Temporarily alter resetDate's seconds-to-milliseconds multiplier in quota-reset.ts to drive the reset-format assertions in quota-bars-rows.test.ts red; restore. The observed-age and rendering tests must continue to import QuotaBars from its old path. Record the named failing assertion and restored green result; do not commit mutations. Do not weaken assertions, replace source guards with export-existence checks, or retarget behavioral tests away from the compatibility boundary. No guard has been executed during this documentation task.

## Verification

Future executor commands only — not run by this delegated author. In a dedicated layer worktree at its tip, instantiate 002 Per-layer gate:

```sh
bun run typecheck
bun test tests/gui/quota-bars-rows.test.ts gui/tests/quota-observed-age.test.tsx gui/tests/fr-localization.test.ts
bun run privacy:scan
wc -l gui/src/components/quota-reset.ts gui/src/components/QuotaBars.tsx
rg -l 'from "[^"]*/QuotaBars(\.tsx?)?"' src gui/src scripts tests gui/tests
# GUI TypeScript/bundler proof and scoped lint, required by gui/AGENTS.md:
(cd gui && bun run build && bun run lint)
# Whole repository suite only on the approved remote host:
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-components-QuotaBars && git checkout -q FETCH_HEAD && git rev-parse HEAD && bun install --frozen-lockfile && bun run test'
# Full GUI PR-ready suite also remote, never substitute it for the root suite:
ssh lidge 'cd ~/ocx-ci/opencodex/gui && bun install --frozen-lockfile && bun test tests'
```

Focused domains: `tests/gui` and `gui/tests`; only the listed files run locally. The core-Lab boundary gate is N/A: no `src/server`, `src/router`, or `src/lib` source is touched; never edit its protected roots. Unchanged UI copy means no locale churn; if copy unexpectedly changes, stop the pure-move layer rather than manufacturing new translations.

Compare the importer list with the 9-file baseline above (count files, not lines; compare existing callers, excluding newly added internal leaves). Compare exported name/kind/signature inventory and explicit local bindings, inspect `git diff --numstat origin/dev...HEAD -- gui/src` against the 500 added+deleted source-line cap, and perform the changed-graph cycle check described above. The remote checkout SHA must equal this PR head; serialize the shared lidge checkout or arrange parent-owned isolation before running it. Do not accept a later remote GUI run on another layer's SHA. Require actual exit statuses and full-suite totals: the command deliberately avoids 002's unguarded `| tail -15`, which could hide failure. Record exact-head CI for the layer and do not merge.

Docs-only verification for this author: inspect only these five requested output documents for nine exact ordered headings, complete declaration coverage, ≤400 projected leaf/residual budgets, correct branch/base/stack map, and whitespace with `git diff --no-index --check /dev/null <doc>`. No runtime, build, privacy or test-pass result is claimed here.

## Accept criteria

1. Every top-level declaration in the origin/dev inventory has one canonical owner; moved blocks match original behavior and no unlisted source file is changed.
2. Existing default/named/type exports and signatures remain importable from `gui/src/components/QuotaBars.tsx`; all 9 existing importer files retain their paths. Re-exported symbols used locally have explicit imports.
3. Exactly 1 new leaves appear at the paths above, each ≤400 physical lines; residual ≤400 (budget 366); actual formatted counts and source diff size are recorded. Exceeding the 500-line source diff or residual budget escalates before publication.
4. State lifetime/ownership and side-effect timing match Module-level state and cycles; changed graph has no new value or type cycle and no upward leaf → original path.
5. Every listed behavioral/text oracle keeps its specified target/disposition; the named guard mutation produces the expected failure and restoration yields green focused tests.
6. Typecheck, focused checks, GUI build/lint, privacy scan, remote whole-suite and remote GUI PR-ready suite pass at the exact layer head, with exit codes and CI SHA evidence; no repository-wide local suite.
7. PR contains all repository template sections and the five-layer stack map; correct base/head, no merge, no release, no unrelated cleanup. If title/body says GUI, attach a real unchanged-UI screenshot as required by the repository gate; never fabricate an image link.

## PR

Title: `refactor(gui): extract quota reset date and locale formatting (split S20 L5/5)`

Head: `codex/split-components-QuotaBars`. Base: `dev`. Closes: none.

Fill `.github/PULL_REQUEST_TEMPLATE.md` Summary, Verification, Checklist; pure move only. Review only this layer's diff; publish later under parent authorization. Placeholder PR numbers below are intentional until PR creation, not fabricated existing PRs.

| Layer | PR | Head branch | Base | Review focus |
|---|---|---|---|---|
| 1 | #TBD-S20-L1 | `codex/split-pages-ClaudeDesktop` | `dev` | isolate Claude Desktop profile data and lane views |
| 2 | #TBD-S20-L2 | `codex/split-components-MemoryObservabilityCard` | `dev` | separate memory metrics and stat views from restart polling |
| 3 | #TBD-S20-L3 | `codex/split-components-provider-workspace-ProviderSettings` | `dev` | extract provider draft helpers and stateless settings fields |
| 4 | #TBD-S20-L4 | `codex/split-pages-dashboard-shared` | `dev` | isolate dashboard sidecar option contracts and selection |
| 5 | #TBD-S20-L5 | `codex/split-components-QuotaBars` | `dev` | extract quota reset date and locale formatting ← this layer |

DEV-STACK-03: each of the five layers carries its own gates and this complete map. S20 groups execution order and PR navigation only; all five layers are independent under STACK-INDEPENDENCE-01.

Base: dev — no dependency on the layers below; no cascade obligation.

Merge remains forbidden here (DEV-STACK-04).
