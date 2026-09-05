# 190 — S06 L1/2: vision planning and image rewriting

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Existing split implementation history; aggregate delivery pending. Original PR is not individually merged.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`. C3 architecture planning, delegated docs-only; the parent owns phase/goal/orchestration. This document is not implementation or verification evidence.
- Goal: reduce `src/vision/index.ts` from 667 lines to at most 390 while preserving every original export, cache identity, auth-selection order, caption ordering, and raw Responses alignment.
- Non-goals: no new cache API, backend changes, model/default changes, validation changes, cache fixes, function-body cleanup, consumer migrations, new tests/tooling, merge, or release.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below. Stop when the implementation layer has its own passing gates and an open exact-head-green PR; never merge.
- Escalation: stop implementation for changed source basis, an uncovered oracle, a required behavior change, cycle, leaf/residual >400, or scope expansion. Report security findings only in ignored scratch, not here. This bounded drafting task writes only this document and `200_images_artifacts.md` and runs no tests or git mutations.
- Sizing conflict for parent resolution: 667→400 alone requires moving at least 267 lines, hence at least 534 raw added+deleted lines before wiring. The selected 287-line move is a documented exception proposal to cxc-dev's DEFAULT 500-line PR threshold, **not** a claim that it satisfies 002's ≤500 changed-source-line wording. Parent must accept a move-aware sizing exception or amend the topology with another layer before execution. No unassigned `#b` is silently introduced.

Basis: docs HEAD `4cc219549`; `origin/dev` `1362b1a3841b4de20177e5d65865a513dd7936c4`. All source/test line citations are at that code basis. `git diff origin/dev -- src/vision/index.ts src/images/artifacts.ts` was empty. Read `000_plan.md`, `001_stale_check.md`, S06 rows and gate in `002_layer_map.md`, and `devlog/_plan/260905_modular_debt_ledger/014_lane_adapters_media.md` (the `src/vision/index.ts` section). The lane identifies the cache at :64–161, planner at :292–370, description execution at :536–637, and fallback at :645–667. Its cache-first suggestion is not mandatory: keeping cache plus executor together avoids exposing a mutable singleton merely to split it.

Structural decision: current callers → `vision/index.ts` → eligibility, sidecar auth, reasoning, describe transports, memory budget. Intended callers → same boundary → `plan.ts` / `image-rewrite.ts`; `plan.ts` → `image-rewrite.ts`, eligibility, reasoning, auth; execution/cache remain in the boundary. Blast radius is one feature, with existing server and management clients unchanged. Direct source callers are `src/lib/app-owned-memory-stores.ts:24`, `src/server/chat-native.ts:20`, `src/server/management/config-routes.ts:67`, `src/server/management/vision-sidecar-options.ts:11`, `src/server/responses/{collaboration,compact,core,encrypted-payload}.ts:42/41/143/40`, and `src/web-search/index.ts:3`.

Rejected alternatives: doing nothing/configuration/deletion cannot remove this structural debt while preserving behavior; a cache leaf with an exported mutable cache would split ownership; moving all execution first creates unnecessary state seams. Reuse existing eligibility, reasoning, timeout and describe owners. Searches for `planVisionSidecar`, `stripImagesInPlace`, `carriesImages`, and `syncRawBodyImageDescriptions` find their implementation only in this file. Sibling convention: `src/vision/{eligibility,reasoning,timeout-bounds}.ts` and `src/images/plan.ts`; no new convenience barrel. The existing public boundary intentionally retains logic plus named compatibility exports, as explicitly required by the train; do not turn this exception into a new internal barrel.

## Symbol inventory

