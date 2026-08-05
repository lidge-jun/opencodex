# 090 — Issue #1001: forced-answer pass accepts malformed tool calls

Independent lane. Research: explorer batch F.

## Verified current state

- `scanEventsForWebSearch` sets `hasRealToolCall=true` for any
  non-`web_search` name including `""`: `src/web-search/loop.ts:62`; no
  identity or closing-event requirement. `consumeIterationEvents` validates
  one terminal event then returns (`:506`). The forced pass has no
  enforcement (`:279`); `forceAnswer` unconditionally ends the loop (`:677`)
  and replays/returns without checking visible text or call validity
  (`:695-705`). Existing test helpers always emit `"final answer"` on later
  passes (`tests/web-search.test.ts:298,1315`) — the empty case is uncovered.

## Contract

Well-formed real tool call: nonblank `id`, nonblank `name`, one structurally
matched `tool_call_start … tool_call_end`. Arguments stay bridge-owned
(freeform tools can't universally require JSON).

Successful forced-answer `done`: non-whitespace non-commentary `text_delta`,
OR at least one well-formed real non-web tool call. Thinking-only,
hallucinated web-search calls, and malformed fragments do not qualify.

## Diff-level plan

MODIFY `src/web-search/loop.ts`:
- Extend `scanEventsForWebSearch` with `hasMalformedToolCall`; pending-call
  flushing preserves event order and distinguishes completed vs unterminated
  calls; blank identity, orphan delta/end, nested replacement of an unclosed
  call, and EOF/terminal before `tool_call_end` are malformed;
  `hasRealToolCall` only after a structurally complete call with nonblank
  id/name.
- Add a small visible-text predicate over buffered passthrough text
  (commentary excluded).
- When `forceAnswer` ends with `done`: reject malformed calls and reject a
  pass with neither visible text nor a valid real call — emit
  `LoopError(502, "forced-answer pass produced no usable assistant output")`,
  which the existing catch converts to in-stream `response.failed`.
- Preserve `incomplete` and upstream error semantics; never log malformed
  arguments/IDs (may contain sensitive material).

MODIFY `tests/web-search.test.ts` — scanner-level structural cases + the
issue's deterministic two-pass SSE regression.

## Tests / activation

Primary: pass 1 emits a batched `web_search` consuming the budget; forced
pass emits `id=""`, `name=""`, arguments, `tool_call_end`, `done` → assert
one `response.failed`, no `response.completed`, no completed malformed call.

Matrix: empty id/name; whitespace-only name; unterminated start; orphan
delta/end; nested start; hallucinated valid `web_search` on a forced pass;
`done` with no text/tool; whitespace-only text; thinking-only; nonblank
text + `done` succeeds; valid closed non-web call without text allowed;
malformed JSON arguments remain bridge-owned; `incomplete` stays
`incomplete`.

## Risks

- Requiring text unconditionally would break legitimate post-search
  shell/apply-patch calls — the valid-real-tool alternative is necessary.
- No retry: it would spend tokens and complicate hard-cap accounting;
  explicit failure is bounded and allowed by the issue.

## Accept criteria

- Primary regression red→green; gates as 030.
