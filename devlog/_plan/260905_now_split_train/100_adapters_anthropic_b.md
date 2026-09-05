# 100 — S03 L3/3: Anthropic messages and response parser leaves (#b)

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

Evidence basis: docs HEAD `4cc219549`; `origin/dev=1362b1a3841b4de20177e5d65865a513dd7936c4`. All source ranges below are at that code basis, not hypothetical post-move line numbers. `git diff origin/dev -- src/adapters/anthropic.ts src/adapters/anthropic-image-normalize.ts` was empty. Read 000, 001, 002 and lane 014 before planning. This delegated C3 docs-only task does not run tests, mutate git, or own CXC orchestration.

## Loop spec

- Archetype: `pure-move`.
- Goal: finish the `anthropic.ts` split after #a by moving message translation, response-value helpers, and the two existing parser methods, leaving the original factory/buildRequest/public URL/error boundary ≤400 lines.
- Non-goals: no protocol fixes, body rewrites, buffering strategy change, auth/header change, new state context/class, provider snapshot, public export rename or caller migration. Do not split the stream's internal state machine.
- Verifier: 002_layer_map.md **Per-layer gate**, instantiated below.
- Stop: all S03 leaves and both originals ≤400, all own-tip gates/CI recorded, no merge. Parent owns lifecycle, stack and goal state.
- Escalation: **712** moved physical source lines in this layer exceed the 002 ≤500 constraint even before double-counting move additions/deletions. Parent must explicitly approve the pure-move size exception or allocate additional layers in 002. This doc is a complete partition proposal, not an assertion that the existing layer-count and diff-size constraints are simultaneously satisfiable. No map/branch expansion is authorized in this bounded task.

Structural decision: `createAnthropicAdapter:870–1375` is 506 lines. Its `buildRequest:878–1035`, `parseStream:1037–1272` and `parseResponse:1274–1372` methods have separate lifetimes. Move the parser methods intact into small closure factories that capture the same provider and tool-name-transform object; do not move the whole 506-line factory into an oversized leaf. Reject a shared global parser state or new mutable context object: the stream state is already correctly invocation-local. Reject hoisting provider flags: the current methods read `provider.anthropicEofTolerance` at invocation time.

L2 first extracted private zero-fan-in policies; L3 handles the more coupled message conversion and parser closure seams. Public helpers with external fan-in 1 and factory fan-in 26 remain at the original boundary, minimizing consumer churn. New private seams exist only to preserve the existing method closures, not as APIs exposed for testing.

Map: registry/index + 24 tests → original factory → L2 policy leaves + new message/parser leaves. Stream and response → response-values; messages → existing types, image, identity, tool-call-id, tool-catalog nudge. No leaf → original boundary or registry edge. Existing OAuth tool-prefix construction stays in the original `buildToolNameTransforms:598–609`, shared by buildRequest and both parser factories. Feature-local blast radius. Sibling naming follows `google-errors.ts`, `google-tool-schema.ts`, `kiro-events.ts`, and the existing Anthropic image/schema leaves; no new convenience index.

## Symbol inventory

Declaration ranges came from `git show origin/dev:<path>` parsed in memory with the installed `@babel/parser` TypeScript parser, cross-checked against `nl -ba` / `rg -n` source reads. Tables include every top-level function, variable, type and interface declaration; imports are dependencies, recorded separately below. Consumer count means distinct other files importing/re-exporting that binding from this exact module: `rg -l '<basename>' src gui/src scripts tests -g '*.ts' -g '*.tsx'` supplies candidates, then import specifiers are resolved and counted. Comments, fixture path strings, unrelated OAuth modules named anthropic, and same-file references are excluded. Private declarations have zero external consumers, not zero internal uses.