Ranges include the declaration/export keyword through its closing token, excluding preceding comments. Enumerated with the installed Babel TypeScript parser over `git show origin/dev:src/vision/index.ts`, cross-checked against numbered source and `rg`. `consumers` is distinct external files using that symbol through this original boundary, counted with `rg -l -w '<symbol>'` over the resolved importer list and checked against import bindings; private symbols have 0. Namespace/data strings and imports directly from `eligibility.ts` do not count. Boundary fan-in: **24 files = 9 source + 15 tests**. Leaf abbreviations: P=`src/vision/plan.ts`, R=`src/vision/image-rewrite.ts`, I=residual `src/vision/index.ts`.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| DEFAULT_VISION_MODEL | const | 42–42 | no | 0 | P |
| DEFAULT_ANTHROPIC_VISION_MODEL | const | 43–43 | no | 0 | P |
| DEFAULT_REASONING | const | 44–44 | no | 0 | P |
| DEFAULT_MAX_DESCRIPTIONS_PER_TURN | const | 45–45 | yes | 1 | P |
| DESCRIPTION_CACHE_MAX_ENTRIES | const | 46–46 | no | 0 | I |
| VISION_DESCRIPTION_CACHE_MAX_BYTES | const | 47–47 | yes | 1 | I |
| descriptionEncoder | const TextEncoder | 48–48 | no | 0 | R (internal named export) |
| VISION_CONCURRENCY | const | 50–50 | no | 0 | I |
| DESC_MAX_CHARS | const | 52–52 | no | 0 | I |
| CONTEXT_MAX_CHARS | const | 54–54 | no | 0 | I |
| VisionDescriptionCache | interface | 56–62 | yes | 0 | I |
| BoundedLruDescriptionCache | class | 64–116 | no | 0 | I |
| descriptionCacheLimits | let | 118–121 | no | 0 | I |
| defaultDescriptionCache | function | 123–125 | no | 0 | I |
| descriptionCache | let | 127–127 | no | 0 | I |
| setVisionDescriptionCache | function | 130–132 | yes | 1 | I |
| resetVisionDescriptionCache | function | 134–136 | yes | 3 | I |
| setVisionDescriptionCacheLimitsForTests | function | 138–145 | yes | 1 | I |
| visionDescriptionRetainedStoreSnapshot | function | 147–157 | yes | 2 | I |
| evictOldestVisionDescriptionForBudget | function | 159–161 | yes | 2 | I |
| resolveMaxDescriptionsPerTurn | function | 164–169 | yes | 3 | P |
| isValidVisionTimeoutMs | function | 171–176 | yes | 1 | P |
| resolveVisionTimeoutMs | function | 179–181 | yes | 3 | P |
| runBounded | async function | 184–195 | no | 0 | I |
| clamp | function | 197–199 | no | 0 | I |
| AnthropicVisionProvider | interface | 201–204 | yes | 1 | P |
| findAnthropicVisionProvider | function | 210–214 | yes | 3 | P |
| resolveVisionBackend | function | 216–226 | yes | 1 | P |
| resolveOpenAiVisionModel | function | 229–234 | yes | 2 | P |
| resolveEffectiveVisionModel | function | 237–250 | yes | 1 | P |
| carriesImages | function | 253–255 | no | 0 | R (internal named export) |
| messagesHaveImage | function | 257–260 | no | 0 | P |
| shouldResolveOpenAiVisionSidecar | function | 262–272 | yes | 5 | P |
| VisionPlan | interface | 274–284 | yes | 2 | P |
| planVisionSidecar | function | 292–370 | yes | 7 | P |
| ImageJob | interface | 372–376 | no | 0 | I |
| renderDescription | function | 379–386 | no | 0 | I |
| IMAGE_OMITTED_TEXT | const | 388–388 | no | 0 | R |
| isPlainRecord | function | 390–392 | no | 0 | R |
| syncRawBodyImageDescriptions | function | 404–452 | no | 0 | R (internal named export) |
| sha256 | function | 454–456 | no | 0 | I |
| normalizedContext | function | 458–460 | no | 0 | I |
| descriptionIdentity | function | 462–483 | no | 0 | I |
| executeDescription | async function | 485–528 | no | 0 | I |
| describeImagesInPlace | async function | 536–637 | yes | 6 | I |
| stripImagesInPlace | function | 645–667 | yes | 6 | R |

