# 080 — S03 L1/3: image normalization cache and codec

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Existing split implementation history; aggregate delivery pending. Original PR is not individually merged.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

Evidence basis: docs HEAD `4cc219549`; `origin/dev=1362b1a3841b4de20177e5d65865a513dd7936c4`. All source ranges below are at that code basis, not hypothetical post-move line numbers. `git diff origin/dev -- src/adapters/anthropic.ts src/adapters/anthropic-image-normalize.ts` was empty. Read 000, 001, 002 and lane 014 before planning. This delegated C3 docs-only task does not run tests, mutate git, or own CXC orchestration.

## Loop spec

- Archetype: `pure-move`.
- Goal: split `src/adapters/anthropic-image-normalize.ts` (518 lines) into one cache/codec owner and the existing wire-neutral orchestration/public boundary, both ≤400 lines.
- Non-goals: no cache-key, TTL, eviction, tier, concurrency, image-quality, decode-guard, retry, overflow or callback semantics changes; no new configuration/dependencies; no edits to callers or the memory-store registry.
- Verifier: 002_layer_map.md **Per-layer gate**, instantiated below.
- Stop: standalone layer passes the gate and exact-head CI is recorded by its executor; never merge. For this delegated task, stop after the three requested docs are checked.
- Escalation: report source drift, any leaf >400, a new cycle, missing export, or need for a new mutation seam. In particular, 299 physically moved lines alone mean ≥598 raw added+deleted lines. The 002 ≤500 changed-source-lines constraint cannot be claimed satisfied under ordinary numstat counting. Parent must approve an explicit pure-move size exception or revise the layer map before execution; this document does not silently authorize either.

Structural decision (cxc-dev-architecture): lane 014:403–416 identifies the cache/codec seam and shared hooks. Reject a cache-only extraction: `encodeCalls++` at source:328 would require a new cross-module mutator if its owner moved away from the encoder loop. Move the whole cache plus `processAt` together instead. Reject deletion/configuration: both would change behavior. Reuse the existing guard and memory-budget APIs, not a new image abstraction.

Current map: `src/adapters/anthropic.ts:21`, `src/adapters/kiro-images.ts:2`, `src/server/claude-messages.ts:12`, and `src/lib/app-owned-memory-stores.ts:17–20` → original boundary → image guard / memory-budget core. Intended map: the same consumers → original boundary → codec → guard / memory-budget core. Feature-local blast radius, no external import migration. Sibling naming follows `anthropic-image-guard.ts`, `anthropic-output-schema.ts`, and `google-tool-schema.ts`; no convenience index barrel is added. The ingress ownership invariant remains the one in `structure/04_transports-and-sidecars.md:1404`.

## Symbol inventory

