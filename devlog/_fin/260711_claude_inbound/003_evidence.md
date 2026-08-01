# 003 — Tier-2 evidence: gateway discovery + Messages wire spec (+ env/CCR)

WP1 hardening evidence. Three parallel cxc-search explorer lanes (sol), all
claims below **Tier 2** (source page opened) unless marked. Access date:
**2026-07-11**. This doc PROMOTES the D6 claims from 002 and pins the wire
contract 010/020 build against.

## Lane 1 — Gateway model discovery (code.claude.com)

Sources: [llm-gateway-protocol](https://code.claude.com/docs/en/llm-gateway-protocol),
[llm-gateway-connect](https://code.claude.com/docs/en/llm-gateway-connect),
[model-config](https://code.claude.com/docs/en/model-config),
[claude-code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).

| # | Claim (now Tier 2) | Evidence quote |
|---|---|---|
| G1 | Env var is exactly `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`; min version **v2.1.129** | "enable it by setting `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`" / "requires Claude Code v2.1.129 or later" (discovery was briefly automatic in 2.1.126-2.1.128) |
| G2 | Request is `GET /v1/models?limit=1000`; response contract is only `{ data: [{ id, display_name? }] }` — `type`/`created_at`/pagination fields NOT read | "Claude Code reads `id` and the optional `display_name` from each entry in the response's `data` array" |
| G3 | Prefix rule: discovery **ignores entries whose `id` doesn't begin with `claude` or `anthropic`** (literal string prefix, not slash-specific) | "ignores entries whose `id` doesn't begin with `claude` or `anthropic`" |
| G4 | Non-matching ids still usable via `--model` / `ANTHROPIC_MODEL` / settings `model` ("Claude Code passes any string through without checking it") — they just don't auto-appear | model-config page |
| G5 | Picker labels discovered entries "From gateway"; `display_name` is the visible name | protocol reference |
| G6 | Selection persists to user settings `model` field (Enter = save, `s` = session-only; save-on-Enter since v2.1.153) | model-config page |
| G7 | Discovery auth: `ANTHROPIC_AUTH_TOKEN` → `Authorization: Bearer …`, else API key → `x-api-key`; `ANTHROPIC_CUSTOM_HEADERS` included | protocol reference |
| G8 | Discovery has a **3-second timeout**, treats redirects as failure, fails silently to cache (`~/.claude/cache/gateway-models.json`) or built-ins | protocol reference |
| G9 | Inference posts to **`/v1/messages?beta=true`** — match the PATH, don't require a query-free URL | protocol reference |
| G10 | `POST /v1/messages/count_tokens` is OPTIONAL ("Token-counting endpoints are the only optional ones"); absent → local estimate | protocol reference |
| G11 | `/v1/me` is NOT part of the gateway protocol; startup probes are `HEAD /` (+ discovery GET when enabled) | negative finding, endpoint list |
| G12 | Gateways must forward/accept `anthropic-version` (currently `2023-06-01`) and `anthropic-beta` unchanged; treat beta values as open lists | "Forward `anthropic-version` and `anthropic-beta` unchanged" |
| G13 | Streaming is mandatory for inference; a buffering gateway stalls the client | protocol reference |

**D6 status: CONFIRMED with amendments.** Alias format `claude-ocx-<provider>--<slug>`
satisfies G3 (begins with `claude`). 020's "flavor detection" gains a hard fact:
discovery sends `?limit=1000` + Anthropic-style auth headers (G2/G7).

## Lane 2 — Anthropic Messages API wire spec (platform.claude.com)

Sources: [Messages](https://platform.claude.com/docs/en/api/messages),
[Streaming](https://platform.claude.com/docs/en/build-with-claude/streaming),
[count_tokens](https://platform.claude.com/docs/en/api/messages/count_tokens),
[Errors](https://platform.claude.com/docs/en/api/errors),
[Extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking),
[Stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons).

### Request (inbound acceptance contract)

- Required: `model`, `max_tokens`, `messages[{role: user|assistant, content: string|blocks}]`.
  There is **no `system` role** — top-level `system?: string | TextBlock[]`.
- Content blocks to accept: `text`, `image{source: base64|url}`, `document`,
  `tool_use{id,name,input}`, `tool_result{tool_use_id, content?: string|blocks, is_error?}`,
  `thinking{thinking, signature}`, `redacted_thinking{data}`.
- `tools[{name, description?, input_schema}]`; `tool_choice: auto|any|tool{name}|none`
  each with `disable_parallel_tool_use?`.
- `thinking: {type:"enabled", budget_tokens>=1024} | {type:"adaptive"} | {type:"disabled"}`
  (+ optional `display: summarized|omitted`). Newer models may reject manual budgets →
  translation maps budgets to effort tiers, never forwards `budget_tokens` upstream.
- Also: `temperature`, `top_p`, `top_k` (DROPPED — Responses has no top_k),
  `stop_sequences[]`, `metadata.user_id`, `stream`.

### Response (non-stream)

`{id, type:"message", role:"assistant", content[], model, stop_reason, stop_sequence,
usage{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}}`.
`stop_reason` values: `end_turn|max_tokens|stop_sequence|tool_use|pause_turn|refusal|`
`model_context_window_exceeded|null` — emit the first four, tolerate the rest.

### Streaming SSE (outbound emission contract)

Order: `message_start` → per block (`content_block_start` → `content_block_delta`* →
`content_block_stop`) → `message_delta` → `message_stop`; any number of `ping`.

- `message_start.message` embeds a full message snapshot with `content:[]` and
  `usage:{input_tokens, output_tokens}` (non-final counts OK).
- Deltas: `text_delta{text}`, `input_json_delta{partial_json}` (accumulate, parse at stop),
  `thinking_delta{thinking}`, `signature_delta{signature}` ("sent just before the
  `content_block_stop`").
- `message_delta`: `{delta:{stop_reason, stop_sequence}, usage:{output_tokens}}` —
  usage is **cumulative**.
- Error mid-stream: `event: error` + `{type:"error", error:{type, message}}` may arrive
  after HTTP 200.
- Clients must tolerate unknown event types (doc-quoted) — but WE emit only the
  documented vocabulary.

### count_tokens / errors / headers

- `POST /v1/messages/count_tokens` → `{"input_tokens": N}` (exact shape).
- Error envelope: `{type:"error", error:{type, message}, request_id?}`; mapping
  400 invalid_request_error / 401 authentication_error / 403 permission_error /
  404 not_found_error / 429 rate_limit_error / 500 api_error / 529 overloaded_error.
- Headers Claude Code sends: `x-api-key` (or `Authorization: Bearer` with
  ANTHROPIC_AUTH_TOKEN), `anthropic-version: 2023-06-01`, `anthropic-beta` (CSV),
  `content-type: application/json`.

### Thinking replay (010 v1 policy, now evidence-backed)

Real Anthropic upstream REQUIRES replayed thinking blocks byte-exact incl.
`signature` (400 on modification). Our inbound DROPS inbound thinking/redacted_
thinking blocks before replay to routed providers — safe, because we never send
them to Anthropic-the-company; the routed provider gets Responses-shaped history
where reasoning lives in `reasoning` items/ocxr1 envelopes instead. Emitting
unsigned `thinking` blocks outbound is display-only for Claude Code. (040
workstream 1 remains the anthropic-family fidelity path.)

## Lane 3 — Claude Code env/settings + CCR internals

Sources: [env-vars](https://code.claude.com/docs/en/env-vars),
[settings](https://code.claude.com/docs/en/settings),
[model-config](https://code.claude.com/docs/en/model-config),
CCR v2.0.0 raw sources (anthropic.transformer.ts, reasoning.transformer.ts,
codeCommand.ts, createEnvVariables.ts, server.ts), CCR issues #504/#575/#744.

| # | Claim (Tier 2) | Evidence |
|---|---|---|
| E1 | `ANTHROPIC_AUTH_TOKEN` → `Authorization: Bearer <v>`; `ANTHROPIC_API_KEY` → `X-Api-Key`; NEVER set both (auth-conflict warning) | env-vars |
| E2 | Model slot env vars TODAY: `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_FABLE_MODEL`; **`ANTHROPIC_SMALL_FAST_MODEL` deprecated** in favor of DEFAULT_HAIKU | model-config |
| E3 | settings.json `env` block persists gateway config for any launch method; `--model`/`ANTHROPIC_MODEL` override settings `model` | env-vars, settings |
| E4 | Endpoints actually needed: POST /v1/messages (required), count_tokens (optional, local estimate fallback), GET /v1/models (discovery opt-in), `HEAD /` probe may occur and MAY be rejected | gateway protocol |
| E5 | CCR v2 `ccr code` = temp `--settings` file with env block; injects ANTHROPIC_AUTH_TOKEN/BASE_URL, NO_PROXY, DISABLE_TELEMETRY, DISABLE_COST_WARNINGS, API_TIMEOUT_MS; defaults port 3456, token "test" | codeCommand.ts, createEnvVariables.ts |
| E6 | CCR thinking policy: replayed thinking kept ONLY if it has a signature; synthesized signature = `Date.now().toString()` emitted via `signature_delta` — i.e. a **synthetic signature satisfies Claude Code**, it is not cryptographically checked client-side | reasoning.transformer.ts |
| E7 | CCR tool ids pass through (`toolu_*` preserved; fallback `call_<ts>_<idx>`) | anthropic.transformer.ts |
| E8 | CCR slots default/background/think/longContext/webSearch(+image); `provider,model` comma selector is the legacy picker hack (#504); current CCR main serves GET /v1/models discovery | routes.ts, gateway/service.ts |

## Consequences pushed into phase docs

1. **010**: `message_start` usage snapshot; cumulative `message_delta.usage`;
   `?beta=true` query ignored by path-match (G9); error envelope + taxonomy table
   moved UP from 040 (cheap now, table-driven); `top_k` documented-drop.
   Thinking blocks outbound get a SYNTHETIC `signature_delta` (E6 precedent:
   Claude Code does not verify signatures client-side; our inbound drops replayed
   thinking anyway).
2. **020**: discovery response can be the minimal `{data:[{id, display_name}]}`
   (G2) — no pagination fields needed; detection signal = `anthropic-version`
   header OR `?limit=` + Bearer/x-api-key (G7); 3s budget → discovery branch must
   not await catalog network refresh (serve from cached registry) (G8);
   `ocx claude` also sets `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` (G1);
   slot injection uses `ANTHROPIC_DEFAULT_HAIKU_MODEL` (+ legacy
   `ANTHROPIC_SMALL_FAST_MODEL` for old versions) per E2; set AUTH_TOKEN only,
   never API_KEY too (E1); `HEAD /` must not 500 (E4 — static handler already
   serves /, verify).
3. **030**: user-spec amendment — sidebar **Claude ON** toggle (label literal
   "Claude ON" in ALL locales) above the language selector; dedicated nav tab
   under API ("Claude"), page = Claude settings (slots, modelMap, discovery
   status, launcher hint). Replaces the earlier "section on Models page" default.
