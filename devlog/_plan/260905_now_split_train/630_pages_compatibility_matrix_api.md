# S19 L1 — Compatibility API pagination and contract owner

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: **pure-move**, C3, docs-only delegated plan. No code, tests, Git mutation, or parent orchestration executed in this task.
- Goal: reduce `gui/src/pages/compatibility-matrix-api.ts` (432 physical lines) below 400 by extracting its pagination foundation while preserving every original export and request/cancellation contract.
- Non-goals: changing parser strictness, page limits, endpoints, error identity, detail concurrency, community trust policy, UI state, or fixing unrelated defects.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated in Verification below; this is a future implementation gate, not evidence that tests have run.
- Stop: this layer has a reviewed pure-move diff, size/export/cycle proof, passing focused checks and exact-head remote full-suite/CI evidence; no merge. Parent owns execution and loop state.
- Escalation: upstream source drift, any behavior or signature change, an unlisted source reader, a new cycle, >400-line output, or >500 raw changed source lines requires parent review before expanding the partition.
- Basis: docs HEAD `4cc219549`; code `origin/dev = 1362b1a3841b4de20177e5d65865a513dd7936c4`. All source ranges below refer to that code revision. All four S19 sources were byte-compared with `git show origin/dev:<path>` and match the working tree. Read `000_plan.md`, `001_stale_check.md`, S19 rows and gate in `002_layer_map.md`, and the four relevant file sections of `260905_modular_debt_ledger/015_lane_gui.md`.

## Symbol inventory

Ranges were obtained from `sg run --kind <function_declaration|lexical_declaration|type_alias_declaration|interface_declaration|class_declaration> --json=compact <file>`, selecting the top-level declaration lines matched by `rg`. Imports are dependency edges, not declaration rows. Every non-import top-level declaration is listed.

Consumers means distinct external importing files, not raw identifier hits: `rg -l 'from ["\x27][^"\x27]*/compatibility-matrix-api(\.tsx?)?["\x27]' src gui/src gui/tests tests scripts`, then `rg -l -w '<symbol>' <those files>`. Non-exported symbols have zero external consumers; they still move with their internal callers. Four importing files: the page plus the three tests listed below. Target P = `gui/src/pages/compatibility-matrix-pagination.ts`; R = residual original path.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| PAGE_LIMIT | const | 25–25 | no | 0 | P |
| MAX_PAGES | const | 26–26 | no | 0 | P |
| DETAIL_CONCURRENCY | const | 27–27 | no | 0 | R |
| MAX_DETAIL_REFERENCES | const | 28–28 | no | 0 | R |
| fetchLabJson | async function | 30–33 | no | 0 | P |
| buildQuery | function | 35–40 | no | 0 | P |
| LabDataContractError | class | 42–42 | yes | 1 | P |
| invalidResponse | function | 44–46 | no | 0 | P |
| assertPaginationContract | function | 48–52 | no | 0 | P |
| parseStrictVerdictPage | function | 54–60 | no | 0 | P |
| parseStrictSubjectPage | function | 62–68 | no | 0 | P |
| parseStrictObservationPage | function | 70–76 | no | 0 | P |
| fetchLabStatus | async function | 78–83 | yes | 1 | R |
| fetchVerdictPage | async function | 85–102 | yes | 0 | P |
| fetchSubjectPage | async function | 104–111 | yes | 0 | P |
| CollectedPages | type | 113–116 | no | 0 | P |
| collectPages | async function | 118–136 | no | 0 | P |
| fetchAllSubjects | async function | 138–143 | yes | 2 | P |
| fetchSubjectDetail | async function | 145–154 | yes | 0 | R |
| fetchObservationsPage | async function | 156–172 | yes | 0 | P |
| fetchAllObservations | async function | 174–183 | no | 0 | P |
| fetchEventById | async function | 185–190 | yes | 0 | R |
| fetchArtifactByDigest | async function | 192–201 | yes | 0 | R |
| PassiveProductionSummaryDto | type | 203–213 | yes | 0 | R |
| parsePassiveProductionSummary | function | 215–229 | no | 0 | R |
| fetchPassiveProductionSummary | async function | 231–242 | yes | 0 | R |
| CommunityEvidenceSummaryRowDto | type | 244–251 | yes | 0 | R |
| CommunityEvidenceContextDto | type | 253–257 | yes | 2 | R |
| hasOnlyKeys | function | 259–262 | no | 0 | R |
| isSha256Hex | function | 264–266 | no | 0 | R |
| isNonNegativeInteger | function | 268–270 | no | 0 | R |
| parseCommunityEvidenceContext | function | 272–306 | yes | 1 | R |
| fetchCommunityEvidenceContext | async function | 308–316 | yes | 0 | R |
| LabPageData | type | 318–326 | yes | 1 | R |
| fetchLabPageData | async function | 328–356 | yes | 2 | R |
| fetchMoreVerdicts | async function | 358–365 | yes | 1 | R |
| VerdictDetailData | type | 367–374 | yes | 1 | R |
| mapSettledBounded | async function | 376–400 | no | 0 | R |
| fetchVerdictDetail | async function | 402–432 | yes | 3 | R |