Declaration ranges came from `git show origin/dev:<path>` parsed in memory with the installed `@babel/parser` TypeScript parser, cross-checked against `nl -ba` / `rg -n` source reads. Tables include every top-level function, variable, type and interface declaration; imports are dependencies, recorded separately below. Consumer count means distinct other files importing/re-exporting that binding from this exact module: `rg -l '<basename>' src gui/src scripts tests -g '*.ts' -g '*.tsx'` supplies candidates, then import specifiers are resolved and counted. Comments, fixture path strings, unrelated OAuth modules named anthropic, and same-file references are excluded. Private declarations have zero external consumers, not zero internal uses.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `TierSpec` | interface | 26–31 | yes | 0 | `anthropic-image-codec.ts` |
| `KiB` | const | 33–33 | no | 0 | `anthropic-image-codec.ts` |
| `MiB` | const | 34–34 | no | 0 | `anthropic-image-codec.ts` |
| `TIER_SPECS` | const | 41–48 | yes | 2 | `anthropic-image-codec.ts` |
| `TERMINAL_POS` | const | 49–49 | no | 0 | `anthropic-image-codec.ts` |
| `TIER0_COUNT` | const | 52–52 | no | 0 | `anthropic-image-codec.ts` |
| `TIER1_COUNT` | const | 53–53 | no | 0 | `anthropic-image-codec.ts` |
| `MAX_INPUT_BASE64_LENGTH` | const | 56–56 | yes | 0 | `anthropic-image-codec.ts` |
| `IMAGE_NORMALIZE_CONCURRENCY` | const | 64–64 | yes | 1 | `anthropic-image-codec.ts` |
| `MAX_INPUT_PIXELS` | const | 65–65 | yes | 0 | `anthropic-image-codec.ts` |
| `UNDECODABLE_TEXT` | const | 67–67 | no | 0 | `anthropic-image-normalize.ts (residual)` |
| `BOMB_TEXT` | const | 68–68 | no | 0 | `anthropic-image-normalize.ts (residual)` |
| `OVERFLOW_DROP_TEXT` | const | 69–69 | no | 0 | `anthropic-image-normalize.ts (residual)` |
| `PASSTHROUGH_MEDIA` | const | 72–72 | no | 0 | `anthropic-image-codec.ts` |
| `NormalizeOptions` | interface | 74–81 | yes | 1 | `anthropic-image-codec.ts` |
| `EncodeFn` | type | 83–87 | yes | 2 | `anthropic-image-codec.ts` |
| `ValidateFn` | type | 90–90 | yes | 0 | `anthropic-image-codec.ts` |
| `ProcessResult` | type | 92–95 | no | 0 | `anthropic-image-codec.ts` |
| `IMAGE_NORMALIZE_CACHE_MAX_BYTES` | const | 102–102 | yes | 1 | `anthropic-image-codec.ts` |
| `CACHE_MAX_ENTRIES` | const | 103–103 | no | 0 | `anthropic-image-codec.ts` |
| `CACHE_MAX_ENTRY_BYTES` | const | 104–104 | no | 0 | `anthropic-image-codec.ts` |
| `CacheValue` | type | 107–107 | no | 0 | `anthropic-image-codec.ts` |
| `CacheEntry` | interface | 108–113 | no | 0 | `anthropic-image-codec.ts` |
| `NormalizeCacheLimits` | interface | 114–118 | no | 0 | `anthropic-image-codec.ts` |
| `DEFAULT_CACHE_LIMITS` | const | 119–123 | no | 0 | `anthropic-image-codec.ts` |
| `cacheEncoder` | const | 124–124 | no | 0 | `anthropic-image-codec.ts` |
| `cache` | const | 125–125 | no | 0 | `anthropic-image-codec.ts` |
| `cacheLimits` | let | 126–126 | no | 0 | `anthropic-image-codec.ts` |
| `cacheBytes` | let | 127–127 | no | 0 | `anthropic-image-codec.ts` |
| `cacheMetadataBytes` | let | 128–128 | no | 0 | `anthropic-image-codec.ts` |
| `cacheSentinelEntries` | let | 129–129 | no | 0 | `anthropic-image-codec.ts` |
| `encodeCalls` | let | 130–130 | no | 0 | `anthropic-image-codec.ts` |
| `cacheEntry` | function | 132–141 | no | 0 | `anthropic-image-codec.ts` |
| `deleteCacheEntry` | function | 143–151 | no | 0 | `anthropic-image-codec.ts` |
| `cachePut` | function | 153–174 | no | 0 | `anthropic-image-codec.ts` |
| `cacheGet` | function | 177–185 | no | 0 | `anthropic-image-codec.ts` |
| `getNormalizeStatsForTests` | function | 188–204 | yes | 1 | `anthropic-image-codec.ts` |
| `resetNormalizeStateForTests` | function | 205–211 | yes | 5 | `anthropic-image-codec.ts` |
| `setNormalizeCacheLimitsForTests` | function | 213–216 | yes | 1 | `anthropic-image-codec.ts` |
| `anthropicImageNormalizeRetainedStoreSnapshot` | function | 218–232 | yes | 2 | `anthropic-image-codec.ts` |
| `evictOldestAnthropicImageNormalizeForBudget` | function | 234–237 | yes | 2 | `anthropic-image-codec.ts` |
| `bunImageEncode` | const | 240–252 | no | 0 | `anthropic-image-codec.ts` |
| `bunImageValidate` | const | 259–261 | no | 0 | `anthropic-image-codec.ts` |
| `mediaTypeOf` | function | 263–267 | no | 0 | `anthropic-image-normalize.ts (residual)` |
| `textify` | function | 269–271 | no | 0 | `anthropic-image-normalize.ts (residual)` |
| `replaceImage` | function | 273–275 | no | 0 | `anthropic-image-normalize.ts (residual)` |
| `initialPosition` | function | 277–280 | no | 0 | `anthropic-image-normalize.ts (residual)` |
| `processAt` | function | 291–347 | no | 0 | `anthropic-image-codec.ts` |
| `NormalizeTarget` | interface | 356–361 | yes | 2 | `anthropic-image-normalize.ts (residual)` |
| `NormalizeTargetsOptions` | interface | 363–374 | yes | 0 | `anthropic-image-normalize.ts (residual)` |
| `normalizeImageTargets` | function | 380–499 | yes | 2 | `anthropic-image-normalize.ts (residual)` |
| `normalizeAnthropicImages` | function | 505–518 | yes | 3 | `anthropic-image-normalize.ts (residual)` |

