# 180 — S05 L3: Ollama native request and response leaves

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: **pure-move**; C3 structural planning with credential-sensitive behavior preserved in place. Source basis `origin/dev:1362b1a38`; docs HEAD `4cc219549`. Inputs read: 000/001/002 S05 and lane 014's Ollama-native audit.
- Goal: split the 1,131-line adapter into four provider-local leaves, each ≤400, leaving the existing factory and header policy in an expected 151-line original module. Preserve both public exports and all wire/event/error/budget semantics.
- Non-goals: new parsing algorithms, fresh state abstractions, rewritten function bodies, observers, changed validation/credentials, request lifecycle changes, test runs/code/git mutation during this delegated drafting task, and parent-owned orchestration/loop/goal commands.
- Structural map/context: registry (`src/adapters/registry.ts:11`) and six test files consume the public factory. Original dependencies 1–38 are base/types, crypto, reasoning, bounded body, diagnostics, translator budget, redaction, image parsing and URL policy. Intended direction: existing factory → request and stream; request → values; stream → events and values; events → values. Existing upstream types/libs and URL policy remain downstream. Blast radius: one adapter feature, not the registry.
- Decision: move already separate top-level definitions; retain `buildHeaders` and the factory's request-owned state. Reject splitting by arbitrary offsets or extracting factory methods with new state arguments: existing helper seams already accept the needed state. Do nothing/configure/delete cannot meet 400 lines; borrowing Command Code's permissive NDJSON decoder would change Ollama's terminal and budget contract.
- Verifier: 002 **Per-layer gate**, instantiated below, plus public-surface/ID/budget/abort fixtures and source-body identity checks.
- Stop: after parent resolves the size contradiction, implementation stops at exact-head green L3 PR, never merges. This drafting task stops after its one assigned document is statically verified.
- **Escalation required before implementation:** 002 gives this 1,131-line file one layer and caps a layer at ≤500 changed source lines. Merely reaching 400 requires moving at least 731 source lines before shims, already >500 even if moves count once; ordinary add+delete accounting is ≥1,462. This complete four-leaf design moves 954 original physical lines. It cannot truthfully satisfy the current one-layer size gate. Parent must explicitly approve a move-only size exception or revise 002 with additional #a/#b layers and their docs/branches. This delegate does not edit 002, add a fourth S05 layer, or treat the contradiction as resolved.

## Symbol inventory

