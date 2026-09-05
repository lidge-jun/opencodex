# S07 L1/4 — Responses parser leaves

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Existing split implementation history; aggregate delivery pending. Original PR is not individually merged.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`; C3 boundary planning, docs-only delegated work.
- Goal: move content, tool-definition and text-format translation to named siblings while preserving the sole public `parseRequest` export.
- Non-goals: changing validation, tool catalog precedence, replay state, reasoning ownership, signatures, error strings, logging, or the body of `parseRequest`; no implementation, tests, Git mutations or orchestration in this drafting task.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below. This is a proposed execution gate, not a claim it ran.
- Stop: documents are complete when declarations, imports, counts and consumers are accounted for. Implementation is **not ready** until the parent resolves the size conflict below; then stop at an exact-head green open PR, never merge.
- Escalation: `src/responses/parser.ts:398–861` is one **464-line function**. Pure declaration moves cannot put it in any <=400-line file. Proposed L1 leaves leave **561 lines**; a provisional **S07 L1#b parser request-body decomposition** must take the rest, but no such layer exists in 002. Parent must authorize statement/helper extraction and a topology amendment, or explicitly accept the remaining debt. Do not silently invent a fifth branch. L1 also moves 325 existing lines, so raw additions+deletions exceed the 500-line changeset guideline; parent must split the implementation further or approve a pure-move size exception. Neither exception is presumed here.

Basis: docs HEAD `4cc219549`; all source coordinates below are `origin/dev` = `1362b1a38`. `git diff origin/dev -- src/responses/parser.ts` was empty. Lane evidence: `devlog/_plan/260905_modular_debt_ledger/011_lane_server_responses.md:193`.

Structural map: `src/index.ts`, `src/lab/conformance/executor.ts`, `src/server/responses/{core,compact,encrypted-payload,collaboration}.ts` and 43 tests -> existing `parser.ts` -> schema/state/reasoning and synthetic-tool modules. Intended: those callers still -> `parser.ts` -> content/tools/text-format leaves; tools and format -> content predicate, never back to parser. Local feature blast radius; no package entry or request contract changes. Reject moving `parseRequest` whole to a new file: it merely relocates the violation. Deletion/configuration does not meet the split request. Reuse existing schema, synthetic-tool and tool-search owners, not a generic utility abstraction.

## Symbol inventory

Ranges are inclusive declarations (comments outside declarations are assigned separately below), measured with `sg run --lang ts --kind 'function_declaration,type_alias_declaration,interface_declaration,lexical_declaration,class_declaration' src/responses/parser.ts --json=compact`, cross-checked with `git show origin/dev:src/responses/parser.ts | nl -ba` and anchored `rg`. Imports at 1–23 are dependencies, not owned declarations.

Consumer counts mean distinct external direct importer/re-exporter files in `src gui/src scripts tests` that reference the symbol, found by resolving literal `from`/`import()` paths and applying `rg -l -w SYMBOL` to those files. Not raw identifier occurrences or unrelated homonyms. Private symbols have zero external consumers. Module fan-in: **49** files (6 source + 43 tests).

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| isObj | function | 25–27 | no | 0 | parser-content.ts |
| replayThoughtSignatureMetadata | function | 36–42 | no | 0 | residual parser.ts |
| InputBlock | type | 44–49 | no | 0 | parser-content.ts |
| nonEmptyString | function | 52–54 | no | 0 | parser-content.ts |
| inputContentParts | function | 56–105 | no | 0 | parser-content.ts |
| OutputBlock | type | 107–107 | no | 0 | parser-content.ts |
| outputTextOf | function | 109–124 | no | 0 | parser-content.ts |
| mapToolChoice | function | 126–149 | no | 0 | parser-tools.ts |
| allowedToolName | function | 151–158 | no | 0 | parser-tools.ts |
| buildTools | function | 160–278 | no | 0 | parser-tools.ts |
| ensureAssistantPlaceholder | function | 280–286 | no | 0 | residual parser.ts |
| outputToToolResultContent | function | 293–314 | no | 0 | parser-content.ts |
| toolOutputContainsEncryptedContent | function | 316–318 | no | 0 | parser-content.ts |
| normalizeImageDetail | function | 324–326 | no | 0 | parser-content.ts |
| findToolById | function | 328–337 | no | 0 | residual parser.ts |
| attachPendingReasoningToCallOwner | function | 347–365 | no | 0 | residual parser.ts |
| REASONING_EFFORTS | const Set | 367–367 | no | 0 | residual parser.ts |
| customToolNamespaces | function | 379–396 | no | 0 | parser-tools.ts |
| parseRequest | function | 398–861 | yes | 49 | residual parser.ts |
| parseTextFormat | function | 869–883 | no | 0 | parser-text-format.ts |

## Leaf partition

Sibling convention inspected: `src/responses/tool-groups.ts`, `tool-search-compat.ts`, `provider-opaque-metadata.ts`; existing domain-named siblings and `src/config/*.ts` / `src/types/*.ts`, no new index barrel.

1. `src/responses/parser-content.ts`: `isObj`, `InputBlock`, `nonEmptyString`, `inputContentParts`, `OutputBlock`, `outputTextOf`, `outputToToolResultContent`, `toolOutputContainsEncryptedContent`, `normalizeImageDetail`. Move original ranges **25–27, 44–124, 288–326** = 123 lines, including comments. Add one import and one separating blank = **125 lines**. Export only the five functions imported below; keep block types and remaining helpers private.

   ```ts
   import type { OcxContentPart, OcxTextContent } from "../types";
   ```

2. `src/responses/parser-tools.ts`: `mapToolChoice`, `allowedToolName`, `buildTools`, `customToolNamespaces`. Move **126–278, 369–396** = 181 lines; five imports + one blank = **187 lines**. Export `mapToolChoice`, `buildTools`, `customToolNamespaces`; retain the nested callbacks in `buildTools` unchanged.

   ```ts
   import type { OcxRequestOptions, OcxTool } from "../types";
   import { isObj } from "./parser-content";
   import { WEB_SEARCH_TOOL_NAME } from "../web-search/synthetic-tool";
   import { buildImageTool, IMAGE_GEN_TOOL_NAME } from "../images/synthetic-tool";
   import { toolSearchDescription, toolSearchParameters } from "./tool-search-compat";
   ```

3. `src/responses/parser-text-format.ts`: `parseTextFormat`, including its leading comment, **863–883** = 21 lines; two imports + one blank = **24 lines**.

   ```ts
   import type { OcxRequestOptions } from "../types";
   import { isObj } from "./parser-content";
   ```

Residual: preserve all other text, including original imports 1–23, and add the three local import lines below: **883 - 325 + 3 = 561 lines**. Total planned footprint **125 + 187 + 24 + 561 = 897 = 883 + 14** import/spacing lines. This count does not hide comment removal or reformatting. All three leaf groups have zero current external consumers, so the lowest-churn private leaves move first. The provisional parent-owned L1#b must remove at least 161 net residual lines; reducing just the 464-line function below 400 is not sufficient to meet the entire file budget. No final #b count can honestly be committed until the parent authorizes and designs that non-whole-declaration seam.

## Re-export block

No existing export moves in this layer: `export function parseRequest(...)` remains at the original path with its exact signature and implementation. Therefore the exact added public re-export block is **empty**; do not export new private helpers from the public path merely to make a barrel. `src/index.ts:2` stays unchanged. The required explicit residual imports are:

```ts
import { isObj, inputContentParts, outputTextOf, outputToToolResultContent, toolOutputContainsEncryptedContent } from "./parser-content";
import { mapToolChoice, buildTools, customToolNamespaces } from "./parser-tools";
import { parseTextFormat } from "./parser-text-format";
```

These are actual local bindings; an `export { ... } from` would not satisfy the call sites. Existing residual imports are deliberately retained in this pure move to avoid assuming unused runtime imports have no evaluation effects; pruning them is not bundled cleanup.

## Module-level state and cycles

- `REASONING_EFFORTS` at `src/responses/parser.ts:367` has exactly one owner, residual `parser.ts`; no copied Set in a leaf.
- No top-level `let`, Map, WeakMap, lock or timer. Sets/Maps at 380, 768–769, 778 and pending reasoning at 417 are request/function-local and remain in their original call lifetime.
- `isObj` is shared functional coupling: tools and text-format import its sole content owner. Having the content leaf import it from the old parser would create `parser -> content -> parser`; explicitly forbidden, including type-only back edges.
- Replay metadata lookup, prior-response-prefix lookup, schema validation and the single `Date.now()` stay in `parseRequest`'s existing sequence. Moving these into a state factory is outside this layer.
- Lane 011 reported no cycle in its static/type/literal-dynamic graph. Recheck the changed reachable graph at implementation tip; no new leaf may import `parser.ts`, `src/index.ts` or the server responses facade. The original Lab consumer is a downward consumer, not permission to import Lab from parser leaves.

## Tests

Direct importers: `rg -l 'responses/parser["\x27]' tests | sort`, **43 files**, all **unchanged**, importing the original public path:

```text
tests/adapters/adapter-buffered-tool-conformance.test.ts
tests/adapters/adapter-tool-conformance.test.ts
tests/adapters/anthropic/anthropic-error-body.test.ts
tests/adapters/anthropic/anthropic-reasoning.test.ts
tests/adapters/anthropic/anthropic-thinking-signature.test.ts
tests/adapters/bridge-raw-reasoning-hidden.test.ts
tests/adapters/google/gemini-web-search.test.ts
tests/adapters/google/google-adapter.test.ts
tests/adapters/google/google-signature-history-roundtrip.test.ts
tests/claude-integration/claude-inbound.test.ts
tests/claude-integration/claude-sidecar-override.test.ts
tests/codex-integration/compatibility-manifest.test.ts
tests/codex-integration/multi-agent-compat.test.ts
tests/e2e-style/phase100-native-parity.test.ts
tests/providers/cursor/cursor-native-exec-policy.test.ts
tests/providers/cursor/cursor-request-builder.test.ts
tests/providers/cursor/cursor-tool-choice.test.ts
tests/providers/deepseek-reasoning-replay-gaps.test.ts
tests/providers/exa-web-search.test.ts
tests/providers/kiro/kiro-adapter.test.ts
tests/providers/kiro/kiro-reasoning-roundtrip.test.ts
tests/providers/nvidia-nim-hardening.test.ts
tests/providers/xai/xai-transport.test.ts
tests/providers/xai/xai-web-search.test.ts
tests/responses/chat-completions-endpoint.test.ts
tests/responses/responses-compaction.test.ts
tests/responses/responses-custom-tool-guidance.test.ts
tests/responses/responses-forward-posit-continuation.test.ts
tests/responses/responses-parser-agent-message.test.ts
tests/responses/responses-parser-malformed-content.test.ts
tests/responses/responses-parser.test.ts
tests/responses/responses-state.test.ts
tests/responses/responses-tool-conformance.test.ts
tests/vision/sidecar-abort.test.ts
tests/vision/vision-anthropic.test.ts
tests/vision/vision-cache.test.ts
tests/vision/vision-fail-closed.test.ts
tests/vision/vision-sidecar-e2e.test.ts
tests/web-search/web-search-anthropic.test.ts
tests/web-search/web-search-backend-union.test.ts
tests/web-search/web-search-timeout-contract.test.ts
tests/web-search/web-search-timeout-plan.test.ts
tests/web-search/web-search.test.ts
```

Source-oracle search: literal `parser.ts`, `responses/parser`, and segmented `repoPath`/`join` paths among `readFileSync`, `Bun.file`, `source(` readers found **no direct parser-text oracle**, matching lane 011. Two transitive source readers must still be preserved:

| test and exact read | disposition | coverage |
|---|---|---|
| `tests/lab/core-lab-boundary.test.ts:69` (`readFileSync(current, "utf8")`) | unchanged | Runtime graph follows new imports automatically; do not edit PROTECTED roots. |
| `tests/codex-integration/compatibility-manifest.test.ts:61` (`readFileSync(current, "utf8")`) | unchanged | Reachable-source scanner includes all three leaves automatically. |

No retarget-to-leaf or explicit add-leaf-to-scan-list is needed. At C, drive the graph guards red once using a temporary forbidden edge in a reachable new leaf (Lab edge for core-Lab guard; compatibility edge for compatibility guard), restore the exact file, then green. Also temporarily break image-detail normalization in `parser-content.ts` and verify the existing parser regression fails before restoring it. Do not add or weaken source-string assertions to bypass the size conflict. No new test file or test-layout entry is planned.

## Verification

Execution-only after parent disposition of L1; none run during drafting. The 002 gate is instantiated as:

```sh
bun run typecheck
bun test tests/responses tests/adapters tests/claude-integration tests/codex-integration tests/providers tests/vision tests/web-search tests/e2e-style/phase100-native-parity.test.ts
bun run privacy:scan
bun test tests/lab/core-lab-boundary.test.ts
wc -l src/responses/parser-content.ts src/responses/parser-tools.ts src/responses/parser-text-format.ts src/responses/parser.ts
rg -n 'from "[^"]*/responses/parser"' src gui/src scripts tests | wc -l
ssh lidge 'set -o pipefail; cd ~/ocx-ci/opencodex && git fetch origin codex/split-responses-parser && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'
```

Original-path module fan-in remains 49 (all are static imports/re-exports here); additionally resolve the symbol imports, not just the printed line count. Require remote tested HEAD = pushed PR head and 0 failures; `pipefail` prevents `tail` hiding test failure. Capture full runner output as well as summary. Full suite is remote only. Inspect static imports/re-exports, type-only edges and literal dynamic imports from each new leaf for a return path to parser; no new cycle. Compare moved AST bodies ignoring only added `export` modifiers/import wiring. Record exact-head CI rollup before readiness.

## Accept criteria

1. All 20 owned declarations occur exactly once; original `parseRequest` remains importable through both old paths and keeps its body/signature.
2. Content/tools/format leaves measure <=400 (planned 125/187/24); sole Set owner stays residual.
3. No behavior, string, schema, timing or state-lifetime delta; new dependencies have no back edge or Lab path.
4. All listed behavioral tests retain their original imports and assertions; both graph guards fail under the temporary forbidden edge and pass after restoration.
5. Typecheck, privacy scan, focused tests, remote exact-head full suite and exact-head CI succeed with recorded evidence.
6. **Blocked until parent decision:** residual 561 cannot satisfy the 400-line terminal objective. Record approved L1#b topology and statement-level seam, or an explicit debt exception; never mark this row resolved just because private leaves moved. Resolve the >500 raw-diff issue at the same gate.

## PR

Title: `refactor(responses): isolate parser translation leaves (split S07 L1/4)`

Branch: `codex/split-responses-parser`. Base: `dev`. Closes: none.
Use `.github/PULL_REQUEST_TEMPLATE.md` Summary, Verification and Checklist. This proposed stack remains the assigned four layers; the unresolved #b is not a fictitious open PR. Review only the current layer diff. No push/PR/merge is performed by this delegated drafting task.

| # | PR | Layer / branch | Base | Review focus |
|---|---|---|---|---|
| 4 | #TBD-S07-L4 | codex/split-server-responses-collaboration | codex/split-responses-parser | Tool maps, roster rendering, insertion |
| 3 | #TBD-S07-L3 | codex/split-server-responses-agent-task-recovery | dev | Envelope codec ownership |
| 2 | #TBD-S07-L2 | codex/split-responses-namespace-tool-compat | dev | Restoration and alias contract |
| 1 | #TBD-S07-L1 | codex/split-responses-parser — this layer | dev | Private parser leaves; size escalation |

Base: dev — no dependency on lower layers; this layer is the parent of 240 (branch based on it), so any change here cascades into that layer with `git rebase --update-refs` + `--force-with-lease` before review (DEV-STACK-02).

Merge requires separate user authorization. This delegated task performs no Git or PR mutation.

## P stale-check (2026-09-05, wp210)

origin/dev 526d4bf64; parser.ts unchanged since 445742966 (883 lines); anchors 25/27/44/124/126/278/288/326/369/396/398/863/883 confirmed by sed. Base `dev` (S07 bottom; 240 collaboration chains on it). RESIDUAL-FN-01 applies (003): the 561-line residual is accepted this layer because `parseRequest` alone is 464 lines; recorded as `RESOLVABLE_AFTER(design:L1-parse-request-extraction)` for the ledger. Executor rules: no bun run test; OCX_TEST_NO_QUEUE=1; CI hygiene requires a test change (extend tests/responses/responses-parser.test.ts).

## Execution record (B/C/D, 2026-09-05)

- Executor worktree: `/tmp/ocx-split-210.Hyb8ZV/wt` (branch `codex/split-responses-parser`, base origin/dev 526d4bf64/a594a7f21 — parser.ts identical). Executor: gpt-6-astra high (Noether, 01a06f50-337b-7851-87f0-bdd999315e1a).
- Commits: 0c554d540 (move: parser-content.ts 127, parser-tools.ts 188, parser-text-format.ts 24, parser.ts 561), 824ec33d5 (test: responses-parser.test.ts +13 — buildTools/parseTextFormat via leaves; leaves have no ./parser import), 3793fb032 (main agent: dropped the trailing blank line at parser.ts EOF flagged by `git diff --check`; residual 560). Diff: 5 files.
- Residual 560 > 400 is accepted under 003 RESIDUAL-FN-01 (parseRequest 398–861, 464 lines) → ledger verdict `RESOLVABLE_AFTER(design:L1-parse-request-extraction)`.
- Local gate: typecheck 0; focused (8 files) 166 pass / 0 fail; guards (core-lab-boundary + compatibility-manifest) 23/0; privacy passed; 49 original-path importers unchanged.
- Red-drives: (a) normalizeImageDetail identity → responses-parser.test.ts:610 fails (original vs high), restored; (b) lab import in parser-content → core-lab-boundary:288 chain core → parser → parser-content → lab/paths, restored; (c) compatibility import in parser-content → compatibility-manifest:191 fails, restored 23/0.

- Adversarial diff review (Godel, gpt-6-astra high, 01a06f54-e186-7ab0-94c0-521de2a16468): VERDICT: PASS (slices exact, residual byte-identical incl. dropped line 862, parseRequest byte-identical over 464 lines, export inventory exactly [parseRequest], no new cycles).
- lidge full suite at 3793fb032: SUITE_EXIT=0, 18061 pass / 0 fail / 16 skip (/tmp/suite-split-210.log).
- PR: https://github.com/lidge-jun/opencodex/pull/3580 (base dev, head 3793fb032). CI rollup at record time: OPEN draft=false 3793fb032 =1 =18 SKIPPED=2 SUCCESS=6
