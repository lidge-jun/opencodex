# 140.01 — Provider Survey (jawcode source of truth)

Evidence from jawcode implementations and model catalogs. Model counts are rows in
`packages/ai/src/models.json` unless noted as static.

## Summary table

| Provider | Models | jawcode `Api` | Primary implementation | Auth mechanism |
|----------|--------|---------------|------------------------|----------------|
| `google-antigravity` | **15** | `google-gemini-cli` | `google-gemini-cli.ts` (shared) | OAuth JSON credential + Bearer |
| `google-vertex` | **13** | `google-vertex` | `google-vertex.ts` + `google-shared` | API key **or** GCP ADC Bearer |
| `amazon-bedrock` | **119** | `bedrock-converse-stream` | `amazon-bedrock.ts` | AWS SigV4 (profile/env/ADC chain) |
| `kiro` | **8** static | `kiro-streaming` | `kiro.ts` | Bearer (+ kiro-cli SQLite / refresh) |
| `cursor` | **145** | `cursor-agent` | `cursor.ts` (+ `cursor/gen/agent_pb`) | Cursor OAuth access token |

Descriptor defaults (`descriptors.ts:301-304`, `291`): bedrock
`us.anthropic.claude-opus-4-6-v1`, antigravity `gemini-3-pro-high`, vertex
`gemini-3-pro-preview`, cursor `claude-sonnet-4-6`, kiro `kiro-auto`.

---

## 1. `google-antigravity`

### Status

**Alive.** Shares the Cloud Code Assist stream implementation with `google-gemini-cli`; provider
slug is switched at runtime (`google-gemini-cli.ts:1-5`, `291`).

### Wire protocol

- **Endpoint:** Antigravity daily/sandbox fallbacks
  (`google-gemini-cli.ts:69-72`, `310`): `daily-cloudcode-pa.googleapis.com`,
  `daily-cloudcode-pa.sandbox.googleapis.com`.
- **Path:** `POST …/v1internal:streamGenerateContent?alt=sse` (`338`).
- **Body envelope:** `CloudCodeAssistRequest` — top-level `{ project, model, request, requestType?, userAgent?, requestId? }`
  (`195-222`, `785-796`). Antigravity adds `requestType: "agent"`, `userAgent: "antigravity"`,
  `requestId: "agent-{uuid}"` (`789-794`).
- **Inner request:** Gemini-shaped `contents`, `systemInstruction`, `generationConfig`,
  `tools`, `toolConfig` (`727-756`).
- **Streaming:** SSE JSON chunks with nested `response.candidates[].content.parts`
  (`394-501`) — text, `thought`/`thoughtSignature`, `functionCall`.

### Auth

- Requires OAuth credential JSON in `options.apiKey` (`286-288`).
- Parsed via `parseGeminiCliCredentials` → `{ accessToken, projectId, refreshToken?, expiresAt? }`
  (`143-179`).
- `Authorization: Bearer ${accessToken}` (`320`).
- Login/onboard: `utils/oauth/google-antigravity.ts` — Google OAuth + `loadCodeAssist` /
  `onboardUser` project provisioning (`116-172`), stores project id in credential blob.
- Refresh skew: 60s for antigravity (`89`, `182-192`).

### Streaming / fidelity quirks

| Quirk | Evidence |
|-------|----------|
| Antigravity session id derived from first user text hash | `653-659`, `731-733` |
| Claude on Antigravity: `anthropic-beta` header, `VALIDATED` tool mode | `95-97`, `324`, `765-770` |
| System instruction injection for Claude/Gemini-3 | `773-783` |
| Tool schema: `parametersJsonSchema` → `parameters` via `normalizeSchemaForCCA` | `662-678` |
| Empty-stream retry (up to 2) | `513-557` |
| Endpoint failover on retry attempts | `337-338` |
| Deletes `maxOutputTokens` for non-Claude antigravity models | `758-763` |

### Model discovery

Dynamic via `fetchAntigravityDiscoveryModels` when OAuth token present
(`google.ts:47-66`, `markUnlistedOutsideDynamic: true`).

### opencodex gap