Inclusive definition ranges were extracted with an in-memory Babel TypeScript AST from `git show origin/dev:src/adapters/ollama-native.ts`. Basis: `origin/dev` = `1362b1a3841b4de20177e5d65865a513dd7936c4`; docs HEAD `4cc219549`. Imports are documented separately below. Consumer counts are distinct files importing this exact symbol through the original path: `rg -l 'ollama-native' src gui/src scripts tests -g '*.ts' -g '*.tsx'`, followed by relative-path/import-name filtering. Generic text matches (for example `usage`) and unrelated same-basename modules are excluded. Private definitions have zero external import consumers. 48 definitions; 7 static importer files.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `OllamaNativeMessage` | interface | 41–57 | yes | 0 | `src/adapters/ollama-native-request.ts` |
| `OllamaNativeTool` | interface | 59–66 | no | 0 | `src/adapters/ollama-native-request.ts` |
| `PendingToolCall` | interface | 68–75 | no | 0 | `src/adapters/ollama-native-request.ts` |
| `PendingToolBatch` | interface | 77–80 | no | 0 | `src/adapters/ollama-native-request.ts` |
| `NativeStreamToolCall` | interface | 82–91 | no | 0 | `src/adapters/ollama-native-events.ts` |
| `NativeStreamState` | interface | 93–102 | no | 0 | `src/adapters/ollama-native-events.ts` |
| `JsonRecord` | type | 104–104 | no | 0 | `src/adapters/ollama-native-values.ts` |
| `NativeReadResult` | type | 105–105 | no | 0 | `src/adapters/ollama-native-stream.ts` |
| `NATIVE_THINK_VALUES` | const | 107–107 | no | 0 | `src/adapters/ollama-native-request.ts` |
| `NATIVE_TOOL_ID_MAX_LENGTH` | const | 108–108 | no | 0 | `src/adapters/ollama-native-values.ts` |
| `NATIVE_TOOL_ID_CONTROL` | const | 109–109 | no | 0 | `src/adapters/ollama-native-values.ts` |
| `isRecord` | function | 111–113 | no | 0 | `src/adapters/ollama-native-values.ts` |
| `isFiniteNonNegativeInteger` | function | 115–117 | no | 0 | `src/adapters/ollama-native-values.ts` |
| `validNativeToolCallId` | function | 125–134 | no | 0 | `src/adapters/ollama-native-values.ts` |
| `mintNativeToolCallId` | function | 136–143 | no | 0 | `src/adapters/ollama-native-values.ts` |
| `allocateNativeToolCallId` | function | 145–156 | no | 0 | `src/adapters/ollama-native-values.ts` |
| `safeNativeString` | function | 158–162 | no | 0 | `src/adapters/ollama-native-values.ts` |
| `errorDetail` | function | 164–174 | no | 0 | `src/adapters/ollama-native-values.ts` |
| `nativeErrorEvent` | function | 176–189 | no | 0 | `src/adapters/ollama-native-values.ts` |
| `malformedNativeEvent` | function | 191–200 | no | 0 | `src/adapters/ollama-native-values.ts` |
| `translationBudgetEvent` | function | 202–211 | no | 0 | `src/adapters/ollama-native-values.ts` |
| `wireModelId` | function | 213–219 | no | 0 | `src/adapters/ollama-native-request.ts` |
| `assertObjectArguments` | function | 221–224 | no | 0 | `src/adapters/ollama-native-values.ts` |
| `normalizedBase64` | function | 226–236 | no | 0 | `src/adapters/ollama-native-request.ts` |
| `imageToBase64` | function | 238–250 | no | 0 | `src/adapters/ollama-native-request.ts` |
| `contentToNative` | function | 252–272 | no | 0 | `src/adapters/ollama-native-request.ts` |
| `assistantTextThinkingAndCalls` | function | 274–292 | no | 0 | `src/adapters/ollama-native-request.ts` |
| `buildNativeMessages` | function | 294–409 | no | 0 | `src/adapters/ollama-native-request.ts` |
| `buildNativeTools` | function | 411–444 | no | 0 | `src/adapters/ollama-native-request.ts` |
| `nativeThink` | function | 446–497 | no | 0 | `src/adapters/ollama-native-request.ts` |
| `nativeFormat` | function | 499–520 | no | 0 | `src/adapters/ollama-native-request.ts` |
| `usageFromNative` | function | 522–528 | no | 0 | `src/adapters/ollama-native-events.ts` |
| `stopReasonFromNative` | function | 530–534 | no | 0 | `src/adapters/ollama-native-events.ts` |
| `nativeMessageEvents` | function | 536–605 | no | 0 | `src/adapters/ollama-native-events.ts` |
| `flushNativeStreamToolCalls` | function | 607–620 | no | 0 | `src/adapters/ollama-native-events.ts` |
| `replaceNativeToolArguments` | function | 622–647 | no | 0 | `src/adapters/ollama-native-events.ts` |
| `releaseNativeStateBuffers` | function | 649–651 | no | 0 | `src/adapters/ollama-native-events.ts` |
| `nativeBodyMessage` | function | 653–656 | no | 0 | `src/adapters/ollama-native-events.ts` |
| `nativeEventsFromResponsePayload` | function | 658–705 | no | 0 | `src/adapters/ollama-native-events.ts` |
| `formatNativeErrorBody` | function | 707–733 | no | 0 | `src/adapters/ollama-native-values.ts` |
| `buildHeaders` | function | 735–784 | no | 0 | `src/adapters/ollama-native.ts (residual)` |
| `replaceLiveBuffer` | function | 786–801 | no | 0 | `src/adapters/ollama-native-stream.ts` |
| `readWithAbort` | function | 803–822 | no | 0 | `src/adapters/ollama-native-stream.ts` |
| `streamState` | function | 824–833 | no | 0 | `src/adapters/ollama-native-events.ts` |
| `processNativeLine` | function | 835–892 | no | 0 | `src/adapters/ollama-native-events.ts` |
| `parseOllamaNativeStream` | function | 894–1014 | no | 0 | `src/adapters/ollama-native-stream.ts` |
| `parseOllamaNativeResponse` | function | 1016–1044 | no | 0 | `src/adapters/ollama-native-stream.ts` |
| `createOllamaNativeAdapter` | function | 1046–1131 | yes | 7 | `src/adapters/ollama-native.ts (residual)` |

