# 090 — S03 L2/3: private Anthropic request policies (#a)

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

Evidence basis: docs HEAD `4cc219549`; `origin/dev=1362b1a3841b4de20177e5d65865a513dd7936c4`. All source ranges below are at that code basis, not hypothetical post-move line numbers. `git diff origin/dev -- src/adapters/anthropic.ts src/adapters/anthropic-image-normalize.ts` was empty. Read 000, 001, 002 and lane 014 before planning. This delegated C3 docs-only task does not run tests, mutate git, or own CXC orchestration.

## Loop spec

- Archetype: `pure-move`.
- Goal: take the zero-external-consumer prompt-cache, reasoning and tool-schema policy leaves first; preserve all three public exports of `src/adapters/anthropic.ts`.
- Non-goals: no wire-body, auth/header, model-family, schema, cache-breakpoint or reasoning-budget changes; no function decomposition, new dependencies, public helper exports, or neighboring adapter cleanup.
- Verifier: 002_layer_map.md **Per-layer gate**, instantiated below.
- Stop: this layer's standalone checks and exact-head CI are recorded; never defer L2 correctness to L3 or merge. Parent owns all orchestration/branch work.
- Escalation: the planned residual is **1007** lines and is explicitly assigned to **100 / S03 L3 / #b**. There is also a raw diff-size conflict: 381 moved physical lines imply ≥762 added+deleted source lines before wiring. Even counting moved lines only, L3 needs 712. Parent must explicitly approve a size exception or revise 002 before implementation; this fixed three-document delegation does not edit the stack map or create extra layers.

Structural decision: lane 014:164–177 identifies prompt caching, request compilation and event decoding as separate seams. This layer follows its recommended cache-policy-first split and the user's lowest-consumer-first rule: all moved bindings are private, with zero external importers. Public factory fan-in is 26 and public URL/error helpers each have one consumer; keep them untouched at their current boundary. Among tied zero-fan-in leaves, take dependency-free cache policy and reasoning/schema policy before message conversion and parser closure relocation.

Reject deleting or configuring policy away: that changes wire semantics. Reject moving the 506-line whole factory to a leaf: it violates ≤400 and conceals the request/response boundary. Existing `anthropic-output-schema.ts` owns output schemas, not the different input-schema rules at source:808–868; do not merge those contracts. Adjacent `google-tool-schema.ts`, `anthropic-output-schema.ts` and `anthropic-image-guard.ts` establish descriptive sibling naming.

Current map: registry/index + 24 tests → anthropic.ts → types, OAuth helpers, image leaves, schema helpers, identity, SSE and budgeting. Intended L2 map: same public dependents → anthropic.ts → prompt-cache / reasoning-policy / tool-schema leaves; policy leaves point directly to existing types/reasoning-effort/responses-tool-schema, never back to anthropic.ts. Blast radius: one adapter feature. Registry construction authority stays unchanged (`structure/10_adapter-registry.md`).

## Symbol inventory

Declaration ranges came from `git show origin/dev:<path>` parsed in memory with the installed `@babel/parser` TypeScript parser, cross-checked against `nl -ba` / `rg -n` source reads. Tables include every top-level function, variable, type and interface declaration; imports are dependencies, recorded separately below. Consumer count means distinct other files importing/re-exporting that binding from this exact module: `rg -l '<basename>' src gui/src scripts tests -g '*.ts' -g '*.tsx'` supplies candidates, then import specifiers are resolved and counted. Comments, fixture path strings, unrelated OAuth modules named anthropic, and same-file references are excluded. Private declarations have zero external consumers, not zero internal uses.

