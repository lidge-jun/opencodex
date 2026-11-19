# 001 — Google protocol parity matrix: CPA vs opencodex

Heads compared: opencodex `dev` **d842c1352e**, PR #8742 head **d21ed22ea8** (Gemini generateContent
inbound and the Antigravity/agy connectors, accepted by the owner), CLIProxyAPI (CPA) **e96d4c4**
(2026-11-15, shallow clone in the gitignored `devlog/_chase/_cca/`). Method: source reading plus
Google's primary docs ([002](002_google_docs_notes.md)). Nothing here was exercised at runtime.

Row evidence (CPA `file:line`, opencodex `file:line`) lives in the lane appendices, keyed by the
same ids: [003](003_lane_a_inbound_interactions.md) (A-, inbound and Interactions),
[004](004_lane_b_antigravity_outbound.md) (B-, Antigravity outbound),
[005](005_lane_c_aistudio_vertex_outbound.md) (C-, AI Studio and Vertex outbound). This table is the
decision layer: status, priority, and which phase takes the row.

A **have (<commit>)** status names the branch commit that closed a row; the rest of the row keeps the research-time note.

Status vocabulary: **have** (parity), **gap** (CPA does it, opencodex should), **diff** (intentionally
different, with the reason), **n-a** (neither side, or outside this unit), **defer** (a real gap left for a
later unit, with the reason).

## Coverage summary

| Surface | CPA | opencodex dev | opencodex dev + #8742 | After this unit |
| --- | --- | --- | --- | --- |
| `GET /v1beta/models[/{m}]` | yes | no | yes | yes, plus token limits |
| `:generateContent` / `:streamGenerateContent` | yes (SSE even without `alt`) | no | yes (SSE or JSON array) | yes, thought signatures carried |
| `:countTokens` | yes, every provider | no | 501 | local estimate |
| `:embedContent` | empty 200 (inferred) | no | 501 | 501 |
| `POST /v1beta/interactions` | yes, translated to every provider | no | no | yes, translated through Chat |
| `previous_interaction_id` | native passthrough only, silently dropped elsewhere | no | no | local bounded store |
| `GET/DELETE /v1beta/interactions/{id}` | no | no | no | yes (stored interactions) |
| Live API (`BidiGenerateContent`) | no | no | no | no (L-01) |
| Outbound Google: generateContent + Antigravity `v1internal` envelope | yes | yes | yes | yes, with the fidelity gaps below fixed |
| Outbound native Interactions provider | yes (`gemini-interactions`) | no | no | no (INT-16, deferred) |

## Inbound: generateContent family (baseline #8742)

