# 350 — S11 L4/5: src/routing/trace.ts

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: **pure-move**. Planning class: C3, bounded docs-only delegation; auth/provenance implementation retains C4 security care where noted below.
- Non-goals: No change to trace wire version, selected-candidate retention, truncation flags, candidate/requirement limits, byte-budget fallback, random decision IDs, or evidence whitelist/normalization behavior.
- Goal: Separate wire DTOs/limits and evidence codecs from trace building, deterministic byte budgeting and persisted-row normalization.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated in Verification below (the 000 reference to 003 is stale; 002 is authoritative).
- Stop: this delegated turn stops after writing and statically checking this plan; no source edits, tests, git mutations, orchestration, loop or goal commands. The later executor stops on any changed behavior, missing binding, cycle, oversized leaf, failing guard or basis drift. Layer execution ends only at an open PR with recorded green exact-head CI; never merge.
- Escalation: send any extra file/layer requirement or boundary change to the parent. Execution also requires the parent to resolve the 500-line diff-size contradiction below.

Basis: docs HEAD `4cc219549`; source `origin/dev = 1362b1a3841b4de20177e5d65865a513dd7936c4`. All source line references below are to that source snapshot. `git diff --numstat origin/dev -- src/routing/trace.ts` is empty. Lane audit: `devlog/_plan/260905_modular_debt_ledger/013_lane_providers_codex_oauth_routing.md:359`. No implementation proof is claimed here.

## Symbol inventory

Every top-level declaration is listed, including private declarations and import bindings. Inclusive start–end spans were extracted with `sg run --lang ts --kind <function_declaration|interface_declaration|type_alias_declaration|lexical_declaration> --json=compact src/routing/trace.ts` and checked against `git show origin/dev:src/routing/trace.ts` with numbered lines. Nested declarations are intentionally not top-level rows.

