# 260710 — `encrypted: true` tool-schema marker: provider risk audit (issue #85 follow-up)

## Background
- Upstream openai/codex commit `5f4d06ef` (merged 2026-06-05, PR #26210) annotates v2 collaboration
  tool schemas (`spawn_agent` / `send_message` / `followup_task` → `properties.message`) with a
  non-standard JSON-Schema keyword `encrypted: true` ("Responses-only marker").
- opencodex forwards Codex Desktop's v2 `additional_tools` since `99b99bb8` (2026-07-10, in v2.7.3).
- Issue #85: Gemini/Antigravity rejects the whole request with 400 — the Google sanitizer
  ([google-tool-schema.ts](../../src/adapters/google-tool-schema.ts)) blacklist omits `encrypted`.
  Confirmed by local repro (parseRequest → google buildRequest emits `encrypted: true` in all three
  collaboration functionDeclarations).

## Question
Which other providers are exposed to the same class of failure (non-standard schema keyword passed
through verbatim → request-level 400)?

## Local adapter surface (grounded in code)
| Provider | Converter | Handling of unknown nested keywords | Prior risk read |
|---|---|---|---|
| Google (AIS/Vertex/Antigravity) | `google-tool-schema.ts` blacklist + deref | passes unknown keys (blacklist misses `encrypted`) | CONFIRMED broken (#85) |
| Kiro (CodeWhisperer/Q) | `kiro-tools.ts` `sanitizeKiroSchema` blacklist | `encrypted` not in `KIRO_REJECTED_SCHEMA_KEYS` → passes through | at-risk, needs evidence |
| Anthropic | `anthropic.ts` `normalizeAnthropicInputSchema` | root-only normalization; nested keys verbatim | needs evidence |
| OpenAI chat / Azure | `openai-chat.ts` verbatim; azure passthrough | verbatim | likely tolerant, verify |
| Cursor | `cursor/tool-definitions.ts` verbatim | verbatim | unknown |
| OpenAI Responses passthrough | native | marker is legal there | SAFE (must keep) |

## Dispatch ledger (Tier-3 cxc-search explorers, sol/medium, fork none, skill-attached)
- `risk_anthropic` — Anthropic Messages API `input_schema` strictness (+ Bedrock/Vertex-hosted Claude). [dispatched]
- `risk_kiro` — Kiro/CodeWhisperer/Q wire + Bedrock Converse `toolSpec.inputSchema.json` strictness. [dispatched]
- `risk_cursor_openai` — OpenAI chat completions (strict on/off), OpenAI-compatible gateways, Cursor agent wire. [dispatched]

## Findings

### Kiro / CodeWhisperer / Bedrock (risk_kiro, returned 2026-07-10)
- Verdict: **AT-RISK in practice** (unknown-keyword disposition itself UNVERIFIED, but the schema
  path is demonstrably restrictive and fails request-wide with 400/ValidationException).
- Kiro wire rejects legit JSON-Schema: root oneOf/allOf/anyOf 400 ("Bedrock error message",
  [Kiro#9638](https://github.com/kirodotdev/Kiro/issues/9638), 2026-06-21); one bad MCP tool fails
  even a "Hi" prompt ([Kiro#9653](https://github.com/kirodotdev/Kiro/issues/9653)); gateway impls
  recursively strip `additionalProperties` because "Kiro rejects" it
  ([Kiro-Go#74](https://github.com/Quorinex/Kiro-Go/pull/74), merged 2026-05-23).
- Bedrock Converse `toolSpec.inputSchema.json`: AWS docs never define a draft/keyword subset
  ([ToolInputSchema](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolInputSchema.html));
  real 400s for nested `minimum`/`maximum` ([LiteLLM#29168](https://github.com/BerriAI/litellm/issues/29168)),
  `default`/`format` stripped by LiteLLM ([LiteLLM PR#31534](https://github.com/BerriAI/litellm/pull/31534)),
  model-dependent `additionalProperties:false` rejection on non-Anthropic models
  ([OpenSRE#2404](https://github.com/Tracer-Cloud/opensre/pull/2404)).
- No public report on `encrypted`/`x-*` specifically → strip it anyway; downside is negligible.

### Anthropic (risk_anthropic, returned 2026-07-10)
- `encrypted: true` 자체의 수용 여부: **UNVERIFIED** — 직접 재현/문서 없음. 단 Anthropic은
  schema-lax가 아님: 서버측 검증이 실재하고 아래가 요청 전체를 400/500으로 죽임.
- 확인된 거부: root oneOf/allOf/anyOf ("input_schema does not support ... at the top level",
  [claude-code#3383](https://github.com/anthropics/claude-code/issues/3383),
  [#4886](https://github.com/anthropics/claude-code/issues/4886)); draft 2020-12 강제
  ([claude-code#59354](https://github.com/anthropics/claude-code/issues/59354), draft-07은 500
  [sdk-python#1001](https://github.com/anthropics/anthropic-sdk-python/issues/1001)); property-key
  패턴 400 ([claude-code#34249](https://github.com/anthropics/claude-code/issues/34249)).
- `strict: true`: 문서화된 제한 서브셋 — 미지원 구성은 "400 error with details"
  ([structured-outputs docs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations));
  minItems/minimum 등 400 실증 ([vercel/ai#13355](https://github.com/vercel/ai/issues/13355)).
- Bedrock/Vertex 호스팅 Claude: Messages 파리티 문서상 유사하나 legacy Bedrock Converse는 에러
  거동 상이(500) ([sdk-ts#885](https://github.com/anthropics/anthropic-sdk-typescript/issues/885)).
- 권고: 방어적으로 Anthropic에도 `encrypted` 제거 (사실 판정은 UNVERIFIED로 기록).

### Cursor / OpenAI chat / Azure (risk_cursor_openai, returned 2026-07-10)
- OpenAI Chat Completions non-strict: **SAFE** — official OpenAPI contract declares
  `FunctionParameters` as `type:object, additionalProperties:true`
  ([openai-openapi @5162af9](https://github.com/openai/openai-openapi/blob/5162af98d3147432c14680df789e8e12d4891e6b/openapi.yaml#L50153-L50193));
  guide: "Chat Completions requests remain non-strict by default".
- OpenAI `strict: true`: **AT-RISK** — "Only a subset of JSON Schema is supported when strict is
  true"; incompatible schemas rejected (function-calling / structured-outputs guides).
- Azure OpenAI: strict **AT-RISK** (same subset per Microsoft Learn structured-outputs, source
  updated 2026-05-13); non-strict **UNVERIFIED** (no contract-level tolerance proof).
- OpenAI-compatible gateways: **AT-RISK**, route-dependent — Fireworks 400 on nested
  `title`/`default` ([LiteLLM#27821](https://github.com/BerriAI/litellm/issues/27821),
  [#28149](https://github.com/BerriAI/litellm/issues/28149)); OpenRouter→DeepSeek 400 on `anyOf`
  shape ([oh-my-pi#1712](https://github.com/can1357/oh-my-pi/issues/1712)); vLLM misprocesses
  `$ref`/`anyOf` ([vLLM#39108](https://github.com/vllm-project/vllm/issues/39108)).
- Cursor backend: **UNVERIFIED** — no public contract or report; forum searches (2026-07-10)
  returned zero posts on unknown-keyword handling.

## Verdict matrix (final)
| Surface | Verdict | Action |
|---|---|---|
| Google AIS/Vertex/Antigravity | **CONFIRMED broken** (#85) | `google-tool-schema.ts` 블랙리스트에 `encrypted` 추가 + 회귀 테스트 |
| Kiro / Bedrock 계열 | **AT-RISK in practice** | `KIRO_REJECTED_SCHEMA_KEYS`에 `encrypted` 추가 |
| Anthropic (1P/Bedrock/Vertex) | UNVERIFIED, 방어 권장 | `normalizeAnthropicInputSchema` 또는 공용 새니타이저에서 제거 |
| OpenAI chat non-strict | SAFE (contract: additionalProperties:true) | 변경 불요 |
| OpenAI/Azure strict:true | AT-RISK | strict 경로 쓸 때만 해당; 현재 proxy는 non-strict 전달 |
| OpenAI-compat 게이트웨이 (Fireworks/OpenRouter/vLLM 등) | AT-RISK, 라우트 의존 | openai-chat 경로에도 방어적 제거 고려 |
| Cursor | UNVERIFIED | 방어적 제거 고려 (공개 계약 없음) |
| OpenAI Responses passthrough | SAFE — 마커 유지 필수 | 절대 제거 금지 (Responses-only 마커) |

## Outcome / next actions
- 공통 원칙: `encrypted`는 Responses 전용 마커 → Responses passthrough 외 모든 어댑터에서 제거해도
  기능 손실이 없다 (마커는 백엔드 암호화 힌트일 뿐 스키마 검증 의미 없음).
- 최소 수정(#85 해소): google-tool-schema.ts DROPPED_SCHEMA_KEYS에 `encrypted` 추가.
- 방어 수정(권장): kiro-tools.ts 블랙리스트에 추가, anthropic/openai-chat/cursor 경로도 동일 적용
  여부는 별도 판단 (오늘 리서치 기준 kiro가 가장 우선순위 높음).
- 테스트: tests/google-tool-schema.test.ts에 nested `encrypted` 제거 케이스,
  tests/multi-agent-compat.test.ts에 실제 v2 collaboration 스키마 fixture, Responses passthrough가
  마커를 보존하는 경계 테스트.