This is the full original **54-declaration** inventory, including symbols left for #b; do not add L3 owners prematurely.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `toAnthropicContentPart` | function | 34–43 | no | 0 | `residual → L3 anthropic-messages.ts` |
| `DEFAULT_MAX_TOKENS` | const | 46–46 | no | 0 | `anthropic-reasoning-policy.ts` |
| `REASONING_MAX_TOKENS_CEILING` | const | 48–48 | no | 0 | `anthropic-reasoning-policy.ts` |
| `ADAPTIVE_THINKING_CEILING` | const | 51–51 | no | 0 | `anthropic-reasoning-policy.ts` |
| `MIN_THINKING_BUDGET` | const | 53–53 | no | 0 | `anthropic-reasoning-policy.ts` |
| `OUTPUT_HEADROOM` | const | 55–55 | no | 0 | `anthropic-reasoning-policy.ts` |
| `OUTPUT_FLOOR` | const | 57–57 | no | 0 | `anthropic-reasoning-policy.ts` |
| `COMPAT_TOOL_PREFIX` | const | 58–58 | no | 0 | `anthropic.ts (residual)` |
| `CacheControl` | type | 59–59 | no | 0 | `anthropic-prompt-cache.ts` |
| `MAX_CACHE_BREAKPOINTS` | const | 60–60 | no | 0 | `anthropic-prompt-cache.ts` |
| `resolveCacheControl` | function | 62–66 | no | 0 | `anthropic-prompt-cache.ts` |
| `applyCacheControlToLast` | function | 79–83 | no | 0 | `anthropic-prompt-cache.ts` |
| `applyCacheControlToLastText` | function | 85–93 | no | 0 | `anthropic-prompt-cache.ts` |
| `PromptCachingOptions` | type | 95–98 | no | 0 | `anthropic-prompt-cache.ts` |
| `applyPromptCaching` | function | 101–166 | no | 0 | `anthropic-prompt-cache.ts` |
| `countBreakpoints` | function | 172–187 | no | 0 | `anthropic-prompt-cache.ts` |
| `enforceCacheControlLimit` | function | 189–214 | no | 0 | `anthropic-prompt-cache.ts` |
| `normalizeTtlOrdering` | function | 220–245 | no | 0 | `anthropic-prompt-cache.ts` |
| `isLikelyRealAnthropicThinkingSignature` | function | 247–251 | no | 0 | `residual → L3 anthropic-messages.ts` |
| `formatAnthropicErrorBody` | function | 258–268 | yes | 1 | `anthropic.ts (residual)` |
| `isAnthropicRecord` | function | 270–272 | no | 0 | `residual → L3 anthropic-response-values.ts` |
| `anthropicStructuralValueType` | function | 274–277 | no | 0 | `residual → L3 anthropic-response-values.ts` |
| `InvalidAnthropicShapeDiagnostic` | interface | 279–283 | no | 0 | `residual → L3 anthropic-response-values.ts` |
| `invalidAnthropicShapeEvent` | function | 290–301 | no | 0 | `residual → L3 anthropic-response-values.ts` |
| `extractAnthropicErrorDetail` | function | 303–321 | no | 0 | `anthropic.ts (residual)` |
| `usesNativeAnthropicEndpoint` | function | 323–329 | no | 0 | `anthropic.ts (residual)` |
| `anthropicMessagesUrl` | function | 332–341 | yes | 1 | `anthropic.ts (residual)` |
| `synthesizeToolUseId` | function | 343–345 | no | 0 | `residual → L3 anthropic-response-values.ts` |
| `usableToolUseId` | function | 353–355 | no | 0 | `residual → L3 anthropic-response-values.ts` |
| `MAX_REPAIRABLE_TOOL_ARGUMENT_BYTES` | const | 366–366 | no | 0 | `residual → L3 anthropic-response-values.ts` |
| `utf8BytesExceed` | function | 373–390 | no | 0 | `residual → L3 anthropic-response-values.ts` |
| `lastValidJsonObject` | function | 392–417 | no | 0 | `residual → L3 anthropic-response-values.ts` |
| `toolUseArguments` | function | 419–439 | no | 0 | `residual → L3 anthropic-response-values.ts` |
| `streamedToolArgumentsParse` | function | 447–456 | no | 0 | `residual → L3 anthropic-response-values.ts` |
| `anthropicKeyUsesBearer` | function | 458–460 | no | 0 | `anthropic.ts (residual)` |
| `reasoningBudget` | function | 463–473 | no | 0 | `anthropic-reasoning-policy.ts` |
| `ADAPTIVE_THINKING_FAMILY_MINIMUMS` | const | 482–486 | no | 0 | `anthropic-reasoning-policy.ts` |
| `claudeFamilyVersion` | function | 504–515 | no | 0 | `anthropic-reasoning-policy.ts` |
| `meetsFamilyMinimum` | function | 517–526 | no | 0 | `anthropic-reasoning-policy.ts` |
| `usesAdaptiveThinking` | function | 528–530 | no | 0 | `anthropic-reasoning-policy.ts` |
| `EXPLICIT_THINKING_DISABLE_FAMILY_MINIMUMS` | const | 544–546 | no | 0 | `anthropic-reasoning-policy.ts` |
| `supportsExplicitThinkingDisable` | function | 548–550 | no | 0 | `anthropic-reasoning-policy.ts` |
| `adaptiveEffort` | function | 553–555 | no | 0 | `anthropic-reasoning-policy.ts` |
| `defaultReasoningEffort` | function | 557–567 | no | 0 | `anthropic-reasoning-policy.ts` |
| `usageFromAnthropic` | function | 569–585 | no | 0 | `residual → L3 anthropic-response-values.ts` |
| `mergeAnthropicUsage` | function | 587–596 | no | 0 | `residual → L3 anthropic-response-values.ts` |
| `buildToolNameTransforms` | function | 598–609 | no | 0 | `anthropic.ts (residual)` |
| `toAnthropicToolResult` | function | 611–630 | no | 0 | `residual → L3 anthropic-messages.ts` |
| `unrepresentableToolCallText` | function | 632–635 | no | 0 | `residual → L3 anthropic-messages.ts` |
| `orphanToolResultText` | function | 637–643 | no | 0 | `residual → L3 anthropic-messages.ts` |
| `messagesToAnthropicFormat` | function | 651–792 | no | 0 | `residual → L3 anthropic-messages.ts` |
| `toolsToAnthropicFormat` | function | 794–806 | no | 0 | `anthropic-tool-schema.ts` |
| `normalizeAnthropicInputSchema` | function | 808–868 | no | 0 | `anthropic-tool-schema.ts` |
| `createAnthropicAdapter` | function | 870–1375 | yes | 26 | `residual; L3 moves parser methods` |

