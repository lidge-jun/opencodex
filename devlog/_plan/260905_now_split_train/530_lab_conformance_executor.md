# 530 — S16 L1/5: src/lab/conformance/executor.ts

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: pure-move. Work class: C3 architecture planning, docs-only delegated scope. Parent owns orchestration, loop and goal state; this document executes none of them.
- Goal: split `src/lab/conformance/executor.ts` (741 lines) into the named leaves while preserving all current exports, signatures, object identities and behavior.
- Non-goals: no behavior fixes, public identifier renames, schema changes, new dependencies, import-consumer churn, function-body rewrites, core-root edits, merge, release or deployment. No code/test/git-state mutation in this drafting task.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below. Current planning basis is docs HEAD `4cc219549`, code `origin/dev = 1362b1a38`; `git diff origin/dev -- src/lab/conformance/executor.ts` is empty. All source line anchors below refer to that code basis, not future leaf line numbers.
- Stop: drafting ends after this plan's declaration/export/state/test inventory is checked. Implementation ends only when its independent per-layer gates and exact-head CI evidence are recorded; no merge is authorized by this document.
- Escalation: stop implementation and return to the parent if source drift invalidates the partition, an export/identity changes, an oracle cannot move without weakening, a new cycle appears, any residual/leaf exceeds 400, or the fixed layer scope needs expansion. Do not create an unplanned #b or edit 002 from this task.

L1 SIZE CONFLICT: the partition below relocates 376 declaration-body lines, so it contributes at least 752 raw additions+deletions before import, comment and whitespace edits. It cannot satisfy a literal ≤500 raw changed-source-lines gate in the fixed five-layer map. Proposed documented DEFAULT exception: review pure moves with --color-moved and judge new logic (zero), while recording raw numstat honestly. Parent must approve that exception before implementation, or authorize another stack/layer and update 002; this delegate does not change topology. All >50-line functions remain unchanged under the pure-move non-goal.

## Symbol inventory

Origin/dev declaration spans were enumerated with `sg run --lang ts --kind 'function_declaration,lexical_declaration,interface_declaration,type_alias_declaration,export_statement' --json=compact src/lab/conformance/executor.ts`, keeping column-zero declarations; exported declarations are counted once. Imports are not redeclarations of their source owners: original import block is src/lab/conformance/executor.ts:1–26, and the exact post-split imports appear below.

Consumer counts mean **direct importing/re-exporting modules**, not occurrences or transitive barrel consumers. Resolved relative import clauses were checked with `rg -q -w <symbol>`; namespace imports and wildcard re-exports count once for every exported symbol. Non-exported declarations have zero external consumers. `rg --files src gui/src scripts tests` supplied the search universe. Module fan-in is 14; the mechanically requested basename-only gate returns 35 because it also matches non-conformance executors.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `resolveProtocolExecutionContext` | function | 28–38 | yes | 9 | `executor.ts (residual)` |
| `collectAdapterEvents` | function | 40–44 | no | 0 | `executor-transport.ts` |
| `nonstreamObservationJson` | function | 46–54 | yes | 2 | `executor-transport.ts` |
| `collectBridgeSse` | function | 56–82 | no | 0 | `executor-transport.ts` |
| `parseUpstreamSse` | function | 84–92 | no | 0 | `executor-transport.ts` |
| `parsedFromContext` | function | 94–114 | no | 0 | `executor.ts (residual)` |
| `normalizeTools` | function | 116–123 | no | 0 | `executor-transport.ts` |
| `createHarnessAdapter` | function | 125–131 | no | 0 | `executor-transport.ts` |
| `runBuildRequest` | function | 133–146 | no | 0 | `executor-transport.ts` |
| `executeAdapterVector` | function | 148–216 | no | 0 | `executor.ts (residual)` |
| `runToolRoundTrip` | function | 218–255 | no | 0 | `executor-tools.ts` |
| `runCustomToolRoundTrip` | function | 257–293 | no | 0 | `executor-tools.ts` |
| `runToolResultContent` | function | 295–314 | no | 0 | `executor-tools.ts` |
| `normalizeImageToolResultUpstream` | function | 316–336 | no | 0 | `executor-tools.ts` |
| `runApplyPatchTurn` | function | 338–367 | no | 0 | `executor-tools.ts` |
| `runCodexToolContinuation` | function | 369–386 | no | 0 | `executor-tools.ts` |
| `runPreviousResponseReplay` | function | 388–421 | no | 0 | `executor-reasoning.ts` |
| `runReasoningEffortMapping` | function | 423–442 | no | 0 | `executor-reasoning.ts` |
| `runReasoningReplay` | function | 444–494 | no | 0 | `executor-reasoning.ts` |
| `runReasoningPrivateIsolation` | function | 496–523 | no | 0 | `executor-reasoning.ts` |
| `executeClientRequest` | function | 525–536 | no | 0 | `executor.ts (residual)` |
| `recordInitiatingRequest` | function | 538–547 | no | 0 | `executor.ts (residual)` |
| `executeStreamScenario` | function | 549–651 | no | 0 | `executor.ts (residual)` |
| `executeScenario` | function | 653–674 | yes | 1 | `executor.ts (residual)` |
| `runScenario` | function | 676–741 | yes | 8 | `executor.ts (residual)` |

