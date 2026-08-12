# 050 — translator stream and serialized-tail bounds

Date: 2026-08-01  
Work phase: wp6  
Depends on: delivered 040
Binding inputs: `000_state_store_inventory.md` §Translator-layer, `005_impl_roadmap.md` locked decision 5 and budget-scope split, and delivered/amended `040_app_bytes_observability.md:17-27`.

## Outcome

Bound every translator-owned accumulator without deleting translation duty. A normal
turn may contain 20 or more interleaved tool calls. Limits are byte-based and preserve
complete protocol units:

```ts
export const TRANSLATOR_MAX_CALL_ARGUMENT_BYTES = 2 * 1024 * 1024;
export const TRANSLATOR_MAX_TURN_BYTES = 32 * 1024 * 1024;
export const TRANSLATOR_MAX_SSE_EVENT_BYTES = 32 * 1024 * 1024;
// Payload only. The five-byte Connect header is neither part of this limit nor charged.
export const CURSOR_MAX_CONNECT_FRAME_BYTES = 32 * 1024 * 1024;
// Contiguous receive/decode makes at most two full payload copies overlap; live transport
// therefore admits at most 16 MiB when the rest of its byte pool is empty.
export const CURSOR_MAX_EFFECTIVE_CONNECT_PAYLOAD_BYTES = 16 * 1024 * 1024;
// Payload bytes only across receive, pending work, and message queues.
export const CURSOR_TRANSPORT_MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
export const CURSOR_TRANSPORT_RESUME_BYTES = 16 * 1024 * 1024;
// Headers/frame objects/promise bookkeeping are count-bounded even for zero-byte payloads.
export const CURSOR_MAX_PENDING_FRAMES = 1024;
export const CURSOR_PENDING_FRAMES_RESUME = 512;
export const MAX_PENDING_IMAGE_FULFILLMENTS = 64;
export const MAX_PENDING_OAUTH_MUTATIONS = 128;
```

The per-call boundary covers one assembled argument stream. The per-turn boundary covers
all hard-charged translator copies for that client turn, including retries and outbound
translation. The original decoded request-body text and the direct `JSON.parse()` tree retained
by genuine Responses, including later in-place mutations of that same tree, remain compatibility
scope under the existing 256 MiB cap. They are observed as transient request-copy overlap but
are not hard-charged against 32 MiB. Only newly materialized translator copies—translations,
collectors, maps, queues, argument assemblies, serializations, and cloned replacement trees—are
hard-charged. Therefore an unchanged Responses body above 32 MiB and at or below 256 MiB passes
through without a translator-budget charge. Overflow cancels upstream and fails the turn
coherently; no completed frame contains truncated JSON, changed item identity, or cross-wired
call ids.

The genuine-Responses passthrough serialization is part of that compatibility scope: the
adapter's outbound `body: JSON.stringify(...)` (`src/adapters/openai-responses.ts:1030-1035`)
re-serializes the SAME compatibility-scoped tree (sanitization passes mutate in place or
share structure), so it is accounted through
`observeExternallyCapped("passthrough_serialization", bytes)` — observed against
current/high-water, hard-bounded by the existing 256 MiB request cap, never charged to the
32 MiB translator budget. Only when a provider path CLONES the tree into a genuinely new
translated shape (Chat/Claude/Kiro/Cursor translation) does hard charging start. Regression:
`unchanged Responses body above 32 MiB serializes for upstream without a translator hard charge`.

040 is a delivered dependency, not parallel work. Its observed registration contract is
`src/lib/app-owned-memory.ts:19-23,93-98`: every owner snapshot is exactly
`{ currentBytes, highWaterBytes, active }`. 050 adds the production observed owners and
hard admission; it does not add those buffers to 040's eviction budget.

## Current-source anchors and retained-state inventory

- `src/lib/app-owned-memory-stores.ts:146-150` currently registers retained stores only;
  startup calls it at `src/server/index.ts:326-330` before the first enforcement/sweeper pass.
- Production adapter contracts and currently unbudgeted parse paths are
  `src/adapters/base.ts:4-39`, `src/server/responses/core.ts:2024-2055`,
  `:2500-2515`, `:2525-2538`, and `:2575-2594`.
- Wrapper metadata is currently dropped by Azure at `src/adapters/azure.ts:15-23` and MiMo at
  `src/adapters/mimo-free.ts:205-211`. Repeated sidecar dispatches are
  `src/web-search/loop.ts:293-315` and `src/images/loop.ts:330-417`.
- Chat creates its translated body and internal request at
  `src/server/chat-completions.ts:49-64,139-159`; Claude does the equivalent at
  `src/server/claude-messages.ts:511-580,670-697`. Direct Responses body reading is
  `src/server/responses/core.ts:1085-1116`.
- The bridge's generic retained state is `src/bridge.ts:251-324,334-435,630-707,772-774`:
  finished items, current message/reasoning/raw-reasoning strings, signature/redacted carry,
  hidden reasoning, compaction text, current tool arguments, and pending web sources.
- OpenAI Chat retains an unbounded raw line plus parallel tool calls at
  `src/adapters/openai-chat.ts:685-708,792-812,824-844,853-861`.
- Cursor's cumulative argument and completion-normalization copies are
  `src/adapters/cursor/protobuf-events.ts:152-188,355-410,441-482`.
- Anthropic retains the current tool payload at `src/adapters/anthropic.ts:792-795,832-890`;
  its shared decoder retains a raw line buffer and event `dataLines` at
  `src/lib/sse-decoder.ts:25-33,44-52,75-95`.
- Kiro's deferred events, output text, thinking parser, fallback events, and tool chunks are
  `src/adapters/kiro.ts:727-782,892-975,1015-1111`; its bounded second attempt is
  `src/adapters/kiro.ts:1334-1426`.
- OpenAI Responses compaction concurrently retains `deltas`, `doneText`, and `snapshot` at
  `src/adapters/openai-responses.ts:1041-1078`. Google's manual SSE buffer and non-stream body
  copies are `src/adapters/google.ts:411-542,595-637`.
- Responses→Chat streaming state is `src/chat/outbound.ts:153-193,303-365`; full non-stream
  folds are `:475-527,545-643`, including the raw SSE collector buffer at `:550-574`.
- Responses→Claude streaming state is `src/claude/outbound.ts:162-170,214-248,286-343`;
  full folds are `:489-545,590-629`, and raw SSE buffers are `:180-182,439-445,591-596`.
- Item-id repair maps are `src/server/responses-item-id-repair.ts:7-12,51-84,115-166`;
  the client-facing rewrite is composed at `src/server/responses/core.ts:1794-1806`.
- Failed-tail classification is `src/server/relay.ts:80-126`. Chat's streaming failure closure
  and reader catch are `src/chat/outbound.ts:243-274,425-470`; Claude's are
  `src/claude/outbound.ts:250-275,439-484`. Their non-stream boundary catches are
  `src/server/chat-completions.ts:251-266` and `src/server/claude-messages.ts:743-760`.
