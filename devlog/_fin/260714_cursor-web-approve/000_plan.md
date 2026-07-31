# 000 — cursor-web-approve: Plan

## Objective

Make web search work for opencodex's Cursor adapter path. The served model
(cursor/grok-4.5) cannot web-search today: opencodex's Cursor transport
HARD-REJECTS Cursor's server-side web-search approval gates, so the model's web
capability is dead. User log: `web_search -> non-interactive bridge reject`.

## Evidence base

- Code: `src/adapters/cursor/live-transport.ts` `planInteractionQueryReply()`
  replies `rejected` (NON_INTERACTIVE_REASON) to `webSearchRequestQuery` (238),
  `exaSearchRequestQuery` (249), `exaFetchRequestQuery` (261).
- Tier2 proto (burpheart/cursor-tap agent.v1, verified by sol/Hegel): each
  `*RequestResponse` is `oneof { Approved{} (empty) | Rejected{reason} }` with NO
  result field. Approval delegates the search to Cursor's SERVER; results are
  injected server-side and the model's answer streams back as `textDelta`. The
  result also arrives as a display-plane `ToolCall.web_search_tool_call` (union
  18) / `exa_*_tool_call` (26/27) InteractionUpdate.
- Transport safety: `mapCursorProtobufServerMessage` handles `textDelta`
  (model answer) and drops native (non-mcp) tool frames — `mcpArgsFromToolCall`
  / `mcpCursorWireName` return undefined for native tool calls, so the
  web/exa result frames are ignored (no stall, no false "incomplete tool call").
- The synthetic web_search sidecar (`server/responses.ts` planWebSearch +
  runWithWebSearch) only fires when the client sends a hosted web_search tool
  (`parsed._webSearch`); this harness does not, so the model uses Cursor-native
  web search and hits the reject.

## Loop-spec

- Loop archetype: verifier-defined (unit tests + typecheck are the bar).
- Write scope: `src/adapters/cursor/live-transport.ts`,
  `tests/cursor-interaction-query.test.ts`, this plan unit.
- Out-of-scope: synthetic web_search sidecar, parallel-tool-call truncation,
  event-stream Transport-closed, context inflation, other adapters, config
  toggle, version bump/release.
- Budget/bounds: single PABCD cycle; local test + typecheck only.
- Tradeoff (must report): approving native web/exa uses the user's Cursor
  web-search/Exa quota (Cursor server performs the search).

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| wp1 | 010_phase1.md | Flip web/exa gates to approved + update test/doc | — |

## Accept criteria (mirrored into goalplan criteria[])

- c1: approved for webSearch/exaSearch/exaFetch.
- c2: askQuestion + switchMode stay rejected.
- c3: cursor-interaction-query.test.ts updated + full cursor sweep green.
- c4: typecheck clean on touched files.
