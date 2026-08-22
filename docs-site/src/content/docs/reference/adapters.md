---
title: Adapters
description: The seven provider adapters — what each targets, how it builds requests, and its quirks.
---

An **adapter** translates between opencodex's internal request/response model and one provider wire
format. Every adapter implements the `ProviderAdapter` interface (`src/adapters/base.ts`):

```ts
interface ProviderAdapter {
  name: string;
  buildRequest(parsed: OcxParsedRequest, incoming: IncomingMeta): AdapterRequest | Promise<AdapterRequest>;
  fetchResponse?(request: AdapterRequest, ctx?: AdapterFetchContext): Promise<Response>;
  parseStream(response: Response, budget: TranslatorBudget): AsyncGenerator<AdapterEvent>;
  parseResponse?(response: Response, budget: TranslatorBudget): Promise<AdapterEvent[]>;
  runTurn?(parsed: OcxParsedRequest, incoming: IncomingMeta, emit: (event: AdapterEvent) => void): Promise<void>;
}
```

`buildRequest` lowers an `OcxParsedRequest` into an upstream HTTP request; `parseStream` /
`parseResponse` lift the provider's reply back into internal `AdapterEvent`s. `fetchResponse` lets an
adapter own retries/timeouts, while `runTurn` supports transports that cannot be represented as one
HTTP fetch followed by one response stream. [`bridge.ts`](/reference/architecture/#the-bridge)
then turns the events into Responses SSE.

## `openai-chat`

**Targets:** OpenAI **Chat Completions** (`POST {baseUrl}/chat/completions`; a trailing `/chat/completions` or `/` on `baseUrl` is stripped first) and every compatible
provider — xAI, Kimi, DeepSeek, GLM, Groq, OpenRouter, Ollama (local & cloud), and more.
**Auth:** `key` (Bearer).

- Converts internal messages to OpenAI roles; maps tools to `{type:"function", function:{…}}` and
  `tool_choice` (`auto`/`none`/`required` or a named function).
- **Tool-result images** ride in a follow-up user vision message (`image_url` parts) released once
  the tool round closes, since `role:"tool"` content is text-only; the `[image]` marker stays in the
  tool message as the anchor.
- **Rewrites Codex's GPT-5 identity prompt** to a model-agnostic intro so routed models don't claim to
  be OpenAI.
- **Clamps `reasoning_effort`** to the model's advertised subset when an exact tier is unavailable;
  `xhigh` and `max` remain distinct labels unless a provider explicitly configures an alias. The
  adapter **omits it entirely** for ids in `provider.noReasoningModels`.
- Streams `delta.content` (text), `delta.reasoning_content` (thinking), and `delta.tool_calls[]`;
  collects `usage`.
- ClinePass uses the live-verified gateway format `reasoning: { enabled: true, effort }` (or
  `{ enabled: false }` when reasoning is disabled); its public API docs do not currently specify
  this request shape. The adapter preserves requested `low`, `medium`, `high`, `xhigh`, and `max`
  tiers, accepts reasoning deltas from either `delta.reasoning_content` or `delta.reasoning`, requests
  streamed usage with `stream_options.include_usage`, and reads usage from non-stream response envelopes.

## `openai-responses`

**Targets:** the OpenAI **Responses API**. **`passthrough: true`** — normally forwards the raw request
body and response, with narrow compatibility rewrites for routed gateways.
**Auth:** canonical OpenAI `forward` relays only the safe caller-header allowlist; noncanonical
`forward` uses configured static headers without relaying caller authorization; `key` uses the
configured provider key.

Noncanonical Responses gateways receive Codex's client-executed `tool_search` declaration as a
collision-safe public function tool. Matching request history and JSON/SSE function calls are
translated back to the private `tool_search` lifecycle for the client. Canonical OpenAI forward
keeps the native private type unchanged.

For `key` auth, [`retryOn429`](/reference/configuration/) applies here too: a pre-stream 429
waits and replays the identical request on the same key before any other handling, exactly like
the translated `openai-chat` / Anthropic request path. Custom `runTurn` transports are not part
of the HTTP retry loop.

- DeepSeek's stateless Responses parser receives provider-scoped history normalization: hook-injected
  context moves after an unambiguous tool-call/result batch. Parallel calls remain grouped before
  their matching outputs so every call stays in the reasoning-bearing assistant turn. Tolerant
  providers and ambiguous duplicate, missing, or out-of-order call IDs keep their original input order.

- `forward` URL → `{baseUrl}/responses`. A `key` provider defaults to the legacy `{baseUrl}/v1/responses` construction.
- A `key` provider may set a validated relative `responsesPath`; the adapter removes one trailing slash from `baseUrl` and sends `{trimmedBaseUrl}{responsesPath}`. For Ark Agent Plan, use `baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3"` with `responsesPath: "/responses"`.
- In `forward` mode only a safe header allowlist is relayed (`FORWARD_HEADERS`): authorization,
  ChatGPT account id, and the OpenAI beta/originator/session headers. This is the ChatGPT-login path
  that also powers the [sidecars](/guides/sidecars/).

## `anthropic`

**Targets:** Anthropic **Messages** (`/v1/messages`).
**Auth:** `key` (`x-api-key` by default, or `Authorization: Bearer` with `apiKeyTransport: "bearer"`) or `oauth` (Bearer + `anthropic-beta`, for Claude Pro/Max).

- Converts messages to Anthropic content blocks (text, base64 image, `tool_use`, `thinking`).
- **Extended thinking math:** Anthropic requires `max_tokens > thinking.budget_tokens`. The adapter
  maps reasoning effort to a budget (minimal 1024 … max 32000), then computes a safe `max_tokens` with
  output headroom, and **drops `temperature`/`top_p`** when thinking is enabled (Anthropic forbids
  them there).
- **Structured output:** Responses `text.format` and Chat Completions `response_format` requests
  with `type: "json_schema"` become Anthropic `output_config.format`. The format merges into an
  existing adaptive-thinking output configuration, preserving a compatible `output_config.effort`.
  Routed Anthropic Messages requests preserve the same format through stored-OAuth translation.
  The adapter mirrors the Anthropic TypeScript SDK's supported JSON Schema subset: unsupported
  constraints are moved into `description` as model guidance, `oneOf` becomes `anyOf`, and object
  schemas receive `additionalProperties: false`. A root `$ref` retains its adjacent `$defs` so the
  local reference remains resolvable. OpenAI envelope fields such as schema `name`, envelope
  `description`, and `strict` are not part of the Anthropic wire format. JSON object mode without a
  schema has no Anthropic equivalent and is not translated.
- Always sends `anthropic-version: 2023-06-01`. Streams `content_block_delta` (`text_delta`,
  `thinking_delta`, compatible `reasoning_delta`, `input_json_delta`). The SSE decoder preserves
  event state across fetch chunks and accepts a terminal `message_stop` without a trailing newline.
- For routed Anthropic Responses turns with client tools, a bounded terminal guard detects the
  high-confidence case where the user requested an action but Claude ends with an execution claim
  and no tool call. It performs at most one internal continuation; normal answers, clarification
  questions, tool-using turns, and transport-incomplete responses are not auto-retried.

## `google`

**Targets:** Google **Gemini**, **Vertex AI**, and Antigravity **Cloud Code Assist**. AI Studio uses
`/v1beta/models/{model}:streamGenerateContent`; the other modes use their native Google endpoints.
**Auth:** API key, Vertex ADC, or Google Antigravity OAuth, selected by `googleMode`.

- System prompt → `systemInstruction`; messages → `contents[]` (assistant → `model`); tools →
  `functionDeclarations`. Data-URL images → `inline_data`.
- Tool-call ids are synthesized when Gemini omits them. Vertex and Antigravity preserve and replay
  opaque `thoughtSignature` values so tool-result continuations retain Gemini reasoning continuity.
  The signature cache is snapshotted to the config directory, so continuations also survive proxy
  restarts.
- **Malformed response shapes fail closed.** A claimed candidate, its `content`, or its
  `content.parts` that is not the documented container terminates the turn with a
  `google response contained invalid …` error naming the structural reason and the offending
  value's type — never its contents. Absence is handled separately from corruption: an absent,
  `null` or empty `content` or `parts` still completes the turn normally, a streaming chunk whose
  `candidates` is absent, `null` or empty is skipped so the turn completes on a later terminal
  frame, and a buffered response that carries no candidate at all returns
  `google response contained no candidates`. A root `data: null` keepalive frame is still skipped as
  padding.
- Tool-call batches are closed by one immediately adjacent user turn containing one ordered
  `functionResponse` per representable call. Interrupted histories receive an explicit missing-result marker;
  duplicate or standalone results are preserved as marked text (and image siblings) rather than
  emitted as invalid unpaired `functionResponse` parts.
- **Inline image output:** when the model is one of the explicit image-capable chat IDs
  (`gemini-3.1-flash-image`, `gemini-2.0-flash-preview-image-generation`, or
  `gemini-3-pro-image-preview`), the adapter sends `responseModalities: ["TEXT", "IMAGE"]`.
  Standalone media-generation IDs such as `gemini-3-pro-image` are not included. Returned
  `inlineData` parts are materialized under the configured OpenCodex `artifacts/` directory and
  surfaced as markdown image links to the authenticated opaque route
  `/v1/opencodex/artifacts/<id>` (not `file:` URIs or host filesystem paths). Each image is capped
  at 50 MB and each response at 100 MB of decoded data; malformed base64 payloads are rejected.
  Artifacts are pruned automatically when the count exceeds 200 files.

## `kiro`

**Targets:** the Amazon CodeWhisperer Streaming `GenerateAssistantResponse` service used by Kiro
(`https://runtime.{region}.kiro.dev/`).
**Auth:** Kiro OAuth access token as Bearer, with region/profile metadata from the Kiro credential.

- Builds Kiro `conversationState`, maps Codex tools and tool results, and sends image blocks supported
  by the Kiro wire.
- Decodes `application/vnd.amazon.eventstream`, reconstructs text/thinking/tool events, detects
  truncated tool JSON, and estimates usage because the upstream does not return token counts.
- Uses the configured `baseUrl` verbatim when it is custom. A canonical
  `runtime.{region}.kiro.dev` URL follows the imported credential's API region; only that canonical
  shape is eligible for one bounded fallback to `q.{region}.amazonaws.com` after an endpoint,
  signature, DNS, or connection failure.
- Owns replay-safe connection-reset recovery, that single eligible endpoint fallback, one OAuth
  refresh/replay after HTTP 401, and bounded recovery for transient Kiro 429s. A shared cooldown and
  single post-cooldown probe prevent concurrent requests from exhausting independent retry budgets;
  hard quota failures and ordinary service errors are not replayed.
- Its non-streaming parser drains the same event stream for the web-search loop.

### Completion semantics

Kiro assistant text carries no dependable end-turn phase of its own. Its terminal `metadataEvent`
can carry a native `stopReason`, but Kiro can label progress prose as `END_TURN`. On tool-enabled
turns, `END_TURN` and `STOP_SEQUENCE` therefore prove only that the inference stopped; ordinary text
remains commentary and enters the one bounded completion validation.

`END_TURN`, `STOP_SEQUENCE`, or a missing stop reason may use the compatibility path. Other explicit
reasons have already terminated the inference upstream, so the adapter reports them instead of
spending another model request: an output-token limit surfaces as incomplete output that a client may continue, while
context-window exhaustion surfaces as a non-retryable context-length error rather than as truncated
output. Filtering and guardrail stops surface as filtered incomplete output, and a `TOOL_USE` stop
that arrives without an actual tool call is reported as a contradiction rather than treated as
progress.

When an ordinary client tool exists, opencodex adds a private
`codex_kiro_final_answer` tool to the upstream request; progress text streams as commentary and
cannot terminate the turn. The adapter consumes the private call, emits its answer as final text,
and never exposes the private tool to Codex or Claude Code. Because the stop reason only arrives at
the end of the stream, assistant text in a tool-enabled turn is held until either a real tool call
starts or the stream ends, then releases it as commentary unless the private tool supplied the final
answer. When the web-search sidecar is active, released
commentary still streams ahead of the terminal event; only the events needed to decide whether the
model requested a synthetic search remain buffered.

If Kiro stops without calling the completion tool, the adapter makes one continuation. Reasoning-
only retries preserve the original valid user/tool-result turn rather than manufacturing an empty
assistant message; visible progress is replayed with a non-empty adapter-owned instruction. Before
transport, the generated conversation is checked for alternating roles, non-empty structural turns,
and matched tool-use/result ids. Empty tool output receives a neutral non-empty placeholder. The
retry cannot recurse: an empty or reasoning-only retry is returned as retryable incomplete, while a
real client tool call keeps the turn open. A completion-tool answer is always emitted as
`final_answer`, even when it exactly repeats prior commentary, because phase correctness is more
important than cosmetic de-duplication. Tool-free requests retain normal text completion behavior.

### Reasoning effort

`gpt-5.6-sol` and `claude-opus-5` have verified native effort support, and each model family names
the request field differently. A selected `low`, `medium`, `high`, `xhigh`, or `max` value is sent
as `additionalModelRequestFields.reasoning.effort` for `gpt-5.6-sol` and as
`additionalModelRequestFields.output_config.effort` for `claude-opus-5`. Other Kiro models currently
use emulated reasoning: opencodex converts the selected level into bounded thinking instructions in
the user content because their native effort field has not been verified. Do not interpret an
advertised effort control on those models as proof of upstream-native reasoning support.

## `cursor`

**Targets:** Cursor's `agent.v1.AgentService/Run` over HTTP/2 Connect streaming at `api2.cursor.sh`
by default. With `upstreamHttpVersion: "http1.1"` (or `"h1"`), uses Cursor's HTTP/1.1
compatibility pair: `agent.v1.AgentService/RunSSE` for server output and
`aiserver.v1.BidiService/BidiAppend` for client messages.
**Auth:** Cursor OAuth/access token from `provider.apiKey` or the forwarded authorization header.

- Uses `runTurn` rather than the ordinary fetch/parse path. Requests, server events, tool arguments,
  usage checkpoints, and client replies are encoded with `@bufbuild/protobuf` schemas in
  `cursor/gen/agent_pb.ts` and framed as Connect messages.
- Replays conversation state through content-addressed blobs, maps server tool calls back to Codex,
  discovers live Cursor models through the protobuf `GetUsableModels` RPC, and retries only before a
  run request is committed to the wire.
- After a successful no-tool turn, the adapter keeps Cursor's returned ConversationStateStructure
  in a process-local store and reuses that checkpoint on the next validated linear continuation
  instead of rebuilding the full root history. Tool-result turns reuse the last completed-turn
  checkpoint plus only the uncovered suffix when the covered message boundary is known.
  Compaction, helper/shadow isolation, account/model mismatch, missing refs, decode failures,
  forced-fresh recovery, and invalid_argument retries fall back to the existing full replay. A
  process restart drops the in-memory store and full-replays. Cursor Connect still does not expose
  authoritative cache_read_tokens, so OpenCodex usage is not a cache-hit counter.
- Honors `upstreamHttpVersion` for both live model discovery and inference. `auto`, `http2`, and `h2`
  preserve the existing HTTP/2 transport; only `http1.1` and `h1` select compatibility mode.
- Exposes Cursor Router as `cursor/auto` plus explicit `cursor/auto-cost`,
  `cursor/auto-balance`, and `cursor/auto-intelligence` entries. Explicit levels are encoded in
  `requested_model.parameters` while the legacy `cursor/auto` entry retains the account/team default.
- Sends regular `cursor/grok-4.5` tiers with Cursor's exact live-discovery wire ids
  (`cursor-grok-4.5-low`, `-medium`, or `-high`). Keeps `cursor/grok-4.5-fast` selectable while
  sending the canonical `grok-4.5` model with separate `effort` and `fast=true` parameters.
- Cursor-native local filesystem/shell/network execution is denied by default. Explicit `mcpServers`
  and `desktopExecutor` integrations have separate opt-ins; `nativeLocalExec: "on"` enables the
  broader built-in executor and bypasses Codex approval/sandbox semantics, and legacy
  `unsafeAllowNativeLocalExec: true` remains equivalent only when `nativeLocalExec` is unset.

## `azure-openai` (alias: `azure`)

**Targets:** **Azure OpenAI**. Wraps `openai-responses` (so also `passthrough: true`).
**Auth:** `key` via the `api-key` header (not Bearer).

- Delegates request building to the Responses passthrough, validates that `baseUrl` contains no
  unresolved template placeholder, and replaces `Authorization` with `api-key`. The configured URL
  targets Azure's v1 Responses API directly, so the adapter does not append `api-version`.

## Image utilities (`image.ts`)

Shared helpers used by the vision-aware adapters:

- `parseDataUrl(url)` — split a `data:<type>;base64,<data>` URL into `{ mediaType, base64 }` for
  Anthropic/Google image blocks.
- `contentPartsToText(content)` — flatten content parts to text for text-only tool messages
  (an undescribed image becomes a short `[image]` marker, never a token-exploding base64 blob).