The two original import declarations are guard values/type at source:17–22 and `enforceAppOwnedMemoryBudget` at source:23. The latter moves to the codec; the former stays for the residual's collection, sniffing, budget and wire-handle type.

## Leaf partition

New file: `src/adapters/anthropic-image-codec.ts`.

- Move source spans **25–66 (42 lines), 71–261 (191), 282–347 (66)**, including their comments and blank lines: **299 lines**.
- Symbols: `TierSpec`, `KiB`, `MiB`, `TIER_SPECS`, `TERMINAL_POS`, `TIER0_COUNT`, `TIER1_COUNT`, `MAX_INPUT_BASE64_LENGTH`, `IMAGE_NORMALIZE_CONCURRENCY`, `MAX_INPUT_PIXELS`, `PASSTHROUGH_MEDIA`, `NormalizeOptions`, `EncodeFn`, `ValidateFn`, `ProcessResult`, `IMAGE_NORMALIZE_CACHE_MAX_BYTES`, `CACHE_MAX_ENTRIES`, `CACHE_MAX_ENTRY_BYTES`, `CacheValue`, `CacheEntry`, `NormalizeCacheLimits`, `DEFAULT_CACHE_LIMITS`, `cacheEncoder`, `cache`, `cacheLimits`, `cacheBytes`, `cacheMetadataBytes`, `cacheSentinelEntries`, `encodeCalls`, `cacheEntry`, `deleteCacheEntry`, `cachePut`, `cacheGet`, `getNormalizeStatsForTests`, `resetNormalizeStateForTests`, `setNormalizeCacheLimitsForTests`, `anthropicImageNormalizeRetainedStoreSnapshot`, `evictOldestAnthropicImageNormalizeForBudget`, `bunImageEncode`, `bunImageValidate`, `processAt`.
- Export the existing public symbols exactly as before. Additionally export only the internal bindings needed by the residual: `TERMINAL_POS`, `TIER0_COUNT`, `TIER1_COUNT`, `bunImageEncode`, `bunImageValidate`, `processAt`. Do not re-export those new internal seams through the old boundary.
- Its complete imports:

```ts
import { sniffImageDimensions } from "./anthropic-image-guard";
import { enforceAppOwnedMemoryBudget } from "../lib/app-owned-memory";
```

- Expected size **302** = 299 moved + two imports + one separating blank line. Export keywords do not add lines. Keep the cache and its encoder counter in this one file.
- No duplicate KiB/MiB, tier array, option type, or mutable cache exists in the residual.