| id | behaviour | lane ids | status | priority | phase |
| --- | --- | --- | --- | --- | --- |
| IN-01 | Routes: models list/get, generateContent, streamGenerateContent on `/v1beta`, generation also on `/v1/models/{m}:{method}` | A-R01 R02 R03 R12 R14 | have (#8742) | — | — |
| IN-02 | Stream without `alt=sse` is one JSON array (Google's REST default); CPA sends SSE regardless | A-R04 | diff: opencodex follows Google | — | — |
| IN-03 | `$alt` alias for `alt` | A-R05 | have (3374a52e28) | P3 | 030 |
| IN-04 | `: keep-alive` SSE comments before the first token | A-R06 | defer: bridge-wide change shared with Ollama; opencodex already disables the idle timeout for generation | P3 | — |
| IN-05 | `:countTokens` answers `{totalTokens}` | A-R07, C-V-10 | have (3374a52e28) | P2 | 030 |
| IN-06 | Embed methods | A-R08 | diff: 501 is honest, CPA's empty 200 is not | — | — |
| IN-07 | Error body `{error:{code,message,status}}` with fixed text; CPA emits OpenAI-shaped bodies and forwards upstream text | A-R17 R18 R19 | diff: opencodex follows Google and never forwards upstream text | — | — |
| IN-08 | Credential forms: `x-goog-api-key`, `?key=` moved onto the proxy header; CPA also takes `?auth_token=`, `X-Api-Key` | A-R15 R16 | diff: narrower on purpose | — | — |
| IN-09 | `thoughtSignature` round-trip on `functionCall` and text parts | A-R23, C-V-37 | partial: function-call parts round-trip (3374a52e28); text-part signatures are a gap | P1 | 030 |
| IN-10 | Hosted tools (`googleSearch`, `urlContext`, `codeExecution`) are dropped silently | A-R24 | defer: changing to 400 can break the owner-accepted connectors; needs a mapping onto opencodex's search relay first | P2 | — |
| IN-11 | `fileData` and non-image `inlineData` are 400 | A-R22 | defer: needs Chat IR document/audio parts end to end (C-V-29 lands the outbound half in 060) | P2 | — |
| IN-12 | Model resources carry `inputTokenLimit`/`outputTokenLimit` | A-R11 | have (3374a52e28) | P2 | 030 |
| IN-13 | `STATUS_NAMES` covers 402/408/409/422/500/502 | A-R17 | have (3374a52e28) | P3 | 030 |
| IN-14 | `usageMetadata.candidatesTokenCount` = Chat completion − reasoning | A-R29 | have (exact since OUT-V38, 3dccfa700f) | — | 050 |
| IN-15 | Tool config, structured output, thinking config, finish reasons, streamed tool calls, body limits, ingress isolation | A-R25 R27 R28 R29 R30 R31 R33 | have (#8742) | — | — |
| IN-16 | CORS: data-plane origin policy; CPA sends `*` | A-R32 | diff | — | — |

## Inbound: Interactions API

| id | behaviour | lane ids / doc | status | priority | phase |
| --- | --- | --- | --- | --- | --- |
| INT-01 | `POST /v1beta/interactions` create | A-I01; 002 Methods | have (9c48809348) | P1 | 010 |
| INT-02 | Exactly one of `model`/`agent`; `agent` needs a native upstream | A-I02 | have (9c48809348); opencodex answers 400 for `agent` (no native Interactions upstream) | P1 | 010 |
| INT-03 | `stream` must be boolean; true = SSE, false = JSON | A-I03 | have (9c48809348) | P1 | 010 |
| INT-04 | `input`: string, content, content list, step list, turn object | A-I04; 002 Interaction | have (9c48809348) | P1 | 010 |
| INT-05 | Input steps: `user_input`, `model_output`, `thought` (signature), `function_call`, `function_result` | A-I05 | have (9c48809348) | P1 | 010 |
| INT-06 | `system_instruction` string (or `{text}`/`{parts}`) | A-I06 | have (9c48809348) | P1 | 010 |
| INT-07 | `generation_config`: temperature, top_p, seed, stop_sequences, max_output_tokens, thinking_level, thinking_summaries, tool_choice; `response_format` | A-I07 A-R27; 002 | have (9c48809348) | P1 | 010 |
| INT-08 | `tools`: `function` entries; hosted tools | A-I08 | have (9c48809348); function tools mapped, hosted tools 400 (new surface, so no silent drop) | P1 | 010 |
| INT-09 | Non-stream body: `id`, `status`, `created`, `updated`, `model`, `steps`, `usage` with Google's `total_*` names | A-I09 A-I11; 002 usage | have (9c48809348); diff from CPA's `input_tokens` naming | P1 | 010 |
| INT-10 | SSE vocabulary: `interaction.created`, `step.start`, `step.delta`, `step.stop`, `interaction.completed`, `error` (`interaction.status_update` is not emitted: nothing runs in the background) | A-I10; 002 events | have (9c48809348) | P1 | 010 |
| INT-11 | Terminal event only after usage and settlement; exactly once | A-I12 | have (9c48809348); (bridge already guarantees it) | P1 | 010 |
| INT-12 | `status`: `requires_action` when the turn ends in function calls, `incomplete` on length, `completed` otherwise | A-I13; 002 status | have (9c48809348); diff: CPA reports `completed` for tool turns | P1 | 010 |
| INT-13 | `previous_interaction_id` resolves earlier history | A-I14 A-I15; 002 State | have (baa5dfbadb); diff: CPA has no local store and silently drops it for translated targets; opencodex keeps a bounded, owner-scoped local store | P1 | 020 |
| INT-14 | `store` (default true), `GET` and `DELETE /v1beta/interactions/{id}` | A-I16; 002 Methods | have (baa5dfbadb); (CPA has no GET/DELETE) | P2 | 020 |
| INT-15 | `background`, `POST …/{id}/cancel` | A-I16 | diff: 400 / 501, no background execution without a native upstream | — | 020 |
| INT-16 | Native Interactions upstream (`/v1beta/interactions` with `Api-Revision`) as a provider | A-I17, C-V-14 | defer: new provider adapter and catalog surface; separate unit | P3 | — |
| INT-17 | Other inbound protocols → Interactions upstream | A-I20 | defer: depends on INT-16 | P3 | — |
| INT-18 | Error envelope in Google shape, fixed text, `event: error` after commit | A-I18 | have (9c48809348) | P1 | 010 |
| INT-19 | Stable `/v1/interactions` alias | 002 Methods (v1 capture) | have (9c48809348); (opencodex-only addition; `/v1/interactions` is unused in opencodex; the v1 reference has the same methods and fields) | P3 | 010 |
| L-01 | Live API WebSocket | 002 Live | n-a: neither CPA nor opencodex; audio realtime is outside this unit | — | — |

## Chat wire carrier used by the Google paths

| id | behaviour | lane ids | status | priority | phase |
| --- | --- | --- | --- | --- | --- |
| CW-01 | Chat `tool_calls[].extra_content.google.thought_signature` read on input and emitted on output (CPA does both) | C-V-34 C-V-35, A-R23 | have (3374a52e28); the Chat wire now carries it both ways, as Responses already did | P1 | 030 |

## Outbound: Antigravity (Cloud Code Assist `v1internal`)

| id | behaviour | lane ids | status | priority | phase |
| --- | --- | --- | --- | --- | --- |
| AG-ENV | Envelope `model`, `userAgent:"antigravity"`, `project`, `request.sessionId`, `toolConfig` placement, `safetySettings` removed, Claude `VALIDATED` | B-E1 E2 E5 E7 E8 E10 | have | — | — |
| AG-SESSION | Session id derivation (opencodex adds account scope and a compaction-stable anchor) | B-E6 S2 | diff | — | — |
| AG-HTTP | Single daily endpoint, no cross-tier fallback; `?alt=sse`; `response` unwrapping | B-H1 H2 R1 | have (R1: opencodex fails closed on an unwrapped frame; diff) | — | — |
| AG-UA | User-Agent family (CPA hub UA auto-versioned; opencodex IDE UA, CLI UA for Gemini 4 codenames) | B-H4 H5 H7 | diff: each side has its own served-model evidence | — | — |
| AG-REPLAY | Thought-signature replay cache, clear-on-invalid, bypass sentinel, foreign-id filtering | B-S1 S4 S5 S6 | have | — | — |
| AG-X1 | 429 classification by `google.rpc.ErrorInfo.reason` (`QUOTA_EXHAUSTED`, `RATE_LIMIT_EXCEEDED`, `INSUFFICIENT_G1_CREDITS_BALANCE`) | B-X1 | have (c07d7cc259) | P1 | 040 |
| AG-X2 | Retry delay from `RetryInfo.retryDelay` / `quotaResetDelay` in full duration syntax (`1h2m3s`, `0.5s`), used by the transient retry loop, not only the quota branch | B-X2, C-V-46 | have (c07d7cc259) | P1 | 040 |
| AG-X3 | `PERMISSION_DENIED` + `ErrorInfo.reason=TOS_VIOLATION` is a credential-scoped terminal refusal, HTTP and in-stream | B-X3 R2 | partial: HTTP 403 has typed account handling (c07d7cc259); a TOS error in HTTP-200 SSE takes the generic stream-error path | P1 | 040 |
| AG-R4 | A stream with only a signature and usage (no text, no call) is a failure, not an empty success | B-R4 | diff: opencodex's empty-completion guard (`src/server/responses/empty-completion-guard.ts`) owns zero-output turns (one retry when enabled, a notice otherwise); a signature-only stream is that shape | — | — |
| AG-R7 | Input tokens include `toolUsePromptTokenCount` | B-R7 | have (3dccfa700f) | P2 | 050 |
| AG-M1 | Tool-result images nested in `functionResponse.parts` | B-M1, C-V-28 | defer: CPA nests on CCA, but ADR-7279 extends nesting only with live upstream evidence per route, and the pinned CCA Claude "responses before images" layout was a live fix; needs an Antigravity live run | P2 | 060 |
| AG-TOSPOOL | Opt-in pool-wide pause after a TOS suspension (CPA `antigravity_executor_credits.go:884-905`, off by default since e96d4c4) | B-X3 | defer: opencodex quarantines the one account (040); a pool-wide stop is a separate operator policy | P3 | — |
| AG-ACP | Official `agy acp` transport as a separate provider (#8480): the CLI owns the credential; one account, no rotation, local only, Gemini only, interactive only | issue #8480 + owner decision; ACP v1 spec; Google staff answers (080) | gap: CPA has no ACP client; opencodex adds it as its own PR | P1 | 080 |
| AG-S7 | Claude-on-CCA signature format validation | B-S7 | defer: needs a corpus of real Claude/Gemini carrier signatures to avoid dropping valid ones | P2 | — |
| AG-TL3 | Required `reason` placeholder for argument-less tools under Claude `VALIDATED` | B-TL3 | defer: needs a live check; opencodex already repairs schema 400s once | P2 | — |
| AG-E3 | `requestType` `image_gen`/`web_search` and their id shapes | B-E3 E4 | defer: upstream effect unverified | P3 | — |
| AG-E9 | CPA deletes `maxOutputTokens` for non-Claude models | B-E9 | defer: no stated reason in CPA; changing it could remove a needed cap | P3 | — |
| AG-E11 | `enabledCreditTypes:["GOOGLE_ONE_AI"]` credits fallback | B-E11 | defer: spends the user's paid credits; needs an explicit opt-in design | P3 | — |
| AG-MISC | countTokens on CCA, onboarding `X-Goog-Api-Client`, split-JSON SSE, non-stream via stream, replay identity with call id, Claude budget thinking, `webSearchModelIds` | B-H3 H5 R3 R6 S3 T2 D3 | defer | P3 | — |
| AG-OCX | opencodex-only: thinking-config 400 repair, schema 400 repair, model-denial rotation, transient retries | B-T3 TL4 X4 X5 | diff (opencodex ahead) | — | — |
| AG-DISC | `loadCodeAssist`, `onboardUser`, `fetchAvailableModels`, token refresh | B-D1 D2 D3 D4 | have (D1 host differs: diff) | — | — |

## Outbound: AI Studio (API key) and Vertex

| id | behaviour | lane ids | status | priority | phase |
| --- | --- | --- | --- | --- | --- |
| OUT-EP | Endpoints, auth headers, Vertex project/express URLs, ADC chain | C-V-01 V-03 V-05 V-07 V-08 | have (opencodex ADC chain is broader) | — | — |
| OUT-V04 | Vertex `us`/`eu` multi-region hosts `aiplatform.{us,eu}.rep.googleapis.com` | C-V-04 | have (430882ffa3) | P2 | 060 |
| OUT-V38 | Output tokens = `candidatesTokenCount + thoughtsTokenCount` (every other adapter's output includes reasoning; telemetry clamps reasoning to output) | C-V-38 V-39 | have (3dccfa700f) | P1 | 050 |
| OUT-V42 | `MALFORMED_FUNCTION_CALL` fails closed on AI Studio too; `UNEXPECTED_TOOL_CALL` and `MALFORMED_RESPONSE` with no output fail closed everywhere | C-V-42 | have (3dccfa700f); fail-closed errors carry 502 `upstream_error` | P1 | 050 |
| OUT-V40 | `IMAGE_SAFETY` → `content_filter` | C-V-40 V-41 | have (3dccfa700f); also `IMAGE_PROHIBITED_CONTENT` and `MALFORMED_RESPONSE` with output | P2 | 050 |
| OUT-V43 | `promptFeedback.blockReason` becomes a typed, non-retryable block error (stream and buffered) | C-V-43 | have (3dccfa700f); 400 `invalid_prompt`, a terminal refusal | P2 | 050 |
| OUT-V27 | Tool error results (`isError`) → `functionResponse.response.error` | C-V-27 | have (430882ffa3) | P3 | 060 |
| INT-20 | Interactions `function_result.is_error` reaches Google as `functionResponse.response.error` | review r1 (R2); Google Interactions reference `is_error` | defer: the Chat and Responses wires that every inbound lane crosses have no tool-error flag, so carrying it is a new private Chat-wire contract in both lanes; today the error reaches every provider as `{"error": …}` result text | P3 | — |
| OUT-V29 | Audio input parts sent as `inline_data` | C-V-29 | have (430882ffa3); Claude on CCA keeps the marker | P2 | 060 |
| OUT-V31 | `thinkingBudget` for the 2.5 family | C-V-31 | defer: effort ladders are catalog-owned (`structure/catalog.md`); the existing 400 repair keeps 2.5 requests working | P2 | — |
| OUT-V23 | Native `googleSearch` grounding on user keys | C-V-23 | defer: overlaps the hosted search relay (`structure/data-planes/search.md`) | P2 | — |
| OUT-V22 | `parametersJsonSchema` instead of the sanitized `parameters` subset | C-V-22 | defer: design decision, current path has loss reporting and repair | P2 | — |
| OUT-V26 | Strip call ids on Vertex | C-V-26 | defer: needs a live Vertex probe; opencodex ids are normalized | P2 | — |
| OUT-V21 | Default `safetySettings` (CPA sends `OFF`) | C-V-21 | diff: policy, Google defaults apply | — | — |
| OUT-V32 | `includeThoughts` from client request vs provider setting | C-V-32 | diff | — | — |
| OUT-P3 | countTokens passthrough, Imagen, Vertex MaaS, `topK`, `imageConfig`, `input_file` URIs, text-part signatures, partial args | C-V-10 V-12 V-13 V-17 V-20 V-30 V-36 V-45 | defer | P3 | — |
| OUT-HAVE | systemInstruction, turn guards, max-output clamp, structured output, tool_choice, thought parts, signature surfacing, stream truncation, retries, 400 repair, model discovery | C-V-15 V-16 V-18 V-19 V-24 V-33 V-35 V-44 V-46 V-47 V-48 | have | — | — |

## Totals

Computed from the tables above (75 rows): 34 rows taken by phases 010-060 and shipped: 33 gaps (P1: 21, P2: 8,
P3: 4) plus INT-15, an intentional difference implemented in 020; 19 deferred, each with its reason (AG-M1 moved
from 060 to deferred during the build, and INT-20 was added from review round 1);
11 intentionally different; 9 at parity; 1 outside both projects. Grouped rows (AG-MISC, OUT-P3,
OUT-HAVE, AG-OCX) stand for several lane rows each; the appendices keep the per-row evidence. AG-ACP (owner decision on #8480) is taken by 080 and ships as its own PR.