Original imports: `./base`:1; `./tool-call-id`:2; debug:3; types:4–17; OAuth:18; image:19; image guard:20; image normalization:21; output schema:22; responses-tool-schema:23; identity:24; redact:25; fingerprint:26; tool-catalog nudge:27; SSE:28; translator-budget:29; reasoning-effort:30; AgentRouter:31. New leaf imports are listed below. Remove only imports that become unused after the move; do not rewrite consumers.

## Leaf partition

All paths are siblings under `src/adapters/`; no new index or generic utilities.

| New file | Exact original spans moved | Symbols | Expected lines |
|---|---|---|---:|
| `src/adapters/anthropic-prompt-cache.ts` | 59–245 = 187 | CacheControl, MAX_CACHE_BREAKPOINTS, resolveCacheControl, applyCacheControlToLast, applyCacheControlToLastText, PromptCachingOptions, applyPromptCaching, countBreakpoints, enforceCacheControlLimit, normalizeTtlOrdering | 187 |
| `src/adapters/anthropic-reasoning-policy.ts` | 45–57 = 13; 462–567 = 106 | DEFAULT_MAX_TOKENS, REASONING_MAX_TOKENS_CEILING, ADAPTIVE_THINKING_CEILING, MIN_THINKING_BUDGET, OUTPUT_HEADROOM, OUTPUT_FLOOR, reasoningBudget, ADAPTIVE_THINKING_FAMILY_MINIMUMS, claudeFamilyVersion, meetsFamilyMinimum, usesAdaptiveThinking, EXPLICIT_THINKING_DISABLE_FAMILY_MINIMUMS, supportsExplicitThinkingDisable, adaptiveEffort, defaultReasoningEffort | 122 |
| `src/adapters/anthropic-tool-schema.ts` | 794–868 = 75 | toolsToAnthropicFormat, normalizeAnthropicInputSchema | 79 |

Prompt-cache leaf imports: **none**. Export only `MAX_CACHE_BREAKPOINTS`, `resolveCacheControl`, `applyPromptCaching`, `enforceCacheControlLimit`, `normalizeTtlOrdering` to its internal caller. CacheControl and PromptCachingOptions remain private to that leaf.