Residual `src/adapters/anthropic-image-normalize.ts`: retain the module contract header, three omission strings, `mediaTypeOf`, `textify`, `replaceImage`, `initialPosition`, `NormalizeTarget`, `NormalizeTargetsOptions`, `normalizeImageTargets`, and `normalizeAnthropicImages`. Expected **227 lines** = 518 − 299 − removed memory-budget import (1) + eight wiring lines and one separator (9). Both files fit; no #b layer is needed for image normalization. Aggregate expected total is 529 = original 518 + net wiring 11. Final formatting may change these estimates, but measured ≤400 is mandatory.

The 120-line `normalizeImageTargets` function remains intact: its bounded first-pass worker pool, synchronous failure flag, wait-for-in-flight-settlement, then oldest-first demotion are not function-size cleanup targets in this pure-move train.

## Re-export block

Exact additions to the original path (five export lines, followed by three actual local imports):

```ts
export type { TierSpec, NormalizeOptions, EncodeFn, ValidateFn } from "./anthropic-image-codec";
export { TIER_SPECS, MAX_INPUT_BASE64_LENGTH, IMAGE_NORMALIZE_CONCURRENCY, MAX_INPUT_PIXELS } from "./anthropic-image-codec";
export { IMAGE_NORMALIZE_CACHE_MAX_BYTES } from "./anthropic-image-codec";
export { getNormalizeStatsForTests, resetNormalizeStateForTests, setNormalizeCacheLimitsForTests } from "./anthropic-image-codec";
export { anthropicImageNormalizeRetainedStoreSnapshot, evictOldestAnthropicImageNormalizeForBudget } from "./anthropic-image-codec";

import { bunImageEncode, bunImageValidate, processAt, TERMINAL_POS, TIER0_COUNT, TIER1_COUNT } from "./anthropic-image-codec";
import { IMAGE_NORMALIZE_CONCURRENCY, MAX_INPUT_BASE64_LENGTH, MAX_INPUT_PIXELS } from "./anthropic-image-codec";
import type { NormalizeOptions } from "./anthropic-image-codec";
```

Keep the remaining four exports defined inline: `NormalizeTarget`, `NormalizeTargetsOptions`, `normalizeImageTargets`, `normalizeAnthropicImages`. Thus all **18** original exported bindings remain importable; the six type/interface exports preserve type identity. A re-export alone never provides the residual's local binding.

## Module-level state and cycles

Single owner for each binding:

| Binding at original line | Kind | Owner |
|---|---|---|
| PASSTHROUGH_MEDIA:72 | policy Set, no new mutator | anthropic-image-codec.ts |
| cacheEncoder:124 | TextEncoder singleton | anthropic-image-codec.ts |
| cache:125 | mutable Map | anthropic-image-codec.ts |
| cacheLimits:126 | mutable limit snapshot | anthropic-image-codec.ts |
| cacheBytes:127 | mutable counter | anthropic-image-codec.ts |
| cacheMetadataBytes:128 | mutable counter | anthropic-image-codec.ts |
| cacheSentinelEntries:129 | mutable counter | anthropic-image-codec.ts |
| encodeCalls:130 | mutable counter; increment at 328 | anthropic-image-codec.ts |

`DEFAULT_CACHE_LIMITS:119–123`, `TIER_SPECS:41–48`, and the codec function objects also stay single-owned, never cloned. No other top-level let/Map/Set/WeakMap or lock exists. The residual's `entries`, `nextIndex`, `firstError`, `failed` at 393–404 stay invocation-local. Reset and eviction hooks still mutate the same cache as every normalizer.

Cycle to avoid: residual → codec → residual (for EncodeFn, TierSpec, NormalizeOptions or policy constants). All those definitions move to codec, so it never imports the old boundary. Another forbidden edge is codec → app-owned-memory-stores → old boundary; import only `app-owned-memory.ts`, whose import scan has no outgoing imports, not the registry. The guard likewise has no imports. Lane G1 found no existing cycle for this module; actual new import/re-export edges must be checked during implementation, including type-only edges. Functional coupling through `processAt` is explicit; there is no exported mutable state. Preserve existing synchronous budget callback timing at source:172.

