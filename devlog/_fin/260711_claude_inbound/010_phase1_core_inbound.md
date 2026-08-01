# 010 — Phase 1: core Anthropic inbound (/v1/messages)

Work class: **C3** (cross-module feature: new server surface + shared auth touch).
One PABCD cycle; this doc is the P artifact. Depends on: 000 D1/D3/D5, 001 §3-4.

**AMENDED 2026-07-11 (WP1 hardening, evidence: 003_evidence.md all Tier 2):**

1. Route match ignores query strings — Claude Code posts `/v1/messages?beta=true`
   (003 G9). Match `url.pathname` only (current index.ts style already does).
2. `message_start.message` embeds a full snapshot: `{id:"msg_<uuid>", type:
   "message", role:"assistant", content:[], model:<requested>, stop_reason:null,
   stop_sequence:null, usage:{input_tokens:0, output_tokens:0}}`; final counts
   arrive in `message_delta.usage` which is CUMULATIVE (003 Lane 2).
3. Thinking blocks: emit `thinking_delta`s, then ONE synthetic `signature_delta`
   (constant-prefixed, e.g. `"ocx-" + Date.now()`) just before
   `content_block_stop` — CCR precedent proves Claude Code accepts synthetic
   signatures (003 E6). Inbound replayed thinking/redacted_thinking still DROPPED.
4. Error envelope is `{type:"error", error:{type, message}, request_id?}`; ship
   the taxonomy table NOW (moved up from 040): 400 invalid_request_error,
   401 authentication_error, 403 permission_error, 404 not_found_error,
   413 request_too_large, 429 rate_limit_error, 500 api_error,
   529 overloaded_error; unknown 5xx -> api_error, unknown 4xx ->
   invalid_request_error. `requireApiAuth`/origin rejections on /v1/messages*
   reuse this shape from day one.
5. `stop_reason` emit set: `end_turn | tool_use | max_tokens | stop_sequence`;
   `response.incomplete` with reason max_output_tokens -> `max_tokens`, else
   `end_turn`. (`pause_turn`/`refusal`/`model_context_window_exceeded` are
   upstream-only; we never synthesize them.)
6. `top_k` accepted-and-dropped (Responses has no equivalent); document in 400
   never — silent drop matches CCR.
7. `thinking.budget_tokens` never forwarded raw (min 1024 on real API; newer
   models reject manual budgets) — effort-ladder mapping stands (003 Lane 2).
8. count_tokens response shape is exactly `{"input_tokens": N}` (003 Lane 2) and
   the endpoint itself is OPTIONAL for Claude Code (G10) — keep it anyway.
9. `x-api-key` admission: `hasValidApiAuth` gains x-api-key read; on loopback
   with no configured keys, ANY value passes (current behavior preserved).
   CORS allow-headers += `X-Api-Key, Anthropic-Version, Anthropic-Beta`.

## Objective

`POST /v1/messages` (+ `/v1/messages/count_tokens`) on the SAME daemon/port,
implemented as translate-and-replay through `handleResponses` so routing, OAuth
refresh, account pool, key failover, and vision/web-search sidecars are inherited
unchanged. Claude Code pointed at `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`
completes a streamed tool-use turn against a routed provider.

## Verified seams (read this session — re-verify line refs at build time)

| Seam | Where | Use |
|------|-------|-----|
| Internal-replay pattern | `src/server/responses.ts` `handleResponsesCompact` | build `Request("http://localhost/v1/responses")`, call `handleResponses` |
| Accepted request shape | `src/responses/schema.ts` `responsesRequestSchema` | translation target; `reasoning.summary:"auto"` required for visible thinking |
| Outbound SSE vocab | `src/bridge.ts` (`response.created/.output_text.delta/.reasoning_*_text.delta/.output_item.added|done/.function_call_arguments.delta/.completed|failed|incomplete/.heartbeat`) | SSE state machine input |
| Usage wire | `src/bridge.ts` `responsesUsage()` (`input_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens`) | map to Anthropic usage |
| Body reader | `src/server/request-decompress.ts` `readJsonRequestBody` | request ingest |
| Forwarded headers | `src/adapters/openai-responses.ts` `FORWARD_HEADERS` | copy onto internal request (compact precedent) |
| Token estimate | `src/lib/token-estimate.ts` `estimateTokens` | count_tokens |
| Auth | `src/server/auth-cors.ts` `hasValidApiAuth` (loopback = no auth) | add `x-api-key` admission |
| Route order | `src/server/index.ts` (must precede the `/v1/*` JSON-404 guard) | registration |

## Design

### New: `src/anthropic/inbound.ts`

- `resolveInboundModel(model, modelMap)` — exact id, then date-stripped
  (`-\d{8}$`), else passthrough (D5). Alias reverse-mapping arrives in Phase 2.
- `anthropicToResponsesBody(body, {modelMap})`:
  - `system` string|text-blocks -> `instructions`.
  - messages -> ordered `input` items; per user block: `text`->`input_text`,
    `image` base64/url source -> `input_image` (data URL), `tool_result` ->
    `function_call_output` (string, or `input_text`/`input_image` blocks;
    `is_error` prefixes `[tool error]`); per assistant block: `text`->message
    `output_text`, `tool_use` -> `function_call` (arguments JSON.stringify),
    `thinking`/`redacted_thinking` -> DROP (v1 policy; revisit 040).
  - `tools`: `{name, input_schema}` -> function tool; `web_search_*` server tool
    -> hosted `{type:"web_search"}` (sidecar path); other server tools dropped.
  - `tool_choice`: auto/none/any/tool -> auto/none/required/{type:"function",name};
    `disable_parallel_tool_use` -> `parallel_tool_calls:false`.
  - `thinking`: adaptive effort passthrough; enabled `budget_tokens` ladder
    `<=4096 low / <=16384 medium / else high`; always `summary:"auto"`.
  - `max_tokens`->`max_output_tokens`, `temperature`, `top_p`,
    `stop_sequences`->`stop`, `metadata.user_id`->`user`, `store:false`.
  - Throws `AnthropicRequestError` -> 400 in the handler.