The dynamic import at `tests/providers/ollama/ollama-native-parser.test.ts:52` is another edge in an already-counted test file, not an eighth consumer. `OllamaNativeMessage` has zero direct importers but is still a public type and must remain exported.

## Leaf partition

Paths reuse provider-prefixed siblings, particularly existing `src/adapters/ollama-native-url.ts:9` and `src/adapters/kiro-thinking.ts:1`. No generic utility module, new index barrel, alternate adapter registry or new dependency. Table sizes preserve comments and blank lines in the specified disjoint slices; imports below are kept on the shown physical lines, followed by one blank.

| New file | Exact symbol ownership | Original slices including comments/blanks | Moved lines + imports | Expected lines |
|---|---|---|---|---:|
| `src/adapters/ollama-native-request.ts` | `OllamaNativeMessage`, `OllamaNativeTool`, `PendingToolCall`, `PendingToolBatch`, `NATIVE_THINK_VALUES`, `wireModelId`, `normalizedBase64`, `imageToBase64`, `contentToNative`, `assistantTextThinkingAndCalls`, `buildNativeMessages`, `buildNativeTools`, `nativeThink`, `nativeFormat` | 40–81, 107, 213–220, 226–521 | 347 +8 | 355 |
| `src/adapters/ollama-native-values.ts` | `JsonRecord`, `NATIVE_TOOL_ID_MAX_LENGTH`, `NATIVE_TOOL_ID_CONTROL`, `isRecord`, `isFiniteNonNegativeInteger`, `validNativeToolCallId`, `mintNativeToolCallId`, `allocateNativeToolCallId`, `safeNativeString`, `errorDetail`, `nativeErrorEvent`, `malformedNativeEvent`, `translationBudgetEvent`, `assertObjectArguments`, `formatNativeErrorBody` | 104, 108–212, 221–225, 707–734 | 139 +4 | 143 |
| `src/adapters/ollama-native-events.ts` | `NativeStreamToolCall`, `NativeStreamState`, `usageFromNative`, `stopReasonFromNative`, `nativeMessageEvents`, `flushNativeStreamToolCalls`, `replaceNativeToolArguments`, `releaseNativeStateBuffers`, `nativeBodyMessage`, `nativeEventsFromResponsePayload`, `streamState`, `processNativeLine` | 82–103, 522–706, 824–893 | 277 +4 | 281 |
| `src/adapters/ollama-native-stream.ts` | `NativeReadResult`, `replaceLiveBuffer`, `readWithAbort`, `parseOllamaNativeStream`, `parseOllamaNativeResponse` | 105, 786–823, 894–1045 | 191 +6 | 197 |

Request leaf own imports:
```ts
import type { OcxAssistantMessage, OcxContentPart, OcxMessage, OcxParsedRequest, OcxProviderConfig, OcxThinkingContent, OcxToolCall } from "../types";
import { isAllowedToolChoice, modelInList, namespacedToolName, toolChoiceToolPredicate } from "../types";
import { configuredReasoningEfforts, isReasoningEffortOmitted, mapReasoningEffort, reasoningEffortMapFor } from "../reasoning-effort";
import { redactSecretString } from "../lib/redact";
import { parseDataUrl } from "./image";
import type { OllamaNativeEndpointKind } from "./ollama-native-url";
import { isRecord, assertObjectArguments } from "./ollama-native-values";
```
Public type `OllamaNativeMessage` stays exported here; export the five actual factory dependencies `wireModelId`, `buildNativeMessages`, `buildNativeTools`, `nativeThink`, `nativeFormat`. Other request definitions remain private.

Values leaf owns existing wire-value validation, ID allocation and error projection (not cross-provider helpers). Own imports:
```ts
import { randomUUID } from "node:crypto";
import type { AdapterEvent, OcxUsage } from "../types";
import { redactSecretString } from "../lib/redact";
```
Export `JsonRecord` as a type plus `isRecord`, `isFiniteNonNegativeInteger`, `validNativeToolCallId`, `allocateNativeToolCallId`, `nativeErrorEvent`, `malformedNativeEvent`, `translationBudgetEvent`, `assertObjectArguments`, `formatNativeErrorBody` for actual leaf/factory consumers. Keep the ID constants, minting implementation, safe-string and detail readers private.