Consumers = unique **direct importing/re-exporting files**, not identifier occurrences or callers inside this module. Start from `rg -l -F 'trace' src gui/src scripts tests`, inspect import/re-export clauses, resolve each relative specifier to this exact file, then intersect each named binding with `rg -l -w '<symbol>' src gui/src scripts tests`. Private declarations have zero external consumers; same-spelling symbols elsewhere are not consumers. Type-only imports count. Imported bindings themselves are local, not exports. Baseline: 14 direct files; test-only leaf imports for new identity assertions do not replace any original import.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `randomBytes` | import binding(s) | 17–17 | no | 0 (local imports) | residual |
| `RouteDecisionKind` | type alias | 19–25 | yes | 1 | `src/routing/trace-contracts.ts` |
| `Unknownable` | type alias | 27–27 | yes | 1 | `src/routing/trace-contracts.ts` |
| `RouteRequirementEvidence` | interface | 29–35 | yes | 1 | `src/routing/trace-contracts.ts` |
| `RouteExclusionReason` | interface | 37–41 | yes | 1 | `src/routing/trace-contracts.ts` |
| `RouteCapabilityEvidence` | interface | 43–54 | yes | 2 | `src/routing/trace-contracts.ts` |
| `RouteHealthEvidence` | interface | 56–65 | yes | 2 | `src/routing/trace-contracts.ts` |
| `RouteQuotaEvidence` | interface | 67–78 | yes | 2 | `src/routing/trace-contracts.ts` |
| `RouteCostCapOutcome` | type alias | 85–89 | yes | 0 | `src/routing/trace-contracts.ts` |
| `RouteCostEvidence` | interface | 91–103 | yes | 2 | `src/routing/trace-contracts.ts` |
| `RouteCompatibilitySuiteTrace` | interface | 105–117 | yes | 0 | `src/routing/trace-contracts.ts` |
| `RouteCompatibilityEvidence` | interface | 119–124 | yes | 2 | `src/routing/trace-contracts.ts` |
| `RouteScoreEvidence` | interface | 126–137 | yes | 1 | `src/routing/trace-contracts.ts` |
| `RouteCandidateTrace` | interface | 139–151 | yes | 1 | `src/routing/trace-contracts.ts` |
| `RouteDecisionTraceV1` | interface | 153–177 | yes | 7 | `src/routing/trace-contracts.ts` |
| `MAX_TRACE_CANDIDATES` | const | 179–179 | yes | 1 | `src/routing/trace-contracts.ts` |
| `MAX_EXCLUSIONS_PER_CANDIDATE` | const | 180–180 | yes | 1 | `src/routing/trace-contracts.ts` |
| `MAX_REQUIREMENTS` | const | 181–181 | yes | 2 | `src/routing/trace-contracts.ts` |
| `MAX_TRACE_STRING` | const | 182–182 | yes | 1 | `src/routing/trace-contracts.ts` |
| `MAX_TRACE_BYTES` | const | 183–183 | yes | 1 | `src/routing/trace-contracts.ts` |
| `ROUTE_KINDS` | const | 185–192 | no | 0 | `src/routing/trace.ts (residual)` |
| `REQUIREMENT_OUTCOMES` | const | 194–194 | no | 0 | `src/routing/trace-evidence.ts` |
| `capString` | function | 197–201 | no | 0 | `src/routing/trace-evidence.ts` |
| `isPlainRecord` | function | 203–205 | no | 0 | `src/routing/trace-evidence.ts` |
| `finiteNumber` | function | 207–209 | no | 0 | `src/routing/trace-evidence.ts` |
| `unknownable` | function | 211–216 | no | 0 | `src/routing/trace-evidence.ts` |
| `TraceCandidateInput` | interface | 218–230 | yes | 1 | `src/routing/trace-contracts.ts` |
| `TraceBuildInput` | interface | 232–248 | yes | 0 | `src/routing/trace-contracts.ts` |
| `ParseCaps` | interface | 250–256 | no | 0 | `src/routing/trace-contracts.ts` |
| `buildCandidate` | function | 259–287 | no | 0 | `src/routing/trace.ts (residual)` |
| `buildRequirement` | function | 290–305 | no | 0 | `src/routing/trace.ts (residual)` |
| `buildRouteDecisionTrace` | function | 311–384 | yes | 3 | `src/routing/trace.ts (residual)` |
| `serializedByteLength` | function | 387–389 | no | 0 | `src/routing/trace.ts (residual)` |
| `enforceByteBudget` | function | 392–443 | no | 0 | `src/routing/trace.ts (residual)` |
| `parseExclusion` | function | 446–457 | no | 0 | `src/routing/trace-evidence.ts` |
| `parseRequirement` | function | 460–484 | no | 0 | `src/routing/trace-evidence.ts` |
| `parseCapability` | function | 487–525 | no | 0 | `src/routing/trace-evidence.ts` |
| `parseHealth` | function | 528–540 | no | 0 | `src/routing/trace-evidence.ts` |
| `parseQuota` | function | 543–558 | no | 0 | `src/routing/trace-evidence.ts` |
| `COST_CAP_OUTCOMES` | const | 560–565 | no | 0 | `src/routing/trace-evidence.ts` |
| `parseCost` | function | 568–584 | no | 0 | `src/routing/trace-evidence.ts` |
| `MAX_COMPATIBILITY_SUITES` | const | 586–586 | no | 0 | `src/routing/trace-evidence.ts` |
| `COMPATIBILITY_OUTCOMES` | const | 587–587 | no | 0 | `src/routing/trace-evidence.ts` |
| `parseCompatibility` | function | 589–623 | no | 0 | `src/routing/trace-evidence.ts` |
| `parseScore` | function | 626–635 | no | 0 | `src/routing/trace-evidence.ts` |
| `parseCandidate` | function | 638–675 | no | 0 | `src/routing/trace-evidence.ts` |
| `normalizeRouteDecisionTrace` | function | 682–776 | yes | 5 | `src/routing/trace.ts (residual)` |

## Leaf partition

