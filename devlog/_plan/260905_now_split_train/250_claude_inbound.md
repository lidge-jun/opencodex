# S08 L1/2 — Claude inbound translation leaves

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Existing split implementation history; aggregate delivery pending. Original PR is not individually merged.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`; C3 architectural planning, docs-only delegated task. Parent owns orchestration, loop and goal state. This document is not permission to run them.
- Goal: split `src/claude/inbound.ts` (578 lines) into three small implementation leaves while preserving the original import surface and every translation result.
- Non-goals: changing classifier affinity, blocked-skill policy, output-schema acceptance, thinking effort, cache-key construction, validation, or exported signatures; no source/test edits or test execution during this planning task.
- Verifier: `002_layer_map.md`, **Per-layer gate**, instantiated below. `000_plan.md`'s reference to 003 is stale; 002 actually owns the gate.
- Stop: the implementation layer has its own exact-tip verification evidence and an open PR; never merge. Stop this delegated task after writing and statically checking its assigned documents.
- Escalation: stop implementation if the source basis drifts, any named export disappears, a leaf needs an upward import, the residual exceeds 400, or actual changed source lines exceed 500. Do not silently borrow S08 L2 for inbound leftovers.
- Basis: docs HEAD `4cc219549`; source `origin/dev = 1362b1a38`. Both assigned source files were byte-compared with `git show origin/dev:<path>` and match the working tree. All source coordinates below refer to that origin/dev snapshot. Lane evidence: `devlog/_plan/260905_modular_debt_ledger/011_lane_server_responses.md`, `src/claude/inbound.ts` subsection, identifies content/tool and directive seams and the two module-level Sets.

Structural decision: the 578-line module combines boundary options/model resolution with content sequencing. Leaving it alone or merely configuring it cannot meet the size gate; deleting behavior is out of scope. Move existing declarations only. Keep the larger content/elision pipeline and cache construction together, and extract the smaller boundary-option groups. This avoids a larger content move whose additions plus deletions would threaten the 500-line layer budget. No generic utility or internal index barrel is introduced.

Current map: `src/server/claude-messages.ts:13`, `src/lab/conformance/executor.ts:4`, and `src/claude/agents-inject.ts:22`, plus five behavioral tests, consume inbound. Inbound imports alias/context/Desktop resolution, the output-schema predicate, outbound WebSearch naming, shared config types, and crypto (`src/claude/inbound.ts:12–18`). Intended direction: these consumers → original compatibility facade/residual → `inbound/model-options.ts`, `inbound/content-options.ts`, `inbound/records.ts`; options leaves → records and their existing lower-level dependencies. Lab remains a consumer, never a dependency. Blast radius: one feature module, no wire/API changes.

Convention evidence: `src/server/responses.ts:1–13` preserves original-path exports over a same-name subdirectory; `src/config/paths.ts:1–5` uses direct leaf imports. Use the same pattern, not an `inbound/index.ts`. The facade-plus-residual is explicitly required by this train, overriding the generic pure-barrel preference.

## Symbol inventory

Ranges are declaration starts/ends, not leading JSDoc. Obtained with `sg run --lang ts --kind function_declaration --json=compact`, plus `lexical_declaration`, `type_alias_declaration`, `interface_declaration`, and an anchored `rg` declaration scan. Imports at 12–18 are dependencies, not locally owned declarations.

Consumer counts are distinct external source/test files referencing the symbol among verified importers of this exact module, not occurrence counts or same-named symbols from `src/chat/inbound.ts`. Method: `rg -l 'claude/inbound["\x27]' src gui/src scripts tests`, plus sibling `rg -n 'from "./inbound"' src/claude`, then `rg -l -w '<symbol>' <verified-importer-files>`. Private declarations have zero external consumers. Existing module fan-in is **8 files: 3 source + 5 test**. `R` means residual `src/claude/inbound.ts`; other target names are under `src/claude/inbound/`.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| AnthropicRequestError | class | 20–20 | yes | 2 | records.ts |
| Rec | type | 22–22 | no | 0 | records.ts |
| isRec | function | 24–26 | no | 0 | records.ts |
| isClaudeClassifierModel | function | 28–31 | no | 0 | model-options.ts |
| configuredClassifierRoute | function | 47–56 | no | 0 | model-options.ts |
| resolveInboundModel | function | 59–89 | yes | 5 | model-options.ts |
| effortForThinkingBudget | function | 92–96 | yes | 1 | model-options.ts |
| OUTPUT_CONFIG_EFFORTS | const Set | 104–104 | no | 0 | model-options.ts |
| effortFromOutputConfig | function | 105–109 | yes | 0 | model-options.ts |
| formatFromOutputConfig | function | 111–120 | no | 0 | model-options.ts |
| systemToInstructions | function | 122–132 | no | 0 | content-options.ts |
| imageBlockToInputImage | function | 134–145 | no | 0 | R |
| toolResultOutput | function | 147–171 | no | 0 | R |
| pushUserMessage | function | 173–176 | no | 0 | R |
| DEFAULT_BLOCKED_SKILLS | const array | 186–186 | yes | 0 | R |
| effectiveBlockedSkillNames | function | 189–195 | yes | 1 | R |
| OCX_ROUTE_RE | const RegExp | 204–204 | no | 0 | model-options.ts |
| OCX_EFFORT_RE | const RegExp | 205–205 | no | 0 | model-options.ts |
| systemText | function | 207–217 | no | 0 | model-options.ts |
| extractOcxRouteDirective | function | 219–224 | yes | 2 | model-options.ts |
| extractOcxEffortDirective | function | 232–237 | yes | 2 | model-options.ts |
| SKILL_ELISION_MIN_CHARS | const number | 240–240 | no | 0 | R |
| SKILL_TEXT_MARKER | const string | 241–241 | no | 0 | R |
| SkillElisionContext | interface | 243–248 | no | 0 | R |
| NO_ELISION | const object containing Set | 250–250 | no | 0 | R |
| maybeElideSkillText | function | 259–270 | no | 0 | R |
| skillElisionStub | function | 272–276 | no | 0 | R |
| blockedSkillCallIds | function | 279–294 | no | 0 | R |
| systemMessageText | function | 303–311 | no | 0 | R |
| userMessageToItems | function | 313–357 | no | 0 | R |
| assistantMessageToItems | function | 359–392 | no | 0 | R |
| toolsToResponses | function | 394–416 | no | 0 | content-options.ts |
| toolChoiceToResponses | function | 418–438 | no | 0 | content-options.ts |
| canonicalJson | function | 441–448 | no | 0 | R |
| ClaudeCacheKeySource | exported type | 451–451 | yes | 1 | R |
| ClaudeInboundTranslation | exported interface | 453–456 | yes | 0 | R |
| anthropicToResponsesBody | function | 462–464 | yes | 2 | R |
| anthropicToResponsesTranslation | function | 471–578 | yes | 4 | R |

## Leaf partition

All counts include comments and allow import/export glue; these are planning ceilings to verify with `wc -l`, not claims about files already created. No #a/#b subdivision is needed for this layer.

| new file | symbols | move slices at origin/dev | expected lines including glue |
|---|---|---|---:|
| `src/claude/inbound/records.ts` | AnthropicRequestError, Rec, isRec | 20–26 = 7 lines | 10 |
| `src/claude/inbound/model-options.ts` | isClaudeClassifierModel, configuredClassifierRoute, resolveInboundModel, effortForThinkingBudget, OUTPUT_CONFIG_EFFORTS, effortFromOutputConfig, formatFromOutputConfig, OCX_ROUTE_RE, OCX_EFFORT_RE, systemText, extractOcxRouteDirective, extractOcxEffortDirective | 28–120 + 197–237 = 134 lines | 144 |
| `src/claude/inbound/content-options.ts` | systemToInstructions, toolsToResponses, toolChoiceToResponses | 122–132 + 394–438 = 56 lines | 64 |

Residual original expected **390 lines**, no #b: 578 − 197 moved − 5 obsolete import lines (13–17) + up to 14 lines of facade/import glue = 390. Leaf projections total 218; total projected footprint is 608, versus 578 originally. New code consists only of imports/exports and declaration visibility needed across leaves. Estimated source churn is approximately 450 lines; measure actual diff rather than relying on this estimate for the 500 gate. Existing long functions are not rewritten merely to meet the separate function-size guideline.

Own imports of `records.ts`: none. `Rec` and `isRec` become leaf exports only; do not add them to the original public export surface.

Own imports of `model-options.ts`:

```ts
import type { OcxClaudeCodeConfig } from "../../types";
import { isAnthropicOutputSchema } from "../../adapters/anthropic-output-schema";
import { resolveAlias } from "../alias";
import { stripOneMillionMarker } from "../context-windows";
import { resolveDesktop3pAlias } from "../desktop-3p";
import { isRec, type Rec } from "./records";
```

Own imports of `content-options.ts`:

```ts
import { isClaudeWebSearchToolName } from "../outbound";
import { AnthropicRequestError, isRec, type Rec } from "./records";
```

Move comments with their declarations. `formatFromOutputConfig`, `systemToInstructions`, `toolsToResponses`, and `toolChoiceToResponses` become direct leaf exports for their production caller, not facade exports or test-only APIs. Existing adapter/alias/outbound owners are reused; no replacement schema validator, alias registry, WebSearch recognizer, or new dependency is planned.

## Re-export block

Add these exact named re-exports to `src/claude/inbound.ts`:

```ts
export { AnthropicRequestError } from "./inbound/records";
export { resolveInboundModel, effortForThinkingBudget, effortFromOutputConfig, extractOcxRouteDirective, extractOcxEffortDirective } from "./inbound/model-options";
```

The existing declarations continue exporting `DEFAULT_BLOCKED_SKILLS`, `effectiveBlockedSkillNames`, `ClaudeCacheKeySource`, `ClaudeInboundTranslation`, `anthropicToResponsesBody`, and `anthropicToResponsesTranslation`. No moved public type requires `export type`; the two public types stay local. All **12** current public identifiers remain importable at the original path.

Re-exporting does not bind local names. The complete residual imports are:

```ts
import type { OcxClaudeCodeConfig } from "../types";
import { createHash } from "node:crypto";
import { AnthropicRequestError, isRec, type Rec } from "./inbound/records";
import { resolveInboundModel, effortForThinkingBudget, effortFromOutputConfig, formatFromOutputConfig } from "./inbound/model-options";
import { systemToInstructions, toolsToResponses, toolChoiceToResponses } from "./inbound/content-options";
```

## Module-level state and cycles

- `OUTPUT_CONFIG_EFFORTS`, origin `src/claude/inbound.ts:104`: one Set owned by `model-options.ts`; retain its allocation and membership semantics. Do not clone it into the residual.
- `NO_ELISION`, origin `:250`: the original residual remains the sole owner of this object and its `callIds` Set. `userMessageToItems`'s default stays attached to that same object.
- `DEFAULT_BLOCKED_SKILLS` (`:186`) is a publicly exported array, not a frozen value. Preserve its object identity and existing mutability in the residual; do not make a copy or freeze it as part of the move.
- `OCX_ROUTE_RE` / `OCX_EFFORT_RE` (`:204–205`) move to model-options with systemText; preserve the absence of global/sticky flags. `SKILL_ELISION_MIN_CHARS` / `SKILL_TEXT_MARKER` (`:240–241`) stay residual.
- No top-level let, Map, WeakMap, timer, or lock exists. Sets created inside effectiveBlockedSkillNames/blockedSkillCallIds (`:191`, `:280`) remain per invocation.
- The common error constructor is the key cycle seam: content-options must not import `AnthropicRequestError` from `../inbound`, and model-options must not import `Rec`/`isRec` from the residual. Both import records directly. This also preserves `instanceof AnthropicRequestError` at `src/server/claude-messages.ts:714`.
- Lane 011 found no cycle in its literal graph. New edges are functional/sequential coupling; the public array is an existing shared-identity contract, not a new shared store. The original module may import its leaves; leaves may not import the original or each other's consumer. `src/lab/conformance/executor.ts` continues importing the public original, never the reverse.

## Tests

Exact behavioral importer list from `rg -l 'claude/inbound["\x27]' tests` (sorted); all **unchanged**, including the dynamic/require site:

| test file | import/use line | disposition |
|---|---:|---|
| `tests/adapters/anthropic/anthropic-reasoning.test.ts` | 5 | unchanged |
| `tests/claude-integration/claude-alias.test.ts` | 12 | unchanged |
| `tests/claude-integration/claude-inbound.test.ts` | 2; 512 require/type import | unchanged |
| `tests/clients/desktop-3p.test.ts` | 19 | unchanged |
| `tests/routing/routing-policy-surface-parity.test.ts` | 4 | unchanged |

Direct text-oracle result: **none found** after `rg -n 'inbound.ts|claude/inbound' tests` and segmented-path/readFileSync/Bun.file/source-call inspection. The similarly named chat inbound imports are not this module. No direct oracle is retargeted and no existing literal scan list needs a leaf entry.

Transitive source oracle: `tests/codex-integration/compatibility-manifest.test.ts:61` reads each reached file with `readFileSync(current, "utf8")`; root list at 182–188 includes server/index, whose `:178` import reaches claude-messages then inbound. **Unchanged**: its runtime re-export/import walker follows the three new leaves automatically. Drive this guard red once during implementation by temporarily adding a static named import/re-export from `../../compatibility/manifest` in `inbound/model-options.ts`, observe the forbidden-chain failure, then remove the probe and obtain green. Do not commit the probe.

`tests/lab/core-lab-boundary.test.ts:69` is a generic reachable-graph reader, but the inspected protected roots do not currently reach inbound; do not claim it is a direct inbound text oracle or edit PROTECTED to make it one. Keep the roots untouched. No new tests are required for pure moves. If an executor needs a new test file, report the scope expansion and register it in both layout registries.

Behavior guard sensitivity: in the existing inbound test, temporarily break the moved hosted WebSearch choice branch (`src/claude/inbound.ts:432` origin), confirm `tests/claude-integration/claude-inbound.test.ts:197` fails, then restore and rerun. The existing malformed-input cases at `:326` also check the shared error identity. These are future red/green instructions, not tests run by this docs task.

## Verification

Run only in the executor's dedicated layer worktree. Domains: claude-integration, clients, routing, adapters/anthropic, lab (conformance consumer), codex-integration (source graph). Instantiate 002's gate as follows:

```sh
bun run typecheck
bun test tests/claude-integration tests/clients/desktop-3p.test.ts tests/routing/routing-policy-surface-parity.test.ts tests/adapters/anthropic/anthropic-reasoning.test.ts tests/lab/lab-conformance-harness.test.ts tests/lab/lab-conformance-runner-failures.test.ts tests/codex-integration/compatibility-manifest.test.ts
bun run privacy:scan
wc -l src/claude/inbound.ts src/claude/inbound/records.ts src/claude/inbound/model-options.ts src/claude/inbound/content-options.ts
rg -n 'claude/inbound["\x27]|from "./inbound"' src gui/src scripts tests
git diff --check
git diff --numstat dev...HEAD -- src
```

Original-path importer identity/count must remain the same 8 files, not be diluted by new internal leaf imports. Compare the sorted importer list, not just a regex total. The protected-root test is conditional in 002 and is not required by this src/claude-only write set; run it if implementation expands to src/server/src/lib/src/router. Leaf-to-parent import scan must have no hits, and an import-graph comparison must find no newly introduced cycle (include type and literal dynamic edges); typecheck alone is not cycle proof.

Full suite is **never local**. On the parent-approved remote checkout, use branch `codex/split-claude-inbound`:

```sh
ssh lidge 'set -e; cd ~/ocx-ci/opencodex; git fetch origin codex/split-claude-inbound; git checkout -q FETCH_HEAD; git rev-parse HEAD; bun install --frozen-lockfile >/dev/null; bun run test'
```

Require the printed remote SHA to equal the recorded PR head and preserve the real test exit status (002's illustrative `| tail -15` alone can mask a failure). Record focused counts, remote full-suite result, privacy/typecheck exit statuses, red/green evidence, sizes, and green exact-head CI rollup. No implementation checks were executed while drafting this document; documentation verification is heading/inventory/path/count consistency only. Fresh read-only Node/ast-grep checks on 2026-09-05 confirmed nine ordered headings, all 38 exact declaration ranges, 12 public identifiers, all named test paths present, 14 relative import/re-export paths resolving to existing or explicitly planned files, and no trailing whitespace (exit 0).

## Accept criteria

1. Exactly three new leaves are added and no source outside this partition is changed; each leaf and residual is ≤400 lines (projected residual 390), with no hidden #b.
2. All 38 top-level declarations above have exactly one owner; the 12 original public identifiers and signatures are unchanged. Existing original-path importers remain 8 identical files.
3. Function bodies and serialized results are unchanged; only location, imports, exports and necessary relative paths change. Shared error identity and exported-array identity are preserved.
4. No leaf imports the residual, no new cycle is introduced, and no Lab/compatibility-catalog dependency enters the ordinary path. No protected-root edit is included.
5. Source-oracle walker still reaches moved code; planned sensitivity probes fail once and restored code passes. Existing behavioral import paths remain unchanged.
6. Every instantiated 002 gate passes at the layer SHA; no full suite runs locally and no previous/head-mismatched result substitutes for evidence.
7. Actual additions plus deletions of changed source are ≤500; if not, the parent must approve a revised slice before implementation proceeds. Open PR carries the stack map, all template sections and exact-head evidence; no merge is performed.

## PR

Title: `refactor(claude): separate inbound options from content translation (split S08 L1/2)`

Branch: `codex/split-claude-inbound`. Base: `dev`. Closes: none.

Use `.github/PULL_REQUEST_TEMPLATE.md` with Summary, Verification and Checklist. Review this layer's diff only. Stack map (DEV-STACK-03; placeholder numbers are intentional until PR creation):

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 2 | #TBD-S08-L2 | server Claude messages | `codex/split-server-claude-messages` | `codex/split-claude-inbound` | native/body/count/replay ownership |
| 1 | #TBD-S08-L1 | inbound ← this layer | `codex/split-claude-inbound` | `dev` | option leaves and stable inbound exports |

L2 depends on #TBD-S08-L1. Lower-layer changes require a parent-owned cascade and renewed exact-head verification; no cascade, push, PR creation, or merge is performed by this delegated docs task.

## P stale-check (2026-09-05, wp250)

origin/dev a594a7f21; inbound.ts unchanged since 445742966 (578 lines); anchors 20/26/28/120/122/132/197/237/394/438 confirmed by sed. Base `dev` (S08 bottom; 260 claude-messages chains on it). Naming: src/claude has no subdirectories today (all flat); the audit decides subdirectory `src/claude/inbound/` vs flat siblings `src/claude/inbound-records.ts`, `inbound-model-options.ts`, `inbound-content-options.ts` (there is already a flat `inbound-debug.ts` sibling). Executor rules: no bun run test; OCX_TEST_NO_QUEUE=1; CI hygiene requires a test change (extend tests/claude-integration/claude-inbound.test.ts).

## A amendment (Maxwell audit, GO-WITH-FIXES blockers=2 → folded; naming adopted)

1. Size gate: the raw ≤500 wording in Loop spec / Accept criteria is void; 003 PURE-MOVE-SIZE-01 binds (197 relocated lines; non-move diff ≤150; move-aware diff + exactly-once ownership as evidence).
2. Error identity: the moved throw at inbound.ts:427 (toolChoiceToResponses, `tool_choice: { type: "tool" }` without a name) is not covered by the existing :326 cases. The required test extension in tests/claude-integration/claude-inbound.test.ts adds a valid request with that tool_choice shape and asserts the thrown value is an instance of the facade-exported AnthropicRequestError, plus seam identity via leaf vs facade and a no-back-edge check on the leaves.
3. Naming adopted: flat siblings `src/claude/inbound-records.ts`, `inbound-model-options.ts`, `inbound-content-options.ts` (matching the existing flat inbound-debug.ts). Leaf import paths become one level shallower (`../types`, `../adapters/anthropic-output-schema`, `./alias`, `./context-windows`, `./desktop-3p`, `./outbound`, `./inbound-records`); facade re-exports/imports use `./inbound-records`, `./inbound-model-options`, `./inbound-content-options`.
Audit-verified structure: 38/38 ranges; partition 7/134/56/381 covering 1–578 once; imports 13–17 all obsolete in the residual; leaf own-imports complete (model-options does not use AnthropicRequestError); residual keeps createHash and OcxClaudeCodeConfig; 12 public identifiers preserved; outbound/desktop-3p closures do not reach inbound.

## Execution record (B/C/D, 2026-09-05)

- Executor worktree: `/tmp/ocx-split-250.d5gu6i/wt` (branch `codex/split-claude-inbound`, base origin/dev a594a7f21). Executor: gpt-6-astra high (Kuhn, 01a06f5e-f95a-7b50-abea-1f4174183bfe).
- Commits: 2e6dfa6c5 (move: inbound-records.ts 7, inbound-model-options.ts 142, inbound-content-options.ts 60, inbound.ts 381) and c0fab2d74 (test: claude-inbound.test.ts +14 — tool_choice {type:"tool"} throws the facade AnthropicRequestError; leaf/facade identity; leaves have no ./inbound back-edge). Diff: 5 files, +228/−202; non-move 36 lines.
- Local gate: typecheck 0; focused (5 importer files + claude-messages-endpoint) 136+42 pass / 0 fail; guards (compatibility-manifest + core-lab-boundary) 23/0; privacy passed; 7 original-path importers unchanged.
- Red-drives: (a) hosted WebSearch tool_choice branch broken → claude-inbound.test.ts:211 (orig 208) fails, restored 32/0; (b) compatibility import in inbound-model-options → compatibility-manifest:191 chain server/index → claude-messages → inbound → inbound-model-options → compatibility/manifest, restored 23/0.

- Adversarial diff review (Mill, gpt-6-astra high, 01a06f63-77fa-7002-9d29-5844130d06c7): VERDICT: PASS (slices exact, residual byte-exact, 12 public ids preserved / 6 internal seams not leaked, 347-file walk no cycle, new test reaches the moved throw at inbound-content-options.ts:49).
- lidge full suite at c0fab2d74: SUITE_EXIT=0 — 18061 pass / 0 fail / 16 skip, 7 serial files finished (/tmp/suite-split-250.log; the SSH pipe was killed after completion, totals read from the retained log).
- PR: https://github.com/lidge-jun/opencodex/pull/3583 (base dev, head c0fab2d74). CI rollup at record time: OPEN draft=false c0fab2d74 =1 =6 SKIPPED=2 SUCCESS=20