## Leaf partition

Structural decision: extract the foundation, not a wrapper around the existing facade. The source pressure is 432 lines spanning paginated reads and detail/community assembly. Keeping `collectPages` separate while importing `LabDataContractError` back from the facade would create a cycle. Instead move the error constructor, low-level fetch/query helpers and strict pagination parsers together. Preserve the existing application boundary rather than introducing a new generic HTTP client.

Current direction: `CompatibilityMatrix.tsx:8` and tests → API → `fetch-json.ts` / `compatibility-matrix-shared.ts`. Intended: same consumers → API → pagination → existing JSON/shared modules. Blast radius: GUI compatibility feature, with zero consumer path edits. Existing sibling convention: `compatibility-matrix-api.ts`, `compatibility-matrix-shared.ts`; do not enlarge the existing shared DTO/parser module or add an `index.ts`.

One NEW file:

- `gui/src/pages/compatibility-matrix-pagination.ts`: all P rows above. Move contiguous original spans 25–26, 30–76, 85–143 and 156–183: **136 source lines** including intervening blanks. Expected **160 lines** including its own imports/separators (budget, not a measured output). Keep `CollectedPages` private; its inferred return shapes remain structurally identical. Export `fetchLabJson`, `buildQuery`, `invalidResponse`, `fetchAllObservations` only from this internal leaf because the residual needs them; do not add them to the old public facade.

Its imports are exactly:

```ts
import { readJsonOrThrow } from "../fetch-json";
import {
  isPlainObject, parseObservationsPage, parseSubjectPage, parseVerdictPage,
  type ObservationDto, type PaginatedObservations, type PaginatedSubjects,
  type PaginatedVerdicts, type SubjectListItemDto, type VerdictQueryFilters,
} from "./compatibility-matrix-shared";
```

Residual `gui/src/pages/compatibility-matrix-api.ts`: **expected 310 lines** with a conservative import/re-export reserve: 432 − 136 = 296 retained source lines before import cleanup/plumbing. Keep every R declaration byte-equivalent. Drop its `readJsonOrThrow`, strict page parser and paginated-subject/observation imports now owned by P; retain the used shared DTOs/parsers. No #b layer is needed. Raw source diff budget is approximately 300 additions plus deletions, comfortably below 500; count actual `git diff --numstat` at implementation.

## Re-export block

Insert these exact compatibility re-exports in the original path; all other existing exports remain declarations there:

```ts
export { LabDataContractError, fetchVerdictPage, fetchSubjectPage, fetchAllSubjects, fetchObservationsPage } from "./compatibility-matrix-pagination";
```

No current exported type moves, so no `export type` line is required. Re-exporting does not bind the residual's names; it explicitly imports:

```ts
import { buildQuery, fetchAllObservations, fetchAllSubjects, fetchLabJson, fetchVerdictPage, invalidResponse } from "./compatibility-matrix-pagination";
```

Keep `fetchLabStatus`, `fetchSubjectDetail`, `fetchEventById`, `fetchArtifactByDigest`, `fetchPassiveProductionSummary`, `parseCommunityEvidenceContext`, `fetchCommunityEvidenceContext`, `fetchLabPageData`, `fetchMoreVerdicts`, `fetchVerdictDetail` and all five exported DTO/data types importable exactly as before. No `export *`, default export, or compatibility alias is added.

## Module-level state and cycles

- No top-level mutable collection, `let`, lock or cache. `PAGE_LIMIT` at `gui/src/pages/compatibility-matrix-api.ts:25` and `MAX_PAGES:26` have one owner in P. `DETAIL_CONCURRENCY:27` and `MAX_DETAIL_REFERENCES:28` remain R.
- `LabDataContractError:42` has one constructor in P; R re-exports that exact binding so `instanceof` at existing tests still works. Do not subclass or redeclare it in R.
- `seen` at original line 122 is per-call pagination state, not a module singleton. `allowedSet:260`, bounded-worker `index:384` and detail event-ID Set at 407 likewise retain their local lifetimes.
- Potential cycle: P → R for fetch/error/query helpers while R → P for pagination. Avoid it by moving all six helper dependencies into P; neither runtime nor type imports in P may reference R.
- New coupling is functional calls / type-only DTOs; existing boundary validation stays at the HTTP response parser. No validation removal or new policy checks.

## Tests

Direct import `rg -l` result (all unchanged, original import paths retained):