All **54 original declarations** are repeated here for complete accounting. L2-owned rows are inherited, not moved again. Factory sub-method spans below are subsets of its 870–1375 range and must not be double-counted.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `toAnthropicContentPart` | function | 34–43 | no | 0 | `anthropic-messages.ts` |
| `DEFAULT_MAX_TOKENS` | const | 46–46 | no | 0 | `anthropic-reasoning-policy.ts (L2 owner)` |
| `REASONING_MAX_TOKENS_CEILING` | const | 48–48 | no | 0 | `anthropic-reasoning-policy.ts (L2 owner)` |
| `ADAPTIVE_THINKING_CEILING` | const | 51–51 | no | 0 | `anthropic-reasoning-policy.ts (L2 owner)` |
| `MIN_THINKING_BUDGET` | const | 53–53 | no | 0 | `anthropic-reasoning-policy.ts (L2 owner)` |
| `OUTPUT_HEADROOM` | const | 55–55 | no | 0 | `anthropic-reasoning-policy.ts (L2 owner)` |
| `OUTPUT_FLOOR` | const | 57–57 | no | 0 | `anthropic-reasoning-policy.ts (L2 owner)` |
| `COMPAT_TOOL_PREFIX` | const | 58–58 | no | 0 | `anthropic.ts (residual)` |
| `CacheControl` | type | 59–59 | no | 0 | `anthropic-prompt-cache.ts (L2 owner)` |
| `MAX_CACHE_BREAKPOINTS` | const | 60–60 | no | 0 | `anthropic-prompt-cache.ts (L2 owner)` |
| `resolveCacheControl` | function | 62–66 | no | 0 | `anthropic-prompt-cache.ts (L2 owner)` |
| `applyCacheControlToLast` | function | 79–83 | no | 0 | `anthropic-prompt-cache.ts (L2 owner)` |
| `applyCacheControlToLastText` | function | 85–93 | no | 0 | `anthropic-prompt-cache.ts (L2 owner)` |
| `PromptCachingOptions` | type | 95–98 | no | 0 | `anthropic-prompt-cache.ts (L2 owner)` |
| `applyPromptCaching` | function | 101–166 | no | 0 | `anthropic-prompt-cache.ts (L2 owner)` |
| `countBreakpoints` | function | 172–187 | no | 0 | `anthropic-prompt-cache.ts (L2 owner)` |
| `enforceCacheControlLimit` | function | 189–214 | no | 0 | `anthropic-prompt-cache.ts (L2 owner)` |
| `normalizeTtlOrdering` | function | 220–245 | no | 0 | `anthropic-prompt-cache.ts (L2 owner)` |
| `isLikelyRealAnthropicThinkingSignature` | function | 247–251 | no | 0 | `anthropic-messages.ts` |
| `formatAnthropicErrorBody` | function | 258–268 | yes | 1 | `anthropic.ts (residual)` |
| `isAnthropicRecord` | function | 270–272 | no | 0 | `anthropic-response-values.ts` |
| `anthropicStructuralValueType` | function | 274–277 | no | 0 | `anthropic-response-values.ts` |
| `InvalidAnthropicShapeDiagnostic` | interface | 279–283 | no | 0 | `anthropic-response-values.ts` |
| `invalidAnthropicShapeEvent` | function | 290–301 | no | 0 | `anthropic-response-values.ts` |
| `extractAnthropicErrorDetail` | function | 303–321 | no | 0 | `anthropic.ts (residual)` |
| `usesNativeAnthropicEndpoint` | function | 323–329 | no | 0 | `anthropic.ts (residual)` |
| `anthropicMessagesUrl` | function | 332–341 | yes | 1 | `anthropic.ts (residual)` |
| `synthesizeToolUseId` | function | 343–345 | no | 0 | `anthropic-response-values.ts` |
| `usableToolUseId` | function | 353–355 | no | 0 | `anthropic-response-values.ts` |
| `MAX_REPAIRABLE_TOOL_ARGUMENT_BYTES` | const | 366–366 | no | 0 | `anthropic-response-values.ts` |
| `utf8BytesExceed` | function | 373–390 | no | 0 | `anthropic-response-values.ts` |
| `lastValidJsonObject` | function | 392–417 | no | 0 | `anthropic-response-values.ts` |
| `toolUseArguments` | function | 419–439 | no | 0 | `anthropic-response-values.ts` |
| `streamedToolArgumentsParse` | function | 447–456 | no | 0 | `anthropic-response-values.ts` |
| `anthropicKeyUsesBearer` | function | 458–460 | no | 0 | `anthropic.ts (residual)` |
| `reasoningBudget` | function | 463–473 | no | 0 | `anthropic-reasoning-policy.ts (L2 owner)` |
| `ADAPTIVE_THINKING_FAMILY_MINIMUMS` | const | 482–486 | no | 0 | `anthropic-reasoning-policy.ts (L2 owner)` |
| `claudeFamilyVersion` | function | 504–515 | no | 0 | `anthropic-reasoning-policy.ts (L2 owner)` |
| `meetsFamilyMinimum` | function | 517–526 | no | 0 | `anthropic-reasoning-policy.ts (L2 owner)` |
| `usesAdaptiveThinking` | function | 528–530 | no | 0 | `anthropic-reasoning-policy.ts (L2 owner)` |
| `EXPLICIT_THINKING_DISABLE_FAMILY_MINIMUMS` | const | 544–546 | no | 0 | `anthropic-reasoning-policy.ts (L2 owner)` |
| `supportsExplicitThinkingDisable` | function | 548–550 | no | 0 | `anthropic-reasoning-policy.ts (L2 owner)` |
| `adaptiveEffort` | function | 553–555 | no | 0 | `anthropic-reasoning-policy.ts (L2 owner)` |
| `defaultReasoningEffort` | function | 557–567 | no | 0 | `anthropic-reasoning-policy.ts (L2 owner)` |
| `usageFromAnthropic` | function | 569–585 | no | 0 | `anthropic-response-values.ts` |
| `mergeAnthropicUsage` | function | 587–596 | no | 0 | `anthropic-response-values.ts` |
| `buildToolNameTransforms` | function | 598–609 | no | 0 | `anthropic.ts (residual)` |
| `toAnthropicToolResult` | function | 611–630 | no | 0 | `anthropic-messages.ts` |
| `unrepresentableToolCallText` | function | 632–635 | no | 0 | `anthropic-messages.ts` |
| `orphanToolResultText` | function | 637–643 | no | 0 | `anthropic-messages.ts` |
| `messagesToAnthropicFormat` | function | 651–792 | no | 0 | `anthropic-messages.ts` |
| `toolsToAnthropicFormat` | function | 794–806 | no | 0 | `anthropic-tool-schema.ts (L2 owner)` |
| `normalizeAnthropicInputSchema` | function | 808–868 | no | 0 | `anthropic-tool-schema.ts (L2 owner)` |
| `createAnthropicAdapter` | function | 870–1375 | yes | 26 | `residual; parser methods → stream/response leaves` |

