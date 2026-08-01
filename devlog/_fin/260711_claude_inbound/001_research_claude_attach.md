# 001 — Research: how routers attach to Claude Code + dashboard precedent

Research artifact for 000_plan.md. Tiering per cxc-search: Tier 1 = hosted
web_search discovery; Tier 2 = opened/local primary source. Claims below carry
their tier.

## 1. Attach mechanism (CCR — claude-code-router, musistudio)

- Claude Code natively speaks the **Anthropic Messages API**; a router attaches by
  setting `ANTHROPIC_BASE_URL` to the local gateway (plus `ANTHROPIC_AUTH_TOKEN`
  as a placeholder secret) and implementing `POST /v1/messages`. All protocol
  translation (Anthropic -> OpenAI/Gemini/DeepSeek/Ollama wire and back, including
  re-emitting **Anthropic-shaped SSE**) happens server-side in the router.
  [Tier 1: web_search on CCR architecture/README + project blog; consistent across
  sources]
- `ccr code` wraps the `claude` binary and injects those env vars automatically —
  the UX precedent for `ocx claude`. [Tier 1]
- CCR router config exposes **slot-based routing**: `default`, `background`
  (Claude Code's small/fast "haiku" slot), `think` (plan/thinking turns),
  `longContext` (token-count threshold), `webSearch`. Slots select
  `provider,model` pairs; users can also switch per-session with `/model` in
  Claude Code. [Tier 1]
- Claude Code first-party env vars `ANTHROPIC_MODEL` and
  `ANTHROPIC_SMALL_FAST_MODEL` cover the default + background slots WITHOUT any
  router-side mapping — the v1 lever for opencodex env injection. [Tier 1;
  cross-checked against ccs-wrapper's alias design, Tier 2 local]

## 2. Dashboard precedent

- CCR (current desktop release) serves the **web dashboard and the gateway on the
  same host:port** (default `localhost:8080`; the legacy CLI generation used
  `:3456`, `ccr ui` opened the config UI on that same port). Config edits go
  through that UI (SQLite/`config.json`). [Tier 1]
- Verdict for opencodex: **integrated GUI** (D2 in 000_plan.md). opencodex already
  multiplexes GUI + data plane on one port (`src/server/index.ts` serves
  `serveGuiFile` after the `/v1/*` guard); Claude traffic lands in the existing
  request log / usage pipeline with zero extra work. A separate dashboard would
  duplicate auth, ports, and process management for nothing. [Tier 2: local source]

## 3. Local primary evidence (Tier 2)

### opencodex internals (read this session)

- `src/server/responses.ts` — `handleResponsesCompact` builds an internal
  `Request("http://localhost/v1/responses")` and calls `handleResponses(...)`,
  then post-processes the result. Established in-repo pattern for
  translate-and-replay inbounds (D3).
- `src/responses/schema.ts` + `src/responses/parser.ts` — exact Responses body a
  translated request must satisfy (`input` item unions incl. `function_call`,
  `function_call_output` with `input_text`/`input_image` blocks; `reasoning.effort`
  ladder; `reasoning.summary` absent/none => thinking hidden — an Anthropic inbound
  wanting visible thinking must set `summary:"auto"`).
- `src/bridge.ts` — outbound Responses SSE vocabulary to translate into Anthropic
  SSE: `response.created`, `response.output_text.delta`,
  `response.reasoning_summary_text.delta` / `response.reasoning_text.delta`,
  `response.output_item.added|done` (item.type `message`/`reasoning`/
  `function_call`), `response.function_call_arguments.delta`,
  `response.completed|failed|incomplete`, `response.heartbeat` (-> Anthropic
  `ping`). Usage shape via `responsesUsage()` incl. `input_tokens_details.cached_tokens`
  (-> `cache_read_input_tokens`).
- `src/server/auth-cors.ts` — loopback binds need no auth; non-loopback accepts
  `x-opencodex-api-key`/`authorization`. Claude Code sends `x-api-key`, so that
  header needs admission in Phase 1.
- `src/lib/token-estimate.ts` — ready-made estimator for `count_tokens`.
- `src/cli/index.ts` — `handleEnsure()` spawns a detached `start` and waits on
  `findLiveProxy()`; `ocx claude` reuses it. Config schema is `.passthrough()`, so
  `config.claudeCode` needs only an OcxConfig type addition.

### ccs-wrapper (predecessor, ../010_2025/ccs-wrapper — read this session)

- 601-line FastAPI proxy over third-party CCS (:8317): model aliasing
  (haiku slot -> small model; sonnet slot -> codex-xhigh), thinking-param
  injection with budget->effort mapping, Codex effort-suffix routing,
  `/v1/messages` passthrough + `/v1/messages/{path}` (count_tokens) forward.
- Liabilities: CCS dependency (not running; launchctl shows nothing, :8317/:8318
  dead), stale model ids, thinking route buffers the full response then fakes SSE,
  zero tests, hardcoded config. Ideas survive as `claudeCode` config; code does not.

### CLIProxyAPI reference (devlog/_chase/_cca, Go — located this session)

- Claude Code inbound + session handling:
  `internal/runtime/executor/claude_executor.go`,
  `internal/runtime/executor/helps/claude_code_session.go`,
  `internal/translator/claude/*`, `internal/translator/openai/claude/*`,
  `internal/misc/claude_code_instructions.go`. Use for wire cross-checks in
  Phase 1 (e.g. beta headers, streaming edge cases). [Tier 2 local: paths verified;
  contents not yet read — read during Phase 1, not now]

## 4. Anthropic Messages wire requirements to satisfy (build checklist)

From the Messages API + Claude Code behavior (Tier 1, cross-checked against
ccs-wrapper's working inbound and the opencodex anthropic OUTBOUND adapter which
already speaks this wire from the client side, Tier 2 local):

- Request: `model`, `max_tokens`, `system` (string | text blocks), `messages`
  (content string | blocks: `text`, `image` (base64/url source), `tool_use`,
  `tool_result` (string | blocks, `is_error`), `thinking`/`redacted_thinking`),
  `tools` ({name, description, input_schema} + server tools like `web_search_*`),
  `tool_choice` ({auto|any|tool|none}, `disable_parallel_tool_use`), `thinking`
  ({enabled, budget_tokens} | adaptive effort), `stop_sequences`, `metadata.user_id`.
- Streaming response event order: `message_start` -> per block
  `content_block_start` / `content_block_delta` (`text_delta`, `thinking_delta`,
  `input_json_delta`) / `content_block_stop` -> `message_delta`
  ({stop_reason: end_turn|tool_use, usage}) -> `message_stop`; `ping` allowed.
- Endpoints: `POST /v1/messages` (+ tolerate `?beta=true` and `anthropic-beta`
  headers), `POST /v1/messages/count_tokens` -> `{input_tokens}`.
- Error shape: `{type:"error", error:{type, message}}` (OpenAI shape is close
  enough for Claude Code's display but should be normalized in Phase 4).

## 5. Alternatives considered (for the archive, D1/D3)

- **strong-1: inbound inside opencodex via internal-replay** (chosen — D1/D3).
  Provenance: local pattern `handleResponsesCompact` (Tier 2) + CCR one-port
  precedent (Tier 1).
- **add-1: standalone wrapper translating Anthropic->Responses against opencodex**
  (ccs-wrapper rebuild). Provenance: ccs-wrapper source (Tier 2 local). Rejected:
  second daemon, duplicated auth/logging, nothing reusable that config can't carry.
- Rebuild-on-CCS rejected outright: CCS third-party dependency is dead on this
  machine and upstream direction is unaligned.