- Request-body raw/decoded/text overlap is `src/server/request-decompress.ts:52-84`;
  image/vision replacement happens at `src/server/responses/core.ts:1394-1401`.
- Cursor's real producer backlog is the `CursorServerMessage[]` queue at
  `src/adapters/cursor/live-transport.ts:467-503,561-575`, the partial-frame buffer and
  fire-and-forget handlers at `:753-787`, and async frame handling at `:845-909`.
  Connect framing advertises a 4 GiB maximum at `src/adapters/cursor/framing.ts:4,68-80`.
  The later adapter-event queue already aborts at 1,024 queued events at
  `src/adapters/run-turn-queue.ts:52-75`.
- Cursor request-local KV clones seeds, sets, and gets without a cap at
  `src/adapters/cursor/kv-store.ts:10-24`. MCP catalog/result caps are already delivered at
  `src/adapters/cursor/mcp-manager.ts:9-14,111-134,239-285`.
- Serialized tails are image retention `src/images/fulfill.ts:12-24,89-106`, OAuth mutation
  `src/oauth/store.ts:317-330`, and Grok apply
  `src/server/management/agent-settings-routes.ts:62-70,534-559`.
- OAuth management dispatch catches `CatalogGatherBusyError` at
  `src/server/management-api.ts:126-144`; account writes enter through
  `src/server/management/oauth-account-routes.ts:127-168,203-213,269-282,375-406`.

## Shared translator-budget design

### NEW `src/lib/translator-budget.ts`

```ts
export type TranslatorBufferKind =
  | "tool_args"
  | "retained_collectors"
  | "live_transient"
  | "reasoning"
  | "item_ids"
  | "tool_search_sources"
  | "cursor_transport"
  | "cursor_kv"
  | "request_copies";

// Observation-only kinds: valid for observeExternallyCapped(), never hard-charged.
export type ExternallyCappedKind = "passthrough_serialization" | "mcp_payload";

export class TranslatorBudgetExceededError extends Error {
  readonly code = "translation_buffer_limit";
  constructor(readonly kind: TranslatorBufferKind, readonly limitBytes: number);
}

/** Internal/test snapshot. This is deliberately not the 040 owner shape. */
export interface TranslatorBudgetSnapshot {
  currentBytes: number;
  highWaterBytes: number;
  activeCalls: number;
  overflows: number;
}

export interface TranslatorTransientReservation {
  /** Convert the charged new allocation into its retained lease; no counter change. */
  commitRetained(): void;
  /** Roll back a failed/not-performed allocation. Idempotent; invalid after commit. */
  release(): void;
}

export interface TranslatorBudget {
  openCall(id: string): void;
  closeCall(id: string): void;
  reserveTransient(
    bytes: number,
    scope: { kind: TranslatorBufferKind; callId?: string },
  ): TranslatorTransientReservation;
  chargeRetained(
    delta: number,
    scope: { kind: TranslatorBufferKind; callId?: string },
  ): void;
  releaseRetained(
    bytes: number,
    scope: { kind: TranslatorBufferKind; callId?: string },
  ): void;
  observeAcceptedRequestCopy(bytes: number): () => void;
  // Observation-only lease: contributes to currentBytes/highWaterBytes only —
  // NEVER to the 2 MiB per-call or 32 MiB per-turn hard caps, and never to
  // activeCalls (040's `active` maps exclusively from sum(activeCalls)). Used for
  // state whose hard bound is owned elsewhere (MCP caps from 035, passthrough
  // serialization under the 256 MiB compatibility cap). Returns an idempotent release.
  observeExternallyCapped(kind: ExternallyCappedKind, bytes: number): () => void;
  snapshot(): TranslatorBudgetSnapshot;
  dispose(): void;
}

export function createTranslatorBudget(options?: TranslatorBudgetOptions): TranslatorBudget;
export function translatorObservedBufferSnapshot(): {
  currentBytes: number;
  highWaterBytes: number;
  active: number;
};
```

Use UTF-8 bytes from one shared `TextEncoder`, never JS code units. The deterministic sizing
rule is the UTF-8 byte length of the serialized source at charge time: an exact retained string
uses `encoder.encode(string).byteLength`; a JSON value copied into a translation, map, queue,
collector, snapshot, or request serialization uses
`encoder.encode(JSON.stringify(sourceValue)).byteLength`; a raw `Uint8Array` uses
`byteLength`. Charge every physical newly materialized copy once, including simultaneous old/new
strings created by concatenation or replacement, but never charge an alias to the same object.
This rule also sizes compatibility observation: the original body text is its encoded byte length,
and the direct parse tree is the encoded `JSON.stringify(tree)` length at each observation/reconcile
point. In-place mutations stay on that observed compatibility lease; only a clone or serialization
created from them starts a hard charge — with one named exemption: the genuine-Responses
passthrough upstream serialization stays on the `passthrough_serialization` observation lease,
per the compatibility-scope section above.

There are exactly two hard-admission operations, and every implementation site names one:

1. `reserveTransient(nextBytes, scope)` is mandatory whenever a new allocation is created while
   its predecessor/source allocation is still live. It charges the FULL new allocation against
   the aggregate turn limit before allocation. After a
   successful allocate/build and owner swap, call `commitRetained()` (no counter change), then
   `releaseRetained(previousBytes, scope)`. On allocation/swap failure, call `release()` and keep
   the old owner. String `+=`, `slice`, `join`, `concatBytes`, object/tree replacement, and
   cumulative argument snapshots are replacements under this rule; growth-only `next-old`
   accounting is forbidden even when the final logical value grows by only a fragment.
   The 2 MiB per-call limit is checked against the LOGICAL assembled argument size (`nextBytes`
   of the new value alone, when `callId` is present), never against the old+new physical
   overlap: appending one byte to a retained 1 MiB argument checks 1 MiB + 1 byte against the
   per-call cap while reserving the full overlap against the 32 MiB aggregate. A per-call
   rejection is therefore reachable only when the assembled argument itself would exceed
   2 MiB, independent of how many fragments built it.
2. `chargeRetained(delta, scope)` is only for a genuine retained-set increase with no second
   replacement allocation: for example, pushing a newly created fragment/event/map entry into an
   existing collection or retaining a new independent chunk. Charge the exact new physical
   object's bytes before insertion; it does not excuse a later concatenation/replacement from
   using `reserveTransient`.

Both admissions and `releaseRetained` validate before mutation; a failed admission changes
neither the owner buffer nor counters. `dispose()` is idempotent, releases all remaining
categories/calls, and unregisters the live budget from the process aggregator. Request-local call
ids never appear in metrics.

The module-level translator aggregator sums live budgets' `currentBytes`, records the
concurrent aggregate high-water, and maps `sum(activeCalls)` to 040's `active`. It retains an
internal monotonic overflow counter for diagnostics/tests, but `overflows` is never returned
through 040's three-scalar observed snapshot.

