# Phase 2 — Web-search native fidelity (3 PABCD cycles)

Goal: close three native-parity gaps the 5-agent recon found. Results are intentionally
not rendered (native shows only the query cell); these three are activity-cell fidelity.

## Cycle 1 — Forced-answer reflects results (loop.ts)

Problem: search results are injected only as `toolResult` to the model. On the forced-answer
pass (`forceAnswer`, web_search tool dropped) a weak model may produce a thin answer that does
not mention what the search found, so the user perceives "search did nothing".

Change (IN scope):
- `src/web-search/loop.ts`: when `forceAnswer` is true AND at least one real search ran
  (`executedSearches.length > 0`), inject a single transient developer-role nudge into the
  forced pass `messages` instructing the model to answer using the gathered web results and
  cite them. The nudge is added to `iterParsed` only (must not pollute the persisted `messages`
  used by later iterations — though forceAnswer is terminal, keep it iteration-local for safety).

OUT of scope: changing `formatWebSearchResult`, sources caps, or the search execution path.

Accept criteria:
- New loop-level test: a forced-answer pass (maxSearches exhausted) includes the developer
  nudge in the request the adapter receives, and only when a real search ran.
- No nudge when zero real searches ran (empty-query / limit / repeat placeholders only).

## Cycle 2 — Live in_progress → completed (bridge.ts + loop.ts)

Problem: loop buffers everything then replays `[...searchEvents, ...finalEvents]` at the end,
and the bridge emits `added(in_progress)`+`done(completed)` back-to-back, so the "Searching the
web" state never shows during the actual (often multi-second) sidecar call.

Change (IN scope):
- Split the single `web_search_call` AdapterEvent into two lifecycle events the loop can emit at
  real wall-clock moments: a start (status in_progress, no action required) before `runWebSearch`,
  and an end (status completed/failed, action.search.query) after it returns.
- Make the loop stream the search-cell start/end live (interleaved with the real sidecar timing)
  instead of collecting them and prepending at the very end.

Accept criteria:
- The added(in_progress) frame is emitted before the sidecar resolves; done(completed) after.
- Existing back-to-back tests updated to the live ordering; turn still completes.

### Cycle 2 design detail (architecture)

Current flow buffers ALL model iterations, collects `executedSearches`, then at the very end
streams `bridge(replay([...searchEvents, ...finalEvents]))`. Because every model call and every
sidecar call has already finished by the time the SSE starts, the in_progress→completed pair is
emitted back-to-back and the "Searching the web" spinner never shows during the real (multi-second)
sidecar call.

Hard contract to preserve (from tests):
- Iteration-1 model fetch failure / turn abort BEFORE streaming must return `jsonError` with a real
  HTTP status (502/499/upstream status). `sidecar-abort.test.ts` aborts during the first fetch and
  asserts `response.status === 502`.
- Sidecar (web_search) failures are NOT fatal: recorded via `recordSidecarOutcome`, the loop still
  returns a 200 SSE and the model answers. `web-search loop forwards sidecar outcomes` asserts 200.

Design — split the lifecycle event + stream live without breaking the eager-error contract:
1. Replace the single `web_search_call` AdapterEvent with two phase events the loop emits at real
   wall-clock moments:
   - `web_search_call_begin { id }` → bridge emits `output_item.added` with status `in_progress`.
   - `web_search_call_end { id, query, status }` → bridge emits `output_item.done` with
     status `completed`/`failed` and `action.search`.
   (The bridge keeps a single combined event too for back-compat is unnecessary — only the loop
   emits these, so migrate it cleanly.)
2. Restructure `runWithWebSearch` so the SSE body is driven by an async generator. To keep the
   eager-error contract, run ONLY the first model call eagerly (its fetch/parse errors still return
   `jsonError`). If that first call is terminal (no search), stream its passthrough exactly as today.
   If it wants to search, hand the bridge a generator that, starting from the first call's intercepted
   web_search calls: emits begin → awaits the real `runWebSearch` sidecar → emits end, then runs the
   next model iteration inside the generator and repeats, finally yielding the terminal passthrough.
3. Model-call failures on iterations 2+ (already inside the live stream, status already 200) surface
   as an in-stream `error` event (bridge already maps `error` → terminal failed). This is the only
   behavior change and no test asserts a non-200 for iteration 2+.

Accept criteria (refined):
- Begin frame for a search is emitted while the sidecar promise is still pending (assert ordering
  with a deferred sidecar fetch), end frame after it resolves.
- Iteration-1 hard failure / abort still returns jsonError 502 (existing tests stay green).
- Sidecar failure still yields a 200 stream that completes.

## Cycle 3 — Native multiple queries (types.ts + bridge.ts + loop.ts)

Problem: native `action.search.queries` (plural) is unsupported; we only carry singular `query`.

Change (IN scope):
- Extend the `web_search_call` AdapterEvent to optionally carry `queries: string[]`.
- Bridge emits `action: { type: "search", query, queries }` when present (both streaming and
  buildResponseJSON paths), matching codex-rs `WebSearchAction::Search { query, queries }`.

Accept criteria:
- A search_call carrying queries renders `action.search.queries` in both bridge paths.
- Singular-only path unchanged (back-compat).

### Cycle 3 design detail

Native semantics: a single `web_search_call` can carry `action.search.queries` (plural) when the
model batches related queries into one call. We currently only accept/carry a singular `query`.

End-to-end change:
1. `synthetic-tool.ts`: the synthetic `web_search` function accepts EITHER `query` (string) or
   `queries` (string[]) — documented as "one or more related queries to run together".
2. `loop.ts scanEventsForWebSearch`: parse a canonical `queries: string[]` from the model's args
   (queries[] if present and non-empty, else [query] if non-empty, else []). `WebSearchCall` carries
   `{ id, queries }`.
3. `loop.ts runSearchCall`: a call may now hold multiple queries. To keep function-call pairing
   valid (one tool call → one tool result), run each query through the sidecar (budget-aware,
   counting each against maxSearches/failedQueries), then inject ONE assistant toolCall (arguments
   `{ queries }`) and ONE aggregated toolResult. Emit ONE begin and ONE end cell; the end carries
   `queries` (all attempted) so Codex shows the native `Searched <first> ...`.
4. `format-result.ts`: add an aggregator that renders multiple (query, outcome) blocks into one
   tool_result string (prose: labeled blocks; structured: one JSON `{ results: [...] }`). The single
   -query path keeps producing the same shape as before (back-compat).
5. `types.ts` + `bridge.ts`: `web_search_call_end` carries optional `queries: string[]`; the bridge
   emits `action: { type:"search", query, queries }` (query = first, for native dual-field parity)
   in both streaming and buildResponseJSON paths.

Accept criteria (refined):
- A batched call with two queries runs two sidecar searches, injects one toolCall + one toolResult,
  and emits one cell whose `action.search.queries` has both, `query` = first.
- Singular `query` calls still emit `action.search.query` with no behavior change.
- Budget: each query counts against maxSearches.
