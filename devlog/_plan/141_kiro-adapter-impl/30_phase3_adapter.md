# 141.30 — Phase 3: kiro adapter (buildRequest + parseStream), plan

> Branch `feat/kiro-on-dev`. NEW `src/adapters/kiro.ts` (implements `ProviderAdapter`) + `resolveAdapter`
> case in `src/server.ts`. Depends on Phase 1 (`src/lib/eventstream-decoder.ts`) + Phase 2 (oauth/registry).
> Port: jawcode `packages/ai/src/providers/kiro.ts` `buildPayload`/`parseKiroPayload` (+ the 260628
> live-confirmed fixes). Contract: codex `015/45_ki_codewhisperer_wire_stream_oauth.md`.

## opencodex contract (verified from src/adapters/base.ts)
```ts
interface ProviderAdapter {
  name: string;
  buildRequest(parsed: OcxParsedRequest, incoming?: IncomingMeta): { url; method; headers; body };  // SYNC on dev
  parseStream(response: Response): AsyncGenerator<AdapterEvent>;
  parseResponse?(response: Response): Promise<AdapterEvent[]>;
}
```
- `buildRequest` is **sync** on dev (no Promise) and `IncomingMeta = { headers: Headers }`.
- `resolveAdapter(providerConfig)` switch in `server.ts:282` (cases: openai-chat/anthropic/openai-responses/google/azure...). Add `case "kiro"`.

## Design (NEW src/adapters/kiro.ts)
### buildRequest(parsed, incoming)
- `url = https://runtime.{region}.kiro.dev/` (region from `KIRO_REGION` / default us-east-1; registry seed is us-east-1).
- headers: `authorization: Bearer <token>`, `content-type: application/x-amz-json-1.0`,
  `accept: application/vnd.amazon.eventstream`, `x-amz-target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse`,
  KiroIDE-spoof `user-agent`/`x-amz-user-agent` (sha256(hostname-username) fingerprint), `x-amzn-kiro-agent-mode: vibe`,
  `x-amzn-kiro-profile-arn: <profileArn>`, `amz-sdk-invocation-id: <uuid>`.
- body: `conversationState` from `parsed` (Responses-shaped input → CW history):
  - **toolUses[].input = JSON object** (NOT stringified) ← carried fix.
  - **toolResults adjacency** (each on the userInputMessage after its assistant turn) ← carried fix.
  - stable `conversationId` (hash of first-3 + last message), `chatTriggerType:"MANUAL"`, `origin:"AI_EDITOR"`.
  - tools from `parsed` tool defs (name ≤64).
### parseStream(response)
- `for await (msg of decodeEventStream(response.body!))` → JSON.parse(msg.payload) →
  **discriminate `stop` → `input` → `name`** (carried fix; CW repeats name on every tool event) →
  emit `AdapterEvent`s (text delta, tool-call start/args-delta/done, completed).

## AUDIT QUESTIONS (Backend A-phase)
- **Q1 token flow:** With sync `buildRequest`, how does the adapter obtain the resolved kiro access token?
  Does the server pre-resolve the OAuth token and pass it via `incoming.headers` (authMode), or must the
  adapter read it? Check `server.ts` around `resolveAdapter` (L282) + the request pipeline (L437) + how
  anthropic/xai (oauth) adapters receive their token. Determine the idiomatic path for kiro.
- **Q2 profileArn (sync):** profileArn must be resolved at buildRequest time. SQLite read is sync (bun:sqlite),
  so a sync `readKiroProfileArn()` (SQLite `profile_arn` / `KIRO_PROFILE_ARN`) is feasible — confirm acceptable,
  and where region should come from.
- **Q3 AdapterEvent shape:** Read `src/types.ts` `AdapterEvent` (L177+) and an existing `parseStream`
  (openai-responses.ts / anthropic.ts) to fix the EXACT event variants kiro must emit for: text delta,
  tool-call (id/name/args-delta), and completion. Map CW stream events → those variants.
- **Q4 OcxParsedRequest shape:** Read `src/types.ts` `OcxParsedRequest` (L1+) to know the input/messages/tools
  shape buildRequest receives (Responses-API-derived) and how to build CW history from it.

## Sub-steps
- A: Backend audits this plan + answers Q1-Q4 with file:line (real adapter token flow + AdapterEvent + OcxParsedRequest).
- B: implement `src/adapters/kiro.ts` + `resolveAdapter` case; tests `tests/kiro-adapter.test.ts` (buildRequest body
  shape incl. input=object + toolResult adjacency + headers; parseStream over encodeMessage frames incl. tool-arg
  accumulation with name-repeat). Backend B-verify.
- C: bun test + tsc; D: close.

## Carried correctness (must-have)
input=object · toolResult adjacency · stream discriminate stop/input/name (the 3 jawcode live fixes).

## Audit resolution (Backend, PASS + C1/C2) — 260628

- **Q1 (token):** server pre-resolves the OAuth token async (`server.ts:~L414`) and it reaches the adapter via
  `provider.apiKey` (token already injected because kiro is `authKind/authMode:"oauth"`, `server.ts:~L412`).
  → kiro `buildRequest` uses the provided token; **must NOT re-resolve**. (Confirm exact accessor in B.)
- **Q2 (profileArn, sync):** sync `bun:sqlite` read OK inside buildRequest. Isolate `readKiroProfileArn()`
  (SQLite `profile_arn` / `KIRO_PROFILE_ARN`), memoize, hard-fail with a clear error when absent.
  region precedence `KIRO_REGION → baseUrl → us-east-1`.
- **Q3 (AdapterEvent variants, exact):** `text_delta{text}` · `tool_call_start{id,name}` (once per tool id) ·
  `tool_call_delta{arguments}` (raw partial-JSON string; or whole JSON in one delta if CW gives atomically) ·
  `tool_call_end{}` (close before next start / before done) · `done{usage?}` · `error{message}`.
  Ordering invariant from openai-chat.ts L233/253/282. This is exactly why the stop→input→name discrimination
  matters: emit start once, route name-repeat chunks to delta, close on stop.
- **Q4 (OcxParsedRequest):** `context = { systemPrompt?: string[]; messages: OcxMessage[]; tools?: OcxTool[] }`.
  `OcxToolCall.arguments` is **already a parsed object** → pass straight into CW `toolUses[].input` (input=object
  fix is native here). toolResult adjacency precedent: anthropic.ts L160-185 (scan j=i+1 while role==='toolResult',
  group onto the following user turn) — replicate for CW.
- **C1:** rely on Phase-2 oauth token injection; don't re-resolve in adapter.
- **C2:** profileArn helper memoized + hard-fail; region precedence as above.
- **B-validate:** endpoint `runtime.{region}.kiro.dev` + `x-amz-target` against jawcode kiro.ts (already confirmed
  this session: host + `AmazonCodeWhispererStreamingService.GenerateAssistantResponse`).

→ Phase 3 build scope (revised): `src/adapters/kiro.ts` (buildRequest: token from provider.apiKey + sync
profileArn/region + conversationState w/ input=object + toolResult adjacency + KiroIDE fingerprint headers +
stable conversationId; parseStream: decodeEventStream + stop/input/name discrimination → the 6 AdapterEvent
variants) + `resolveAdapter` `case "kiro"` + `tests/kiro-adapter.test.ts`.