Reasoning-policy leaf complete imports (119 moved + 2 imports + blank = 122):

```ts
import type { OcxProviderConfig } from "../types";
import { isReasoningEffortOmitted, modelRecordValue } from "../reasoning-effort";
```

Export its six numeric constants plus `reasoningBudget`, `usesAdaptiveThinking`, `supportsExplicitThinkingDisable`, `adaptiveEffort`, `defaultReasoningEffort`. Keep family tables and parsing/minimum helpers private. The factory still imports `modelRecordValue` directly for its configured output-token lookup at source:902.

Tool-schema leaf complete imports (75 moved + 3 imports + blank = 79):

```ts
import type { OcxParsedRequest } from "../types";
import { isAllowedToolChoice, namespacedToolName, toolChoiceToolPredicate } from "../types";
import { stripResponsesOnlyEncryptedMarker } from "./responses-tool-schema";
```

Export `toolsToAnthropicFormat` only to the adapter; `normalizeAnthropicInputSchema` stays leaf-private.

Residual arithmetic: **1375 − 381 moved + up to 13 net wiring/format lines = 1007** expected upper budget. Imports that become unused can lower the actual count; they are not extra declarations moved. All leaves ≤400. The residual >400 is deliberate and assigned to **100_adapters_anthropic_b.md**, not treated as resolved here. L3's consistent ledger is **1007 − 712 + 10 = 305**. Combined file totals may grow by import lines; no behavior block is counted twice.

Diff semantics: 381 is unique moved physical source, not raw git diff size. Preserved long functions are not split internally in this layer. No line wrapping/minification to manufacture compliance.

## Re-export block

**No new re-export statements in L2:** every moved binding was private. Adding `export { applyPromptCaching, ... }` at the original path would unnecessarily enlarge its public API. The exact new `export { ... } from "./leaf"` / `export type { ... }` block is therefore empty.

Keep the existing exported definitions at the original boundary, with these unchanged signatures:

```ts
export function formatAnthropicErrorBody(status: number, _headers: Headers, payloadText: string): string
export function anthropicMessagesUrl(baseUrl: string): string
export function createAnthropicAdapter(provider: OcxProviderConfig, cacheRetention?: "none" | "short" | "long"): ProviderAdapter
```

The snippets above identify signatures, not replacement implementations. These explicit local imports are required by the retained factory:

```ts
import { MAX_CACHE_BREAKPOINTS, resolveCacheControl, applyPromptCaching, enforceCacheControlLimit, normalizeTtlOrdering } from "./anthropic-prompt-cache";
import { DEFAULT_MAX_TOKENS, REASONING_MAX_TOKENS_CEILING, ADAPTIVE_THINKING_CEILING, MIN_THINKING_BUDGET, OUTPUT_HEADROOM, OUTPUT_FLOOR, reasoningBudget, usesAdaptiveThinking, supportsExplicitThinkingDisable, adaptiveEffort, defaultReasoningEffort } from "./anthropic-reasoning-policy";
import { toolsToAnthropicFormat } from "./anthropic-tool-schema";
```

Retain all other still-used source imports, dropping moved-only bindings such as `stripResponsesOnlyEncryptedMarker`. Leaf exports are implementation seams consumed directly, not convenience barrel exports. Re-exporting a name is not a local import.

## Module-level state and cycles

There is **no top-level let, Map, Set, WeakMap, timer, lock or mutable tracker** in anthropic.ts. The full top-level scan has 54 declarations. Constant scalar values move with their policies; `COMPAT_TOOL_PREFIX:58` stays in the original file.

| Aggregate | Original range | Single owner after L2 |
|---|---|---|
| ADAPTIVE_THINKING_FAMILY_MINIMUMS | 482–486 | anthropic-reasoning-policy.ts |
| EXPLICIT_THINKING_DISABLE_FAMILY_MINIMUMS | 544–546 | anthropic-reasoning-policy.ts |

These tables are read-only by convention; retain object identity and do not introduce copies or writers. `Set` objects in message pairing (source:738,741) and input-schema required fields (834) are function-local, not module caches. Factory `isOAuth:871` and `toolNames:872` retain their per-adapter closure lifetime.

