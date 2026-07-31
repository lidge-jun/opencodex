# 010 — Cycle 1: passthrough record/replay state machine (#334 + #326)

> DIFFLEVEL-ROADMAP-01: this is the copy-paste-executable implementation PRD for Cycle 1. The implementer must keep the production and test paths, signatures, branch semantics, and verification gates below unless new repository evidence makes the design impossible. Any expansion is escalated to the main agent before editing.

> **Stale-check (2026-07-24): verified against `origin/dev` `097cadc1` (supersedes the original `d9e06c8d` baseline).** Commits `3781448a` + `e0c7caba` (#314 WP1/WP2) added `OcxConfig.streamMode`, introduced `src/server/relay-eager.ts`, and refactored both legacy SSE consumers around the exported per-chunk `createSseInspector` state machine at `src/server/relay.ts:407-482`. The former plan to add a second shared completion helper is superseded: #334 state now belongs inside `createSseInspector`, which also covers the eager relay wired at `src/server/responses/core.ts:1037-1076`. #326 behavior is unchanged; its current anchors and the five shifted `rememberResponseState` call sites are recorded below. The nine new `src/types.ts` lines are `OcxConfig.streamMode` at `src/types.ts:448-456` and do not collide with the planned `OcxParsedRequest._replayPrefixLen` insertion at `src/types.ts:7-10`.

## Loop spec

- **Loop archetype:** spec-satisfaction repair.
- **Trigger:** issue #334 reports that native Responses SSE persistence loses completed output items when `response.completed.response.output` is absent or empty; issue #326 reports that proxy-generated multi-agent guidance is persisted and then appended again on every `previous_response_id` continuation.
- **Goal:** make passthrough continuation recording reconstruct terminal output from `response.output_item.done` events when necessary, and make proxy-generated guidance injection idempotent across replayed prefixes, without altering client-facing SSE bytes or compaction ordering.
- **Non-goals:** redesign the Responses state store; strip guidance at persistence time; add a second completion accumulator/helper outside `createSseInspector`; modify the legacy consumer or eager-relay control loops; backfill request-log-only SSE tracking; synthesize items from delta events; change upstream payloads, adapter routing, provider continuation state, retention limits, snapshots, compaction behavior, or GUI/docs behavior.
- **Verifier:** `bun run typecheck`; `bun run test`; `bun run privacy:scan`.
- **Stop condition:** all focused regressions below pass, all three repository verifiers exit 0, native client SSE remains byte-identical, empty/missing terminal output is backfilled in `output_index` order through the shared inspector for both legacy wrappers and the eager relay, non-empty terminal output remains authoritative, and a two-continuation replay contains exactly one proxy guidance item in outbound input and persisted state.
- **Memory artifact:** this file, `devlog/_plan/260724_bugfix_train/010_passthrough_state.md`, updated only by the owning main agent if implementation evidence forces a correction.
- **Expected terminal outcomes:** `PASS` (implementation and all verifiers satisfy this spec); `FAIL` (a verifier or acceptance assertion fails and the cycle returns to implementation); `BLOCKED` (the required behavior cannot be achieved inside the file/scope map and is escalated).
- **Escalation:** upward — main reclaims after two agent failures; downward — none planned.

## Failure model and invariants

### #334 — terminal response is not the whole streamed response

`src/server/relay.ts:431-482` now centralizes chunk decoding, SSE block framing, terminal/log inspection, and `onCompletedResponse` dispatch in `createSseInspector`, but its completion branch at `src/server/relay.ts:457-460` still extracts only the `response` object carried by `response.completed`. Native Responses streams can instead finalize authoritative output items in earlier `response.output_item.done` events while the terminal event has `output: []` or no `output`. `rememberResponseState` accepts any array, including an empty one, so the current terminal-only callback either stores no assistant/reasoning/function-call items or does not store at all when `output` is absent. The next locally expanded continuation is therefore incomplete and can repeat a tool call forever.

The repair law is:

1. Observe only `response.output_item.done` events.
2. Store each valid item in one `Map<number, unknown>` keyed by integer, non-negative `output_index`; later observations for the same index replace earlier ones.
3. On `response.completed`, leave a non-empty terminal `response.output` exactly untouched.
4. If terminal `output` is missing or an empty array and at least one done item was accumulated, provide a shallow response copy whose `output` is the accumulated items sorted by ascending index.
5. Invoke `onCompletedResponse` only after rule 3 or 4 has been applied.
6. Never rewrite, buffer, re-encode, or emit the client-facing SSE branch.

One inspector implementation now serves all persistence-capable stream shapes:

- `consumeForInspection` constructs `createSseInspector({ onTerminal, logCtx, onCompletedResponse, onFirstOutput })` at `src/server/relay.ts:484-495` and only calls `feed`/`finish` at `src/server/relay.ts:516-529`.
- `consumeForResponseLogMetadata` constructs the same inspector without `onTerminal` at `src/server/relay.ts:548-559` and only calls `feed`/`finish` at `src/server/relay.ts:570-579`. With no terminal handler, `reported` stays false, preserving unconditional metadata inspection.
- The eager path constructs `createSseInspector` with `onCompletedResponse: rememberPassthroughResponse` at `src/server/responses/core.ts:1047-1052`; `relaySseEagerBounded` receives `inspector.feed`, `inspector.finish`, and `inspector.reported` at `src/server/responses/core.ts:1053-1056`, then invokes the feed hook for every upstream chunk and the finish hook at clean EOF (`src/server/relay-eager.ts:119-135`). It has no separate completed-response path. Therefore an accumulator inside `createSseInspector` covers eager delivery, normal delivery, and post-cancel discard-drain inspection without any `relay-eager.ts` or `core.ts` change.
- Preserve `createSseInspector.feed`'s current `if (reported && !handlers.onCompletedResponse) continue` gate at `src/server/relay.ts:467-471`, its `finish()` trailing-buffer asymmetry at `src/server/relay.ts:473-479`, and terminal/log callback ordering. The accumulator observes only payloads the state machine already scans.
- `trackSseForRequestLog` at `src/server/relay.ts:171-230` is a separate terminal-status/request-log relay. It has no `onCompletedResponse`, never calls `rememberResponseState`, and must not allocate or use the item accumulator.

### #326 — replay provenance must reach injection

`expandPreviousResponseInput` still records the replay prefix length in the proxy-private `WeakMap` at `src/responses/state.ts:78,209-229`, keyed by the exact expanded request object. `parseRequest` still reads that length at `src/responses/parser.ts:227-229` and uses it only for the current-suffix compaction boundary at `src/responses/parser.ts:270-295`, but discards it from `OcxParsedRequest`. `injectDeveloperMessage` remains unchanged at `src/server/responses/collaboration.ts:284-298`, so it cannot distinguish replayed proxy guidance from a new request suffix and always appends another copy to both parsed messages and `_rawBody.input`. Passthrough persistence records the mutated `_rawBody`, producing one extra guidance item per continuation.

The repair law is:

1. Add optional proxy-private `OcxParsedRequest._replayPrefixLen?: number`.
2. `parseRequest` copies its already-read `replayedInputPrefixLength` into that field when the value is positive.
3. `injectDeveloperMessage` constructs the exact wire item it would inject, scans every item in `_rawBody.input.slice(0, _replayPrefixLen)`, and skips both parsed-message and raw-input insertion if an exact generated item is present.
4. “Exact generated item” means `{type:"message", role:"developer", content:[{type:"input_text", text}]}` with exactly one content part and the exact requested text. Do not match arbitrary developer messages, substrings, or suffix items.
5. Detection searches the whole replay prefix. It never assumes guidance is first, last, adjacent to a user item, or adjacent to `compaction_trigger`.
6. Fresh insertion retains the existing invariant: if the final raw item is `compaction_trigger`, insert immediately before it; otherwise append.
7. Do not implement the rejected persist-time stripping alternative. It would spread policy across five persistence call sites and enlarge the blast radius.

## Exact file change map

### Planning artifact changes for this cycle

- **NEW** `devlog/_plan/260724_bugfix_train/010_passthrough_state.md` — this diff-level implementation contract.
  (The `010_phase1.md` scaffold was replaced pre-commit and never tracked; no DELETE entry applies.)

### Production and regression changes to implement

- **MODIFY** `src/server/relay.ts` — add the per-stream `output_item.done` accumulator inside the existing exported `createSseInspector`; retain `completedResponseFromSsePayload`, both consumer wrappers, and `trackSseForRequestLog` unchanged.
- **MODIFY** `src/types.ts` — add `_replayPrefixLen?: number` to `OcxParsedRequest`.
- **MODIFY** `src/responses/parser.ts` — preserve the already-computed replay prefix length on the parsed request.
- **MODIFY** `src/server/responses/collaboration.ts` — detect the exact generated guidance item anywhere in the replay prefix and make dual-write injection idempotent.
- **MODIFY** `tests/responses-state.test.ts` — add focused inspector-to-persistence tests, terminal-output authority, and the two-continuation guidance regression.
- **MODIFY** `tests/relay-eager.test.ts` — extend the existing `createSseInspector`/eager-relay fixtures with direct accumulator and eager-path coverage where this is cleaner than reconstructing legacy consumer plumbing.

No other file is part of Cycle 1. In particular, do not modify `src/server/relay-eager.ts`, `src/server/responses/core.ts`, `src/responses/state.ts`, `src/server/request-log.ts`, adapters, snapshots, docs, GUI, workflows, dependencies, or release automation. The eager path is covered by changing the inspector it already calls and by regression tests only.

## Diff-level implementation

### 1. `src/server/relay.ts`

#### Keep the terminal extractor and public inspector contract unchanged

Current anchors on `097cadc1`:

- `completedResponseFromSsePayload`: `src/server/relay.ts:157-169`.
- `SseInspector`: `src/server/relay.ts:407-414`.
- `createSseInspector`: `src/server/relay.ts:431-482`.
- `consumeForInspection`: `src/server/relay.ts:484-546`.
- `consumeForResponseLogMetadata`: `src/server/relay.ts:548-587`.

Retain the terminal extractor byte-for-byte:

```ts
/** Extract the response object from a `response.completed` SSE payload, or null. */
export function completedResponseFromSsePayload(payload: string): { id?: unknown; output?: unknown; status?: unknown } | null {
  if (payload === "[DONE]") return null;
  try {
    const json = JSON.parse(payload) as { type?: unknown; response?: unknown };
    if (json.type !== "response.completed") return null;
    const response = json.response;
    if (!response || typeof response !== "object" || Array.isArray(response)) return null;
    return response as { id?: unknown; output?: unknown; status?: unknown };
  } catch {
    return null;
  }
}
```

Do not add `CompletedResponse`, `createCompletedResponseAccumulator`, or any other second shared helper after this function. That earlier design is superseded by the upstream `createSseInspector` seam.

Retain the exported `SseInspector` type and `createSseInspector` handler signature unchanged. The accumulator is private closure state inside each inspector instance.

#### Modify `createSseInspector` at the single shared implementation point

Current state initialization (`src/server/relay.ts:437-440`):

```ts
  const decoder = new TextDecoder();
  let buffer = "";
  let reported = false;
  const reportFirstOutput = createFirstOutputReporter(handlers.onFirstOutput);
```

After:

```ts
  const decoder = new TextDecoder();
  let buffer = "";
  let reported = false;
  const reportFirstOutput = createFirstOutputReporter(handlers.onFirstOutput);
  // Allocate reconstruction state only for persistence-capable inspectors.
  const completedItemsByOutputIndex = handlers.onCompletedResponse
    ? new Map<number, unknown>()
    : null;
```

Current completion branch inside `scanPayload` (`src/server/relay.ts:457-460`):

```ts
    if (handlers.onCompletedResponse) {
      const response = completedResponseFromSsePayload(payload);
      if (response) handlers.onCompletedResponse(response);
    }
```

After:

```ts
    if (handlers.onCompletedResponse) {
      try {
        const event = JSON.parse(payload) as {
          type?: unknown;
          output_index?: unknown;
          item?: unknown;
        };
        if (event.type === "response.output_item.done"
          && Number.isInteger(event.output_index)
          && (event.output_index as number) >= 0
          && typeof event.item === "object"
          && event.item !== null
          && !Array.isArray(event.item)
          && typeof (event.item as { type?: unknown }).type === "string") {
          completedItemsByOutputIndex!.set(event.output_index as number, event.item);
        }
      } catch {
        /* malformed SSE payloads remain best-effort/no-throw */
      }

      let response = completedResponseFromSsePayload(payload);
      if (response
        && (!Array.isArray(response.output) || response.output.length === 0)
        && completedItemsByOutputIndex!.size > 0) {
        response = {
          ...response,
          output: [...completedItemsByOutputIndex!.entries()]
            .sort(([left], [right]) => left - right)
            .map(([, item]) => item),
        };
      }
      if (response) handlers.onCompletedResponse(response);
    }
```

Implementation constraints:

- The map is per `createSseInspector` call/per upstream stream, not global and not shared across requests.
- Allocate it only when `handlers.onCompletedResponse` exists. `trackSseForRequestLog` and inspectors used only for terminal/log metadata must not acquire unused output-item state.
- Observe only `response.output_item.done`; malformed JSON, invalid indices, missing items, deltas, and `[DONE]` remain ignored.
- Keep the existing terminal/log/first-output operations before this completion branch. In particular, `onTerminal("completed")` may fire before `onCompletedResponse`; only the latter is persistence-bearing and must receive the reconstructed response.
- Keep `completedResponseFromSsePayload` as the sole terminal-response extractor. The inline parse owns done-item observation only.
- Do not clear the map at terminal. Existing `feed` semantics intentionally permit per-block completion callbacks after `reported` when `onCompletedResponse` exists; preserving the map preserves that extraction lock.
- Do not alter decoding, SSE framing, `feed`'s post-terminal gate, `finish`'s trailing-buffer gate, `reported()`, logging, or first-output reporting.

#### Explicit no-change: legacy consumers

`consumeForInspection` (`src/server/relay.ts:484-546`) and `consumeForResponseLogMetadata` (`src/server/relay.ts:548-587`) already construct and delegate every chunk/EOF to `createSseInspector`. Before and after are identical. Do not reintroduce accumulator logic into either wrapper.

The critical existing wiring remains:

```ts
const inspector = createSseInspector({ onTerminal, logCtx, onCompletedResponse, onFirstOutput });
// ... inspector.finish(); ... inspector.feed(value)

const inspector = createSseInspector({ logCtx, onCompletedResponse, onFirstOutput });
// ... inspector.finish(); ... inspector.feed(value)
```

#### Explicit no-change: eager bounded relay and core wiring

`src/server/relay-eager.ts` does not parse completed responses itself. It accepts generic inspection hooks (`src/server/relay-eager.ts:27-39`), calls `finishInspection()` at clean EOF (`:123-127`), and calls `inspectChunk(value)` before queueing or discard-draining each chunk (`:130-139`). `src/server/responses/core.ts:1047-1056` binds those hooks directly to the same `createSseInspector` instance and passes `rememberPassthroughResponse` as `onCompletedResponse`.

Before and after are identical. This evidence means the single inspector change covers eager relay completion persistence, including chunks inspected during bounded post-cancel discard-drain.

#### Explicit no-change: `trackSseForRequestLog`

Real signature at `src/server/relay.ts:171-178`:

```ts
export function trackSseForRequestLog(
  body: ReadableStream<Uint8Array>,
  onTerminal: (status: ResponsesTerminalStatus) => void,
  onCancel: () => void,
  logCtx?: RequestLogContext,
  onFirstOutput?: () => void,
): ReadableStream<Uint8Array> {
```

Before and after are identical. This function only calls `terminalStatusFromSsePayload`, reports log terminal state, and relays bytes. It has no response-state callback. Adding reconstruction here would create unused state and blur the persistence boundary.

### 2. `src/types.ts`

Current excerpt at `src/types.ts:1-10`:

```ts
export interface OcxParsedRequest {
  modelId: string;
  previousResponseId?: string;
  context: OcxContext;
  stream: boolean;
  options: OcxRequestOptions;
  _rawBody?: unknown;
  /** True when the proxy expanded a previous_response_id request into a full input replay. */
  _previousResponseInputExpanded?: boolean;
```

After:

```ts
export interface OcxParsedRequest {
  modelId: string;
  previousResponseId?: string;
  context: OcxContext;
  stream: boolean;
  options: OcxRequestOptions;
  _rawBody?: unknown;
  /** Number of leading raw input items restored from local previous_response_id state. */
  _replayPrefixLen?: number;
  /** True when the proxy expanded a previous_response_id request into a full input replay. */
  _previousResponseInputExpanded?: boolean;
```

Keep the field optional so existing hand-built `OcxParsedRequest` fixtures remain valid. It is proxy-private metadata and must never be serialized into `_rawBody` or sent upstream.

The #314 WP1 delta is elsewhere: `streamMode?: "auto" | "legacy-tee" | "eager-relay"` was added to `OcxConfig` at `src/types.ts:448-456`. It neither overlaps nor semantically conflicts with this proxy-private parsed-request field.

### 3. `src/responses/parser.ts`

Real signature at `src/responses/parser.ts:227`:

```ts
export function parseRequest(body: unknown): OcxParsedRequest {
```

Current opening at `src/responses/parser.ts:227-230` already captures provenance and remains unchanged:

```ts
export function parseRequest(body: unknown): OcxParsedRequest {
  const replayedInputPrefixLength = previousResponseReplayPrefixLength(body);
  const parsed = responsesRequestSchema.safeParse(body);
```

Current return excerpt at `src/responses/parser.ts:590-601`:

```ts
  return {
    modelId: data.model,
    ...(data.previous_response_id ? { previousResponseId: data.previous_response_id } : {}),
    context,
    stream: data.stream === true,
    options,
    _rawBody: body,
    ...(webSearch ? { _webSearch: webSearch } : {}),
```

After:

```ts
  return {
    modelId: data.model,
    ...(data.previous_response_id ? { previousResponseId: data.previous_response_id } : {}),
    context,
    stream: data.stream === true,
    options,
    _rawBody: body,
    ...(replayedInputPrefixLength > 0 ? { _replayPrefixLen: replayedInputPrefixLength } : {}),
    ...(webSearch ? { _webSearch: webSearch } : {}),
```

Do not replace the existing `WeakMap` (`src/responses/state.ts:78`), alter `expandPreviousResponseInput`/`previousResponseReplayPrefixLength` (`src/responses/state.ts:209-229`), add a wire field, or change the existing `inputIndex >= replayedInputPrefixLength` compaction-boundary test (`src/responses/parser.ts:270-295`). This is a second consumer of provenance already read at function entry.

### 4. `src/server/responses/collaboration.ts`

#### Add exact-item predicates immediately above `injectDeveloperMessage` (`src/server/responses/collaboration.ts:284`)

After:

```ts
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isGeneratedDeveloperItem(item: unknown, text: string): boolean {
  if (!isRecord(item) || item.type !== "message" || item.role !== "developer") return false;
  if (!Array.isArray(item.content) || item.content.length !== 1) return false;
  const [part] = item.content;
  return isRecord(part) && part.type === "input_text" && part.text === text;
}
```

If this file already has an equivalent record guard at implementation time, reuse it instead of adding a duplicate. The semantic check must remain exact as shown.

#### Modify `injectDeveloperMessage`

Real signature at `src/server/responses/collaboration.ts:284`:

```ts
export function injectDeveloperMessage(parsed: OcxParsedRequest, text: string): void {
```

Current function:

```ts
export function injectDeveloperMessage(parsed: OcxParsedRequest, text: string): void {
  parsed.context.messages.push({ role: "developer", content: text, timestamp: Date.now() });
  const raw = parsed._rawBody as { input?: unknown } | undefined;
  if (raw && Array.isArray(raw.input)) {
    const devItem = { type: "message", role: "developer", content: [{ type: "input_text", text }] };
    // compaction_trigger must remain the final input item (codex-rs + ChatGPT backend both
    // validate this). Insert the developer message BEFORE the trigger when present.
    const last = raw.input[raw.input.length - 1];
    if (last && typeof last === "object" && (last as { type?: string }).type === "compaction_trigger") {
      raw.input.splice(raw.input.length - 1, 0, devItem);
    } else {
      raw.input.push(devItem);
    }
  }
}
```

After:

```ts
export function injectDeveloperMessage(parsed: OcxParsedRequest, text: string): void {
  const raw = parsed._rawBody as { input?: unknown } | undefined;
  const devItem = { type: "message", role: "developer", content: [{ type: "input_text", text }] };
  if (raw && Array.isArray(raw.input)) {
    const replayPrefixLen = Math.min(parsed._replayPrefixLen ?? 0, raw.input.length);
    if (raw.input.slice(0, replayPrefixLen).some(item => isGeneratedDeveloperItem(item, text))) {
      return;
    }
  }

  parsed.context.messages.push({ role: "developer", content: text, timestamp: Date.now() });
  if (raw && Array.isArray(raw.input)) {
    // compaction_trigger must remain the final input item (codex-rs + ChatGPT backend both
    // validate this). Insert the developer message BEFORE the trigger when present.
    const last = raw.input[raw.input.length - 1];
    if (last && typeof last === "object" && (last as { type?: string }).type === "compaction_trigger") {
      raw.input.splice(raw.input.length - 1, 0, devItem);
    } else {
      raw.input.push(devItem);
    }
  }
}
```

The early return is intentionally before the parsed-message push. `parseRequest` has already converted the replayed wire guidance into one developer message in `parsed.context.messages`; adding another parsed-only copy would still duplicate model context. If raw input is a string/non-array, preserve current behavior: parsed context receives the message and raw input is untouched. A matching item in the new suffix does not suppress injection because only replayed proxy state is trusted for idempotence.

### 5. Read-only #326 integration anchor audit (`src/server/responses/core.ts`)

#314 WP2's `core.ts` delta touched 53 lines (52 additions, 1 deletion): it added three imports near the top and the eager-relay branch before the legacy tee path. It did not change #326 ordering or persistence policy, but it shifted current line anchors:

- `expandPreviousResponseInput(body)` remains before parsing at `src/server/responses/core.ts:558-560` (was `:555-557` on `d9e06c8d`).
- `parseRequest(body)` remains after raw-body compatibility rewriting at `src/server/responses/core.ts:580-585` (was `:577-582`).
- `injectDeveloperMessage(parsed, guidance)` remains after parse/route selection and before request construction at `src/server/responses/core.ts:669-679` (was `:666-676`).
- The five `rememberResponseState` call sites remain exactly five and keep their prior roles:
  1. native passthrough closure — `src/server/responses/core.ts:913-916` (was `:910-913`);
  2. routed `runTurn` streaming bridge — `src/server/responses/core.ts:1202-1208` (was `:1151-1157`);
  3. routed `runTurn` JSON response — `src/server/responses/core.ts:1239-1245` (was `:1188-1194`);
  4. standard adapter streaming bridge — `src/server/responses/core.ts:1488-1496` (was `:1437-1445`);
  5. standard adapter JSON response — `src/server/responses/core.ts:1524-1530` (was `:1473-1479`).

No `core.ts` change is required for #326. The accepted injection-side idempotence still avoids spreading policy across these five persistence sites. No `core.ts` change is required for #334 either: the eager branch already passes `rememberPassthroughResponse` into `createSseInspector` at `:1047-1052`, while both legacy branches pass the same callback into wrappers that instantiate the inspector at `:1090-1108`.

## Regression test plan

Split tests at the current owning seams:

- **MODIFY** `tests/responses-state.test.ts`: its existing `beforeEach`/`afterEach` isolate `OPENCODEX_HOME`, clear memory, and remove snapshots. Extend imports with `injectDeveloperMessage` from `../src/server/responses` and `createSseInspector` from `../src/server/relay`. Use the inspector callback to call `rememberResponseState` directly; no fake `RequestLogContext`, background-consumer timing, or sleep is needed.
- **MODIFY** `tests/relay-eager.test.ts`: this file already imports `createSseInspector` and `relaySseEagerBounded`, defines `sse(...)`, `makeHooks()`, and deterministic controlled-upstream fixtures (`tests/relay-eager.test.ts:7-77`), and owns the inspector extraction locks at `tests/relay-eager.test.ts:275-325`. Extend those fixtures for the eager-path regression instead of adding another relay harness.

Suggested shared fixture:

```ts
function feedInspector(
  inspector: ReturnType<typeof createSseInspector>,
  events: Array<Record<string, unknown> | "[DONE]">,
): void {
  const encoder = new TextEncoder();
  for (const event of events) {
    const payload = typeof event === "string" ? event : JSON.stringify(event);
    inspector.feed(encoder.encode(`data: ${payload}\n\n`));
  }
  inspector.finish();
}
```

The direct inspector fixture is the preferred unit seam because all three production stream paths already delegate to it. Keep one eager integration regression to prove the new #314 path uses the same completion callback; existing #314 extraction-lock tests retain legacy state-machine semantics.

### Test 1 — shared inspector backfills and persists done items

Name:

```ts
test("SSE inspector backfills empty completed output before passthrough persistence (#334)", () => { ... });
```

Fixture/event order:

1. `response.output_item.done`, `output_index: 2`, completed `function_call` item.
2. `response.output_item.done`, `output_index: 0`, completed `reasoning` item.
3. `response.output_item.done`, `output_index: 1`, completed assistant `message` item.
4. `response.completed`, response `{id:"resp_334_inspection", status:"completed", output:[]}`.

Create `createSseInspector({ onCompletedResponse })`; make the callback call `rememberResponseState(requestBody, response, undefined, {force:true})`. Feed all events through the inspector, expand a next request with `previous_response_id: "resp_334_inspection"`, and assert the replayed output types are exactly `reasoning`, `message`, `function_call` after the original input and before the new suffix. Append `[DONE]` after completion and assert the callback still fires once.

**C-ACTIVATION-GROUNDING-01:** out-of-order indices activate the sort path; all three valid done events activate `Map.set`; the terminal empty array activates backfill; `rememberResponseState` plus the next expansion proves the callback received the reconstructed array and that saved state contains assistant/reasoning/tool-call items. Client bytes are outside the inspector and remain structurally untouched; passthrough suites retain wire proof.

### Test 2 — eager relay uses the same backfill path

Name:

```ts
test("eager relay backfills missing completed output before passthrough persistence (#334)", async () => { ... });
```

In `tests/relay-eager.test.ts`, extend `makeHooks` or construct an inspector that captures `onCompletedResponse`. Feed at least a `message` done item at index 0 and a `function_call` done item at index 1 through `relaySseEagerBounded`, followed by `response.completed` whose response has an id/status but **omits** `output`. Drain the returned client stream, await `hooks.onDone`, and assert the callback receives both items in index order. Test 1 owns the state-store/replay assertion, so this eager integration test must not introduce `OPENCODEX_HOME` or snapshot side effects.

Additionally (mandatory wire-fidelity assertion): capture the drained client bytes and assert
exact byte equality with the original upstream frames for both the `output_item.done` events and
the terminal `response.completed` frame — in particular, the terminal frame on the wire must
still OMIT `output` (backfill exists only in the inspector callback, never in client-facing
bytes). This converts the byte-identical delivery guarantee from prose into a regression.

**C-ACTIVATION-GROUNDING-01:** omitted `output` activates the `!Array.isArray(response.output)` side of backfill. Driving `relaySseEagerBounded` through hooks bound to `createSseInspector` proves #314's single-reader path reaches the same reconstructed completion callback; Test 1 separately grounds persistence/replay. The current wrapper construction at `src/server/relay.ts:495,559` is unchanged and requires no duplicate consumer-specific fixture.

### Test 3 — non-empty terminal output remains authoritative

Name:

```ts
test("non-empty completed output remains authoritative over accumulated done items (#334)", async () => { ... });
```

Send a done event containing a sentinel `function_call`, then complete with a non-empty `output` containing a different sentinel assistant message. Capture the callback response and persist it. Assert the callback's `output` is the exact terminal array/reference and the next replay contains the terminal assistant item but not the accumulated sentinel call.

**C-ACTIVATION-GROUNDING-01:** the prior done event makes the map non-empty, so the only reason the call is excluded is activation of the `Array.isArray(output) && output.length > 0` authoritative path. Reference equality (when captured before stream construction) plus replay content proves the terminal array was not replaced or merged.

### Test 4 — two chained continuations keep one guidance copy

Name:

```ts
test("two previous_response_id continuations keep one replayed guidance item (#326)", () => { ... });
```

Use one stable guidance string and perform this sequence:

1. Parse request 1 with array input, inject guidance once, and persist response 1. Response 1's `output` must include a completed `function_call` item, modeling the post-#334 persisted shape.
2. Expand request 2 from response 1 with a `function_call_output` suffix, parse it, and assert `_replayPrefixLen` covers the saved request-1 input plus output. The replay prefix order must place the guidance before the backfilled function call, so guidance is not at the prefix edge. Call `injectDeveloperMessage` with the same text and assert raw outbound input and parsed context each contain exactly one copy. Persist response 2.
3. Expand request 3 from response 2 with a new user suffix, parse it, call injection again, and assert raw outbound input and parsed context still contain exactly one copy. Persist response 3, expand an audit-only request from response 3, and assert saved state also contains exactly one exact generated wire item.

Count only exact wire items matching the generated shape, and separately count parsed developer messages whose content equals the guidance. Retain the existing `injectDeveloperMessage` test `inserts BEFORE compaction_trigger so it stays the final input item` unchanged.

**C-ACTIVATION-GROUNDING-01:** request 1 activates fresh insertion; request 2's interior replayed guidance activates whole-prefix search and early return; the replayed `function_call` grounds fixture ordering after #334; request 3 activates idempotence on a second chained continuation; raw `_rawBody.input` is the passthrough outbound body observable; audit expansion from response 3 is the saved-state observable. Exact counts of one prove neither dual-write destination accumulated duplicates.

### Test 5 — duplicate output indices are last-write-wins

Name:

```ts
test("duplicate output_index keeps only the final done item (#334)", async () => { ... });
```

Send two valid `response.output_item.done` events at `output_index: 2`: first a sentinel
assistant message, then the final completed `function_call`. Follow them with an empty
`response.completed.response.output`, persist through `createSseInspector`, and replay the
saved response. Assert index 2 appears exactly once, contains the final function call, and does not
contain the earlier sentinel. This fixture mandatorily activates the existing `Map.set` replacement
branch rather than merely exercising insertion.

### Test 6 — malformed done events are rejected

Name:

```ts
test("malformed output_item.done events do not enter reconstructed output (#334)", async () => { ... });
```

Interleave one valid index-0 message with done events whose `output_index` is missing, negative,
fractional, and a string, plus valid-index events whose `item` is missing, `null`, a scalar
(`"text"`, `42`), an array, and an object without a string `type`. Complete with
`output: []`. Assert the callback fires once and reconstructed/persisted output contains only the
valid index-0 item. This is the mandatory activation for every index/item rejection guard,
including the item-shape guard (non-array record with string `type`) that keeps malformed
members out of persisted replay state (schema.ts:87/133 would reject them on the next parse).

### Test 7 — exact guidance in the current suffix does not suppress injection

Name:

```ts
test("matching guidance in the current suffix does not suppress replay-prefix injection (#326)", () => { ... });
```

Build an expanded request whose replay prefix contains no exact generated guidance, but whose new
caller suffix contains an item with the exact generated wire shape/text. Set `_replayPrefixLen` to
end immediately before that suffix item, call `injectDeveloperMessage`, and assert a new generated
item is inserted in addition to the suffix item and parsed context receives the injected message.
The observable count is two raw exact-shape items, proving the scan is restricted to trusted replay
provenance rather than all current input.

### Test 8 — malformed SSE payload is skipped without losing completion

Name:

```ts
test("malformed SSE payload is skipped before a valid completed response (#334)", async () => { ... });
```

Use a raw inspector feed containing `data: {not-json}\n\n`, then a valid index-0 done event and a
valid empty-output completion. Assert no throw, one completion callback, and replay contains the
valid item. Repeat the malformed-before-valid sequence through the eager relay fixture (table-driven
subcases are allowed) and assert one reconstructed callback there too. This mandatorily activates
the accumulator's JSON parse catch while proving later frames are still processed through both the
unit seam and #314's production relay shape.

### Conditional-path activation matrix

| New/changed conditional | Activation scenario | Observable proof |
|---|---|---|
| Null or `[DONE]` payload is ignored | Append `[DONE]` to Test 1 and retain existing null/no-payload coverage | Callback fires once and no throw/regression occurs |
| Malformed SSE payload is ignored | Mandatory Test 8 places raw invalid JSON before valid done/completed frames in direct-inspector and eager-relay subcases | No throw; one callback; later valid item persists |
| Valid `response.output_item.done` index/item | Tests 1–3 send valid done events | Saved/captured output contains the item |
| Duplicate `output_index` uses Map last-write-wins | Mandatory Test 5 sends two valid items at index 2 | Replay contains exactly one final index-2 item and no sentinel |
| Invalid/missing index or missing item is ignored | Mandatory Test 6 covers missing, negative, fractional, string index and missing item | Callback/replay contains only the one valid item |
| Missing terminal output backfills | Test 2 omits `output` | Eager-path callback has message + function call |
| Empty terminal output backfills | Test 1 uses `output: []` | Saved replay has reasoning + message + function call |
| Eager relay reaches reconstructed completion | Test 2 drives `relaySseEagerBounded` with hooks bound to the inspector | Captured callback output is index-ordered despite missing terminal `output` |
| Non-empty terminal output is untouched | Test 3 supplies a non-empty terminal array while map is populated | Reference equality and no sentinel call in replay |
| Completion callback absent / map not allocated | Existing inspector extraction locks and cancel/incomplete tests omit `onCompletedResponse` | Existing terminal/log/cancel assertions remain green; no completion state is needed |
| Replay prefix length is zero | Existing fresh injection tests plus request 1 in Test 4 | One parsed and one raw guidance insertion |
| Exact guidance exists anywhere in replay prefix | Test 4 places it before a backfilled function call | Injection returns early; counts remain one |
| Similar/non-exact developer item does not suppress | MANDATORY table-driven Test 7 subcases exercising EVERY rejection guard of the exact-guidance predicate: non-record item, wrong `type`, wrong `role`, non-array `content`, wrong content length, non-record part, wrong part `type`, different text, extra content part | Each near-match subcase still causes exactly one fresh injection (parsed + raw counts assert one new copy) |
| Matching item exists only in current suffix | Mandatory Test 7 places exact shape/text after `_replayPrefixLen` | Prefix-only scan inserts one new item; raw exact-shape count becomes two |
| Raw input is non-array | Existing `string raw input is left alone` test | Parsed message added; raw string unchanged |
| Fresh raw input ends in `compaction_trigger` | Existing `inserts BEFORE compaction_trigger so it stays the final input item` test | Trigger remains final |

Tests 1–8 and every matrix row marked mandatory/required are acceptance requirements. Table-driven
subcases may share setup, but none may be omitted, folded into an unnamed “existing coverage” claim,
or have its observable weakened.

## Scope boundary

### IN

- Native Responses SSE background inspection used by passthrough response-state recording.
- Reconstruction from finalized output items only.
- Replay-prefix provenance propagation from parser to collaboration injection.
- Exact, prefix-scoped idempotence for proxy-generated developer guidance.
- Focused state-machine regressions and repository-wide verification.

### OUT

- Client-facing SSE mutation, buffering, reordering, or synthesis.
- Delta-to-item reconstruction (`response.output_text.delta`, reasoning deltas, function argument deltas).
- Changes to `rememberResponseState`, `expandPreviousResponseInput`, WeakMap ownership, snapshot schema/version, TTL, byte caps, or eviction.
- Persist-time removal of guidance.
- Any change to `trackSseForRequestLog`; its separate request-log-only path is already correct.
- Compaction trigger placement or compaction persistence policy changes.
- Routed-provider bridge output, JSON passthrough, provider adapters, request routing, auth, credentials, workflows, dependencies, release scripts, GUI, or docs-site.

Any need to touch an OUT path or any file not listed in the exact change map is a scope expansion and must be reported to the main agent before editing.

## Docs-site sync decision

No docs-site update. Both issues repair internal continuation correctness and preserve the public wire contract. There is no new option, endpoint, model behavior, or user-facing workflow to document. The regression tests and this devlog artifact are the appropriate durable record.

## Security and privacy

- No authentication, credential, OAuth, workflow, dependency, release, or permission boundary changes are in scope.
- Never log request bodies, replayed input, guidance text, completed output items, tool arguments, account identifiers, or response-state contents.
- The new replay prefix field remains in the in-process parsed object only; it must not be copied into `_rawBody`, serialized upstream, or persisted as a new snapshot field.
- The accumulator is per-inspector/per-stream local state and is released when inspection finishes. It does not create cross-request global state.
- `bun run privacy:scan` is mandatory even though no new logging is planned.

## Implementation and verification sequence

1. Confirm the worktree is at the intended `origin/dev` baseline and preserve unrelated dirty work.
2. Implement the accumulator only inside `createSseInspector` in `src/server/relay.ts`; do not change either legacy consumer, the eager relay, core wiring, or the client relay branch.
3. Add `_replayPrefixLen` in `src/types.ts` and populate it in `src/responses/parser.ts`.
4. Implement exact replay-prefix detection in `src/server/responses/collaboration.ts`, retaining fresh compaction-trigger ordering.
5. Add ALL EIGHT named regressions (the four core regressions plus the four
   mandatory matrix tests: duplicate-index last-write-wins, malformed done-event
   rejection, suffix-guidance non-dedupe, malformed-SSE skip) and their activation
   assertions across `tests/responses-state.test.ts` and `tests/relay-eager.test.ts`
   exactly as assigned above.
6. Run focused tests: `bun test tests/responses-state.test.ts tests/relay-eager.test.ts tests/multi-agent-compat.test.ts tests/consume-for-inspection-cancel.test.ts tests/passthrough-abort.test.ts`.
7. Run `bun run typecheck` and require exit 0.
8. Run `bun run test` and require exit 0.
9. Run `bun run privacy:scan` and require exit 0.
10. Inspect `git diff --check`, `git diff --stat`, and the exact changed-path list. Fail if any path outside the implementation map changed.

## Acceptance checklist

- [ ] One per-stream `Map<output_index, item>` accumulator lives inside `createSseInspector`, with no second helper or wrapper-local implementation.
- [ ] Both legacy wrappers and the eager bounded relay reach the same inspector completion path; `relay-eager.ts` and `core.ts` remain unchanged.
- [ ] Empty and missing terminal output are backfilled in ascending index order before `onCompletedResponse`.
- [ ] Non-empty terminal output is passed through unchanged and is never merged with accumulated items.
- [ ] `trackSseForRequestLog` remains terminal-status-only and receives no backfill logic.
- [ ] Client-facing native SSE bytes and relay selection remain unchanged.
- [ ] `OcxParsedRequest` receives proxy-private replay prefix length without changing the wire body.
- [ ] Guidance detection searches the whole replay prefix for the exact generated item shape.
- [ ] A replay hit skips both parsed-context and raw-input insertion.
- [ ] Fresh guidance insertion still precedes a final `compaction_trigger`.
- [ ] #326 fixtures include the post-#334 persisted `function_call` shape.
- [ ] Two chained continuations produce one guidance copy in outbound input and one in persisted/replayed state.
- [ ] Focused tests, typecheck, full test suite, and privacy scan all exit 0.
- [ ] No request-body or response-item logging was introduced.

## Issue-comment traceability self-check

- [ ] **#334 reporter — `relay.ts` empty-output backfill:** implemented by the inspector-local accumulator and `output_index` Map ordering; existing legacy-wrapper and eager-relay wiring reaches that single implementation point.
- [ ] **#334 reporter — regression test:** covered by the shared-inspector empty-output persistence test, eager-relay missing-output callback test, and non-empty authoritative-output test.
- [ ] **#326 reporter kdnsna — idempotent injection or persist exclusion:** implemented using the accepted idempotent injection option; replay provenance is copied to `OcxParsedRequest`, the exact guidance item is searched across the prefix, and the rejected five-call-site persist exclusion is explicitly out of scope.
- [ ] **#326 reporter kdnsna — two-continuation regression:** covered by the request-1 → response-1 → request-2 → response-2 → request-3 sequence, with raw outbound and audit-replayed saved-state counts fixed at one.
- [ ] **Cross-issue ordering:** the #326 fixture deliberately replays a #334-style completed `function_call`, proving guidance detection does not assume a prefix-edge position.
- [ ] **Compaction invariant:** the existing regression requiring generated guidance before final `compaction_trigger` remains mandatory and unchanged.
