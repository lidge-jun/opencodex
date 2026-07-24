---
title: Adapters
description: Provider adapters — what each targets, how it builds requests, and its quirks.
---

An **adapter** translates between opencodex's internal request/response model and one provider wire
format. Every adapter implements the `ProviderAdapter` interface (`src/adapters/base.ts`):

```ts
interface ProviderAdapter {
  name: string;
  buildRequest(parsed, incoming?): AdapterRequest | Promise<AdapterRequest>;
  fetchResponse?(request, context): Promise<Response>;   // custom retry/transport
  parseStream(response): AsyncGenerator<AdapterEvent>;
  parseResponse?(response): Promise<AdapterEvent[]>;   // non-streaming
  runTurn?(parsed, incoming, emit): Promise<void>;      // bidirectional transport
}
```

`buildRequest` lowers an `OcxParsedRequest` into an upstream HTTP request; `parseStream` /
`parseResponse` lift the provider's reply back into internal `AdapterEvent`s. `fetchResponse` lets an
adapter own retries/timeouts, while `runTurn` supports transports that cannot be represented as one
HTTP fetch followed by one response stream. [`bridge.ts`](/reference/architecture/#the-bridge)
then turns the events into Responses SSE.

## `openai-chat`

**Targets:** OpenAI **Chat Completions** (`POST {baseUrl}/chat/completions`) and every compatible
provider — xAI, Kimi, DeepSeek, GLM, Groq, OpenRouter, Ollama (local & cloud), and more.
**Auth:** `key` (Bearer).

- Converts internal messages to OpenAI roles; maps tools to `{type:"function", function:{…}}` and
  `tool_choice` (`auto`/`none`/`required` or a named function).
- **Rewrites Codex's GPT-5 identity prompt** to a model-agnostic intro so routed models don't claim to
  be OpenAI.
- **Clamps `reasoning_effort`** to the model's advertised subset when an exact tier is unavailable;
  `xhigh` and `max` remain distinct labels unless a provider explicitly configures an alias. The
  adapter **omits it entirely** for ids in `provider.noReasoningModels`.
- Streams `delta.content` (text), `delta.reasoning_content` (thinking), and `delta.tool_calls[]`;
  collects `usage`.

## `openai-responses`

**Targets:** the OpenAI **Responses API**. **`passthrough: true`** — forwards the raw request body and
streams the response back **untranslated**.
**Auth:** `forward` (relay the caller's headers) or `key`.

- `forward` URL → `{baseUrl}/responses`. A `key` provider defaults to the legacy `{baseUrl}/v1/responses` construction.
- A `key` provider may set a validated relative `responsesPath`; the adapter removes one trailing slash from `baseUrl` and sends `{trimmedBaseUrl}{responsesPath}`. For Ark Agent Plan, use `baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3"` with `responsesPath: "/responses"`.
- In `forward` mode only a safe header allowlist is relayed (`FORWARD_HEADERS`): authorization,
  ChatGPT account id, and the OpenAI beta/originator/session headers. This is the ChatGPT-login path
  that also powers the [sidecars](/guides/sidecars/).

## `anthropic`

**Targets:** Anthropic **Messages** (`/v1/messages`).
**Auth:** `key` (`x-api-key`) or `oauth` (Bearer + `anthropic-beta`, for Claude Pro/Max).

- Converts messages to Anthropic content blocks (text, base64 image, `tool_use`, `thinking`).
- **Extended thinking math:** Anthropic requires `max_tokens > thinking.budget_tokens`. The adapter
  maps reasoning effort to a budget (minimal 1024 … max 32000), then computes a safe `max_tokens` with
  output headroom, and **drops `temperature`/`top_p`** when thinking is enabled (Anthropic forbids
  them there).
- Always sends `anthropic-version: 2023-06-01`. Streams `content_block_delta` (`text_delta`,
  `thinking_delta`, compatible `reasoning_delta`, `input_json_delta`). The SSE decoder preserves
  event state across fetch chunks and accepts a terminal `message_stop` without a trailing newline.

## `google`

**Targets:** Google **Gemini**, **Vertex AI**, and Antigravity **Cloud Code Assist**. AI Studio uses
`/v1beta/models/{model}:streamGenerateContent`; the other modes use their native Google endpoints.
**Auth:** API key, Vertex ADC, or Google Antigravity OAuth, selected by `googleMode`.

- System prompt → `systemInstruction`; messages → `contents[]` (assistant → `model`); tools →
  `functionDeclarations`. Data-URL images → `inline_data`.
- Tool-call ids are synthesized when Gemini omits them. Antigravity preserves and replays real
  `thoughtSignature` values so reasoning continuity survives later turns.

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
- Owns replay-safe connection-reset recovery, that single eligible endpoint fallback, and one OAuth
  refresh/replay after HTTP 401. The client owns throttling, timeout, and ordinary service retries;
  opencodex does not multiply those policies inside the adapter.
- Its non-streaming parser drains the same event stream for the web-search loop.

### Completion semantics

Kiro text events do not carry a dependable end-turn phase. When an ordinary client tool is present,
opencodex therefore adds a private `codex_kiro_final_answer` tool to the upstream request. Progress
text streams as commentary and cannot terminate the turn. The adapter consumes the private call,
emits its answer as final text, and never exposes the private tool to Codex or Claude Code.
When the web-search sidecar is active, this commentary still streams immediately; only the events
needed to decide whether the model requested a synthetic search remain buffered.

If Kiro emits progress without calling the completion tool, the adapter makes one continuation. That
single retry may finish with a validated private completion or plain final text. It cannot recurse:
an empty or reasoning-only retry is returned as retryable incomplete, while a real client tool call
keeps the turn open. If the retry only repeats the preceding commentary after whitespace
normalization, the duplicate output is suppressed while the turn still completes. Tool-free
requests retain normal text completion behavior.

### Reasoning effort

`gpt-5.6-sol` has verified native effort support. Its selected `low`, `medium`, `high`, `xhigh`, or
`max` value is sent as `additionalModelRequestFields.reasoning.effort`. Other Kiro models currently
use emulated reasoning: opencodex converts the selected level into bounded thinking instructions in
the user content because their native effort field has not been verified. Do not interpret an
advertised effort control on those models as proof of upstream-native reasoning support.

## `cursor`

**Targets:** Cursor's `agent.v1.AgentService/Run` over HTTP/2 Connect streaming at `api2.cursor.sh`.
**Auth:** Cursor OAuth/access token from `provider.apiKey` or the forwarded authorization header.

- Uses `runTurn` rather than the ordinary fetch/parse path. Requests, server events, tool arguments,
  usage checkpoints, and client replies are encoded with `@bufbuild/protobuf` schemas in
  `cursor/gen/agent_pb.ts` and framed as Connect messages.
- Replays conversation state through content-addressed blobs, maps server tool calls back to Codex,
  discovers live Cursor models through the protobuf `GetUsableModels` RPC, and retries only before a
  run request is committed to the wire.
- Exposes Cursor Router as `cursor/auto` plus explicit `cursor/auto-cost`,
  `cursor/auto-balance`, and `cursor/auto-intelligence` entries. Explicit levels are encoded in
  `requested_model.parameters` while the legacy `cursor/auto` entry retains the account/team default.
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

## `open2-beta`

**Targets:** Upstage's Open2 public-beta web client over `solar-chat.v1` WebSocket frames.
**Auth:** an anonymous `solar_session` cookie created and refreshed automatically through
`GET /api/session`; no API key is currently required.

- This is an unofficial bridge to a private beta web protocol, not a stable public API. It is
  currently free and keyless only while the anonymous public beta remains open; Upstage may change,
  restrict, authenticate, or remove it without notice.
- Uses `runTurn` for the WebSocket lifecycle, checks the ready protocol and event sequence, maps text,
  thinking, usage, completion, and errors into `AdapterEvent`s, and keeps refreshed cookies only in
  memory.
- Supports text and the beta UI's `none`, `medium`, `high`, and `max` reasoning choices. The upstream
  wire does not currently expose Codex client tools or native vision.

## Image utilities (`image.ts`)

Shared helpers used by the vision-aware adapters:

- `parseDataUrl(url)` — split a `data:<type>;base64,<data>` URL into `{ mediaType, base64 }` for
  Anthropic/Google image blocks.
- `contentPartsToText(content)` — flatten content parts to text for text-only tool messages
  (an undescribed image becomes a short `[image]` marker, never a token-exploding base64 blob).