Events leaf own imports:
```ts
import type { AdapterEvent, OcxUsage } from "../types";
import { isTranslatorBudgetExceededError, TRANSLATOR_MAX_SSE_EVENT_BYTES, TranslatorBudgetExceededError, type TranslatorBudget } from "../lib/translator-budget";
import { isRecord, isFiniteNonNegativeInteger, validNativeToolCallId, allocateNativeToolCallId, assertObjectArguments, nativeErrorEvent, malformedNativeEvent, translationBudgetEvent, type JsonRecord } from "./ollama-native-values";
```
Export `NativeStreamState` as a type and `nativeEventsFromResponsePayload`, `releaseNativeStateBuffers`, `streamState`, `processNativeLine` for the stream leaf. `NativeStreamToolCall` stays local; no new state object/factory is invented.

Stream leaf own imports:
```ts
import type { AdapterEvent } from "../types";
import { readBoundedResponseBytes } from "../lib/bounded-body";
import { isTranslatorBudgetExceededError, retainTranslatedEventBatch, TRANSLATOR_MAX_SSE_EVENT_BYTES, TranslatorBudgetExceededError, type TranslatorBudget } from "../lib/translator-budget";
import { malformedNativeEvent, translationBudgetEvent } from "./ollama-native-values";
import { nativeEventsFromResponsePayload, releaseNativeStateBuffers, streamState, processNativeLine } from "./ollama-native-events";
```
Export only `parseOllamaNativeStream` and `parseOllamaNativeResponse`. No imported `NativeStreamState` is needed here: `streamState` already infers it; the type is exported by its owner as part of that leaf contract.

Residual `src/adapters/ollama-native.ts`: `buildHeaders` (735–784), `createOllamaNativeAdapter` (1046–1131), and the boundary imports below. Source-slice arithmetic: 1,131 −954 =177 retained lines; replace the old 38-line import block with the 12 lines below, retaining the old separator = **151**. Leaf total 976; aggregate 1,127 =1,131 −38 +12 +22 leaf-import/separator lines. Formatting changes require fresh counts, never dropping comments to hit a threshold.

This complete design leaves **zero residuals over 400**; it is not a claim that the single L3 satisfies the diff-size cap. No approved #b exists in 002. If the parent chooses reslicing instead of an exception, #a should first take the zero-external-consumer values foundation, then dependent request/events/stream leaves, preserving these exact owners. The parent must assign intermediate residual counts and enough layers to satisfy measured add+delete size; do not silently publish this complete design under an incomplete #a label.

## Re-export block

Replace imports 1–38 with these 12 lines (including the type re-export):
```ts
import type { AdapterRequest, IncomingMeta, ProviderAdapter } from "./base";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../types";
import { modelInList } from "../types";
import { modelRecordValue } from "../reasoning-effort";
import { debugProviderDiagnostic } from "../lib/debug";
import type { TranslatorBudget } from "../lib/translator-budget";
import { SENSITIVE_KEY_PATTERN } from "../lib/redact";
import { ollamaNativeChatUrl, ollamaNativeEndpointKind, type OllamaNativeEndpointKind } from "./ollama-native-url";
import { buildNativeMessages, buildNativeTools, nativeFormat, nativeThink, wireModelId } from "./ollama-native-request";
import { formatNativeErrorBody } from "./ollama-native-values";
import { parseOllamaNativeStream, parseOllamaNativeResponse } from "./ollama-native-stream";
export type { OllamaNativeMessage } from "./ollama-native-request";
```
`createOllamaNativeAdapter` remains inline exported. These are the entire original public surface (one factory, one type); no value re-export is needed because the factory stays. Explicit value imports bind the functions used in that factory at old 1052, 1060–1062, 1088–1090 and 1113–1128. Re-exporting the type does not create a local binding, and the residual does not use that type.

## Module-level state and cycles