Cycle risks: do not make any leaf import anthropic.ts for types/constants, and do not import the adapter registry. Type aliases required by cache policy stay with their leaf; other leaves use the existing ../types boundary. Existing lane G1 found no return path into anthropic.ts. Planned edges add only downstream functional dependencies. Reasoning and schema remain independent; neither imports the other. No dependency injection or validation wrapper is needed. Verify concrete type/runtime edges during implementation rather than assuming typecheck is cycle detection.

## Tests

Complete direct-import `rg -l` list for the exact `src/adapters/anthropic` module (line numbers are import sites, not source-text reads). Each of the **24 test files is unchanged**:

```text
tests/adapters/adapter-usage.test.ts:3
tests/adapters/openai/openai-chat-model-suffix.test.ts:3
tests/adapters/buffered-response-shape-guards.test.ts:2
tests/adapters/anthropic/anthropic-tool-schema.test.ts:2
tests/adapters/anthropic/anthropic-compatible-stream.test.ts:2
tests/adapters/anthropic/anthropic-error-stop-reason.test.ts:2
tests/adapters/anthropic/anthropic-agentrouter-language-framing.test.ts:2
tests/adapters/anthropic/anthropic-image-retry.test.ts:3
tests/adapters/translator-budget.test.ts:3
tests/adapters/anthropic/anthropic-empty-content.test.ts:2
tests/adapters/anthropic/anthropic-tail-guard.test.ts:2
tests/adapters/anthropic/anthropic-eof-tolerance.test.ts:2
tests/adapters/anthropic/anthropic-stream-hardening.test.ts:2
tests/adapters/anthropic/anthropic-hardening.test.ts:2
tests/adapters/anthropic/anthropic-error-body.test.ts:3
tests/adapters/anthropic/anthropic-reasoning.test.ts:2
tests/adapters/anthropic/anthropic-thinking-signature.test.ts:3
tests/adapters/identity-neutralize.test.ts:13
tests/codex-integration/reasoning-effort.test.ts:3
tests/providers/umans-provider.test.ts:2
tests/responses/sse-null-data-frame.test.ts:2
tests/responses/responses-parser-malformed-content.test.ts:4
tests/clients/client-fingerprint.test.ts:8
tests/claude-integration/claude-messages-endpoint.test.ts:8
```

Production consumers are `src/adapters/registry.ts:1` and `src/index.ts:4` (public re-export). Exact-path fan-in is **26 files**, with `createAnthropicAdapter` in all 26, `formatAnthropicErrorBody` in one test, and `anthropicMessagesUrl` in one test. Do not count `src/oauth/index.ts:34`'s different `./anthropic` module or comments in provider/config-export/google sources.

Text-oracle readers of this source: **none found**, consistent with lane 014:173. Verified by basename/exact-path `rg -n` across tests, then inspecting candidates for `readFileSync|readFile\\(|Bun\\.file|source\\(`. Layout JSON references are test-path metadata. The GUI-file reads in `anthropic-pool-toggle-copy.test.ts:44,54,63,73` do not read S03 code. Thus no retarget-to-leaf or add-leaf-to-scan-list action, and no source-read line to report. Behavioral imports remain unchanged so they exercise the original compatibility boundary.

C-phase guard mutations, each temporary then restored (not executed in this docs task):

- `tests/adapters/adapter-usage.test.ts:209–211,244–247`: suppress `applyPromptCaching` at its existing factory call site and confirm the explicit system/tool/penultimate-message breakpoint assertions fail, then restore. Lane 014's `anthropic-reasoning.test.ts:444` assertion checks top-level automatic caching, which is assigned outside the moved helper; it is not a sufficient red guard for this extraction. No existing direct mixed-TTL/excess-breakpoint assertion was found in the inspected focused files, so do not claim those specific branches were driven red. Preserve their code verbatim and record this coverage limitation rather than exporting private helpers only for tests.
- Same reasoning suite: perturb adaptive/disabled-thinking classification and confirm the relevant existing behavior assertions fail; restore both family tables unchanged.
- `tests/adapters/anthropic/anthropic-tool-schema.test.ts`: bypass root composition normalization and confirm the composition test fails, then restore.
- Do not create source-string assertions as a substitute for request-body behavior tests.