`observeAcceptedRequestCopy()` accounts raw/decoded/text/direct-parse-tree overlap in the same
global current and high-water observation but does not apply the 32 MiB hard cap to an original
body already admitted by `MAX_DECOMPRESSED_BODY_BYTES`. Its returned idempotent release closes
that exact physical copy. The direct parse tree and its in-place mutations remain on this
compatibility lease. A translated/cloned/serialized structure uses `chargeRetained` when it is a
new independent retained object, or `reserveTransient` when it replaces/derives from a still-live
hard-charged predecessor. The named externally capped passthrough/MCP observation leases remain
outside both hard-admission operations.

### Mandatory production signatures

Modify `src/adapters/base.ts:4-39` so omission is a compile error:

```ts
export interface IncomingMeta {
  headers: Headers;
  translatorBudget: TranslatorBudget;
  abortSignal?: AbortSignal;
  imageTierBias?: number;
}

export interface ProviderAdapter {
  buildRequest(parsed: OcxParsedRequest, incoming: IncomingMeta): AdapterRequest | Promise<AdapterRequest>;
  parseStream(response: Response, budget: TranslatorBudget): AsyncGenerator<AdapterEvent>;
  parseResponse?(response: Response, budget: TranslatorBudget): Promise<AdapterEvent[]>;
  runTurn?(
    parsed: OcxParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void,
  ): Promise<void>;
}
```

Update every implementation returned by `src/adapters/openai-chat.ts:679,887`,
`src/adapters/google.ts:411,595`, `src/adapters/anthropic.ts:786,933`,
`src/adapters/kiro.ts:1596-1656`, `src/adapters/cursor.ts:54-74`, and
`src/adapters/openai-responses.ts:1041,1081`. `IncomingMeta.translatorBudget` is required, not
optional. An adapter that does not retain translation state still declares the required parameter
(prefixed `_budget` if unused). Tests construct an explicit budget through a shared
`createTestTranslatorBudget()` fixture; no production signature has an optional/default budget
escape hatch.

Wrapper completeness is mandatory: change Azure's override at
`src/adapters/azure.ts:15-23` to `buildRequest(parsed, incoming)` and call
`inner.buildRequest(parsed, incoming)`; change MiMo at `src/adapters/mimo-free.ts:205-211` to
the same pass-through when calling its OpenAI Chat base adapter. The wrapper may add auth/body
changes after the inner build, but it may never omit, replace, or clone the budget.

Pass the exact same object to every build/parse/retry path. This includes passthrough/retry
builds at `src/server/responses/core.ts:367-377,1463-1474`, runTurn at `:2024-2037`, the
initial build at `:2144-2149`, rebuilds at `:2194-2214`, continuation builds/parses at
`:2377-2417,2500-2515`, and initial stream/non-stream parses at `:2525-2538,2575-2594`.

Sidecar loops join, rather than fork, the parent turn. Add required `incomingMeta: IncomingMeta`
to `WebSearchLoopDeps` at `src/web-search/loop.ts:204-241` and `ImageBridgeDeps` at
`src/images/loop.ts:200-234`; their callers pass the ingress meta whose required
`translatorBudget` is the parent object. Every iteration, 429 rotation, forced-answer pass,
runTurn call, stream parse, and non-stream parse at `src/web-search/loop.ts:293-315` and
`src/images/loop.ts:330-417` derives per-iteration headers/abort signals from that propagated
meta but preserves the exact same `translatorBudget` object, and passes it explicitly to
`parseStream`/`parseResponse`. The web-search loop and both image and video branches never call
`createTranslatorBudget()`, never accept an optional budget, and never dispose the parent.
`IncomingMeta` plus the wrapper/sidecar signatures are deliberately required so
`bun run typecheck` reports every missed production call site.

### Ingress creation, propagation, and response-lifetime disposal

The client ingress that creates a budget owns it through the outermost client-facing response:

1. Chat creates the budget immediately on entry at
   `src/server/chat-completions.ts:49-59`, beside the incoming 035
   `turnAdmissionLease`, before `readChatBody()` and `chatCompletionsToResponsesBody()`.
   Use `chargeRetained` for the independent translated body and serialized internal request at
   `:139-143`; pass the same object in `HandleResponsesOptions` at `:151-159` and into both
   Responses→Chat streaming and non-stream folds.
2. Claude does the same at `src/server/claude-messages.ts:511-529`, before native/routed
   discrimination and `anthropicToResponsesTranslation()` at `:570-579`; use `chargeRetained`
   for each independent translated/serialized body at `:670-674`, then pass the same object at
   `:686-697` and through both outbound modes.
3. Genuine Responses creates its own budget before `readJsonRequestBody()` at
   `src/server/responses/core.ts:1085-1099`. Recursive combo attempts at `:916-988` reuse this
   object; a combo child never creates or disposes a second budget.
4. Add `translatorBudget?: TranslatorBudget` to `HandleResponsesOptions` at
   `src/server/responses/core.ts:502-525`. Presence means caller-owned; absence means direct
   Responses owns a newly created budget. This optional ownership seam does not weaken adapter
   method signatures.

Add one idempotent response-lifetime finalizer used by normal completion, client cancel,
upstream abort, thrown parser errors, early HTTP errors, native passthrough, sidecars, runTurn,
and non-stream returns. Chat/Claude attach it only to their outer translated response; direct
Responses attaches it to its own returned body/response. Inner `handleResponses()` must not
dispose a caller-owned budget when its Responses body reaches EOF, because an outbound
Chat/Claude collector may still retain state.

Ownership transfer precedes release. Streaming bridge callbacks call
`rememberResponseState()` at `src/server/responses/core.ts:2554-2569`; non-stream does so at
`:2611-2619`; runTurn has the same ordering at `:2088-2100,2133-2141`.
`rememberResponseState()` clones the accepted request/output into retained continuation state
at `src/responses/state.ts:794-835`, then schedules persistence whose outcomes are
`stable|unstable|failed` at `src/responses/state.ts:518-525,549-557`. Release translator-owned
copies only after `rememberResponseState()` returns and response-state ownership exists; do
not await persistence, and do not release before the callback on completed/max-token partials.

## Coherent overflow design

Adapter-local overflow becomes one terminal adapter event:

```ts
{
  type: "error",
  status: 502,
  errorType: "upstream_error",
  code: "translation_buffer_limit",
  message: "upstream translation buffer exceeded the safe limit"
}
```

The current bridge error closure is not safe for translator overflow. Inside
`bridgeToResponsesSSE()`, `failCurrentToolCall()` at `src/bridge.ts:443-468` skips an
argument-done frame but still emits `response.output_item.done`, copies partial arguments into
the item, parses partial tool-search JSON through `parseArgsObj()` at `:199-202` (which can turn
it into `{}`), and pushes the item to `finishedItems`. Keep that generic incomplete behavior for
existing non-overflow terminals, but add an overflow-only nested closure named
`abortCurrentToolCallForTranslatorOverflow()` and change the adapter `case "error"` at
`src/bridge.ts:851-873` to select it when `event.code === "translation_buffer_limit"`.