### New: `src/anthropic/outbound.ts`

- `responsesSseToAnthropicSse(body, model)` — SSE frame parser + state machine:
  one open block at a time, monotonic block index, `sawToolUse` for stop_reason.

| Responses event | Anthropic emit |
|---|---|
| `response.created` | `message_start` (+ one `ping`) |
| `output_text.delta` | ensure text block -> `content_block_delta` `text_delta` |
| `reasoning_summary_text.delta` / `reasoning_text.delta` | ensure thinking block -> `thinking_delta` |
| `output_item.added` (function_call) | close open -> `content_block_start` `tool_use` (id=call_id) |
| `function_call_arguments.delta` | `input_json_delta` (partial_json) |
| `output_item.done` | `content_block_stop` for the matching open block |
| `completed` | close open -> `message_delta` {stop_reason end_turn|tool_use, usage} -> `message_stop` |
| `failed` | close open -> `error` event (api_error) |
| `incomplete` / EOF w/o terminal | close open -> `message_delta` end_turn -> `message_stop` |
| `heartbeat` | `ping` |
| others (web_search_call, custom_tool_call.*) | ignore v1 |

- `responsesJsonToAnthropicMessage(json, model)` — non-stream: output items ->
  content blocks (reasoning summary->thinking, message->text, function_call->
  tool_use w/ parsed input); `json.status !== "completed"` -> error response.
- Usage map: `input_tokens` (minus cached), `cache_read_input_tokens` <- 
  `input_tokens_details.cached_tokens`, `output_tokens`.

### New: `src/server/messages.ts`

- `handleAnthropicMessages(req, config, logCtx)`: read body -> translate ->
  internal Request (content-type + FORWARD_HEADERS copies) ->
  `handleResponses(..., {abortSignal: req.signal})` -> if `!ok` re-shape error to
  `{type:"error", error:{type,message}}` (status preserved); SSE -> transform;
  JSON -> transform.
- `handleAnthropicCountTokens(req, config)`: serialize system+messages+tools ->
  `estimateTokens(text, model)` -> `{input_tokens}` (documented approximation).

### Modified

- `src/server/index.ts`: register `POST /v1/messages/count_tokens` then
  `POST /v1/messages` (draining check, `requireApiAuth("data-plane")`, origin
  check, request-log via `nextRequestLogId` + `responseWithDeferredRequestLog` —
  same scaffold as `/v1/responses`).
- `src/server/auth-cors.ts`: `hasValidApiAuth` also reads `x-api-key`;
  CORS allow-headers += `X-Api-Key, Anthropic-Version, Anthropic-Beta`.
- `src/types.ts`: `OcxConfig.claudeCode?: { model?, smallFastModel?, modelMap? }`
  (type only; consumed in Phase 2 — config schema is `.passthrough()`).

## Out of scope

- `ocx claude` CLI, model discovery/aliases, GUI, docs-site (020/030).
- Thinking-signature round-trip fidelity, Anthropic error-type parity table (040).

## Test plan (C gate)

- `tests/anthropic-inbound.test.ts`: full Claude Code-shaped request (system
  array, tool_use/tool_result cycle, base64 image, thinking budget, tool_choice
  variants, stop_sequences) -> translated body **passes the real `parseRequest`**
  and round-trips content/tools/options; modelMap exact + date-stripped; error
  cases (no model / empty messages).
- `tests/anthropic-outbound.test.ts`: fixture Responses SSE (text + thinking +
  tool_call + completed w/ usage; failed; incomplete; heartbeat) -> exact
  Anthropic event sequence; non-stream JSON translation; usage/cache mapping.
- `tests/anthropic-messages-endpoint.test.ts`: 400 shape on bad body; count_tokens
  returns positive estimate; route 404 guard untouched for other `/v1/*`.
- Commands: `bun test ./tests/anthropic-*.test.ts`, `bun test ./tests/`,
  `bun x tsc --noEmit`.
- Manual smoke: `curl -N localhost:<port>/v1/messages` streamed tool-use turn
  against a routed provider; then `ANTHROPIC_BASE_URL=... claude -p "hello"`.

## Gate criteria (exit to D)

1. All new tests + full suite + typecheck green (fresh run, output read).
2. Manual smoke: Claude Code completes a streamed turn incl. one tool call on a
   routed provider; request appears in GUI Logs with model/provider populated.
3. No change to existing `/v1/responses` behavior (suite is the proof).

## Risks

- Anthropic strict block-ordering (tool_result must pair prior tool_use):
  translation preserves order; test locks it.
- Claude Code sends thinking blocks back on replay -> dropped v1; if a provider
  needs them, that is 040's signature-envelope work, not a Phase 1 blocker.
- Native ChatGPT passthrough via claude inbound (model routes to native gpt):
  works through the same SSE translation; non-stream native path is untested ->
  document as known edge, Claude Code always streams.