Existing `google` adapter targets AI Studio URL
(`google.ts:108-110`: `/v1beta/models/{id}:streamGenerateContent`) with flat Gemini body and
`x-goog-api-key` — **not** the CCA envelope or Bearer auth.

---

## 2. `google-vertex`

### Wire protocol

- Delegates to `streamGoogleGenAI` with `api: "google-vertex"` (`google-vertex.ts:24-28`).
- **Two URL modes:**
  - API key: `https://aiplatform.googleapis.com/v1/publishers/google/models/{id}:streamGenerateContent?alt=sse`
    with `x-goog-api-key` (`37-44`).
  - ADC: `https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{id}:streamGenerateContent?alt=sse`
    with `Authorization: Bearer` (`47-57`).
- **Body:** standard `buildGoogleGenerateContentParams` (Gemini generateContent shape via
  `google-shared`).
- **Streaming:** same SSE JSON as AI Studio path inside `streamGoogleGenAI`.

### Auth

- API key: `GOOGLE_CLOUD_API_KEY` or real-looking `options.apiKey` (`61-67`).
- ADC: `getVertexAccessToken` from `google-auth.ts:1-13` — service account JWT, authorized_user
  refresh, or GCE metadata (`6-9`).
- Project/location required for ADC path (`69-87`).

### Quirks

- `retainTextSignature: true` for vertex (`28`) — thought signatures preserved for tool/thinking
  continuity.
- No dynamic model discovery yet (`google.ts:36-44` comment).

### opencodex gap

`google` adapter hardcodes AI Studio base URL and API key header. Vertex needs configurable
base host, path prefix (`projects/…/locations/…`), and Bearer injection from ADC refresh.

---

## 3. `amazon-bedrock`

### Wire protocol

- **API:** Bedrock Runtime `ConverseStream` — `POST /model/{modelId}/converse-stream`
  (`amazon-bedrock.ts:217-218`).
- **Accept:** `application/vnd.amazon.eventstream` (`244`).
- **Body:** `ConverseStreamRequest` — `messages`, optional `system`, `inferenceConfig`,
  `toolConfig`, `additionalModelRequestFields` for thinking (`204-214`, `763-810`).
- **Streaming:** AWS eventstream frames decoded by `decodeEventStream` (`276`); event types
  `messageStart`, `contentBlockStart/Delta/Stop`, `messageStop`, `metadata` (`298-334`).

### Auth

- `resolveAwsCredentials` with optional profile (`233-237`); test bypass
  `AWS_BEDROCK_SKIP_AUTH` (`230-231`).
- Request signed via custom `signRequest` (SigV4, no AWS SDK) (`246-255`).

### Message / tool mapping

- Messages converted to Bedrock wire roles with cache points for Anthropic models
  (`570-714`).
- Tool results batched into single user message (`662-696`).
- Thinking: `additionalModelRequestFields.thinking` with adaptive vs budget modes
  (`763-810`); `thinkingDisplay` default `"summarized"` (`65`, `779`).

### Model catalog

- **119** models in `models.json`.
- Discovery via models.dev key `amazon-bedrock` (`openai-compat.ts:2170-2204`) with cross-region
  id transform and EU variant duplication for Claude (`2184-2202`).

### opencodex gap

No Bedrock adapter, no SigV4 signer, no eventstream parser in opencodex. Cannot reuse
`anthropic` adapter — request/response shapes differ despite similar message semantics.

---

## 4. `kiro`

### Wire protocol

- **Host:** `https://runtime.{region}.kiro.dev/` (`kiro.ts:49-50`, `545-546`).
- **Headers:** AWS-style `x-amz-target:
  AmazonCodeWhispererStreamingService.GenerateAssistantResponse` (`50`, `92`).
- **Content-Type:** `application/x-amz-json-1.0` (`90`).
- **Accept:** `application/vnd.amazon.eventstream` (`91`).
- **Body:** `conversationState` with `history`, `currentMessage.userInputMessage`, optional
  `tools` / `toolResults` in context (`145-240`).
- **Streaming:** shared `decodeEventStream` (`591`); payload JSON heuristics in
  `parseKiroPayload` (`256-305`) — `content`, tool `{name,input,toolUseId}`, `{stop:true}`,
  `{usage}`.

### Auth

