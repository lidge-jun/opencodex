# WP1 Plan — Claude outbound web_search translation (diff-level)

Phase: P. Loop archetype: spec-satisfaction repair (verifier = unit tests +
existing suite). Write scope: src/claude/outbound.ts, src/bridge.ts
(additive), tests/claude-outbound.test.ts. Out of scope: inbound, sidecar,
config.

## Wire evidence (verified)

- Bridge sidecar path emits web_search_call items:
  added {type:"web_search_call", id, status:"in_progress"} (bridge.ts:556),
  done {type:"web_search_call", id, status, action: webSearchAction(queries)}
  (bridge.ts:385). action = {type:"search", query} or {type:"search", queries}.
  SOURCES ARE NOT ON THE ITEM — they go to pendingWebSources -> annotations
  on the NEXT assistant message (bridge.ts:571-577).
- Native ChatGPT passthrough emits the same Responses item shape; citations
  arrive later as url_citation annotations on output_text.
- outbound.ts SSE path currently ignores all of this (default case, :255).
  JSON collect path also ignores web_search_call output items.
- Claude Code expects (150_claude_code WebSearchTool.ts):
  server_tool_use block + web_search_tool_result block (content = array of
  {title,url} hits, or non-array error {error_code}) + text. searchCount =
  count of web_search_tool_result blocks. Usage:
  usage.server_tool_use.web_search_requests (emptyUsage.ts shape).

## Design decisions

D1. Emit BOTH Anthropic blocks at output_item.done time (query only known
    then). Cosmetic: no in_progress spinner window; acceptable v1.
D2. Sources: additive field on the bridge's done item — item.sources =
    [{url, title?}] (serde ignores unknown fields in codex-rs; Codex path
    unaffected). Native passthrough items lack sources -> content [] (count
    still registers in Claude Code). Annotation retro-fill = follow-up, out
    of WP1 scope.
D3. status "failed" -> web_search_tool_result content = non-array error
    object {type:"web_search_tool_result_error", error_code:"unavailable"}.
D4. usage: count web_search_call done items per turn; anthropicUsage gains
    optional serverToolUse count -> emit usage.server_tool_use =
    {web_search_requests: N} in message_delta (SSE) and message.usage (JSON).
D5. ids: reuse item.id as server_tool_use id and tool_use_id (pairing is
    what matters; no prefix validation in Claude Code parser).

## Diffs

1. src/bridge.ts closeCurrentWebSearch(): add `...(sources.length ? {sources} : {})`
   to the done item; thread sources from the end event (stream path already
   has event.sources in scope; JSON path :862 same). Keep pendingWebSources
   annotation behavior unchanged (Codex UX).
2. src/claude/outbound.ts SSE handleFrame():
   - case response.output_item.done, item.type === "web_search_call":
     closeOpenBlock(); emit content_block_start
     {type:"server_tool_use", id, name:"web_search", input:{}} at index i;
     emit content_block_delta input_json_delta partial_json =
     JSON.stringify({query}) (or {queries}); content_block_stop.
     Then content_block_start {type:"web_search_tool_result",
     tool_use_id:id, content: hits|error} + content_block_stop.
     webSearchRequests++.
   - finish(): pass webSearchRequests into anthropicUsage -> add
     server_tool_use.web_search_requests when > 0. sawToolUse must NOT be
     set by server_tool_use (stop_reason stays end_turn unless real tool_use).
3. src/claude/outbound.ts responsesJsonToAnthropicMessage(): map
   web_search_call items in body.output to the same two content blocks in
   order; usage augmentation identical.
4. tests/claude-outbound.test.ts fixtures:
   T1 single search (added+done w/ action.query + sources) -> block sequence
   + pairing ids + usage count 1.
   T2 multi-search (2 items) -> 2 pairs, usage 2, indexes monotonic.
   T3 failed status -> error-shaped content, usage still counts.
   T4 no-sources item -> content [], searchCount still 1 (shape assert).
   T5 JSON path equivalents (single + failed).
   T6 regression: turns w/o web_search unchanged (existing tests green).

## Risks

R1 codex-rs strict deserialization of unknown `sources` field — mitigation:
   verified serde default ignores unknown fields; if CI/codex smoke shows
   otherwise, move sources under action.sources (same reader change).
R2 Claude Code streaming parser may require input_json_delta before
   content_block_stop on server_tool_use — covered by T1 shape assertions
   mirroring WebSearchTool.ts partial-json query extraction.
R3 stop_reason regression if server_tool_use marks sawToolUse — explicit
   test T6 asserts end_turn preserved.

## Verifier

bun test tests/claude-outbound.test.ts + full bun test + lint + build.

## Audit round 1 synthesis (Bacon/sol — VERDICT: FAIL, 3 findings accepted)

Evidence: .codexclaw/evidence/260712-wp1-plan-audit.md
- F1 ACCEPT: usage.server_tool_use.web_search_requests counts ONLY
  status:"completed" items (Anthropic does not bill errored searches;
  Claude Code uses the field for cost accounting).
- F2 ACCEPT: success hits emit full web_search_result objects:
  {type:"web_search_result", title:<string, fallback "">, url:<string>}.
- F3 ACCEPT: collectAnthropicMessage() (non-stream collector) accumulates
  input_json_delta only for tool_use blocks (outbound.ts:408-412,433-434);
  extend to server_tool_use so the query input survives; add test T7
  (collect path: server_tool_use input preserved + usage passthrough).
- C4: content_block_start for server_tool_use emits WITHOUT inline input
  field (documented stream shape); query arrives via input_json_delta only.
- Confirmed safe: top-level `sources` on the Responses item (codex-rs
  models.rs:932-934 no deny_unknown_fields); usage conversion only at
  outbound.ts:167/:387; collector must NOT recount usage.