Structural decision: The 776-line module has self-contained contracts and shared evidence parsing used by both builder and normalizer. Reject extracting only normalizeRouteDecisionTrace: it depends on parsers also used by buildCandidate and would create a facade return edge or duplicate code. Choose trace-contracts.ts and trace-evidence.ts siblings, matching src/routing/request-evidence.ts and domain-named routing modules. Keep both public coordinators and byte-budget enforcement in trace.ts. Blast radius: routing evidence contract used by routing, usage hydration and request logs; no Lab implementation dependency is introduced.

Pre-change/intended map: Current: src/routing/evaluator.ts:10, src/routing/quota.ts:22, src/router.ts:39, src/usage/log.ts:10 and src/server/request-log.ts:16 → trace.ts → node:crypto only. Intended: same callers → trace.ts → trace-evidence.ts → trace-contracts.ts; trace.ts also imports contracts directly. node:crypto remains only in trace.ts. Evidence codecs consume shared contracts and never import the build/normalization facade. ParseCaps is an internal downward contract, exported only from its leaf and not added to the old public API.

Sizing escalation: the partition moves 461 existing lines, so source additions-plus-deletions are at least 922 before rewiring. The fixed S11 L4 cannot meet a literal 500 changed-line cap. Parent disposition (explicit pure-move exception or revised layer map) is required before execution. Do not report the one-way moved-line count as a passing diff-size check. No extra #b is assumed by this document.

### `src/routing/trace-contracts.ts` — 208 expected lines

Move source bands `src/routing/trace.ts:19`–184, `src/routing/trace.ts:218`–257 (206 physical lines including existing inter-declaration comments/blanks). Symbols: `RouteDecisionKind`, `Unknownable`, `RouteRequirementEvidence`, `RouteExclusionReason`, `RouteCapabilityEvidence`, `RouteHealthEvidence`, `RouteQuotaEvidence`, `RouteCostCapOutcome`, `RouteCostEvidence`, `RouteCompatibilitySuiteTrace`, `RouteCompatibilityEvidence`, `RouteScoreEvidence`, `RouteCandidateTrace`, `RouteDecisionTraceV1`, `MAX_TRACE_CANDIDATES`, `MAX_EXCLUSIONS_PER_CANDIDATE`, `MAX_REQUIREMENTS`, `MAX_TRACE_STRING`, `MAX_TRACE_BYTES`, `TraceCandidateInput`, `TraceBuildInput`, `ParseCaps`.

Keep existing exported declarations exported. Add the `export` modifier (without changing a body/signature) only to these formerly private declarations needed by another production module: `ParseCaps`. Every other private declaration stays private; none of the new internal exports is added to the facade.

Own imports (complete):

```ts
// None: this leaf has no imports.
```

### `src/routing/trace-evidence.ts` — 259 expected lines

Move source bands `src/routing/trace.ts:194`–194, `src/routing/trace.ts:196`–217, `src/routing/trace.ts:445`–676 (255 physical lines including existing inter-declaration comments/blanks). Symbols: `REQUIREMENT_OUTCOMES`, `capString`, `isPlainRecord`, `finiteNumber`, `unknownable`, `parseExclusion`, `parseRequirement`, `parseCapability`, `parseHealth`, `parseQuota`, `COST_CAP_OUTCOMES`, `parseCost`, `MAX_COMPATIBILITY_SUITES`, `COMPATIBILITY_OUTCOMES`, `parseCompatibility`, `parseScore`, `parseCandidate`.

Keep existing exported declarations exported. Add the `export` modifier (without changing a body/signature) only to these formerly private declarations needed by another production module: `capString`, `isPlainRecord`, `finiteNumber`, `parseRequirement`, `parseCapability`, `parseHealth`, `parseQuota`, `parseCost`, `parseCompatibility`, `parseCandidate`. Every other private declaration stays private; none of the new internal exports is added to the facade.

Own imports (complete):

