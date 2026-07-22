---
title: Adapters
description: The seven provider adapters — what each targets, how it builds requests, and its quirks.
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
HTTP fetch followed by one response stream. [`bridge.ts`](/opencodex/reference/architecture/#the-bridge)
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

- `forward` URL → `{baseUrl}/responses`; `key` URL → `{baseUrl}/v1/responses`.
- In `forward` mode only a safe header allowlist is relayed (`FORWARD_HEADERS`): authorization,
  ChatGPT account id, and the OpenAI beta/originator/session headers. This is the ChatGPT-login path
  that also powers the [sidecars](/opencodex/guides/sidecars/).

## `anthropic`

**Targets:** Anthropic **Messages** (`/v1/messages`).
**Auth:** `key` (`x-api-key`) or `oauth` (Bearer + `anthropic-beta`, for Claude Pro/Max).

- Converts messages to Anthropic content blocks (text, base64 image, `tool_use`, `thinking`).
- **Extended thinking math:** Anthropic requires `max_tokens > thinking.budget_tokens`. The adapter
  maps reasoning effort to a budget (minimal 1024 … max 32000), then computes a safe `max_tokens` with
  output headroom, and **drops `temperature`/`top_p`** when thinking is enabled (Anthropic forbids
  them there).
- Always sends `anthropic-version: 2023-06-01`. Streams `content_block_delta` (`text_delta`,
  `thinking_delta`, `input_json_delta`).

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
- Owns bounded retries and classified/redacted errors through `fetchResponse`; its non-streaming
  parser drains the same event stream for the web-search loop.

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
  and `desktopExecutor` integrations have separate opt-ins; `unsafeAllowNativeLocalExec` enables the
  broader built-in executor and bypasses Codex approval/sandbox semantics.

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