Nested method relocation inventory (additional to, not replacing, the top-level inventory):

| Original member | Original range | Captured outer bindings | New owner/export |
|---|---|---|---|
| createAnthropicAdapter.buildRequest | 878–1035 | provider, isOAuth, toolNames, cacheRetention | stays inline in anthropic.ts |
| createAnthropicAdapter.parseStream | 1037–1272 | provider, toolNames | anthropic-stream.ts / createAnthropicStreamParser |
| createAnthropicAdapter.parseResponse | 1274–1372 | provider, toolNames | anthropic-response.ts / createAnthropicResponseParser |

The new factory functions have one production consumer each (the residual adapter); that is intended post-split fan-in, not an origin/dev count.

## Leaf partition

L2's three leaves remain unchanged at 187 / 122 / 79 expected lines. L1's codec/residual remain 302 / 227. L3 adds exactly **four** sibling files:

1. `src/adapters/anthropic-messages.ts`: move **34–44 (11), 247–252 (6), 611–793 (183)** = **200** lines. Symbols: `toAnthropicContentPart`, `isLikelyRealAnthropicThinkingSignature`, `toAnthropicToolResult`, `unrepresentableToolCallText`, `orphanToolResultText`, `messagesToAnthropicFormat`. Export only `messagesToAnthropicFormat` to the adapter. Expected **207** = 200 + six imports + blank.

```ts
import type { OcxAssistantMessage, OcxContentPart, OcxParsedRequest, OcxTextContent, OcxThinkingContent, OcxToolCall, OcxToolResultMessage } from "../types";
import { namespacedToolName } from "../types";
import { createToolCallIdAllocator } from "./tool-call-id";
import { parseDataUrl } from "./image";
import { identifyRoutedModel } from "./identity";
import { buildNonOpenAIToolCatalogNudgeForTools } from "./tool-catalog-nudge";
```

Do not carry the original unused OcxMessage or ToolCallIdAllocator imports into this leaf. Keep allocator creation and reserve/allocate/lookup passes together inside the moved function.

2. `src/adapters/anthropic-response-values.ts`: move **270–302 (33), 343–457 (115), 569–597 (29)** = **177** lines. Symbols: `isAnthropicRecord`, `anthropicStructuralValueType`, `InvalidAnthropicShapeDiagnostic`, `invalidAnthropicShapeEvent`, `synthesizeToolUseId`, `usableToolUseId`, `MAX_REPAIRABLE_TOOL_ARGUMENT_BYTES`, `utf8BytesExceed`, `lastValidJsonObject`, `toolUseArguments`, `streamedToolArgumentsParse`, `usageFromAnthropic`, `mergeAnthropicUsage`. Export only the eight called from parser leaves: isAnthropicRecord, anthropicStructuralValueType, invalidAnthropicShapeEvent, usableToolUseId, toolUseArguments, streamedToolArgumentsParse, usageFromAnthropic, mergeAnthropicUsage. Expected **179** = 177 + one import + blank.

