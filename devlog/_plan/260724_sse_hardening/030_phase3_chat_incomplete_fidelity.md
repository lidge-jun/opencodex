# 030 — Phase 3: Chat Completions incomplete error fidelity (class 4)

One PABCD cycle. Integration surface: /v1/chat/completions must not end a
stalled or truncated turn with a success-looking `finish_reason` + [DONE].

## Scope

IN:
- src/chat/outbound.ts (responsesSseToChatCompletionsSse incomplete case;
  collectChatCompletion non-stream path)
- tests: chat-completions-endpoint, plus outbound-focused coverage

OUT: bridge/adapters (phases 1-2 landed), claude outbound (already maps
failure taxonomy — verify only), WS bridge (verify only).

## File change map

### 1. src/chat/outbound.ts — MODIFY response.incomplete case (~323-330)

STALE-CHECK (WP3 P, post-#363): the case now lives at outbound.ts:348-356;
the file was restructured by #363 (shared decodeServerSentEvents, buffered
tool-call frames) but the incomplete mapping logic is verbatim-identical,
so the plan applies unchanged at the new anchors. collectChatCompletion is
now at :479; the EOF-truncation fail at :389 is pre-existing.

Current (verified):
```ts
case "response.incomplete": {
  const response = isRec(data.response) ? data.response : {};
  const details = isRec(response.incomplete_details) ? response.incomplete_details : {};
  const reason = details.reason === "max_output_tokens" ? "length"
    : details.reason === "content_filter" ? "content_filter"
    : sawToolUse ? "tool_calls" : "stop";
  finish(reason, response.usage);
  break;
}
```

Change:
- Keep `max_output_tokens -> finish("length")` and
  `content_filter -> finish("content_filter")`: both are truthful
  OpenAI-compatible finish reasons.
- Every other incomplete reason (`upstream_stall_timeout`, `adapter_eof`,
  proxy-synthesized reasons) routes to `fail(message)` instead of finish():
  message = details.message if present, else
  `upstream stream ended early (<reason>)`. fail() already emits an OpenAI
  error frame and closes WITHOUT [DONE] (:179-200) — truthful abnormal end.

### 2. src/chat/outbound.ts — collectChatCompletion (:479): NO CODE CHANGE
### (A-gate precision)

Once item 1 routes stall/eof incompletes to fail(), the error frame travels
the SAME converter output stream and collectChatCompletion's existing
error-frame branch already throws ChatCompletionsStreamError
(outbound.ts:516-523, 559), which the endpoint maps to an error response
(chat-completions.ts:203-206). Item 2 is therefore achieved structurally:
B only verifies it and adds the accept-criterion-5 test. Implementation
detail: use `details.message` only after a `typeof === "string"` check
(same pattern as claude outbound).

### 3. Verify-only: claude/outbound.ts and ws-bridge.ts

Confirm their incomplete handling is already truthful (claude-outbound has
a failure taxonomy; ws-bridge cancels on terminal). No change unless the
audit finds a false-success mapping; if found, amend this doc before B.

## Accept criteria + activation scenarios

1. Stall scenario: Responses bridge emits response.incomplete with reason
   upstream_stall_timeout -> chat stream ends with an error frame and NO
   [DONE]; client sees a non-success termination. Activation: endpoint test
   injecting a stalled fake adapter (chat-completions-endpoint harness has
   stall coverage patterns already).
2. adapter_eof incomplete -> same error-frame contract.
3. max_output_tokens incomplete -> finish_reason "length" + [DONE]
   (unchanged, pinned).
4. content_filter incomplete -> finish_reason "content_filter" + [DONE]
   (unchanged, pinned).
5. Non-stream collectChatCompletion on stall -> ChatCompletionsStreamError
   surfaces; endpoint maps it to an error response, not a 200 completion.
6. Regression: chat-completions-endpoint.test.ts green;
   `bun run typecheck` green.

## Risks

- Clients that only understand [DONE]-terminated streams see an error frame:
  that is the documented OpenAI error-frame contract and the same shape
  fail() already produces for response.failed today.
