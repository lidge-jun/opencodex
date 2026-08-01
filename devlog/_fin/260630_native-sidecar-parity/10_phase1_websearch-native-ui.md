# Phase 1 — Native web_search_call UI for the web-search sidecar (PABCD plan)

Date: 2026-06-30
Work class: C3 (cross-module: web-search loop + bridge protocol + tests).
Goal: make routed (non-OpenAI) models show native "Searched the web" activity in
Codex when the sidecar runs a search, instead of swallowing the search and only
injecting a tool_result text.

## Background (from 00_research.md)

codex-rs natively parses `ResponseItem::WebSearchCall` (wire `web_search_call`)
and renders it as a web-search history cell. opencodex already speaks the
Responses SSE that codex-rs consumes (`src/bridge.ts`), but the web-search loop
intercepts the synthetic `web_search` call, runs the real search via the ChatGPT
forward sidecar, and feeds only text back to the routed model. The native UI item
is never emitted, so Codex shows a plain answer with no search activity.

## P — Plan (diff-level)

### Scope boundary

IN:
- `src/types.ts` — add one `AdapterEvent` variant `web_search_call`.
- `src/bridge.ts` — handle the new event in `bridgeToResponsesSSE` (streaming)
  and `buildResponseJSON` (non-stream) by emitting a self-contained
  `web_search_call` output item.
- `src/web-search/loop.ts` — record executed searches and prepend the new events
  to `finalEvents` before bridging.
- `tests/bridge.test.ts` + `tests/web-search.test.ts` — coverage.

OUT:
- No change to adapters, the sidecar executor, or `parse.ts`.
- No change to the already-committed kiro/timeout work.
- No vision sidecar changes (out of scope by user decision).
- Do not relay sidecar `sources` as citations/annotations in this phase (the
  native cell only needs `action.query`); annotations can be a later phase.

### Change 1 — new AdapterEvent variant (`src/types.ts`)

Add to the `AdapterEvent` union:

```ts
| { type: "web_search_call"; id: string; query: string; status?: "completed" | "in_progress" }
```

`id` is the synthetic call id from the intercepted tool call; `query` is the
search query. `status` optional, defaults to `completed` when emitted by the loop.

### Change 2 — bridge streaming handler (`src/bridge.ts`, in `bridgeToResponsesSSE` switch)

Add a `case "web_search_call"` that closes any open msg/reasoning/tool item
(same discipline as `tool_call_start`), then emits a self-contained pair under a
fresh `output_index`:

```ts
case "web_search_call": {
  if (currentMsg) closeCurrentMessage();
  if (currentReasoning) closeCurrentReasoning();
  if (currentRawReasoning) closeCurrentRawReasoning();
  if (currentToolCall) closeCurrentToolCall();
  const itemId = `ws_${uuid()}`;
  const added = { type: "web_search_call", id: itemId, status: "in_progress" };
  emit("response.output_item.added", { output_index: outputIndex, item: added });
  const done = {
    type: "web_search_call", id: itemId, status: event.status ?? "completed",
    action: { type: "search", query: event.query },
  };
  emit("response.output_item.done", { output_index: outputIndex, item: done });
  finishedItems.push(done as OutputItem);
  outputIndex++;
  break;
}
```

Note: codex-rs `WebSearchCall` deserializes `id` from the item `id` (skip on
serialize is only for its own re-serialization); the SSE consumer reads the item
`id` field. We send `id` on both added and done.

### Change 3 — bridge non-stream handler (`src/bridge.ts`, in `buildResponseJSON` switch)

Add a `case "web_search_call"` that flushes open buffers then pushes one item:

```ts
case "web_search_call":
  if (currentText) flushText();
  if (currentSummaryReasoning) flushSummaryReasoning();
  if (currentRawReasoning) flushRawReasoning();
  flushToolCall();
  output.push({
    type: "web_search_call", id: `ws_${uuid()}`, status: "completed",
    action: { type: "search", query: e.query },
  });
  break;
```

(The web-search loop only uses the streaming path today, but keeping the JSON
builder in sync avoids a silently-dropped event if a non-stream path ever feeds
this variant.)

### Change 4 — web-search loop records + emits (`src/web-search/loop.ts`)

In `runWithWebSearch`, collect the executed searches as we already iterate
`calls`, then prepend `web_search_call` AdapterEvents to `finalEvents` before
`bridgeToResponsesSSE`:

- Add `const executedSearches: { id: string; query: string }[] = [];`
  alongside `searchesExecuted`.
- For each call where a real search was actually run (has a non-empty query and
  was not short-circuited as a repeat/limit), push `{ id: call.id, query: call.query }`.
  Decision: record only calls that triggered a real `runWebSearch` (i.e. the
  `else` branch that increments via `runWebSearch`), so the UI mirrors real
  searches, not failed/empty/limit placeholders.
- Before building the SSE, map them to events and prepend:
  ```ts
  const searchEvents: AdapterEvent[] = executedSearches.map(s => ({
    type: "web_search_call", id: s.id, query: s.query,
  }));
  const bridged = [...searchEvents, ...finalEvents];
  ```
  then `replay(bridged)`.

Ordering decision: emit all search activity items first, then the final answer
items. This matches the native flow (search happens, then the model answers) and
keeps it simple since the loop already executed every search before producing
`finalEvents`.

### Accept criteria

1. `bun x tsc --noEmit` clean.
2. New bridge test: feeding a `web_search_call` AdapterEvent through
   `bridgeToResponsesSSE` produces `response.output_item.added` then
   `response.output_item.done` with `item.type === "web_search_call"` and
   `item.action.query` equal to the query, same `item.id` on both, and a valid
   terminal `response.completed`.
3. New web-search loop behavior is covered: an executed search yields a
   `web_search_call` item ahead of the final assistant message (unit-level via
   the loop or via a focused bridge test of the prepend ordering).
4. Existing `tests/bridge.test.ts`, `tests/web-search.test.ts`,
   `tests/sidecar-abort.test.ts` still pass.

### Risks / audit targets

- Exact wire shape codex-rs expects for `web_search_call` over SSE (item `id`
  field vs `call_id`; whether `status` is required). 00_research.md and
  models.rs show `id`, `status`, `action` with `action.type:"search"`.
- `output_index` correctness: the new item consumes an index; ensure the final
  message item indices stay monotonic and `finishedItems` stays consistent for
  the `response.completed` snapshot.
- Failed/empty/limit searches must NOT render as completed native searches.
- No double-emit when `maxSearches`/forceAnswer loops run multiple iterations.