- `NATIVE_THINK_VALUES` (107), the only top-level Set, moves once to request; no mutation is added. `NATIVE_TOOL_ID_MAX_LENGTH` (108) and `NATIVE_TOOL_ID_CONTROL` (109) move once to values. The regex has no global/sticky flag and no new shared mutable state is introduced.
- No top-level let, Map, WeakMap, timer or lock. `NativeStreamState.toolCalls` is a type member (94), not an allocation.
- Factory closure stays intact: `requestAbortSignal` (1047), `requestAllowsParallelToolCalls` (1048), `issuedToolCallIds` Set (1049). `buildNativeMessages` still clears/reserves that same Set (307, 372); both response paths receive it (1117, 1126). No per-leaf or process-global substitute.
- State maps at 668 and 826 remain per parse invocation, with creation owned by events. Pending batch maps at 401 remain per message compilation in request. Live reader, decoder, residual, cancellation and abort-listener state (803–821, 905–912) stays invocation-local in stream; retain all finally/release ordering.
- Intended DAG: boundary → request/stream/values; request → values; stream → events/values; events → values. No leaf imports the boundary. Request-only types live in request, parser types in events, shared `JsonRecord` in values, and `NativeReadResult` in stream. Keeping shared predicates in the residual would create request↔boundary and events↔boundary cycles; moving them to values avoids those.
- Existing lane G1 found no cycle. Re-run its resolved graph including type edges after extraction; existing dependencies retain their direction. No lazy import escape hatch, new Lab edge or convenience barrel.
- Coupling: provider external-format coupling stays contained; explicit Set/budget parameters preserve existing temporal contract. Moving definitions does not authorize duplicating state, passing callbacks to break a cycle, or inventing an observer API.

## Tests

Exact direct static-import file list from `rg -l 'adapters/ollama-native"' tests -g '*.ts'`:
- `tests/providers/ollama/ollama-show-enrichment-v7.test.ts:371` — unchanged; keep its original-path import.
- `tests/providers/ollama/ollama-native-v4.test.ts:2` — unchanged; keep its original-path import.
- `tests/providers/ollama/ollama-native-parser.test.ts:2` — unchanged; keep its original-path import.
- `tests/providers/ollama/ollama-native-reasoning-wire.test.ts:2` — unchanged; keep its original-path import.
- `tests/providers/ollama/ollama-native-structured-output.test.ts:2` — unchanged; keep its original-path import.
- `tests/providers/ollama/ollama-native.test.ts:2` — unchanged; keep its original-path import.

`tests/providers/ollama/ollama-native-parser.test.ts:52` dynamically imports the original module to check absence of observation machinery; unchanged. This is a runtime module-surface guard, **not** a source-text reader. Do not retarget it to a leaf.

Additional unchanged indirect gates: `tests/adapters/adapter-registry-authority.test.ts`, `tests/adapters/adapter-tool-conformance.test.ts`, `tests/adapters/adapter-buffered-tool-conformance.test.ts`.

Filename-specific source-text readers: **none** in O1 basename/path + readFileSync/Bun.file/readFile search. Generic source oracle: `tests/lab/core-lab-boundary.test.ts:69` reads transitive source and will automatically traverse all static leaf edges — unchanged. No retarget-to-leaf or add-leaf-to-scan-list. Preserve its PROTECTED roots at line 20.

Drive guards red once during implementation and restore before final verification:
1. Existing observer-free guard at parser.test.ts:50–58: temporarily export the prohibited observation-sink name from the residual; the dynamic-import guard must fail. Remove the temporary export.
2. Budget/EOF parity: temporarily release the EOF residual before `processNativeLine` (old 974); `tests/providers/ollama/ollama-native-v4.test.ts:28` must fail. Restore the exact accounting order.
3. Temporarily import a Lab module from a new leaf; the generic transitive guard must report the path. Restore without touching PROTECTED or weakening the scan.

Keep tool ID reuse/parallel policy, done:true validation, structured-output, reasoning omission, remote-image refusal, and transport/header tests through the public factory. Do not move credential policy out of `buildHeaders`, nor lower limits to make memory tests cheaper. Red runs happen only in the implementation worktree, not this drafting task.

## Verification

Implementation-only commands: none were run for this docs-only delegation. This instantiates `002_layer_map.md` → **Per-layer gate** (the `003` reference in 000 is stale).