Existing re-export declarations are part of the contract, not new implementations:

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| describeImage | re-export | 21–21 | yes | 0 | existing ./describe |
| isModelTextOnly | aliased re-export | 24–24 | yes | 6 | existing ./eligibility |
| describeImageAnthropic, parseAnthropicVisionSSE | re-exports | 25–25 | yes | 1 each | existing ./anthropic-describe |
| BASELINE_VISION_MODELS, isModelVisionSidecarConsumer, isVisionEligibleModel, isVisionSidecarConsumer, modelAcceptsImageInput, visionBackendForCandidate, visionEligibleModelOptions | re-exports | 26–34 | yes | 0 each through index | existing ./eligibility |
| VisionCandidateModel, VisionModelOption, VisionSidecarBackend | type re-exports | 35–35 | yes | 0 each through index | existing ./eligibility |
| DEFAULT_VISION_TIMEOUT_MS | imported export | 36–40 | yes | 3 | existing ./timeout-bounds |
| MAX_VISION_TIMEOUT_MS, MIN_VISION_TIMEOUT_MS | imported exports | 36–40 | yes | 4 each | existing ./timeout-bounds |

Import-declaration accounting (imported bindings are not definitions): :1 `createHash` stays I; :2 core types split between I/P/R; :3 `VisionReasoningEffort` goes P; :4 `describeImage`/`DescribeOutcome` stay I, `VisionSettings` goes P; :5–6 describe transports stay I; :7 eligibility and :8 reasoning go P; :9 unused `CodexAuthContext` is retained in I to avoid unrelated cleanup; :10 auth and :11 forward-sidecar type go P; :12 outcome-recorder, :13 memory-budget and :14 translator-budget stay I (R also needs the translator-budget type); :15–19 timeout imports go P, with direct named re-exports in I.

## Leaf partition

1. **`src/vision/plan.ts` — expected ≤210 lines.** Owns exactly P rows. Move original :42–45, :163–181, :201–250, :257–370, preserving comments and bodies: **187 original lines**, plus ≤23 import/separator lines. `messagesHaveImage` stays private; no duplicate type definition. Own imports:

   ```ts
   import type { OcxConfig, OcxContentPart, OcxParsedRequest, OcxProviderConfig } from "../types";
   import type { VisionReasoningEffort } from "../reasoning-effort";
   import type { VisionSettings } from "./describe";
   import type { ResolvedOpenAiForwardSidecar } from "../providers/openai-sidecar";
   import { isModelVisionSidecarConsumer as isModelTextOnly, modelAcceptsImageInput } from "./eligibility";
   import { normalizeVisionReasoningForModel } from "./reasoning";
   import { resolveSidecarAuth } from "../sidecar/auth";
   import { DEFAULT_VISION_TIMEOUT_MS, MAX_VISION_TIMEOUT_MS, MIN_VISION_TIMEOUT_MS } from "./timeout-bounds";
   import { carriesImages } from "./image-rewrite";
   ```

2. **`src/vision/image-rewrite.ts` — expected ≤110 lines.** Owns exactly R rows. Move :48, :252–256, :388–452, :639–667: **100 original lines**, plus ≤10 import/separator lines. `IMAGE_OMITTED_TEXT` and `isPlainRecord` remain private. Export `descriptionEncoder`, `carriesImages`, and `syncRawBodyImageDescriptions` only from this leaf for real internal consumers, not through the public boundary. Own imports:

   ```ts
   import type { OcxContentPart, OcxParsedRequest, OcxTextContent } from "../types";
   import type { TranslatorBudget } from "../lib/translator-budget";
   ```

3. **Residual `src/vision/index.ts` — expected ≤390 lines.** Exactly I rows remain, including all cache/execution ownership. Arithmetic: 667 − 187 − 100 = 380 original lines; replace original :1–40 header with at most 50 lines of imports and compatibility exports → ≤390. No `#b` is needed for residual size. Move comments with their owners; do not collapse body formatting to hit the bound. Expected combined maximum is 710 = 390 + 210 + 110; the ≤43 net extra lines are import/export/separator allowance, not duplicated logic.

In-memory physical-line accounting using these exact ranges and the import/export blocks below produced **P=200, R=106, residual=381** (687 total = 667 + 20 wiring lines). The larger bounds above leave formatting room; they are not measured implementation results. Adding `export` to the three cross-leaf helper declarations changes no line count.