`abortCurrentToolCallForTranslatorOverflow()` clears/releases the open call without invoking
`closeCurrentToolCall()`, `failCurrentToolCall()`, `freeformInput()`, or `parseArgsObj()`. It
emits no argument-done frame and no `response.output_item.done`, does not increment
`outputIndex`, and never inserts the partial item into `finishedItems`; the following typed
`response.failed` is the sole terminal closure. This is an ABORTED item, not an incomplete or
completed item. The regression `translator overflow aborts an open tool item without any done
frame or truncated JSON in finished output` in `tests/bridge.test.ts` covers ordinary,
freeform, and tool-search calls and asserts every emitted `response.output_item.done` lacks the
truncated argument sentinel.

Route every adapter/collector overflow through that typed `case "error"` path. Request-direction
hard-cap overflow is client input and returns structured HTTP 413 `request_too_large` before
adapter construction or upstream work.

Item-id repair is special because it runs inside the client-facing payload rewrite at
`src/server/sse-payload-rewrite.ts:66-115` and is integrated at
`src/server/responses/core.ts:1794-1806`. Charge before inserting a placeholder/map entry and
before emitting a replacement. On overflow, cancel the rewrite reader and mark the rewritten
stream failed through the existing `relaySseWithFailedTail` path so the client receives a
`response.failed` terminal with `translation_buffer_limit`; do not leak a raw thrown body error.
Already emitted `output_index -> id` mappings remain immutable.

Make that failed-tail contract reachable. Export an `isTranslatorBudgetExceededError()` guard
from `src/lib/translator-budget.ts`; change `buildFailedTailPayload()` and the catch in
`relaySseWithFailedTail()` at `src/server/relay.ts:80-126` so a typed error thrown by the payload
rewrite maps to `code: "translation_buffer_limit"` (and its bounded safe message), while every
other caught read/rewrite failure remains `code: "upstream_reset"`. The relay still emits one
`response.failed`, `[DONE]`, aborts upstream, and closes. The named regression
`relaySseWithFailedTail preserves translation_buffer_limit from a rewrite overflow and keeps
ordinary failures upstream_reset` belongs in `tests/sse-failed-tail.test.ts`, with the throwing
rewrite integration covered in `tests/sse-payload-rewrite.test.ts`.

## Accumulator-by-accumulator diff design

### Tool-call assembly and shared SSE framing

| Owner and verified current anchor | Exact admission/release rule |
|---|---|
| OpenAI Chat `src/adapters/openai-chat.ts:696-708,792-812,853-861` | `openCall` on first index/id. Every `call.args += fragment` uses `reserveTransient(fullNextArgsBytes, { kind: "tool_args", callId })`; allocate/swap, commit the full new string, then release the full previous string. Fragment-only `chargeRetained(fragmentBytes)` is forbidden because JS concatenation allocates a second string. Close/release only after atomic start/delta/end emission or terminal failure. Preserve index/id rescue and 20+ interleaving. |
| OpenAI Chat raw line `src/adapters/openai-chat.ts:685-687,824-844` | Every decoded `buffer += chunk`, residual `slice`, or joined line replacement uses `reserveTransient(fullNewBufferBytes, { kind: "live_transient" })`, commits after swap, then releases the predecessor. `chargeRetained` is used only for an independently retained parsed line/event entry. A line above `TRANSLATOR_MAX_SSE_EVENT_BYTES` becomes the coherent adapter error. |
| Generic bridge `src/bridge.ts:251-324,334-435,630-707,772-774` | Every current text/reasoning/argument string append or replacement uses `reserveTransient(fullNewBytes, scope)` before swap and releases the full old allocation after commit. A newly inserted map entry, source entry, or array item with no replaced allocation uses `chargeRetained(entryBytes, scope)`. Building a distinct immutable `finishedItems` item while its mutable source remains live uses `reserveTransient(fullItemBytes, { kind: "retained_collectors" })`; aliases transfer ownership without a second charge. |
| Cursor protobuf `src/adapters/cursor/protobuf-events.ts:152-188,355-410,441-482` | `argsTextDelta` is cumulative. Every longest-value/current-args swap uses `reserveTransient(fullNewArgsBytes, { kind: "tool_args", callId })`, commits after swap, then releases the full old args; `new-old` accounting is forbidden. Independent normalization copies from `resolveCompletedArgs()`/`JSON.stringify` use `chargeRetained(copyBytes, scope)` before creation; later replacement of either copy again uses `reserveTransient`. Release open args after atomic completion and release emitted collectors when consumed. |
| Anthropic `src/adapters/anthropic.ts:792-795,832-890` | Every `currentToolCallJson += partial_json` uses `reserveTransient(fullNextJsonBytes, { kind: "tool_args", callId })`, commits after swap, then releases the full old JSON. `chargeRetained` applies only to a separately retained block/event object. Release only after validated `content_block_stop` or failure; overflow cancels and never emits `tool_call_end`. |
| Shared SSE decoder `src/lib/sse-decoder.ts:25-33,44-52,75-95` | Add required budget/options plumbing from adapter parse calls. Raw-buffer append, residual `slice`, and `dataLines.join` use `reserveTransient(fullNewBytes, { kind: "live_transient" })` with full old release after swap. Each independently pushed `dataLines` entry uses `chargeRetained(lineBytes, scope)`. Bound one event's combined physical copies to `TRANSLATOR_MAX_SSE_EVENT_BYTES`, and release after dispatch/yield ownership moves to the consumer. |
| Kiro `src/adapters/kiro.ts:727-782,892-975,1015-1111` | Every `deferred`, `assistantText`, `outputChars`, thinking-carry, or tool-input string concatenation/replacement uses `reserveTransient(fullNewBytes, scope)` and releases the full predecessor after commit. Each independent `fallbackEvents`/event/fragment insertion uses `chargeRetained(entryBytes, scope)`. Assign each physical copy one canonical kind; aliases are not double-counted. Private completion and ordinary tools share the 2 MiB call limit. |
| OpenAI Responses compaction `src/adapters/openai-responses.ts:1041-1078` | `deltas`, `doneText`, and `snapshot` are three independent retained strings. Every `+=` and snapshot assignment—including the first replacement of an empty string—uses `reserveTransient(fullNewBytes, scope)`, commits after swap, then releases the full old allocation. `chargeRetained` is used only for separately inserted usage/event objects, never these string replacements. At selection, release the two losers and transfer the selected retained lease to the yielded event. Overflow cancels the source and emits the typed adapter error. |
| Google streaming SSE `src/adapters/google.ts:411-542` | Decoded `buffer += chunk`, residual slicing, payload slicing, and any string replacement use `reserveTransient(fullNewBytes, { kind: "live_transient" })` while their source remains live. Each independent `lines` entry or parsed JSON tree uses `chargeRetained(copyBytes, scope)` before materialization; replacing such a tree uses `reserveTransient`. Release each predecessor/source only after all derived copies are admitted. One unterminated frame and all parsed frame copies share the aggregate 32 MiB budget in addition to the per-frame guard. |
| Google non-stream response `src/adapters/google.ts:595-637` | Each independent incoming chunk pushed into `chunks` uses `chargeRetained(chunkBytes, scope)`. Before concatenating, decoding, or parsing while source chunks/bytes/text remain live, use `reserveTransient(fullNewBytes, scope)` for the concatenated `Uint8Array`, `rawText`, and parsed `raw` tree; commit each result, then release its full predecessor set only after ownership swaps. Existing `MAX_RESPONSE_BYTES` remains an upstream-body guard, not a substitute for aggregate translator accounting. |