```ts
import type { Unknownable, RouteRequirementEvidence, RouteExclusionReason, RouteCapabilityEvidence, RouteHealthEvidence, RouteQuotaEvidence, RouteCostCapOutcome, RouteCostEvidence, RouteCompatibilitySuiteTrace, RouteCompatibilityEvidence, RouteScoreEvidence, RouteCandidateTrace, ParseCaps } from "./trace-contracts";
import { MAX_TRACE_STRING, MAX_EXCLUSIONS_PER_CANDIDATE } from "./trace-contracts";
```

### Residual `src/routing/trace.ts` — 321 expected lines

Keep these declarations: `ROUTE_KINDS`, `buildCandidate`, `buildRequirement`, `buildRouteDecisionTrace`, `serializedByteLength`, `enforceByteBudget`, `normalizeRouteDecisionTrace`.

Accounting: 776 original − 461 moved − 0 replaced import/header lines + 3 explicit import lines + 2 named re-export lines + 1 separator = **321**. Each leaf estimate is its source-band count + own import lines + two header/separator lines. These are physical-line estimates using the compact exact import blocks below, not a claim of measured implementation output. Preserve comments, allow readable multiline imports, and remeasure after formatting; no file may exceed 400. No residual >400 and no #b required by file length. No #a/#b/#c parts are added in this five-layer map. Original function bodies over 50 lines remain unchanged as an explicit pure-move exception; splitting their logic is out of scope.

## Re-export block

Insert at the existing feature boundary, using named re-exports only. This is preservation of an established path, not a new internal index barrel. Re-exports create no local bindings.

```ts
export { MAX_TRACE_CANDIDATES, MAX_EXCLUSIONS_PER_CANDIDATE, MAX_REQUIREMENTS, MAX_TRACE_STRING, MAX_TRACE_BYTES } from "./trace-contracts";
export type { RouteDecisionKind, Unknownable, RouteRequirementEvidence, RouteExclusionReason, RouteCapabilityEvidence, RouteHealthEvidence, RouteQuotaEvidence, RouteCostCapOutcome, RouteCostEvidence, RouteCompatibilitySuiteTrace, RouteCompatibilityEvidence, RouteScoreEvidence, RouteCandidateTrace, RouteDecisionTraceV1, TraceCandidateInput, TraceBuildInput } from "./trace-contracts";
```

Retain these current exports as declarations in the original file (not copies): `buildRouteDecisionTrace`, `normalizeRouteDecisionTrace`. Together with the block above this preserves the complete old type/value export set; leaf-private API is not added to the facade.

Explicit residual imports (add alongside any unchanged original imports):

```ts
import type { RouteCandidateTrace, RouteDecisionTraceV1, RouteDecisionKind, RouteRequirementEvidence, TraceCandidateInput, TraceBuildInput, ParseCaps } from "./trace-contracts";
import { MAX_TRACE_CANDIDATES, MAX_EXCLUSIONS_PER_CANDIDATE, MAX_REQUIREMENTS, MAX_TRACE_STRING, MAX_TRACE_BYTES } from "./trace-contracts";
import { capString, isPlainRecord, finiteNumber, parseCapability, parseHealth, parseQuota, parseCost, parseCompatibility, parseCandidate, parseRequirement } from "./trace-evidence";
```

## Module-level state and cycles

ROUTE_KINDS Set at 185–192 stays in trace.ts with normalizeRouteDecisionTrace. REQUIREMENT_OUTCOMES at 194 moves to trace-evidence.ts with parseRequirement. COST_CAP_OUTCOMES at 560–565 and COMPATIBILITY_OUTCOMES at 587 move to that same leaf; neither is exported. MAX_COMPATIBILITY_SUITES at 586 moves with parseCompatibility. The five public numeric limits at 179–183 have one owner in trace-contracts.ts and are re-exported, never copied. There is no module-level let, WeakMap, lock, flight or timer. budget/caps/truncated objects are call-local. Builder → parser → facade would be a cycle if ParseCaps or limits stayed only in the facade; moving them into contracts prevents that edge.