## Re-export block

Exact compatibility exports in `src/vision/index.ts` (existing local exported declarations in I remain untouched):

```ts
export { describeImage } from "./describe";
export { isModelVisionSidecarConsumer as isModelTextOnly } from "./eligibility";
export { describeImageAnthropic, parseAnthropicVisionSSE } from "./anthropic-describe";
export {
  BASELINE_VISION_MODELS,
  isModelVisionSidecarConsumer,
  isVisionEligibleModel,
  isVisionSidecarConsumer,
  modelAcceptsImageInput,
  visionBackendForCandidate,
  visionEligibleModelOptions,
} from "./eligibility";
export type { VisionCandidateModel, VisionModelOption, VisionSidecarBackend } from "./eligibility";
export { DEFAULT_VISION_TIMEOUT_MS, MAX_VISION_TIMEOUT_MS, MIN_VISION_TIMEOUT_MS } from "./timeout-bounds";
export {
  DEFAULT_MAX_DESCRIPTIONS_PER_TURN,
  resolveMaxDescriptionsPerTurn,
  isValidVisionTimeoutMs,
  resolveVisionTimeoutMs,
  findAnthropicVisionProvider,
  resolveVisionBackend,
  resolveOpenAiVisionModel,
  resolveEffectiveVisionModel,
  shouldResolveOpenAiVisionSidecar,
  planVisionSidecar,
} from "./plan";
export type { AnthropicVisionProvider, VisionPlan } from "./plan";
export { stripImagesInPlace } from "./image-rewrite";
```

Re-exports bind nothing locally. Replacement residual imports, including the existing dependencies still needed by I:

```ts
import { createHash } from "node:crypto";
import type { OcxContentPart, OcxMessage, OcxParsedRequest, OcxTextContent } from "../types";
import { describeImage, type DescribeOutcome } from "./describe";
import { describeImageAnthropic } from "./anthropic-describe";
import { describeImageRouted } from "./routed-describe";
import type { CodexAuthContext } from "../codex/auth-context";
import type { SidecarOutcomeRecorder } from "../web-search/executor";
import { enforceAppOwnedMemoryBudget } from "../lib/app-owned-memory";
import type { TranslatorBudget } from "../lib/translator-budget";
import type { VisionPlan } from "./plan";
import { carriesImages, descriptionEncoder, syncRawBodyImageDescriptions } from "./image-rewrite";
```

## Module-level state and cycles

- `descriptionCacheLimits` (:118–121) and `descriptionCache` (:127) have exactly one owner: residual I, alongside setters (:130–145), snapshots/eviction (:147–161), and reads/writes (:572, :605). No new getter, exported live mutable binding, cache copy, or closure snapshot.
- `BoundedLruDescriptionCache.entries` (:65) and `.bytes` (:66) are instance fields, not module-level Maps; ownership remains in I. Default construction still occurs once at module load. `descriptionEncoder` (:48) moves once to R; I uses the same stateless encoder object for cache accounting (:85) and transient reservations (:628), while strip uses it inside R (:657).
- All other top-level consts are scalar policy values except `IMAGE_OMITTED_TEXT` (string); no top-level Set, WeakMap, lock, timer or other mutable collection exists. The `inFlight` Map (:565), counters and resolver closures remain request-local in `describeImagesInPlace`.
- Graph: I→P; I→R; P→R; R→types/translator-budget (type-only). Never R→P/I or P→I, even for types. P imports `VisionSettings` directly from `describe`, not I. Auth and reasoning are called at the same places in the moved planner; import relocation must not add auth reads at module load.
- Lane G1 found no cycle for this module. During implementation re-run the lane's in-memory resolved import-graph walk (including type edges) on I/P/R and require no return path; no new dependency installer or generated graph file. The new edge is functional; plan→rewrite uses the existing role predicate. Cache temporal coupling stays co-located, and raw-message synchronization remains sequentially after replacement.

## Tests