Direct production consumers / public boundaries, all preserved:

- `src/lab/conformance/runner.ts:2`.
- `src/lab/conformance/index.ts:4`.
- `src/lab/automation/dispatch.ts:3`.
- `src/lab/automation/planner.ts:5`.
- `src/lab/observe/from-conformance.ts:31`.

## Leaf partition

Structural decision: Keep role dispatch, client/stream execution and result assembly in the original entry. Move the shared transport primitives before the two vector families: executor → tools/reasoning → transport; executor also imports transport directly. Existing observation.ts and harness-budget.ts remain canonical. Reject a single vector-family leaf that imports runBuildRequest or collectBridgeSse back from executor: that creates a facade cycle. Reject a generic helpers.ts and adapting the production adapters, neither is needed for this pure move.

Sibling convention evidence: `src/lab/conformance/fixture-provider.ts`, `harness-budget.ts`, `sse-normalize.ts` and `observation.ts` already use concern-named siblings; no new index barrel.

The existing lane-016 inventory replaces an extra map command. Search evidence: `rg --files src/lab/conformance`, exact symbol searches and the direct-consumer inventory above; existing owners are reused, not copied. Doing nothing leaves the approved file-size debt; deletion/configuration would change behavior. Blast radius: local Lab feature plus unchanged entry-path consumers.

Expected counts below are an in-memory plan calculation: original complete declaration bodies and attached comments, the imports shown here, named re-exports, and one blank line between declarations. They are not a claim of executed source changes. Formatting may change the exact number; implementation must run wc and still stay ≤400. Private declarations listed in each leaf's “leaf exports” gain only the internal import seam; they are **not** added to the original public export surface.

### `src/lab/conformance/executor-transport.ts` — expected 95 lines

Symbols: `collectAdapterEvents`, `nonstreamObservationJson`, `collectBridgeSse`, `parseUpstreamSse`, `normalizeTools`, `createHarnessAdapter`, `runBuildRequest`.

Leaf exports: `nonstreamObservationJson`, `collectBridgeSse`, `parseUpstreamSse`, `normalizeTools`, `runBuildRequest`. Everything else in this leaf stays private.

Own imports (exact):

```ts
import { createOpenAIChatAdapter } from "../../adapters/openai-chat";
import { createResponsesPassthroughAdapter } from "../../adapters/openai-responses";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../bridge";
import { createTranslatorBudget } from "../../lib/translator-budget";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../types";
import { withHarnessTranslatorBudget } from "./harness-budget";
import { recordUpstreamRequest } from "./observation";
import { normalizeSseBytes } from "./sse-normalize";
import type { NormalizedObservation } from "./types";
```

### `src/lab/conformance/executor-tools.ts` — expected 179 lines

Symbols: `runToolRoundTrip`, `runCustomToolRoundTrip`, `runToolResultContent`, `normalizeImageToolResultUpstream`, `runApplyPatchTurn`, `runCodexToolContinuation`.

Leaf exports: `runToolRoundTrip`, `runCustomToolRoundTrip`, `runToolResultContent`, `runApplyPatchTurn`, `runCodexToolContinuation`. Everything else in this leaf stays private.

Own imports (exact):