Lane 013 reported no static return-path cycle for this source. This plan's new local graph is acyclic by the dependency direction above; this is not a substitute for the executor's fresh whole-relative-graph return-path scan. Include type-only imports/re-exports, not merely runtime imports. New edges are Functional/Sequential coupling, not shared mutable Common state; preserve existing invocation ordering rather than adding locks or global owners. No leaf imports `./trace` or any facade that routes back into itself. No lazy import workaround.

## Tests

Direct importer list, reproduced by `rg -l -F 'src/routing/trace' tests` (all **unchanged**, including import path and existing assertions):

- `tests/routing/routing-compatibility.test.ts` — unchanged.
- `tests/routing/routing-policy-fallback.test.ts` — unchanged.
- `tests/server/route-decision-trace.test.ts` — unchanged.
- `tests/usage/cost-cap-unknown-evidence.test.ts` — unchanged.

Text-oracle inventory: **none found** for this exact source path. Inspected basename/path matches and segmented `repoPath` forms for `readFileSync`, `Bun.file` and source-reader helpers, consistent with lane 013. There is therefore no source-read line to retarget and no explicit scan-list entry to add. A basename occurrence in `tests/fixtures/test-layout-expected.json` is test registration, not a source read. Generic recursive import-graph coverage is unchanged and discovers imports naturally. If implementation finds a computed/path-list source oracle not captured here, stop and extend the inventory with its exact read line before moving code; do not weaken it.

All four direct-import test files retain behavioral imports through trace.ts. Preserve tests/server/route-decision-trace.test.ts:186 exactly: selected-candidate index/model and UTF-8 byte budget are the initial pure-move oracle. Also keep :227 (retained reasoning-effort reads), :259 (sparse evidence), :338 (whitelisted evidence) and :383 (usage/request-log roundtrip). Add assertions to the existing trace test comparing all five public numeric limits with ../../src/routing/trace-contracts; add a bound test using a long provider string so the facade demonstrably uses the moved MAX_TRACE_STRING. Drive the latter guard red once by temporarily bypassing capString's slice in trace-evidence.ts, restore, then green. Preserve the existing byte-budget test unchanged rather than adjusting an expected limit to make extraction pass.

These red-once mutations are future disposable-worktree verification steps, never persistent changes. They were not performed during drafting. Extend existing test files only; no new test file or test-layout entry is planned. `tests/lab/core-lab-boundary.test.ts` PROTECTED roots are never edited.

## Verification

Future implementation commands only; **none run in this docs-only task**. Execute against this layer's own tip, domains **server, routing, usage**, not the eventual stack top.

```sh
bun run typecheck
bun test tests/server/route-decision-trace.test.ts tests/routing/routing-policy-fallback.test.ts tests/routing/routing-compatibility.test.ts tests/usage/cost-cap-unknown-evidence.test.ts
bun run privacy:scan
wc -l src/routing/trace-contracts.ts src/routing/trace-evidence.ts src/routing/trace.ts
rg -l -F 'routing/trace' src gui/src scripts tests
# Resolve relative import/re-export paths and compare the original consumer file set.
# Full suite: lidge only, no local full-suite invocation; keep the full exit status/log.
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-routing-trace && git checkout -q FETCH_HEAD && bun install --frozen-lockfile && bun run test'
```

For the 002 importer gate, the expected **existing** direct consumer set is 14: `src/router.ts`, `src/routing/capability.ts`, `src/routing/compatibility/policy.ts`, `src/routing/cost.ts`, `src/routing/evaluator.ts`, `src/routing/health.ts`, `src/routing/quota.ts`, `src/server/request-log.ts`, `src/server/responses/policy-fallback.ts`, `src/usage/log.ts`, `tests/routing/routing-compatibility.test.ts`, `tests/routing/routing-policy-fallback.test.ts`, `tests/server/route-decision-trace.test.ts`, `tests/usage/cost-cap-unknown-evidence.test.ts`. The rg line above is a candidate list, not the count: same-directory imports and aliases require the path resolution described in Symbol inventory. Compare file sets, not statement counts; added leaf imports in identity tests are intentional. No original consumer migrates away from this boundary. Typecheck must still resolve every old export.