Exact direct-import `rg -l` list (all **unchanged**, original `../../src/vision` import path retained):

```text
tests/claude-integration/claude-sidecar-override.test.ts
tests/cli/cli-models.test.ts
tests/codex-integration/app-owned-memory.test.ts
tests/gui/vision-sidecar-timeout-bounds.test.ts
tests/providers/nvidia-nim-hardening.test.ts
tests/routing/routing-capability-model-matching.test.ts
tests/vision/sidecar-auth.test.ts
tests/vision/sidecar-settings-vision-controls.test.ts
tests/vision/vision-anthropic.test.ts
tests/vision/vision-cache.test.ts
tests/vision/vision-fail-closed.test.ts
tests/vision/vision-reasoning-contract.test.ts
tests/vision/vision-routed.test.ts
tests/vision/vision-sidecar-e2e.test.ts
tests/vision/vision-text-only-predicate.test.ts
```

Reproduce with `rg -l 'from "[^" ]*/vision(/index)?(\.ts)?"' tests -g '*.test.ts' | sort`. Search full target paths and split path segments separately for source readers. **No target-specific body-text oracle was found**; `001`'s broad `index.ts` count of 47 is not 47 readers of this file. `tests/routing/routing-capability-model-matching.test.ts:14` is a source-location comment, not a source read. Reads in vision-reasoning-contract :177/:183 and sidecar-settings-vision-controls :65 are generated config JSON, not this module.

Recursive source oracles that DO read this file, with exact read sites:

| test | read site | disposition |
|---|---|---|
| `tests/lab/core-lab-boundary.test.ts` | :69 `readFileSync(current, "utf8")`; reached via `src/server/responses/core.ts:143` | unchanged; named imports/re-exports automatically include both new leaves; never edit PROTECTED (:20–27) |
| `tests/codex-integration/codex-history-reachability.test.ts` | :100 import scan and :114 mutator scan; recursive source enumeration :54–61 | unchanged; both leaves automatically scanned; no allowlist expansion |
| `tests/windows/windows-popup-fix.test.ts` | :139 `readFileSync(file, "utf8")`; recursive runtime enumeration :121–129 | unchanged; both leaves automatically scanned |

There is no explicit scan list to extend and no retarget-to-leaf operation. Before/after implementation confirm these walkers actually include the new paths, rather than accepting an empty match set. Parent correction required outside this task's write scope: `002_layer_map.md`'s S06 thesis still says “47 text oracles retargeted”; replace that with zero target-specific retargets and the three recursive guards above after accepting this inventory.

Guards to drive red once during C (not during this drafting task): change R's `carriesImages` to exclude `user` and require `vision-fail-closed.test.ts:18` to fail; temporarily suppress raw synchronization and require the raw-body cases in `vision-sidecar-e2e.test.ts` to fail; change P's cap resolver to lose explicit zero and require `vision-cache.test.ts:133` to fail. For the transitive boundary guard, temporarily add a direct Lab import to R and require core-lab-boundary's :284 case to fail, then restore it without changing PROTECTED. Never commit fault injections. Existing cache identity/LRU cases :166/:323/:347 stay unchanged.

## Verification

Draft validation actually performed: a read-only `bun -e` parser check matched all **46** definition rows against original start/end lines, confirmed the nine required headings in order, parsed every TypeScript snippet, and counted the proposed partition entirely in memory. `git diff --no-index --check /dev/null devlog/_plan/260905_now_split_train/190_vision_index.md` reported no whitespace errors. These are documentation checks, not tests or typechecking.

Future executor only; **no commands below were run by this docs task**. Execute at this layer's exact tip, not L2's tip:

```sh
bun run typecheck
bun test tests/vision
bun test tests/claude-integration/claude-sidecar-override.test.ts tests/cli/cli-models.test.ts tests/codex-integration/app-owned-memory.test.ts tests/gui/vision-sidecar-timeout-bounds.test.ts tests/providers/nvidia-nim-hardening.test.ts tests/routing/routing-capability-model-matching.test.ts
bun test tests/lab/core-lab-boundary.test.ts tests/codex-integration/codex-history-reachability.test.ts tests/windows/windows-popup-fix.test.ts
bun run privacy:scan
wc -l src/vision/plan.ts src/vision/image-rewrite.ts src/vision/index.ts
rg -l 'from "[^" ]*/vision(/index)?(\.ts)?"' src gui/src scripts tests -g '*.ts' -g '*.tsx' | sort
```