```ts
import { createOpenAIChatAdapter } from "../../adapters/openai-chat";
import { createResponsesPassthroughAdapter } from "../../adapters/openai-responses";
import { parseRequest } from "../../responses/parser";
import type { OcxProviderConfig } from "../../types";
import { fixtureProviderConfig } from "./fixture-provider";
import { withHarnessTranslatorBudget } from "./harness-budget";
import { finalizeObservation, recordUpstreamRequest } from "./observation";
import type { NormalizedObservation } from "./types";
import { collectBridgeSse, normalizeTools, parseUpstreamSse } from "./executor-transport";
```

### `src/lab/conformance/executor-reasoning.ts` — expected 146 lines

Symbols: `runPreviousResponseReplay`, `runReasoningEffortMapping`, `runReasoningReplay`, `runReasoningPrivateIsolation`.

Leaf exports: `runPreviousResponseReplay`, `runReasoningEffortMapping`, `runReasoningReplay`, `runReasoningPrivateIsolation`. Everything else in this leaf stays private.

Own imports (exact):

```ts
import { createResponsesPassthroughAdapter } from "../../adapters/openai-responses";
import { parseRequest } from "../../responses/parser";
import { clearResponseStateForTests, expandPreviousResponseInput, rememberResponseState } from "../../responses/state";
import type { OcxProviderConfig } from "../../types";
import { fixtureProviderConfig } from "./fixture-provider";
import { withHarnessTranslatorBudget } from "./harness-budget";
import { recordUpstreamRequest } from "./observation";
import type { NormalizedObservation } from "./types";
import { runBuildRequest } from "./executor-transport";
```

### Residual `src/lab/conformance/executor.ts` — expected 342 lines

Retains: `resolveProtocolExecutionContext`, `parsedFromContext`, `executeAdapterVector`, `executeClientRequest`, `recordInitiatingRequest`, `executeStreamScenario`, `executeScenario`, `runScenario`.

No #a/#b/#c subdivision: the whole file's assigned work is this layer, and no residual exceeds 400. There is no unnamed later remainder. Upstream imports retained by the residual, in addition to the local imports in the next section:

```ts
import { createOpenAIChatAdapter } from "../../adapters/openai-chat";
import { createResponsesPassthroughAdapter } from "../../adapters/openai-responses";
import { bridgeToResponsesSSE } from "../../bridge";
import { anthropicToResponsesTranslation } from "../../claude/inbound";
import { responsesSseToAnthropicSse } from "../../claude/outbound";
import { createTranslatorBudget } from "../../lib/translator-budget";
import { parseRequest } from "../../responses/parser";
import { evaluateAssertions } from "./assertion";
import { fixtureProviderConfig, upstreamAdapterForProtocol } from "./fixture-provider";
import { withHarnessTranslatorBudget } from "./harness-budget";
import { attachMcpVerifiers, executeMcpSyntheticAction } from "./mcp-stub";
import { attachVerifiers, emptyObservation, finalizeObservation, filterAnthropicEvents } from "./observation";
import { normalizeSseBytes } from "./sse-normalize";
import type { CaseRecord, NormalizedObservation, ScenarioRunResult, ProtocolExecutionContextV1 } from "./types";
```

## Re-export block

Add exactly these compatibility re-exports to `src/lab/conformance/executor.ts`:

```ts
export { nonstreamObservationJson } from "./executor-transport";
```

Retained exports in the original file: `resolveProtocolExecutionContext`, `executeScenario`, `runScenario`. No wildcard or renamed re-export is introduced. This is preservation of an existing boundary, not a new internal convenience barrel.

Explicit local imports required by residual call sites (re-exporting binds nothing):

```ts
import { nonstreamObservationJson, collectBridgeSse, parseUpstreamSse, normalizeTools, runBuildRequest } from "./executor-transport";
import { runToolRoundTrip, runCustomToolRoundTrip, runToolResultContent, runApplyPatchTurn, runCodexToolContinuation } from "./executor-tools";
import { runPreviousResponseReplay, runReasoningEffortMapping, runReasoningReplay, runReasoningPrivateIsolation } from "./executor-reasoning";
```

## Module-level state and cycles