```ts
import type { AdapterEvent, OcxUsage } from "../types";
```

3. `src/adapters/anthropic-stream.ts`: move method **1037–1272 (236)** without modifying its body. Replace method syntax by the returned async generator shown below; one closure factory owns access to the existing provider/toolNames objects. Expected **245** = 236 moved + two closure wrapper lines + six imports + blank. This is not a stream state-machine decomposition.

```ts
import type { ProviderAdapter } from "./base";
import type { AdapterEvent, OcxProviderConfig } from "../types";
import { debugDroppedFrame } from "../lib/debug";
import { decodeServerSentEvents } from "../lib/sse-decoder";
import { isTranslatorBudgetExceededError, type TranslatorBudget } from "../lib/translator-budget";
import { usableToolUseId, streamedToolArgumentsParse, usageFromAnthropic, mergeAnthropicUsage } from "./anthropic-response-values";
```

Exact wrapper signature (body is the verbatim original 1038–1271):

```ts
export function createAnthropicStreamParser(provider: OcxProviderConfig, toolNames: { fromWire: (name: string) => string }): ProviderAdapter["parseStream"]
```

Inside it return `async function* parseStream(response: Response, budget: TranslatorBudget): AsyncGenerator<AdapterEvent>` with that body. Close the returned function with `};`, then close the factory. Do not implement a second forwarding generator or eagerly allocate stream state in the outer factory.

4. `src/adapters/anthropic-response.ts`: move method **1274–1372 (99)**, body unchanged. Expected **107** = 99 moved + two wrapper lines + five imports + blank.

```ts
import type { ProviderAdapter } from "./base";
import type { AdapterEvent, OcxProviderConfig } from "../types";
import type { TranslatorBudget } from "../lib/translator-budget";
import { retainTranslatedEventBatch } from "../lib/translator-budget";
import { isAnthropicRecord, anthropicStructuralValueType, invalidAnthropicShapeEvent, usableToolUseId, toolUseArguments, usageFromAnthropic } from "./anthropic-response-values";
```

Exact wrapper signature:

```ts
export function createAnthropicResponseParser(provider: OcxProviderConfig, toolNames: { fromWire: (name: string) => string }): NonNullable<ProviderAdapter["parseResponse"]>
```

Return `async function parseResponse(response: Response, budget: TranslatorBudget): Promise<AdapterEvent[]>` with original 1275–1371 body. `NonNullable` is needed because base.ts:66 declares the adapter member optional; do not widen this concrete factory's result to possibly undefined. Both factories use an inline structural type for toolNames instead of duplicating its producer or adding a contracts module.

Residual `src/adapters/anthropic.ts` retains the original public functions `formatAnthropicErrorBody`, `anthropicMessagesUrl`, `createAnthropicAdapter`; private `extractAnthropicErrorDetail`, `usesNativeAnthropicEndpoint`, `anthropicKeyUsesBearer`, `COMPAT_TOOL_PREFIX`, `buildToolNameTransforms`; and the entire buildRequest method.

Physical ledger: #a left ≤1007. #b removes **200 + 177 + 236 + 99 = 712**, reserves **10** net wiring/format lines, yielding **≤305**. Combined: **1375 − 381 − 712 + 13 + 10 = 305**. Final L3 leaves expected **207 / 179 / 245 / 107** (all ≤400). Source import cleanup may reduce the residual further. Neither factory-body method is counted twice as moved source. No #c remains necessary for size after this partition, but additional PR layers or a size exception are necessary to satisfy the conflicting changeset cap.

## Re-export block

No existing public binding moves out of anthropic.ts in L3, so the exact additional named re-export/type-re-export block is **empty**. Keep these three public functions defined there (original signatures and implementations, with factory wiring only):

```ts
export function formatAnthropicErrorBody(status: number, _headers: Headers, payloadText: string): string
export function anthropicMessagesUrl(baseUrl: string): string
export function createAnthropicAdapter(provider: OcxProviderConfig, cacheRetention?: "none" | "short" | "long"): ProviderAdapter
```

Do not add public exports for any new private seam. The residual's new imports:

```ts
import { messagesToAnthropicFormat } from "./anthropic-messages";
import { createAnthropicStreamParser } from "./anthropic-stream";
import { createAnthropicResponseParser } from "./anthropic-response";
```

Keep L2's actual local imports as well:

```ts
import { MAX_CACHE_BREAKPOINTS, resolveCacheControl, applyPromptCaching, enforceCacheControlLimit, normalizeTtlOrdering } from "./anthropic-prompt-cache";
import { DEFAULT_MAX_TOKENS, REASONING_MAX_TOKENS_CEILING, ADAPTIVE_THINKING_CEILING, MIN_THINKING_BUDGET, OUTPUT_HEADROOM, OUTPUT_FLOOR, reasoningBudget, usesAdaptiveThinking, supportsExplicitThinkingDisable, adaptiveEffort, defaultReasoningEffort } from "./anthropic-reasoning-policy";
import { toolsToAnthropicFormat } from "./anthropic-tool-schema";
```

Replace only the two method properties in the returned adapter object:

```ts
parseStream: createAnthropicStreamParser(provider, toolNames),
parseResponse: createAnthropicResponseParser(provider, toolNames),
```

No parser helper import is needed by the residual. Keep the original base/types, OAuth, image-limit/normalization, output-schema, redact, fingerprint, tool-choice, modelRecordValue and AgentRouter bindings still used by buildRequest/URL/error/tool-prefix code. Remove moved-only imports for message conversion, debug, SSE and translator-budget. Re-exports never substitute for local imports.

## Module-level state and cycles

No top-level let/Map/Set/WeakMap/lock in the original or proposed adapter leaves. Inherited reasoning tables at original 482–486 and 544–546 remain owned by the L2 reasoning-policy leaf. COMPAT_TOOL_PREFIX:58 stays original; MAX_REPAIRABLE_TOOL_ARGUMENT_BYTES:366 moves only to response-values. Other scalar policy constants stay with their L2 owners.

| Existing state | Original lines | Lifetime and owner after move |
|---|---|---|
| isOAuth, toolNames | 871–872 | per adapter, original constructor; same object passed into each parser factory |
| callIds | 657 onward | per messagesToAnthropicFormat call, messages leaf |
| requiredIds / seen | 738 / 741 | per assistant-message pairing, messages leaf |
| budgetEncoder; currentBlockType/currentToolCallId/currentToolCallName/currentToolCallJson; pendingUsage/pendingStopReason; emittedDone/sawVisibleText | 1043–1051 | allocated inside each parseStream invocation, stream leaf |
| emitDone closure | 1053–1073 | captures only that stream invocation's state, stream leaf |
| responseBytes / events / finishWithEvents | 1289–1298 | per buffered parse invocation, response leaf |

No holder is copied into both leaves, and no per-stream variable is moved to module or outer-factory scope. Preserve tool-call budget open/close order, retained/transient accounting, cancellation `finally`, terminal error returns, and exact usage merge precedence. The original methods contain no `this` access; closure factories need no `.bind`, shared context object or callback adapter.

Forbidden cycles: messages → anthropic (for its signature checker); stream/response → anthropic (for usage/tool-argument helpers); response-values → either parser. Move each helper to the downstream owner specified above; stream and response do not import one another. Existing types/base dependencies are imported directly; no leaf imports registry or the old public boundary. Type edges count in the cycle check. This is functional coupling; shared wire-format parsing stays single-owned, and request-state temporal coupling stays confined to one function.

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

Retain L2's explicit breakpoint assertions in adapter-usage.test.ts unchanged in L3. No new test filename, source-text oracle or layout-map entry is required.

C-phase guards to drive red once, then restore (implementation only):

- `anthropic-thinking-signature.test.ts`, `anthropic-tail-guard.test.ts`, `anthropic-hardening.test.ts`: bypass respectively the moved thinking-signature predicate, terminal user nudge, and call/result pairing. Each corresponding existing assertion must fail; restore all.
- `anthropic-error-stop-reason.test.ts`: suppress an error-terminal branch in each parser separately and verify that parser's case fails. Do not test just one wire mode.
- `anthropic-eof-tolerance.test.ts` and `anthropic-stream-hardening.test.ts`: perturb usable-ID/assembled-JSON validation, confirm existing invalid-tool and EOF cases fail, then restore.
- `tests/adapters/translator-budget.test.ts`: remove the terminal return after a stream budget error or the buffered release in a temporary mutation; matching budget/terminal tests must fail, then restore.
- Preserve tests through `createAnthropicAdapter`, not direct imports solely to expose internals. All byte/order-sensitive assertions remain at least as strict.