```sh
bun run typecheck
bun test tests/providers/ollama/ollama-native.test.ts tests/providers/ollama/ollama-native-parser.test.ts tests/providers/ollama/ollama-native-v4.test.ts tests/providers/ollama/ollama-native-reasoning-wire.test.ts tests/providers/ollama/ollama-native-structured-output.test.ts tests/providers/ollama/ollama-show-enrichment-v7.test.ts tests/adapters/adapter-registry-authority.test.ts tests/adapters/adapter-tool-conformance.test.ts tests/adapters/adapter-buffered-tool-conformance.test.ts
bun run privacy:scan
bun test tests/lab/core-lab-boundary.test.ts
wc -l src/adapters/ollama-native-request.ts src/adapters/ollama-native-values.ts src/adapters/ollama-native-events.ts src/adapters/ollama-native-stream.ts src/adapters/ollama-native.ts
rg -l 'from "[^"]*/ollama-native"' src gui/src scripts tests
git diff --check
git diff --numstat origin/dev...HEAD -- src tests
```

Focused domains: `tests/providers/ollama` and `tests/adapters` registry/tool conformance. The original-path static importer list must retain 7 unique files after exact relative-path filtering (the raw basename rg can include unrelated modules). Keep exports/types resolvable; count alone is not proof. No protected-root edits are needed; the Lab guard is included because adapters are transitively reachable. Each listed leaf and residual must be ≤400 physical lines. Compare normalized AST bodies before/after, allowing only location, import/export modifiers and required import binding changes; preserve comments and exact error/wire literals.

Run the resolved-relative-import/re-export graph walk from lane 014's G1, including type edges, at the layer tip; no return path from any new leaf to its old boundary or another leaf may appear. The Lab guard checks optional-subsystem reachability, not general cycles.

Full suite is **never local**; executor uses the existing authorized remote checkout only after verifying its ownership, with pipeline failure propagation:
```sh
ssh lidge 'bash -o pipefail -c "cd ~/ocx-ci/opencodex && git fetch origin codex/split-adapters-ollama-native && git checkout -q FETCH_HEAD && git rev-parse HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15"'
```
Record remote HEAD equal to PR head, full-suite exit status and totals, local focused/typecheck/privacy results, and the complete exact-head CI rollup. A tail without the test exit status is not evidence. Re-run only invalidated checks after a lower-layer cascade; no merge/auto-merge.


Before these commands, resolve the one-layer/500-line contradiction in Loop spec; a passing suite is not a size-gate waiver. Preserve `buildHeaders` and URL policy ASTs exactly, and obtain the explicit security review required by `MAINTAINERS.md` if the actual implementation diff touches credential handling. No new dependency or general-purpose cycle checker installation is authorized.

## Accept criteria

1. Parent records either an explicit pure-move size exception for this L3 or an approved updated layer map with #a/#b ownership/residual accounting; without it, this plan is **blocked for implementation**, not ready.
2. All 48 definitions have exactly one owner; moved bodies/signatures/default arguments equal origin/dev; no new observer or validation behavior.
3. `createOllamaNativeAdapter` and `OllamaNativeMessage` remain importable from the original path; all seven static consumer files and the existing dynamic surface guard remain valid.
4. Four leaves ≤400 (355, 143, 281, 197 expected), residual ≤400 (151 expected); total line arithmetic is consistent and no residual debt is silently deferred.
5. Factory owns the single issued-ID Set and abort/parallel state; parser maps/readers/budget reservations keep original lifetimes and cleanup order.
6. No runtime/type cycle or new Lab reachability; no protected-root edits; credential/URL policy unchanged.
7. All focused fixtures and restored red probes, typecheck, privacy, remote full suite and complete CI rollup pass at the exact resolved layer head.
8. Branch/base and stack map reflect the parent-approved topology; no merge, auto-merge, unrelated source changes or code edits on the docs worktree.

## PR

Title: `refactor(adapters): isolate Ollama native request and response translation (split S05 L3/3)`

Branch: `codex/split-adapters-ollama-native`.

Base: dev — no dependency on the layers below; no cascade obligation.

Closes: none.

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 1 | #TBD-S05-L1 | xAI tool schema | `codex/split-adapters-xai-tool-schema` | `dev` | Schema-analysis extraction |
| 2 | #TBD-S05-L2 | Command Code | `codex/split-adapters-command-code` | `dev` | Wire messages and single-owner workspace cache |
| 3 | #TBD-S05-L3 | Ollama native | `codex/split-adapters-ollama-native` | `dev` | Request compilation and response translation |

L3 is this PR. This is the assigned three-layer map, not an invented approval to exceed its size gate. Parent must reconcile it before PR publication if choosing reslicing. Fill the repository Summary, Verification and Checklist template sections with exact-head evidence and the resolved stack map; review only this layer's diff.