One one-shot/empty-predecessor 2 MiB call allocation passes exactly; one byte over fails.
A fragmented argument assembled across many appends admits exactly 2 MiB of logical size and
rejects one byte over — identical to the one-shot outcome, because the per-call check reads
the logical assembled size, never the transient old+new overlap.
Twenty-four independently retained 1 MiB calls pass the call limit and remain below 32 MiB;
standalone aggregate byte 32 MiB passes exactly and byte 32 MiB + 1 fails. A replacement may
correctly fail below the final logical AGGREGATE size when its full old+new physical overlap
crosses the 32 MiB turn cap; the 2 MiB per-call boundary is never overlap-dependent.
Kiro passes the same `TranslatorBudget` from `parseKiroStream()` through both
`parseKiroAttempt()` invocations at `src/adapters/kiro.ts:1334-1426`; creating a fresh budget
for the bounded fallback retry is forbidden.

### Live-transient output versus retained collectors

Responses→Chat streaming text/reasoning is emitted directly at
`src/chat/outbound.ts:179-193,282-289`; do not charge it as retained output. Charge only live
frame construction under `live_transient` until enqueue, plus retained tool identity/name/
argument maps at `:153-158,303-365`. Release map entries after the authoritative tool call is
emitted. The full collectors at `:475-527,545-643` hard-charge text, reasoning, tool arrays,
and the raw SSE `buffer` at `:550-574` until final JSON handoff.

For those outbound accumulators, every text/reasoning/argument/raw-buffer string replacement uses
`reserveTransient(fullNewBytes, scope)`; each independent map/array/frame insertion uses
`chargeRetained(entryBytes, scope)`. The same operation split applies to the Claude accumulators
below.