No top-level let/Map/Set/WeakMap/lock exists. The Set at executor.ts:62 is per collectBridgeSse invocation, not a singleton. The global response store is still owned by ../../responses/state; the clear/remember/clear sequences at executor.ts:392–420 and :500–522 move intact to executor-reasoning.ts, including both finally blocks. Adapter and translator-budget disposal stays per-call. Do not initialize adapters, budgets, timers or response-state caches at leaf import time. Cross-leaf calls are functional/sequential coupling; response-store setup/cleanup is existing temporal coupling, not a newly shared owner.

Lane 016 reported no return path through this file. The proposed edges above preserve that direction; this is a design argument, not a completed implementation cycle scan. During implementation, repeat lane 016 method G (resolved static imports/exports, type-only edges and literal dynamic imports) for each new leaf and the residual, and require no new cycle. Do not “fix” a cycle with lazy imports or duplicate a type/constant. No protected core root, activation timing or optional-Lab registration seam is changed.

## Tests

Direct test import inventory, from `rg -l 'src/lab/conformance/executor"' tests` with relative specifiers resolved and hits inspected:

| test file / import anchor | action |
|---|---|
| `tests/routing/cl01-review-regressions.test.ts:2` | unchanged — keep original import path |
| `tests/lab/lab-evidence-sanitization.test.ts:21` | unchanged — keep original import path |
| `tests/lab/lab-public-surfaces.test.ts:14` | unchanged — keep original import path |
| `tests/lab/lab-read-surfaces.test.ts:21` | unchanged — keep original import path |
| `tests/lab/lab-conformance-harness.test.ts:6` | unchanged — keep original import path |
| `tests/lab/lab-conformance-runner-failures.test.ts:2` | unchanged — keep original import path |
| `tests/lab/lab-evidence-ledger.test.ts:41` | unchanged — keep original import path |
| `tests/lab/lab-public-export-transaction.test.ts:12` | unchanged — keep original import path |
| `tests/lab/lab-ledger-mutation-lock.test.ts:20` | unchanged — keep original import path |

Additional indirect/guard coverage (all unchanged unless a narrowly described case is added below):

- `tests/lab/core-lab-boundary.test.ts`.

Text-oracle inventory: **zero tests read this specific file as source**. Checked `rg -n '(executor\\.ts|persistence\\.ts|community\\.ts|verification\\.ts|verdicts\\.ts)' tests`, qualified source paths and candidate reader bodies. Therefore retarget-to-leaf = none; add-leaf-to-scan-list = none. Behavioral imports stay unchanged; source-reading tests are not weakened into export-existence checks.

The 001 executor textoracle=1 is a basename false positive: `tests/lib/credential-redirect-guard.test.ts:65` lists **src/web-search/executor.ts**, read with `Bun.file(repoPath(file)).text()` at :71. Leave that test and its scan list unchanged; it does not govern any of these conformance leaves. This confirms lane 016's qualified-path result.

The generic boundary guard reads graph nodes at `tests/lab/core-lab-boundary.test.ts:69` and its composition root at :355; its PROTECTED list (:20–28) and reader paths are unchanged. It discovers relative graph edges without a new leaf scan list. Never retarget or edit the protected production roots to accommodate this split.

No text guard needs retargeting. During implementation, drive tests/routing/cl01-review-regressions.test.ts:76 red once by temporarily making nonstreamObservationJson always return fixture JSON in executor-transport.ts; restore immediately. Also preserve the malformed-negative-control assertion at that file:62 and the harness-failure accounting at tests/lab/lab-conformance-runner-failures.test.ts:24. Never replace production work with fixture-only stubs.

## Verification

This is the `002_layer_map.md` Per-layer gate instantiated for S16 L1. These are **future implementation commands**, not tests run by this docs-only delegate. Run at this layer's own tip, not the top of the stack. Focused domains: tests/lab and tests/routing/cl01-review-regressions.test.ts.