## Verification

Implementation-only 002 **Per-layer gate** (not run by this doc author):

```sh
bun run typecheck
bun test tests/adapters/anthropic tests/adapters/adapter-usage.test.ts tests/adapters/openai/openai-chat-model-suffix.test.ts tests/adapters/buffered-response-shape-guards.test.ts tests/adapters/translator-budget.test.ts tests/adapters/identity-neutralize.test.ts tests/codex-integration/reasoning-effort.test.ts tests/providers/umans-provider.test.ts tests/responses/sse-null-data-frame.test.ts tests/responses/responses-parser-malformed-content.test.ts tests/clients/client-fingerprint.test.ts tests/claude-integration/claude-messages-endpoint.test.ts
bun run privacy:scan
wc -l src/adapters/anthropic-prompt-cache.ts src/adapters/anthropic-reasoning-policy.ts src/adapters/anthropic-tool-schema.ts src/adapters/anthropic.ts
rg -n 'from "[^"]*/adapters/anthropic"' src gui/src scripts tests
git diff --numstat
```

The `src/index.ts` public re-export and `src/adapters/registry.ts` sibling import require separate inspection (`rg -n 'adapters/anthropic|from "./anthropic"' src/index.ts src/adapters/registry.ts`); the combined exact-path set must stay at 26. Pass: typecheck/privacy exit 0, focused domains adapters/anthropic plus adapters/openai, codex-integration, providers, responses, clients, claude-integration at 0 failures, every new leaf ≤400, residual ≤1007 with #b explicitly pending. No src/server|src/router|src/lib file is touched, so the conditional core-lab test is not required here; never edit PROTECTED roots.

Full suite only on lidge:

```sh
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-adapters-anthropic-a && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'
```

Record the remote HEAD and full-suite real exit status (pipefail or unpiped run); tail alone does not prove success. Record the green exact-head CI rollup and a new-edge import-cycle check including type edges. Never run a repository-wide suite locally. The executor must have the same L1 base tip being reviewed and preserve its L1 gate evidence independently.

## Accept criteria

1. The full 54-declaration inventory remains accounted for; only the three listed private policy groups move.
2. Three new leaves measure ≤400; expected sizes are 187, 122 and 79.
3. Original exports remain exactly formatAnthropicErrorBody, anthropicMessagesUrl and createAnthropicAdapter; external consumer files remain the same 26.
4. Retained factory behavior and all moved bodies/literals/comments remain identical apart from imports/exports and whitespace.
5. No table duplication, upward import, cycle, public helper API, new dependency or source-oracle weakening.
6. The expected residual ≤1007 is explicitly pending #b, whose budget resolves it to ≤305; L2 alone is not claimed to finish anthropic.ts.
7. All focused and remote/exact-head gates pass with red/restored-green evidence for selected policy guards.
8. Parent resolves the 500-line accounting conflict before execution. This draft does not authorize extra branches, a cap waiver, or a merge.

## PR

Title: `refactor(adapters): extract private Anthropic request policies (split S03 L2/3)`

Base: `codex/split-adapters-anthropic-image-normalize`. Branch: `codex/split-adapters-anthropic-a`. Closes: none.

| Layer | PR | Branch | Base | Review focus |
|---|---|---|---|---|
| S03 L1/3 | #<S03-L1> | `codex/split-adapters-anthropic-image-normalize` | `dev` | Single cache/codec owner |
| S03 L2/3 | #<S03-L2> | `codex/split-adapters-anthropic-a` | `codex/split-adapters-anthropic-image-normalize` | Private prompt-cache/reasoning/schema leaves |
| S03 L3/3 | #<S03-L3> | `codex/split-adapters-anthropic-b` | `codex/split-adapters-anthropic-a` | Message conversion and response parsers |

Fill Summary, Verification and Checklist from the repository PR template. Mark L2 current; depends on #<S03-L1>. Review this layer's diff only. L1 changes require cascading L2 and L3; L2 changes require cascading L3, with fresh exact-head checks. Stack maintenance remains parent-owned, and no merge is authorized.