Responses→Claude has the same split. Text/thinking deltas at
`src/claude/outbound.ts:286-303` are emitted directly and only live-transient charged. Retain
and charge `OpenBlock` tool identity and web-search args at `:162-170,214-248,305-343`.
The signature emitted at `:229-234` is explicitly synthetic (`ocx${Date.now()}`), not an
upstream signature. Non-stream folds at `:489-545,590-629` charge all content/thinking/tool
copies. Bound/release the raw SSE buffers at `:180-182,439-445,591-596` (including the
collector's continuing parse at `:649-668`) per complete event.

Both outbound streaming dialects have an overflow-specific coherent stop. In
`responsesSseToChatCompletionsSse()`, change the `fail()` closure and reader catch at
`src/chat/outbound.ts:243-274,425-470`: when the caught error is
`TranslatorBudgetExceededError`, first abort `upstreamAbort`, cancel/return the active upstream
SSE iterator (or cancel `upstream` before decoder start), then emit exactly one Chat error SSE
frame with HTTP semantic status 413 and `code: "translation_buffer_limit"`; emit no `[DONE]`.
Normal read failures keep their existing classification. In `responsesSseToAnthropicSse()`,
change `fail()` and the catch/finally at `src/claude/outbound.ts:250-275,439-484`: await
`reader.cancel(error)` before `releaseLock()`, then emit one Anthropic `error` SSE event whose
error has `type: "request_too_large"` and `code: "translation_buffer_limit"`. Extend
`anthropicErrorBody()` / `anthropicErrorResponse()` at `src/claude/outbound.ts:41-49` with an
optional safe code field; all existing callers remain unchanged. A lock release alone is never
overflow cleanup.

The non-stream collectors preserve that typed boundary. At the catch surrounding
`collectChatCompletion()` in `src/server/chat-completions.ts:251-266`, detect either a direct
`TranslatorBudgetExceededError` or the translated `ChatCompletionsStreamError` code before the
generic `server_error` branch and return structured HTTP 413 with
`code: "translation_buffer_limit"`. Add a catch around `collectAnthropicMessage()` at
`src/server/claude-messages.ts:743-760`; map the typed overflow to
`anthropicErrorResponse(413, ..., "request_too_large", "translation_buffer_limit")` before the
generic path. Named regressions in `tests/chat-completions-endpoint.test.ts` and
`tests/claude-messages-endpoint.test.ts` assert upstream reader cancellation, one typed terminal
SSE error for streaming, and structured 413 rather than generic server error for non-streaming.

### Item ids, tool maps, Cursor KV, and MCP observation

- `src/server/responses-item-id-repair.ts:51-84,115-166`: use `chargeRetained` before inserting
  each placeholder/set/map entry. A rewritten snapshot that replaces an existing physical snapshot
  uses `reserveTransient(fullNewSnapshotBytes, { kind: "item_ids" })`, commits after swap, then
  releases the full predecessor. Aggregate cap plus admission-before-mutation prevents identity
  changes or raw stream errors.
- `buildToolBridgeMaps()` currently runs after runTurn setup at
  `src/server/responses/core.ts:2024-2055` and after upstream response acquisition at
  `:2525-2538`. Move one budgeted preflight immediately after successful `parseRequest()` at
  `:1133-1143`, before route resolution/adapter construction at `:1181-1189,1354-1358` and
  before any upstream build/fetch. Use `chargeRetained` for namespace/name strings and set/map
  entries while walking accepted tools; overflow returns 413. Reuse this admitted map object in
  passthrough,
  sidecar, runTurn, stream, and non-stream branches; do not rebuild it later.
- Bridge web sources at `src/bridge.ts:321-331,739-777` use `chargeRetained` for independent
  URL/title entries before insert; release only after annotations are charged onto the next
  assistant item or terminal cleanup.
- `src/adapters/cursor/kv-store.ts:10-24`: make the seed, replacement set, and clone-on-get
  copies use the request's translator budget. A new seed and clone-on-get use `chargeRetained`;
  a set that replaces an existing value uses `reserveTransient(fullNewValueBytes, cursorKvScope)`,
  commits after swap, then releases the full old value. Return a budgeted clone lease on get so
  the caller releases it after encoding. No seed/default path is exempt.
- MCP catalogs/results remain under delivered 035 caps at
  `src/adapters/cursor/mcp-manager.ts:9-14,111-134,239-285`. While they are live inside a
  turn, account them through `observeExternallyCapped("mcp_payload", bytes)` — observation
  contributes to current/high-water scalars only; the 035 caps remain the sole hard bound,
  no second MCP hard cap is introduced, and 040 never evicts them. Regression:
  `MCP payload observation raises highWaterBytes without consuming per-call or per-turn hard budget`.

### Request-direction copies, translated images, and vision

Change `readJsonRequestBody(req, budget)` at `src/server/request-decompress.ts:81-84` so the
budget/tracker exists before `req.arrayBuffer()`, decompression, `TextDecoder.decode()`, and
`JSON.parse()`. Reserve from a valid `content-length` before raw allocation and reconcile to
actual `ArrayBuffer.byteLength`; for chunked input, register the raw copy immediately when the
array buffer resolves. Materialize the decoded body text as a named value, observe raw, decoded,
text, and the direct parse tree as separate compatibility-scope physical copies, and release each
at its last use. Preserve `MAX_DECOMPRESSED_BODY_BYTES` at `:15-21` and zlib's in-decompress cap
at `:52-77`.

Use `chargeRetained` for each newly created independent Chat/Claude Responses body and serialized
internal request at the ingress anchors above. In genuine Responses, the `body`/`originalBody`
object at
`src/server/responses/core.ts:1094-1133` is the direct parse tree: sanitization and any other
in-place mutation of that same object remain compatibility-scope, not a hard charge. A distinct
tree returned by `expandPreviousResponseInput()` at `:1107-1116`, or any later clone,
translation, collector, or serialization, is newly materialized: use `reserveTransient` when it
replaces a still-live hard-charged allocation and `chargeRetained` for an independent insertion
before retention—except the passthrough upstream `JSON.stringify` of the compatibility tree
itself, which stays on the `passthrough_serialization` observation lease. This explicit identity
rule is why an unchanged 32–256 MiB Responses request passes through uncharged under the
translator cap. Image alias maps and image/vision translations are
translator-owned: use `chargeRetained` for independent alias-map entries and
`reserveTransient(fullReplacementBytes, scope)` for newly allocated text/image replacements
created by `planVisionSidecar()` / `describeImagesInPlace()` /
`stripImagesInPlace()` at `src/server/responses/core.ts:1394-1401`. Existing image normalization
limits stay authoritative; release replaced translator copies when no downstream serializer can
reference them, while in-place changes to the direct parse tree stay on its compatibility lease.

### Cursor transport byte admission and existing 1,024-event cap

Do not add or substitute a 4,096-message cap. The single normative wp6 design is the existing
contiguous receive/decode model with every physical copy charged. A segmented/zero-copy decoder
is explicitly out of scope for 050. The request-local transport pool follows these rules:

1. Keep `CURSOR_MAX_CONNECT_FRAME_BYTES = 32 MiB` as the payload-only wire/protocol ceiling;
   five-byte headers remain excluded from that byte ceiling. Change
   `tryDecodeConnectFrame(input, offset, maxPayloadBytes = MAX_CONNECT_FRAME_PAYLOAD_BYTES)` at
   `src/adapters/cursor/framing.ts:68-80` to reject an announced payload above its supplied maximum
   after the header and before payload allocation. Generic framing may use the 32 MiB ceiling, but
   live transport passes `CURSOR_MAX_EFFECTIVE_CONNECT_PAYLOAD_BYTES = 16 MiB`. Thus 16 MiB is the
   maximum live payload with an otherwise empty transport pool; 16 MiB + 1 is rejected from the
   announced header. The lower effective limit is the deliberate cost of copy-accounted one-phase
   implementation, not a second protocol constant masquerading as the wire cap.
2. Rewrite `concatBytes()` at `src/adapters/cursor/live-transport.ts:1007-1011` and its call at
   `:753-765` to use the shared budget operations. Retaining an incoming payload region with no
   replacement uses `chargeRetained(incomingPayloadBytes, cursorScope)`. Before `concatBytes`
   allocates the full combined buffer, call `reserveTransient(combinedPayloadBytes, cursorScope)`
   while old pending + incoming remain charged; after swap, commit the combined lease and release
   both full predecessor leases. Header bytes in these buffers are excluded from each byte count.
3. `tryDecodeConnectFrame()` currently copies payload with `slice` at
   `src/adapters/cursor/framing.ts:78-80`; `decodeAvailableConnectFrames()` copies the residual at
   `:111-123`. Each copy uses `reserveTransient(fullCopiedPayloadBytes, cursorScope)` while the
   combined input remains charged. Commit payload/residual leases, then release the full combined
   predecessor only after all outputs are admitted. Consequently the worst physical overlap is
   `2 * 16 MiB = 32 MiB`; there is no atomic lease transfer and no uncharged duplicate. Any other
   live transport/turn state reduces the admissible payload below 16 MiB through the same aggregate
   check.
4. Add a count admission independent of payload bytes:
   `CURSOR_MAX_PENDING_FRAMES = 1024` and `CURSOR_PENDING_FRAMES_RESUME = 512`.
   Rewrite `decodeAvailableConnectFrames()` at `src/adapters/cursor/framing.ts:111-123` to accept
   available frame slots. Its loop checks that a complete frame is present and reserves one slot
   BEFORE invoking `tryDecodeConnectFrame()` or materializing the next `ConnectFrame`; when no slot
   remains it leaves all remaining encoded bytes in the charged residual. In
   `LiveCursorTransport.open()` at `src/adapters/cursor/live-transport.ts:670-843`, maintain
   `pendingFrameCount` across decoded frames, serialized handler promises, and queued frame work;
   release a slot only after that frame is fully handled—synchronous terminal/error paths in a
   `finally`, and async handlers in `promise.finally`. Add a local `drainPendingFrames()` owner so
   released slots decode already-buffered residual bytes even if no new network chunk arrives.
5. Pause the HTTP/2 stream when either the physical-copy byte pool reaches
   `CURSOR_TRANSPORT_MAX_BUFFERED_BYTES` or `pendingFrameCount` reaches
   `CURSOR_MAX_PENDING_FRAMES`. Resume only when BOTH bytes are at or below
   `CURSOR_TRANSPORT_RESUME_BYTES` (16 MiB) and frame count is at or below
   `CURSOR_PENDING_FRAMES_RESUME` (512). A transfer exceeding byte admission closes/cancels with
   the coherent typed adapter error; frame-count saturation pauses and retains encoded residual
   bytes without materializing another frame object. Serialized work and `drainPendingFrames()`
   preserve FIFO with zero loss.
6. At `src/adapters/cursor/live-transport.ts:467-503,561-575`, each independent queued
   `CursorServerMessage` insertion uses `chargeRetained(encodedPayloadBytes, cursorScope)` before
   `queue.push`; release after `queue.shift` transfers it to the consumer. Keep
   `createAdapterEventQueue()`'s separate default 1,024-event abort at
   `src/adapters/run-turn-queue.ts:52-75` unchanged; transport frame-count and byte admission are
   earlier bounds and do not increase, disable, or replace it.

## 040 observed-owner registrations

Add `registerDefaultAppOwnedObservedBuffers()` beside the retained registration at
`src/lib/app-owned-memory-stores.ts:146-150`. It calls 040's `registerObservedBuffer()` exactly
four times, with static ids and no dynamic/provider/request identifiers:

| id | category | snapshot owner |
|---|---|---|
| `translator_buffers` | `translator` | `translatorObservedBufferSnapshot()` |
| `image_fulfillment_tail` | `serialized_tails` | image fulfillment gate/tail snapshot |
| `oauth_mutation_tail` | `serialized_tails` | OAuth mutation admission/serialization snapshot |
| `grok_apply_flight` | `serialized_tails` | Grok joined-flight snapshot |

Call it once beside `registerDefaultAppOwnedMemoryStores()` at
`src/server/index.ts:326-330`, before the first app-owned snapshot/enforcement. Every callback
returns exactly `{ currentBytes, highWaterBytes, active }`; rejection/overflow counters remain
owner-internal and are not fields in `observedInFlight`. These registrations are observation
only and never candidates for 040 eviction.

## Serialized promise-tail design

| Tail | Verified current anchor | Bound, accounting, and acceptance contract |
|---|---|---|
| Image fulfillment | `src/images/fulfill.ts:12-24,89-106` | Reserve one of 64 slots before any provider or artifact work in `fulfillImageCall()`. This honestly bounds the whole accepted fulfillment population, not merely the short retention-chain section. The 65th returns ordinary tool failure `image_fulfillment_busy`. `image_fulfillment_tail.currentBytes` is the exact UTF-8 bytes of closure-retained call payload/path strings and the `paths` entries waiting in `retentionTail`; charge each physical retained copy, transfer charge when provider payload becomes queued paths, and release after filter/error. Never report count as bytes. `active` is accepted fulfillments; high-water is aggregate retained bytes. Preserve write→prune→filter. |
| OAuth mutation | `src/oauth/store.ts:317-330` | Introduce a 128-lease admission gate before appending work to the mutation chain. Full admission rejects with typed exported `OAuthMutationBusyError`; rejected work never enters `mutationTail`. A reserved waiter may wait at most 30 s for the current chain head. At wake/timeout, atomically check whether execution started: if not started at timeout, release its lease and reject without enqueue; if the head won, recheck/swap the current tail synchronously, mark started, and guarantee accepted work executes exactly once. Timeout never interrupts running work. Release lease in execution `finally`. Snapshot bytes are exact retained closure/provider/account string bytes, `active` is reserved+running leases, and rejected waiters contribute neither bytes nor active count. |
| Grok apply | `src/server/management/agent-settings-routes.ts:62-70,534-559` | Replace the FIFO chain with one `grokApplyFlight: { startedAt, promise } | null`. Concurrent no-body applies join that exact promise only while it is younger than 120 s. Resolve dynamic imports, `loadConfig()`, `readRuntimePort(process.pid)`, host, port, and sync options inside the newly created flight closure—not before queue/join—so joined callers truly share identical persisted/runtime state. If an active flight is 120 s old, do not join or start another; return 409 `grok_apply_busy`. Clear only by identity in `finally`. Snapshot exact retained host/config serialization bytes while active and `active` 0/1. |

At the management boundary, import `OAuthMutationBusyError` beside
`CatalogGatherBusyError` and extend the dispatch catch in `handleManagementRequest()` at
`src/server/management-api.ts:126-144`. Map it to HTTP 503 with `Retry-After: 1` and JSON error
`{ type: "server_error", code: "oauth_mutation_busy", message }`; keep the existing catalog
mapping unchanged. The OAuth login catch at
`src/server/management/oauth-account-routes.ts:127-168` must rethrow
`OAuthMutationBusyError` before its generic 409 conversion. Logout, active-account, alias, and
delete mutations at `:203-213,269-282,375-406` already await store operations and must let the
typed error reach the same outer management catch. No OAuth account route invents a different
status or swallows the retry header.

Internal refresh callers treat mutation saturation as retryable-transient. Add an explicit
`OAuthMutationBusyError` branch before terminal-grant classification in
`refreshXaiAccountWithLock()`, `refreshAnthropicAccountWithLock()`, and
`refreshGenericAccountWithLock()` at `src/oauth/index.ts:394,403-479,483-523`, and preserve
it through `resolveAccessSnapshotForAccount()` at `:281-333`. It rethrows unchanged, never calls
`markAccountNeedsReauthIfGeneration()`, and never writes `permanentRefreshFailures`; if the XAI
path provisionally inserted a permanent verdict before a mutation write rejects, remove that
verdict before rethrowing. The token guardian catch at `src/oauth/token-guardian.ts:151-162`
records only transient backoff/skipped-retry treatment for this type—no permanent failure row and
no `needsReauth`. Regressions cover the management 503/header/code and each refresh path's
unchanged credential/health state.

## Regression tests and verification

Add/extend the nearest existing suites with these exact cases:

- `production adapter contract rejects omitted translator budgets at typecheck`
- `Azure and MiMo wrappers pass the exact required IncomingMeta budget to their inner adapters`
- `every production parse build retry and runTurn path receives the ingress budget instance`
- `web-search image and video loop iterations join the parent budget across retry and forced-final passes`
- `Chat and Claude create the budget before inbound translation and dispose after outbound lifetime`
- `client abort cancels the upstream reader and returns translator currentBytes and active to zero`
- `translator observed snapshot maps activeCalls to active and omits internal overflows`
- `24 interleaved OpenAI Chat tool calls complete without reordering`
- `one one-shot tool call admits exactly 2 MiB and rejects one byte over`
- `a fragmented tool call assembled by appends admits exactly 2 MiB logical size and rejects one byte over`
- `standalone aggregate translator bytes admit exactly 32 MiB and fail one byte over`
- `reserveTransient charges full old plus full new overlap before every replacement swap`
- `chargeRetained is used only for insertion growth with no replaced allocation`
- `overflow emits no arguments.done output_item.done or finished item carrying truncated JSON`
- `overflow cancels upstream once and bridge emits response.failed`
- `failed-tail rewrite overflow preserves translation_buffer_limit while ordinary failure stays upstream_reset`
- `shared SSE decoder admits one 32 MiB event and rejects one byte over without retaining dataLines`
- `OpenAI Responses compaction charges deltas doneText and snapshot concurrently`
- `Google streaming and non-stream physical copies share the aggregate 32 MiB budget`
- `Responses to Chat streaming deltas are transient while tool maps remain charged`
- `Responses to Chat and Claude non-stream collectors stay exact at the aggregate boundary`
- `Chat and Claude streaming overflow cancel readers and emit one translation_buffer_limit event`
- `Chat and Claude non-stream overflow returns structured HTTP 413 instead of generic server error`
- `Claude streaming signature remains synthetic and raw SSE buffers release per event`
- `Kiro first attempt and bounded fallback retry share one turn budget`
- `Cursor cumulative args replacement reserves the full new allocation before releasing the old`
- `item id repair overflow uses failed-tail response.failed and preserves emitted ids`
- `buildToolBridgeMaps overflow returns 413 before adapter construction or upstream work`
- `request-local Cursor KV seed set replacement and clone-on-get account exact bytes`
- `translated request over 32 MiB returns 413 before upstream creation`
- `unchanged Responses bodies above 32 MiB through 256 MiB remain compatibility-scope and pass uncharged`
- `unchanged Responses body above 32 MiB serializes for upstream without a translator hard charge`
- `MCP payload observation raises highWaterBytes without consuming per-call or per-turn hard budget`
- `request decompression observes raw decoded text and direct parse tree without lowering 256 MiB cap`
- `vision translation and image aliases charge the ingress translator budget`
- `Cursor announced frame over 32 MiB rejects after header before payload allocation`
- `Cursor contiguous-copy transport admits exactly 16 MiB and rejects 16 MiB plus one before payload allocation`
- `Cursor concat payload and residual copies report a 32 MiB overlap high-water at the 16 MiB effective maximum`
- `Cursor transport pauses at 32 MiB resumes at 16 MiB preserves FIFO and loses zero frames`
- `Cursor tiny-frame flood pauses at 1024 pending frames resumes at 512 and materializes no 1025th frame early`
- `Cursor byte backpressure preserves the existing 1024-event queue abort cap`
- `image fulfillment 65 returns busy before provider or artifact work and reports path bytes`
- `OAuth mutation 129 rejects before enqueue while every accepted mutation executes once`
- `OAuth 30 second wait timeout releases an unstarted lease and never enters the chain`
- `OAuth mutation busy maps to management HTTP 503 Retry-After 1 and oauth_mutation_busy`
- `OAuth refresh mutation busy is transient and writes neither needsReauth nor permanent failure`
- `concurrent no-body Grok applies resolve state inside and join one flight`
- `all four 050 observed ids appear in observedInFlight with the 040 scalar shape`.

Primary test files are NEW `tests/translator-budget.test.ts`,
`tests/azure-adapter.test.ts`, `tests/mimo-free-provider.test.ts`,
`tests/web-search.test.ts`, `tests/images/loop.test.ts`,
`tests/openai-chat-parallel-stream.test.ts`, `tests/openai-responses-passthrough.test.ts`,
`tests/google-adapter.test.ts`, `tests/bridge.test.ts`,
`tests/sse-decoder.test.ts`, `tests/sse-failed-tail.test.ts`,
`tests/sse-payload-rewrite.test.ts`, `tests/cursor-protobuf-events.test.ts`,
`tests/cursor-framing.test.ts`, `tests/cursor-adapter.test.ts`,
`tests/cursor-live-transport.test.ts`,
`tests/run-turn-queue.test.ts`, `tests/chat-completions-endpoint.test.ts`,
`tests/claude-outbound.test.ts`, `tests/claude-messages-endpoint.test.ts`,
`tests/kiro-stream.test.ts`,
`tests/responses-item-id-repair.test.ts`, `tests/request-decompress.test.ts`,
`tests/images/z-fulfill.test.ts`, `tests/oauth-store-multi.test.ts`,
`tests/account-pool-management-api.test.ts`, `tests/grok-management-api.test.ts`, and
`tests/app-owned-memory.test.ts`.

The type-level regression uses NEW
`tests/fixtures/translator-budget-required.invalid.ts`, which calls `buildRequest`,
`parseStream`, `parseResponse`, and `runTurn` without their required meta/budget and must fail
with TS2554. NEW `tests/fixtures/translator-budget-required.valid.ts` supplies
`createTestTranslatorBudget()` and must compile. `tests/translator-budget.test.ts` spawns the
same commands and asserts nonzero+TS2554 for the invalid fixture and zero for the valid fixture.
The exact isolated commands are:

```bash
bun x tsc --noEmit --target ESNext --module ESNext --moduleResolution bundler \
  --types bun-types --strict --skipLibCheck tests/fixtures/translator-budget-required.invalid.ts
bun x tsc --noEmit --target ESNext --module ESNext --moduleResolution bundler \
  --types bun-types --strict --skipLibCheck tests/fixtures/translator-budget-required.valid.ts
```

The first command is intentionally nonzero with TS2554; the second is zero. Runtime mocks assert
object identity, not merely non-undefined presence.

Verification:

```bash
bun test tests/translator-budget.test.ts tests/openai-chat-parallel-stream.test.ts \
  tests/azure-adapter.test.ts tests/mimo-free-provider.test.ts tests/web-search.test.ts \
  tests/images/loop.test.ts tests/openai-responses-passthrough.test.ts tests/google-adapter.test.ts \
  tests/bridge.test.ts tests/sse-decoder.test.ts tests/sse-failed-tail.test.ts \
  tests/sse-payload-rewrite.test.ts tests/cursor-protobuf-events.test.ts \
  tests/cursor-framing.test.ts tests/cursor-adapter.test.ts tests/cursor-live-transport.test.ts \
  tests/run-turn-queue.test.ts tests/chat-completions-endpoint.test.ts \
  tests/claude-outbound.test.ts tests/claude-messages-endpoint.test.ts tests/kiro-stream.test.ts \
  tests/responses-item-id-repair.test.ts tests/request-decompress.test.ts \
  tests/images/z-fulfill.test.ts tests/oauth-store-multi.test.ts \
  tests/account-pool-management-api.test.ts tests/grok-management-api.test.ts \
  tests/app-owned-memory.test.ts
bun run typecheck
bun run test
bun run privacy:scan
```

## Commit

`fix(translators): bound stream accumulation and serialized tails`

Do not commit from this planning amendment. The implementation commit above is the later
single-unit target after all focused and full gates pass.

## Explicitly not changed

- No single-digit tool-call count cap; 20+ parallel calls are a normal acceptance case.
- No truncation of JSON, reasoning envelopes, ids, source attribution, SSE events, or MCP payloads.
- No optional/default production budget parameter and no fresh budget per retry/fallback attempt.
- No global-budget eviction of in-flight translator/tail state and no 040 snapshot fields beyond
  `{ currentBytes, highWaterBytes, active }`.
- No reduction of the 256 MiB accepted request-body compatibility cap.
- No relaxation or replacement of the existing 1,024-event runTurn queue abort.
- No count-as-bytes accounting for image/OAuth/Grok tails.
- No new MCP cap, provider event semantic change, or reopening of prior stream-path work.