```sh
bun run typecheck
bun test tests/routing/cl01-review-regressions.test.ts tests/lab/lab-evidence-sanitization.test.ts tests/lab/lab-public-surfaces.test.ts tests/lab/lab-read-surfaces.test.ts tests/lab/lab-conformance-harness.test.ts tests/lab/lab-conformance-runner-failures.test.ts tests/lab/lab-evidence-ledger.test.ts tests/lab/lab-public-export-transaction.test.ts tests/lab/lab-ledger-mutation-lock.test.ts tests/lab/core-lab-boundary.test.ts
bun test tests/lab
bun run privacy:scan
bun test tests/lab/core-lab-boundary.test.ts
wc -l src/lab/conformance/executor-transport.ts src/lab/conformance/executor-tools.ts src/lab/conformance/executor-reasoning.ts src/lab/conformance/executor.ts
rg -n 'from "[^"]*/executor"' src gui/src scripts tests | wc -l
# Full suite only on the designated remote, never in this local worktree:
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-lab-conformance-executor && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'
```

Focused commands overlapping the full lab domain need not be repeated on unchanged code: capture the focused red/green during the move, then domain coverage once at the final tip. Typecheck/privacy must exit 0; tests must report zero failures. The basename-only rg baseline is 35; the resolved exact-module fan-in must remain 14. Leaf names deliberately do not end in /executor, so they do not inflate that gate. Recount against the actual parent if upstream changes.

The inherited remote pipeline's tail status alone is not proof of a passing Bun process: capture its complete test result and actual test exit status (enable pipefail or retain the status separately) and record the checked-out SHA. Do not treat fetch/checkout as authorization granted to this docs delegate. Parent/executor verifies remote checkout ownership before use. Record a green **complete exact-head CI rollup**, not an empty required-check list. New or modified source-oracle guards, if discovered, must be driven red and restored before claiming green. No test runner is installed for this plan.

Use `git diff --check`, `git diff --numstat <base>...HEAD` and move-aware diff inspection to prove only declaration moves/import rewiring. Compare all original exports (including erased types) to the explicit inventory. Re-run the lane-G import graph check, including type edges; a clean typecheck alone does not prove acyclicity.

## Accept criteria

1. Every declaration in the inventory has exactly one owner after the split; no duplicated mutable state or constants, and no omitted declaration.
2. All 4 original exported names remain importable from `src/lab/conformance/executor` with the same signatures/identity; the named re-export and local-import blocks above are present exactly where needed.
3. The 3 new leaves have expected counts 95, 179, 146; residual expected 342. Actual `wc -l` is ≤400 for every one. No hidden #b or sixth stack layer is assumed.
4. Existing function bodies, comparison ordering, errors, cleanup/finally behavior, and allocation timing are unchanged apart from export visibility needed by the private leaf seam. No new upward or facade-back import; static/type/dynamic graph has no newly introduced cycle.
5. All direct tests keep original imports; all identified text-oracle dispositions are implemented without weakening. The named deliberate red mutation fails for the intended reason and is fully removed before the final green run.
6. The instantiated local focused/domain, typecheck and privacy gates plus the remote-only full suite pass on the recorded layer SHA, and its complete exact-head CI is green. No local full suite.
7. The PR contains only this layer's pure move and necessary existing-test additions, retains the parent branch base, and includes the full five-layer stack map. The raw-diff-size exception is explicitly approved by the parent before code execution; otherwise this layer is not implementation-ready.

## PR

Title: `refactor(lab-conformance): separate scenario transport and vector families (split S16 L1/5)`

Branch: `codex/split-lab-conformance-executor`. Base: `dev`. Closes: none.

Use every section of `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist); include the pure-move thesis, planned/actual counts, gate evidence and this DEV-STACK-03 map. The placeholders below are intentional pre-creation PR numbers, not existing PRs.

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 1 | #TBD-S16-L1 | 530 — this PR | `codex/split-lab-conformance-executor` | `dev` | separate scenario transport and vector families |
| 2 | #TBD-S16-L2 | 540 | `codex/split-lab-automation-persistence` | `dev` | isolate the state-file lock owner |
| 3 | #TBD-S16-L3 | 550 | `codex/split-lab-public-community` | `dev` | extract bounded community input validation |
| 4 | #TBD-S16-L4 | 560 | `codex/split-lab-projection-verification` | `dev` | isolate suite artifact parsing |
| 5 | #TBD-S16-L5 | 570 | `codex/split-lab-projection-verdicts` | `codex/split-lab-projection-verification` | separate projection keys and claim reduction |

Base: dev — no dependency on the layers below; no cascade obligation. Every layer passes independently. Merge remains separately user-authorized; never merge or enable auto-merge as part of this plan.