```text
gui/tests/compatibility-lab.test.tsx
gui/tests/compatibility-community-evidence.test.ts
gui/tests/compatibility-pagination-cap.test.ts
```

The first imports at line 27, the second at line 7, the third at line 2. `rg -n 'compatibility-matrix-api' tests gui/tests` plus inspection of their `Bun.file` / `readFileSync` sites found **no text-oracle reader of this API file**. No retarget-to-leaf or add-leaf-to-scan-list action is required here. `compatibility-matrix-layout.test.ts:7` reads the page, not this API; that change belongs to L2.

Guards to drive red once in the implementation worktree, then restore before green: change P's `MAX_PAGES` from 200 to 199 and observe the pagination-cap test fail; replace P's thrown constructor in the malformed-page path and observe the `LabDataContractError` assertion fail in `compatibility-lab.test.tsx`. The production/community response assertions must remain unchanged. These are planned mutation checks, not runs performed by this docs task.

## Verification

Run in the dedicated L1 implementation worktree, at its own tip (002 Per-layer gate, domains `gui/tests` compatibility + JSON API):

```sh
bun run typecheck
bun test gui/tests/compatibility-lab.test.tsx gui/tests/compatibility-community-evidence.test.ts gui/tests/compatibility-pagination-cap.test.ts
bun run privacy:scan
(cd gui && bun run lint && bun run build)
wc -l gui/src/pages/compatibility-matrix-pagination.ts gui/src/pages/compatibility-matrix-api.ts
rg -l 'from ["\x27][^"\x27]*/compatibility-matrix-api(\.tsx?)?["\x27]' src gui/src gui/tests tests scripts
sg run --kind import_statement --json=compact gui/src/pages/compatibility-matrix-pagination.ts
git diff --check
git diff --numstat
```

Require zero test failures and exit 0 for typecheck/privacy/lint/build. Importer set stays the four observed files until a later authorized S19 layer adds internal consumers; compare the set, not just its size. Inspect P's imports against the exact inward graph above, including type edges; no facade backlink. Core-Lab boundary test is not triggered: no `src/server`, `src/router`, or `src/lib` change; do not edit its protected roots.

Full suites only on the parent's allocated `lidge` checkout at the exact pushed branch tip:

```sh
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-pages-compatibility-matrix-api && git checkout -q FETCH_HEAD && bun install --frozen-lockfile && bun run test && (cd gui && bun install --frozen-lockfile && bun test tests)'
```

Record remote `git rev-parse HEAD`, full log/exit status and exact-head CI rollup. Do not accept `tail`'s exit code as suite success or share a mutable remote checkout concurrently with another stack. No local full suite. No commands in this section were run during drafting.

## Accept criteria

1. All 39 declaration rows have exactly one owner; only the one named leaf is added.
2. P and R are each ≤400 physical lines; retained export names and parameter/return contracts are unchanged, including zero-consumer exports.
3. Pagination still uses limit 50, cap 200, repeated-cursor rejection and the same caller signal; returned truncation semantics are unchanged.
4. There is exactly one `LabDataContractError` definition and no P → R import or re-export edge.
5. Three direct-import tests remain on the original path; the two planned negative probes fail, restored focused tests pass, and remote full-suite plus exact-head CI are green.
6. Layer-only diff passes the 500-line budget check; no UI copy, CSS, endpoint, consumer path, unrelated code or protected-root edits.
7. PR base is `dev`, parent records evidence, and no merge occurs.

## PR

Title: `refactor(gui): isolate compatibility pagination contracts (split S19 L1/4)`

Branch: `codex/split-pages-compatibility-matrix-api`. Base: `dev`. Closes: none.

Use all Summary / Verification / Checklist sections of `.github/PULL_REQUEST_TEMPLATE.md`. Include unchanged-UI screenshot evidence because the title names gui; do not claim a UI redesign. DEV-STACK-03 map (placeholder PR numbers, replace only when PRs exist):

| # | PR | Branch | Base | Review focus |
|---|---|---|---|---|
| 1 | #TBD-S19-L1 | codex/split-pages-compatibility-matrix-api | dev | pagination/error owner; this layer |
| 2 | #TBD-S19-L2 | codex/split-pages-CompatibilityMatrix | codex/split-pages-compatibility-matrix-api | matrix presentation leaves |
| 3 | #TBD-S19-L3 | codex/split-combo-workspace-data | dev | quota evidence and combo contracts |
| 4 | #TBD-S19-L4 | codex/split-components-combo-workspace-detail-panel | codex/split-combo-workspace-data | controlled Config contents |

Base: dev — no dependency on lower layers; this layer is the parent of 640 (branch based on it), so any change here cascades into that layer with `git rebase --update-refs` + `--force-with-lease` before review (DEV-STACK-02).

Review this layer's diff only. Merge only after separate user authorization; never enable auto-merge.