## Tests

Complete direct-import `rg -l` list, after filtering to the exact import path; every entry is **unchanged** (no retarget and no scan-list addition):

```text
tests/adapters/anthropic/anthropic-image-normalize.test.ts:2–14
tests/adapters/anthropic/anthropic-image-retry.test.ts:4
tests/adapters/anthropic/anthropic-image-retry-e2e.test.ts:8
tests/providers/kiro/kiro-images.test.ts:7
tests/claude-integration/claude-native-passthrough.test.ts:359
tests/codex-integration/app-owned-memory.test.ts:15
```

The exact-path import population is **10 files**: six tests plus four production consumers listed above. Tests access cache hooks through the original module, exercising the preserved identity.

Text-oracle tests reading this source: **none found**. Search used `rg -n 'anthropic-image-normalize|anthropic\\.ts' tests -g '*.ts'`, followed by `rg -n 'readFileSync|readFile\\(|Bun\\.file|source\\(' <candidate tests>` and inspection. The matches in layout JSON are test-location metadata, not source-body readers; `anthropic-pool-toggle-copy.test.ts:44,54,63,73` reads GUI files, not either S03 source. Therefore there is no source-read line to retarget and no source scan-list to extend. Do not invent a text oracle or weaken behavioral guards.

C-phase guards to drive red once, then restore (not executed while drafting):

- Cache identity/hit: `anthropic-image-normalize.test.ts:205` (N3) must fail if codec cache reads are temporarily bypassed.
- Accounting/eviction: same file:85,109,157 must fail if metadata/sentinel accounting or oldest-row eviction is temporarily bypassed.
- Keep the same file's concurrency/fatal-callback/order cases intact; temporarily reversing the demotion selection must trip oldest-first coverage. Restore original statements and run clean green.
- No mutation is committed; record exact mutation, failing assertion and restored green evidence.

## Verification

Implementation-only instantiation of 002 **Per-layer gate**; no commands here have been run as tests by the doc author.

```sh
bun run typecheck
bun test tests/adapters/anthropic/anthropic-image-normalize.test.ts tests/adapters/anthropic/anthropic-image-retry.test.ts tests/adapters/anthropic/anthropic-image-retry-e2e.test.ts tests/providers/kiro/kiro-images.test.ts tests/claude-integration/claude-native-passthrough.test.ts tests/codex-integration/app-owned-memory.test.ts
bun run privacy:scan
wc -l src/adapters/anthropic-image-codec.ts src/adapters/anthropic-image-normalize.ts
rg -n 'from "[^"]*/anthropic-image-normalize"' src gui/src scripts tests
git diff --numstat
```

Pass conditions: typecheck/privacy exit 0; focused adapters/anthropic, providers/kiro, claude-integration and codex-integration tests 0 fail; both source files ≤400; original-path consumer set remains the same 10 files. The conditional 002 `tests/lab/core-lab-boundary.test.ts` gate is not activated by adapter-only edits; never change its PROTECTED roots. Stop if implementation unexpectedly touches src/server, src/router or src/lib, then apply that gate after parent scope approval.

Full suite **only on lidge**, at this exact layer tip:

```sh
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-adapters-anthropic-image-normalize && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'
```

The executor must also preserve the full-suite exit status (pipefail or unpiped run) and capture `git rev-parse HEAD`; a successful `tail` is not test proof. Record exact-head CI rollup independently. No remote work is performed during this delegated docs task. Perform import-graph/type-edge cycle verification against the direction above without installing new tooling.

## Accept criteria

