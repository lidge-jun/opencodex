# S07 L4/4 — Collaboration leaves

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`; C3 boundary planning with explicit review of unchanged tool-authorization behavior.
- Goal: separate tool bridge maps, roster text rendering and developer-message insertion, keeping guidance orchestration and all public exports at the existing boundary.
- Non-goals: rewriting guidance strings, changing model/effort selection, config/catalog timing, tool authorization, budget accounting, raw/parsed insertion order, or existing dynamic import strategy. No code, tests, Git mutations or cxc orchestration in this drafting task.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below.
- Stop: complete the plan; execution later stops at exact-head green open PR, never merge. Parent must resolve L1's scope conflict before stack readiness.
- Escalation: any changed runtime behavior or import side effect, cycle, >400 file, >500 changeset or required scope expansion. Do not prune unrelated unused imports as opportunistic cleanup.

Basis: docs HEAD `4cc219549`; source `origin/dev` = `1362b1a38`, 622 lines, identical in working tree. Lane: `devlog/_plan/260905_modular_debt_ledger/011_lane_server_responses.md:314`.

Structural map: `src/server/responses.ts:6–7`, `src/server/responses/core.ts` and two direct tests -> collaboration -> types/config/catalog/provider-slug/fallback/debug modules. There are also facade consumers listed under Tests. Intended: same callers -> collaboration -> tool-bridge-maps / subagent-roster-text / developer-message-insertion; only roster rendering is needed as a local binding. The feature facade remains the public compatibility boundary, not a new convenience barrel. Local server-feature blast radius. Reject lifting the entire guidance block into a fourth owner or new service: the three moves below meet 400 while staying within the changeset budget. Deletion/configuration cannot deliver the split. Reuse type helpers and existing catalog APIs; do not implement new tooling or model resolution.

## Symbol inventory

Inclusive origin/dev declaration spans from ast-grep plus numbered source/anchored `rg`. Imports 1–102 are existing dependencies, including many apparently unused bindings; preserve their source text in the residual rather than infer initialization safety. Consumers = distinct direct importer/re-exporter files in `src gui/src scripts tests` that match `rg -l -w SYMBOL` after literal-path resolution. Not transitive facade consumers or homonym counts. Module fan-in **4** files (2 source, 2 tests).

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| buildToolBridgeMaps | function | 105–231 | yes | 2 | tool-bridge-maps.ts |
| PROACTIVE_MULTI_AGENT_MODE_TEXT | const string | 235–241 | yes | 1 | residual collaboration.ts |
| isV1CollabSurface | function | 243–245 | yes | 1 | residual collaboration.ts |
| collabSurface | function | 249–270 | yes | 2 | residual collaboration.ts |
| MultiAgentGuidanceOptions | interface | 274–282 | yes | 1 | residual collaboration.ts |
| MultiAgentGuidanceDeps | interface | 286–293 | yes | 1 | residual collaboration.ts |
| defaultCollectCatalogState | function | 295–304 | no | 0 | residual collaboration.ts |
| resolveEffectiveSubagentRoster | function | 308–314 | yes | 1 | residual collaboration.ts |
| freshSubagentCatalogEntries | function | 329–346 | no | 0 | residual collaboration.ts |
| createRequestScopedSubagentRosterResolver | function | 349–356 | no | 0 | residual collaboration.ts |
| multiAgentGuidanceText | function | 360–497 | yes | 3 | residual collaboration.ts |
| V2_GUIDANCE_CHAR_BUDGET | const | 501–501 | yes | 1 | residual collaboration.ts |
| applyInjectionPlaceholders | function | 503–509 | yes | 0 | residual collaboration.ts |
| subagentRosterText | function | 513–525 | yes | 0 | subagent-roster-text.ts |
| isRecord | function | 529–531 | no | 0 | developer-message-insertion.ts |
| generatedDeveloperText | function | 533–540 | no | 0 | developer-message-insertion.ts |
| isGeneratedDeveloperItem | function | 542–544 | no | 0 | developer-message-insertion.ts |
| isDeveloperPrefixItem | function | 546–551 | no | 0 | developer-message-insertion.ts |
| leadingDeveloperPrefixLength | function | 553–557 | no | 0 | developer-message-insertion.ts |
| isConversationalItem | function | 559–564 | no | 0 | developer-message-insertion.ts |
| statefulRawInsertionIndex | function | 566–574 | no | 0 | developer-message-insertion.ts |
| injectDeveloperMessage | function | 576–622 | yes | 2 | developer-message-insertion.ts |

## Leaf partition

1. `src/server/responses/tool-bridge-maps.ts`: `buildToolBridgeMaps`, original **105–231** = 127 lines; three imports + one blank = **131 lines**. Keep all request-local maps, collision ordering and budget charges inside the function.

   ```ts
   import { dottedToolName, namespacedToolName, toolChoiceToolPredicate } from "../../types";
   import type { OcxParsedRequest } from "../../types";
   import type { TranslatorBudget } from "../../lib/translator-budget";
   ```

2. `src/server/responses/developer-message-insertion.ts`: `isRecord`, `generatedDeveloperText`, `isGeneratedDeveloperItem`, `isDeveloperPrefixItem`, `leadingDeveloperPrefixLength`, `isConversationalItem`, `statefulRawInsertionIndex`, `injectDeveloperMessage`, original **529–622** = 94 lines; one import + one blank = **96 lines**. Only `injectDeveloperMessage` is exported.

   ```ts
   import type { OcxParsedRequest } from "../../types";
   ```

3. `src/server/responses/subagent-roster-text.ts`: `subagentRosterText`, original **513–525** = **13 lines**; own imports **none**. This small pure renderer has a real local consumer and an existing exported contract, not a generic helper bucket. It is separate from config/catalog orchestration so it introduces no runtime catalog dependency.

Residual: keep every other line, adding three named re-exports and one local import: **622 - (127 + 94 + 13) + 4 = 392 lines**. Total **131 + 96 + 13 + 392 = 632 = 622 + 10**. Raw diff estimate **234 deletions + 244 additions = 478** before formatter differences; do not widen it by pruning/reformatting the 102-line import prelude. No #b needed. Existing named sibling convention checked against `src/server/responses/{input-admission,encrypted-payload,agent-task-recovery-cache,context-overflow}.ts` and `src/config/*.ts` / `src/types/*.ts`.

## Re-export block

Exact added compatibility exports:

```ts
export { buildToolBridgeMaps } from "./tool-bridge-maps";
export { injectDeveloperMessage } from "./developer-message-insertion";
export { subagentRosterText } from "./subagent-roster-text";
```

Explicit local binding required by the retained `multiAgentGuidanceText` call at original line 444:

```ts
import { subagentRosterText } from "./subagent-roster-text";
```

No local imports of `buildToolBridgeMaps` or `injectDeveloperMessage`: the residual never calls them. Preserve the remaining nine exported declarations verbatim: `PROACTIVE_MULTI_AGENT_MODE_TEXT`, `isV1CollabSurface`, `collabSurface`, `MultiAgentGuidanceOptions`, `MultiAgentGuidanceDeps`, `resolveEffectiveSubagentRoster`, `multiAgentGuidanceText`, `V2_GUIDANCE_CHAR_BUDGET`, `applyInjectionPlaceholders`. Both type exports therefore remain direct declarations, not fabricated `export type ... from` lines. `src/server/responses.ts:6–7` stays unchanged, preserving the facade's deliberately smaller export set.

## Module-level state and cycles

No top-level mutable Map/Set/WeakMap/let/lock/timer. `PROACTIVE_MULTI_AGENT_MODE_TEXT` at `src/server/responses/collaboration.ts:235–241` and `V2_GUIDANCE_CHAR_BUDGET` at line 501 remain single immutable scalar owners in residual collaboration.

The Maps/Sets at 115–121, 131, 203 and 208 remain local to each `buildToolBridgeMaps` call in its new owner; they are not promoted to module scope. The roster formatter's Set at 515 stays local to its call. The catalog snapshot captured at 353 and candidate Set at 418 stay request-local in the residual. No second roster snapshot, lazy cache or duplicated budget collector is introduced.

No leaf imports collaboration or the `../responses` facade, even for types. Maps imports existing types and a type-only budget; insertion imports the existing parsed-request type; roster text imports nothing. Intended edges are functional and downward. A type import from collaboration into any leaf would create a prohibited facade cycle. Retain the existing dynamic imports at 302, 312, 330–331 and 352 in their original owner and timing; they are not a new cycle-avoidance hack. Lane 011 reported no cycle in the literal graph; recheck changed static/type/dynamic paths before readiness. Core remains a protected root with no new Lab reachability.

## Tests

Direct importer list from `rg -l 'responses/collaboration["\x27]' tests | sort` (**2**, both **unchanged**):

```text
tests/routing/subagent-context-staleness.test.ts
tests/server/server-combo-failover-e2e.test.ts
```

The latter dynamically imports this module at line 1752; count it in fan-in even though 002's static `from` command misses it. Additional unchanged tests using collaboration exports through `src/server/responses.ts`, found by `rg -l 'buildToolBridgeMaps|injectDeveloperMessage|multiAgentGuidanceText|collabSurface' tests` and import inspection:

```text
tests/adapters/adapter-buffered-tool-conformance.test.ts
tests/adapters/adapter-tool-conformance.test.ts
tests/codex-integration/effort-policy.test.ts
tests/codex-integration/multi-agent-compat.test.ts
tests/responses/responses-parser.test.ts
tests/responses/responses-state.test.ts
```

No direct source-text oracle was found by literal/segmented collaboration path search among source-reading tests (lane 011 agrees). Transitive source readers still apply:

| test and exact read | disposition | action |
|---|---|---|
| `tests/lab/core-lab-boundary.test.ts:69` | unchanged | Existing runtime re-export/import traversal discovers all three leaves. PROTECTED roots untouched. |
| `tests/codex-integration/compatibility-manifest.test.ts:61` | unchanged | Leaves join the reachable scan without manual scan-list entries. |

No retarget-to-leaf or explicit add-leaf-to-scan-list needed; no new test-layout entries. Drive insertion guard `tests/codex-integration/multi-agent-compat.test.ts:1125` red once by temporarily weakening the exact guidance predicate in the new insertion leaf, then restore and green. Also keep placement cases at 1029, 1043, 1075, 1092 and 1105 unchanged. Temporarily corrupt a tool namespace map result and confirm the existing adapter conformance assertions fail; restore the moved body. Red/green the two graph guards with temporary forbidden edges in a reachable leaf, without editing protected roots. Run the roster/staleness behavioral tests through their existing boundary, not a new test-only import.

## Verification

Future implementation gate only; no tests run during drafting:

```sh
bun run typecheck
bun test tests/routing/subagent-context-staleness.test.ts tests/server/server-combo-failover-e2e.test.ts tests/adapters/adapter-buffered-tool-conformance.test.ts tests/adapters/adapter-tool-conformance.test.ts tests/codex-integration/effort-policy.test.ts tests/codex-integration/multi-agent-compat.test.ts tests/responses/responses-parser.test.ts tests/responses/responses-state.test.ts tests/codex-integration/compatibility-manifest.test.ts
bun run privacy:scan
bun test tests/lab/core-lab-boundary.test.ts
wc -l src/server/responses/tool-bridge-maps.ts src/server/responses/developer-message-insertion.ts src/server/responses/subagent-roster-text.ts src/server/responses/collaboration.ts
rg -n 'from "[^"]*/collaboration"' src gui/src scripts tests | wc -l
rg -n 'import\("[^"]*/collaboration"\)' src gui/src scripts tests
ssh lidge 'set -o pipefail; cd ~/ocx-ci/opencodex && git fetch origin codex/split-server-responses-collaboration && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'
```

Domains: routing, server, adapters, codex-integration, Responses and Lab boundary. Baseline **4 distinct consumer files**, including the dynamic import; a static line count alone is not the fan-in count (two re-export lines also share one facade file). Typecheck proves all old exports resolve. Compare all moved AST bodies, unchanged residual statements and retained dynamic imports; resolve new static/type/literal-dynamic edges and reject a return path. Record explicit authorization-boundary review for `buildToolBridgeMaps`. Remote full suite only; tested SHA must equal PR head, pipeline exit 0, 0 failures and retained complete output; exact-head CI rollup required before readiness.

## Accept criteria

1. All 22 declarations have exactly one owner; all 12 current exports and the existing facade subset retain names, signatures and import paths.
2. New files <=400 (131/96/13 planned), residual <=400 (392 planned); raw changeset stays <=500 after wiring/formatting or escalates before publication.
3. No global collectors, altered budget charging, extra catalog reads or changed dynamic import timing; no new return edge or Lab reachability.
4. Guidance text, roster rendering, authorization, replay deduplication and raw/parsed insertion ordering are byte/behavior preserved; no unrelated import pruning.
5. Direct and facade behavioral tests remain unchanged; designated mutation and graph guards prove red then green without weakening assertions.
6. Typecheck, focused tests, privacy scan, remote exact-head full suite, boundary review and exact-head CI evidence pass at this layer's own tip; base points to L3.

## PR

Title: `refactor(server-responses): separate collaboration map and insertion leaves (split S07 L4/4)`

Branch: `codex/split-server-responses-collaboration`. Base: `codex/split-responses-parser`. Closes: none. Fill `.github/PULL_REQUEST_TEMPLATE.md` Summary, Verification and Checklist. Depends on #TBD-S07-L1; review only this layer's diff.

| # | PR | Layer / branch | Base | Review focus |
|---|---|---|---|---|
| 4 | #TBD-S07-L4 | codex/split-server-responses-collaboration — this layer | codex/split-responses-parser | Tool maps, roster rendering, insertion |
| 3 | #TBD-S07-L3 | codex/split-server-responses-agent-task-recovery | dev | Envelope codec ownership |
| 2 | #TBD-S07-L2 | codex/split-responses-namespace-tool-compat | dev | Restoration and alias contract |
| 1 | #TBD-S07-L1 | codex/split-responses-parser | dev | Private parser leaves; size escalation |

DEV-STACK-02/03: cascade changes from the real parent `codex/split-responses-parser` (#TBD-S07-L1) into `codex/split-server-responses-collaboration` and refresh exact head/base evidence. No dependency on L2 or L3; no cascade obligation from either. Merge the parent before this layer, only with separate user authorization. No Git or PR mutation is performed by this delegated task.