Cycle verification: repeat lane 013 SG-GRAPH using `sg run --lang ts --kind import_statement --json=compact src` and `sg run --lang ts --kind export_statement --json=compact src`; resolve relative .ts/.tsx/index targets, include type edges, and search for a return path to the original or any new leaf. Require no new return path; record the scoped graph result. Do not install a new dependency tool for this layer.

The 002 conditional Lab gate is not triggered by these planned source paths (none is src/server, src/router.ts or src/lib). If the implementation touches one of those paths, that is an expansion requiring parent approval and `bun test tests/lab/core-lab-boundary.test.ts`; keep PROTECTED unchanged. All new leaves must stay free of a transitive Lab dependency regardless.

Record red then green for the guard named in Tests, typecheck exit 0, focused tests 0 failures, privacy scan exit 0, actual per-file line counts, full-suite exit 0 on lidge, the exact tested SHA and CI rollup. The remote worktree is parent-coordinated; confirm ownership before checkout and require its tested SHA to equal the PR head. Do not mask test exit status with an unguarded tail pipeline. Revalidate after any cascade.

## Accept criteria

1. Source still matches the stated basis or the plan is refreshed for every changed symbol before extraction. Parent size disposition is recorded before implementation; absent that decision the layer is not executable.
2. Every inventory declaration has exactly one owner; all function bodies/signatures and constant/type definitions are moved verbatim, apart from the necessary export modifiers and import paths. No public export is renamed, deleted, wrapped or newly invented.
3. Every current export remains importable from `src/routing/trace.ts`; moved values pass identity guards where applicable, and residual references are satisfied by real imports, not a re-export-only assumption.
4. Actual 2 new leaves and the residual are each ≤400 physical lines. Record counts rather than relying on these estimates. No hidden #b or unplanned source file is required.
5. The old runtime export set is exactly five numeric limits plus the two public functions; all sixteen public types remain importable; codec-private sets and ParseCaps do not leak through the facade.
6. State/constant ownership matches this plan; fresh relative-import graph reports no new cycle, including type-only edges, and no new Lab reachability.
7. Existing tests/imports/source guards are retained without weakening; the specified guard is demonstrated red once and restored green. All instantiated 002 gates and exact-head CI are green with recorded evidence.
8. PR uses the template, correct base and complete five-layer map. No merge, release, deployment, dependency installation on the user's running service, or unrelated code change is included.

## PR

Title: `refactor(routing): separate trace contracts and evidence codecs (split S11 L4/5)`

Branch: `codex/split-routing-trace`. Base: `dev`. Closes: **none**.

Use `.github/PULL_REQUEST_TEMPLATE.md` with Summary, Verification and Checklist. Put the measured move size and any parent-approved exception in Summary, evidence tied to this PR head in Verification, and include the stack map below. Review this layer's diff only. PR numbers are intentionally unassigned planning placeholders, not existing PR claims.

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 1 | #TBD-S11-L1 |  L1 | `codex/split-combos-types` | `dev` | isolate combo identifiers from validation |
| 2 | #TBD-S11-L2 |  L2 | `codex/split-codex-subagent-defaults` | `dev` | isolate format-preserving subagent TOML lexing |
| 3 | #TBD-S11-L3 |  L3 | `codex/split-codex-cli-install-provenance` | `dev` | separate install evidence from classification |
| 4 | #TBD-S11-L4 | **L4 — this layer** | `codex/split-routing-trace` | `dev` | separate trace contracts and evidence codecs |
| 5 | #TBD-S11-L5 |  L5 | `codex/split-oauth-github-copilot` | `dev` | isolate GitHub device grant transport |

Base: dev — no dependency on the layers below; no cascade obligation.

DEV-STACK-04: merges remain separately authorized; this task performs none.