1. Exactly the three documented source spans move; bodies, signatures, literal values, scheduling and callback order stay identical.
2. All 52 top-level declarations have one owner; all 18 original exports remain at the original path.
3. The cache, reset/stats/budget hooks and encode counter share one codec owner, with no public mutable holder and no counter wrapper added.
4. Measured codec and residual line counts are ≤400 (expected 302 and 227).
5. All six importing tests stay unchanged; no source-text oracle is silently omitted.
6. Retarget-free behavioral guards have documented red/restored-green evidence and every per-layer gate passes at the same tip.
7. No new import cycle, source caller migration, test-layout drift, credential behavior change or protected-root edit.
8. Parent resolves the raw >500-line size conflict before execution; absence of that decision blocks implementation, not the accuracy of this draft.

## PR

Title: `refactor(adapters): isolate the image normalization cache and codec (split S03 L1/3)`

Base: `dev`. Branch: `codex/split-adapters-anthropic-image-normalize`. Closes: none.

| Layer | PR | Branch | Base | Review focus |
|---|---|---|---|---|
| S03 L1/3 | #<S03-L1> | `codex/split-adapters-anthropic-image-normalize` | `dev` | Single cache/codec owner |
| S03 L2/3 | #<S03-L2> | `codex/split-adapters-anthropic-a` | `codex/split-adapters-anthropic-image-normalize` | Private prompt-cache/reasoning/schema leaves |
| S03 L3/3 | #<S03-L3> | `codex/split-adapters-anthropic-b` | `codex/split-adapters-anthropic-a` | Message conversion and response parsers |

Fill repository PR template Summary, Verification and Checklist; include this map with L1 marked current. Review only the layer diff. L2 depends on this layer, so a lower-layer rewrite requires a parent-owned cascade through L2 and L3 and fresh exact-head checks. No merge is authorized by this plan.

## P stale-check (2026-09-05, wp080)

origin/dev 4dde2db97; `git diff --stat 445742966 origin/dev -- src/adapters/anthropic-image-normalize.ts` empty (518 lines). Anchors 25/66/71/124/125/130/261/282/291/347/380/505 confirmed by sed. Base `dev` (S03 bottom; 090/100 anthropic.ts #a/#b chain on this layer). Executor rules: no bun run test; OCX_TEST_NO_QUEUE=1 on focused runs; CI hygiene requires a test change in the same PR.

## Execution record (B/C/D, 2026-09-05)

- Executor worktree: `/tmp/ocx-split-080.bBldI7/wt` (branch `codex/split-adapters-anthropic-image-normalize`, base origin/dev 4dde2db97). Executor: gpt-6-astra high (Mencius, 01a06f15-eda0-7490-b193-c3b9a2295835).
- Commits: 0fbddf27e (move: anthropic-image-codec.ts 304 lines, anthropic-image-normalize.ts 228; unused enforceAppOwnedMemoryBudget import dropped from residual) and c1d436738 (test: +15 — reset/stats hooks identical via both paths; residual has no cache state). Diff: 3 files, +327/−298.
- Local gate: typecheck 0; focused (6 files) 80 pass / 0 fail; privacy passed; 10 original-path consumers unchanged; residual has no cache/cacheBytes/encodeCalls declarations.
- Red-drives: (a) cacheGet → undefined fails :213 (encodeCalls 2 vs 1), restored 24/0; (b) cachePut skips sentinel accounting fails :91, restored 24/0.

- Adversarial diff review (Huygens, gpt-6-astra high, 01a06f19-6c0d-74a2-b55b-f4402fa9591b): VERDICT: PASS first round (three spans byte-identical, residual reconstruction exact, 18 exports preserved with type identity, 7 state bindings single-owned at codec:100–106, zero cycles via scanImports, 3 files).
- lidge full suite at c1d436738: SUITE_EXIT=0, 18014 pass / 0 fail / 16 skip (/tmp/suite-split-080.log).
- PR: https://github.com/lidge-jun/opencodex/pull/3567 (base dev, head c1d436738). CI rollup at record time: OPEN draft=false c1d436738 =1 =10 SKIPPED=2 SUCCESS=16