The final importer list must remain the same 24 files; symbol-import sets and all preexisting named/type exports must remain identical. Typecheck proves bindings resolve, not that unused public exports were preserved: compare the original AST export inventory against the post-split boundary explicitly. Run the lane G1 graph walk and archive zero return paths for all three owned modules. Core-lab testing is included despite no protected-file edit because `core.ts` already reaches these leaves. No GUI changes, so no GUI build/visual work is added.

Full suite only on `lidge`, with the branch and exact fetched SHA recorded. Use pipefail and retain the suite log so `tail` cannot hide test failure (002's abbreviated pipeline alone does not preserve it):

```sh
ssh lidge 'bash -lc '\''set -o pipefail; cd ~/ocx-ci/opencodex && git fetch origin codex/split-vision-index && git checkout -q FETCH_HEAD && git rev-parse HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tee /tmp/ocx-S06-L1-tests.log | tail -15'\'''
```

Require exit 0, zero failures, full log inspection, and equality with the PR head SHA. Parent coordinates exclusive use of that remote checkout. Before ready-for-review record exact-head CI rollup plus the focused results, privacy result, line counts, graph and public-export comparison. No local full suite.

## Accept criteria

1. Source basis is rechecked before moving; changes are confined to I, P, R and authorized layer documentation. Existing callers and tests retain import paths.
2. Every declaration above has exactly one owner; no body, signature, default, error text, cache key or authorization predicate changes.
3. New files are ≤210/110 and residual ≤390 (hard maximum 400 for every file), measured with `wc -l`; all 287 moved original lines are accounted for once.
4. All original runtime/type exports—including eligibility aliases and unused public symbols—remain importable from `src/vision`; internal encoder/predicate/sync exports are not added to that boundary.
5. Cache reset/eviction/insertion share the original singleton; raw `_rawBody` and parsed image replacement tests pass; no new module cycle or Lab reachability.
6. All three recursive source guards scan both leaves unchanged; specified fault injections fail their guards once and restored code passes.
7. Every per-layer gate above passes at the layer head, remote suite SHA matches PR head, and no merge/release occurs.
8. Parent resolves the >500 raw-line sizing conflict before execution; a changed topology requires a revised plan, not an implicit exception to 002.

## PR

Title: `refactor(vision): separate planning and image rewriting (split S06 L1/2)`

Branch: `codex/split-vision-index`. Base: `dev`. Closes: none.

Fill the repository PR template's Summary, Verification and Checklist. Include this full DEV-STACK-03 map; placeholders are for future PR numbers only:

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 2 | #TBD-S06-L2 | images artifacts | codex/split-images-artifacts | dev | storage/HTTPS leaves, original artifact API |
| 1 | #TBD-S06-L1 | vision ← you are here | codex/split-vision-index | dev | planning/rewrite leaves, co-located cache |

Base: dev — no dependency on the layers below; no cascade obligation.

Review only this layer's diff. S06 groups execution order and PR navigation under `003_parent_decisions.md` STACK-INDEPENDENCE-01; both layers are independent PRs against dev. This train stops with open PRs and never merges.

## P stale-check (2026-09-05, wp190)

origin/dev 24cc558d5; src/vision/index.ts unchanged since 445742966 (667 lines); anchors 42/45/48/118/127/163/181/201/250/252/256/257/370/388/452/639/667 confirmed by sed. Base `dev` (S06 independent; 003 S06-ORACLE-01 already applied to 002). Executor rules: no bun run test; OCX_TEST_NO_QUEUE=1; CI hygiene requires a test change.

## A amendment (Arendt audit, GO-WITH-FIXES blockers=2 → folded)

1. Sizing: the Loop-spec escalation and Accept-criteria wording about a 500-line raw cap are void; the binding gate is 003 PURE-MOVE-SIZE-01 (non-move diff ≤150; move-aware diff + exactly-once symbol inventory as evidence). Audit measured ≤100 non-move lines for this layer.
2. Test change: "all tests unchanged" applies to existing assertions and import paths only. This layer, like every layer in the train, extends one existing focused test (tests/vision/vision-cache.test.ts) with a seam-identity + zero-cycle guard so the CI hygiene rule `missing_regression_test` passes; that is the authorized test-change scope. No new test file, no layout-manifest edit.
Audit-verified structure: 46/46 declaration ranges, 17/17 header exports, P=187/R=100/I=340 partition covering 41–667 once, 38 boundary exports preserved, P imports exactly 15 bindings, R exactly 4, residual replacement imports cover all 16 used bindings (CodexAuthContext retained, pre-existing unused), no return path in a 347-module walk incl. type edges. Red-drive targets confirmed: vision-fail-closed:18, vision-sidecar-e2e:138/:228, vision-cache:133, core-lab-boundary:284 (needs a runtime Lab import in R).

## Execution record (B/C/D, 2026-09-05)

- Executor worktree: `/tmp/ocx-split-190.whV1dc/wt` (branch `codex/split-vision-index`, base origin/dev 24cc558d5). Executor: gpt-6-astra high (Linnaeus, 01a06f41-7f42-73e1-b715-b9bf2a0ed5bb).
- Commits: d39ee6ee1 (move: plan.ts 200, image-rewrite.ts 106, index.ts 381) and 51f5a82d7 (test: vision-cache.test.ts +13 — seam identity for resolveMaxDescriptionsPerTurn and stripImagesInPlace via both paths; leaves have no back-edge to index/plan). Diff: 4 files, +338/−305. 24 original-path importers unchanged; 38 boundary exports preserved.
- Local gate: typecheck 0; guards (core-lab-boundary, codex-history-reachability, windows-popup-fix) 27/0; privacy passed. Focused tests/vision + 6 importers: 254 pass / 2 fail. The 2 failures (sidecar-settings-vision-filter "10. GET exposes only catalog rows…" and vision-reasoning-contract "native management rows expose vision-safe reasoning ladders") are **pre-existing and environment/order-dependent**: main agent reproduced the identical 2 failures on a pristine origin/dev worktree running `tests/vision` together (170 pass / 2 fail), while both files pass 19/0 when run alone on either tree. Not caused by this layer; lidge full suite is the arbiter. tests/gui/vision-sidecar-timeout-bounds.test.ts errors locally only because the backend node_modules symlink has no react (GUI deps).
- Red-drives: (a) carriesImages excludes user → vision-fail-closed:20 fails, restored 2/0; (b) resolveMaxDescriptionsPerTurn loses 0 → vision-cache:134 fails (8 vs 0), restored 15/0; (c) runtime lab import in image-rewrite → core-lab-boundary:288 chain core → vision/index → image-rewrite → lab/paths, restored 17/0.

- Adversarial diff review (Gibbs, gpt-6-astra high, 01a06f46-ab23-7053-bcfa-b7ff0256810e): VERDICT: PASS (slices byte-exact, residual exact, 38/38 exports incl. 6 types and the isModelTextOnly alias, 348-module graph zero return paths, cache state single-owned, non-move ≤119). Qualification recorded: sidecar-settings-vision-filter case 10 does call the moved-but-byte-identical findAnthropicVisionProvider (plan.ts:45) via config-routes.ts:117; vision-reasoning-contract's ladder case does not touch moved code. Both failures are order-dependent on pristine dev and absent on the full remote suite.
- lidge full suite at 51f5a82d7: SUITE_EXIT=0, 18018 pass / 0 fail / 16 skip (/tmp/suite-split-190.log) — the arbiter for the two local order-dependent failures.
- PR: https://github.com/lidge-jun/opencodex/pull/3577 (base dev, head 51f5a82d7). CI rollup at record time: OPEN draft=false 51f5a82d7 =1 =5 SKIPPED=2 SUCCESS=21