## Verification

Implementation-only 002 **Per-layer gate**, not executed by this doc author:

```sh
bun run typecheck
bun test tests/adapters/anthropic tests/adapters/adapter-usage.test.ts tests/adapters/openai/openai-chat-model-suffix.test.ts tests/adapters/buffered-response-shape-guards.test.ts tests/adapters/translator-budget.test.ts tests/adapters/identity-neutralize.test.ts tests/codex-integration/reasoning-effort.test.ts tests/providers/umans-provider.test.ts tests/responses/sse-null-data-frame.test.ts tests/responses/responses-parser-malformed-content.test.ts tests/clients/client-fingerprint.test.ts tests/claude-integration/claude-messages-endpoint.test.ts
bun run privacy:scan
wc -l src/adapters/anthropic-image-codec.ts src/adapters/anthropic-image-normalize.ts src/adapters/anthropic-prompt-cache.ts src/adapters/anthropic-reasoning-policy.ts src/adapters/anthropic-tool-schema.ts src/adapters/anthropic-messages.ts src/adapters/anthropic-response-values.ts src/adapters/anthropic-stream.ts src/adapters/anthropic-response.ts src/adapters/anthropic.ts
rg -n 'from "[^"]*/adapters/anthropic"' src gui/src scripts tests
rg -n 'adapters/anthropic|from "./anthropic"' src/index.ts src/adapters/registry.ts
git diff --numstat
```

Expected: typecheck/privacy exit 0, focused adapters/anthropic plus adapters/openai, codex-integration, providers, responses, clients and claude-integration at 0 fail; original adapter consumer set unchanged at 26; every listed source file ≤400. Verify actual new import/re-export graph including type edges against the stated DAG. Conditional 002 core-lab gate is not activated for adapter-only edits; never change PROTECTED roots or introduce Lab edges. Any need to touch server/router/lib first escalates scope and then invokes that gate.

Full suite only on lidge, not locally:

```sh
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-adapters-anthropic-b && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'
```

Capture exact remote HEAD and true full-suite exit status using pipefail or an unpiped run; tail success is not suite success. Record the exact-head CI rollup and ensure this L3 tip contains the reviewed L2 tip. The doc author does not run remote commands or CI.

## Accept criteria

1. All original 54 top-level declarations have exactly one owner; all three original public exports and all 26 consumer files stay compatible.
2. The four new leaves are ≤400, expected 207/179/245/107. The residual is ≤305; inherited L1/L2 modules also remain ≤400.
3. Arithmetic matches #a: 381 lines moved there, 712 here, residual allowance 305; no new source file or final residual exceeds 400.
4. Methods move with bodies intact; only closure factory syntax, imports/exports and two property bindings change. No wrappers add a generator hop or alter promise/error timing.
5. Each stream/buffer invocation owns its state and cleanup; provider/toolNames captures preserve reference identity and late-read semantics.
6. Zero new upward/type/runtime cycles, duplicate helper/state owners, public seam exports, source-oracle weakening or caller migrations.
7. Existing behavioral tests, selected red/restored-green guards, focused checks, privacy, remote full suite and exact-head CI all pass for this tip.
8. Parent resolves the >500-line conflict before execution; this doc never claims the fixed L3 diff fits that cap or authorizes extra stack layers.
9. No merges, releases, orchestration commands or source/test edits occur as part of drafting these three documents.

## PR

Title: `refactor(adapters): separate Anthropic messages and response parsers (split S03 L3/3)`

Base: `codex/split-adapters-anthropic-a`. Branch: `codex/split-adapters-anthropic-b`. Closes: none.

| Layer | PR | Branch | Base | Review focus |
|---|---|---|---|---|
| S03 L1/3 | #<S03-L1> | `codex/split-adapters-anthropic-image-normalize` | `dev` | Single cache/codec owner |
| S03 L2/3 | #<S03-L2> | `codex/split-adapters-anthropic-a` | `codex/split-adapters-anthropic-image-normalize` | Private prompt-cache/reasoning/schema leaves |
| S03 L3/3 | #<S03-L3> | `codex/split-adapters-anthropic-b` | `codex/split-adapters-anthropic-a` | Message conversion and response parsers |

Use the repository template's Summary, Verification and Checklist, mark L3 current, and state depends on #<S03-L2>. Review only this layer's diff; L1/L2 maintain their own independent gates. Parent cascades any lower-layer change and refreshes exact-head checks. No merge is authorized.