- Multi-source resolver `resolveKiroAuth` (`392-487`): explicit token, `aoa*` apiKey prefix,
  `KIRO_ACCESS_TOKEN`, cache + refresh, prokiro `auth.json`, kiro-cli SQLite
  (`328-368`, `462-484`).
- Refresh: `POST https://prod.{region}.auth.desktop.kiro.dev/refreshToken` (`312`, `371-389`).
- **Anti-detection:** machine fingerprint in User-Agent (`72-83`, `85-98`).

### Quirks

| Quirk | Evidence |
|-------|----------|
| Model id mapping table (`kiro-auto` → `auto`, etc.) | `728-749` |
| Stable `conversationId` hash from messages | `751-765` |
| Tool name truncated to 64 chars | `121` |
| No thinking stream — text + tools only | `602-671` |
| 401 → refresh + single retry | `562-579` |

### Models

**8** static entries in `special.ts:82-91` (not in `models.json`). Default `kiro-auto`
(`descriptors.ts:222`).

### opencodex gap

Proprietary payload + IDE impersonation headers. Eventstream decoder could be **shared** with
Bedrock port, but request builder and auth import path are Kiro-specific.

---

## 5. `cursor`

### Wire protocol

- **Not an LLM REST API.** HTTP/2 Connect to `AgentService/Run` (`cursor.ts:133-134`, `355-368`).
- **Content-Type:** `application/connect+proto` (`360`).
- **Framing:** 5-byte Connect frames (`175-180`, `412-421`); protobuf payloads
  (`AgentClientMessage` / `AgentServerMessage`).
- **Streaming:** `interactionUpdate` cases — `textDelta`, `thinkingDelta`, `toolCallStarted`,
  `toolCallDelta`, `toolCallCompleted`, `turnEnded` (`1955-2098`).
- **Bidirectional:** server sends `execServerMessage`, `kvServerMessage`; client must respond
  (`611-622`, `968-1203`).

### Auth

- Bearer access token required (`337-340`).
- OAuth: PKCE + browser login + poll (`utils/oauth/cursor.ts:4-76`); refresh via
  `exchange_user_api_key` (`98+`).
- Descriptor: `oauthProvider: "cursor"` (`descriptors.ts:291`).

### Conversation / prompt state

- `buildGrpcRequest` maintains `conversationState`, blob store, `rootPromptMessagesJson`
  (`2509-2640`) — critical for multi-turn (`2273-2276`).
- Host override system prompt so model doesn't assume Cursor IDE (`2293-2297`).
- Tools advertised via `requestContext` exec handshake, not in initial Run request
  (`2616-2617`, `977-998`).

### Exec / tools (major complexity)

- Shell, read, write, grep, ls, mcp, etc. handlers (`1005-1167`).
- Without `execHandlers`, tools return "Tool not available" / "Not implemented"
  (`1256-1257`, `1108`, `1135`).
- Heartbeat every 5s (`468-479`).

### Models

**145** entries in `models.json`. Dynamic discovery when API key present
(`special.ts:46-58` → `fetchCursorUsableModels`).

### opencodex gap

Requires new adapter with HTTP/2 + protobuf + optional exec bridge. Cannot map to any existing
five adapters. Highest risk: Codex tool calls vs Cursor native tool loop mismatch.

---

## Cross-reference: jawcode type system

`types.ts:35-61` registers all five APIs in `KnownApi` / `ApiOptionsMap`. Provider slugs
(`types.ts:101-149`) include all five survey subjects. Stream dispatch:
`register-builtins.ts:358-371` (gemini-cli/antigravity), `366-371` (vertex), plus bedrock,
cursor, kiro lazy loaders in the same file.

## opencodex adapter interface (target shape)

Every port must satisfy (`adapters/base.ts:8-20`):

```typescript
buildRequest(parsed, incoming?) → { url, method, headers, body }
parseStream(response) → AsyncGenerator<AdapterEvent>
parseResponse?(response) → Promise<AdapterEvent[]>
```

OAuth pattern reference: `oauth/index.ts:11-17` (`login`, `refresh`, `providerConfig`,
`defaultModel`) — exemplar flow in `oauth/xai.ts:1-71` (PKCE, discovery, token refresh).
