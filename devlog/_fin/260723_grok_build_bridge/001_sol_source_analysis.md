# 001 — Sol 서브에이전트 소스 분석 fold-in (grok-build a5727c5)

Date: 2026-07-23
Source: Sol(medium) 서브에이전트 read-only 분석, 전문은 `/tmp/grok-build-a5727c5-analysis.md`
Tree: `/Users/jun/Developer/codex/180_grok-build` @ `a5727c5960452e7527a154b25cb5bf00cda0545e` (SOURCE_REV `30192d2eef5d`)

## 핵심 판정 (Sol)

1. **Responses usage details는 여전히 필수(non-Option).** pinned `async-openai` fork(`95b52ebd`)의 `ResponseUsage`가 `input_tokens_details`/`output_tokens_details`를 required struct로 정의 — `#[serde(default)]` 없음. 중첩 필드(`cached_tokens`, `reasoning_tokens`)도 required.
   - `crates/codegen/xai-grok-sampler/src/client.rs:99-129` (SSE 역직렬화, 실패 시 SamplingError)
   - `crates/codegen/xai-grok-sampler/src/stream/responses.rs:319-327, 482-488`
2. **Chat Completions 클라이언트는 관대.** chunk의 `usage`는 Optional, details도 Optional, 중첩은 zero-default (`xai-grok-sampling-types/src/types.rs:535-587`).
3. **system 메시지는 chat 백엔드에서 정상 role로 전송** (`conversation.rs:1781-1784`) — ocx chat 인바운드가 instructions로 폴딩하므로 문제 없음.
4. **카탈로그 fetch는 loopback 예외 없이 Bearer 필수** (`remote/client.rs:686-738`). 빈 키면 `No API key for custom models endpoint`. `{data:[...]}` 형태, id는 `model|modelId|id|_meta.*`, `context_window` 없으면 256k 기본.
5. **신규 config 표면**: `[model_providers.<id>]` 재사용 블록 + `[model.<id>] auth_provider`(동적 Bearer 헬퍼). 백엔드 enum은 3종 그대로(chat_completions 기본).
6. custom-models 가이드(11-custom-models.md)는 구/신 revision에서 blob 동일 — 계약 변경 없음.

## 로컬 스모크와의 교차 검증 (main agent, 2026-07-23)

`/tmp/grok-smoke-chat.err`의 raw_data가 결정적:

```
Failed to deserialize ResponseStreamEvent … missing field `input_tokens_details`
raw_data={"type":"response.completed", … "usage":{"input_tokens":0,"output_tokens":22,"total_tokens":22}}
```

- `api_backend = "chat_completions"`로 설정한 `ocx-chat`(cursor/grok-4.5)조차 **실제 와이어는 Responses 이벤트를 역직렬화하다 실패**했다. grok 0.2.101 하니스가 이 turn을 Responses 클라이언트로 태운 것 (설정과 무관하게 harness 내부 경로가 Responses vocab을 쓰는 표면 존재 — 정확한 트리거는 잔여 조사 항목).
- native `gpt-5.4-mini`가 exit 0인 이유: ChatGPT 상류가 details를 항상 포함하고 ocx가 보존 → 역직렬화 통과.
- routed가 죽는 이유: ocx `src/bridge.ts` `responsesUsage()`가 cached/reasoning 미보고 upstream에서 `*_tokens_details`를 **생략**.

### 수렴 결론

Grok 쪽 3개 백엔드/신규 표면 무엇을 쓰든, **ocx가 usage details를 상시 방출하면 전 매트릭스가 뚫린다.** Sol 권고(chat 기본 브리지)와 로컬 스모크(사실상 Responses 경로 강제)를 합치면 wp1은 두 인코더 모두 커버해야 한다:

1. `src/bridge.ts` `responsesUsage()` — `input_tokens_details.cached_tokens`(기본 0), `output_tokens_details.reasoning_tokens`(기본 0) 상시 포함. usage undefined인 기본 반환값에도 포함.
2. `src/chat/outbound.ts` `chatCompletionsUsage()` — `prompt_tokens_details`/`completion_tokens_details` 상시 포함 (grok chat 클라이언트엔 optional이지만 대칭성+향후 strict 클라이언트 대비).

## Grok-side 신규 기회 (문서화 대상, wp2)

- `[model_providers.opencodex]` 블록 하나로 base_url/backend를 공유하고 모델별 alias만 얇게 추가하는 권장 config.
- 카탈로그 연동: `GROK_MODELS_BASE_URL=http://127.0.0.1:10100/v1` + 아무 non-empty `XAI_API_KEY` (loopback ocx는 admission key 무시). ocx `/v1/models`는 이미 `{data:[{id,…}]}` 반환 — `api_backend`/`context_window` per-model 필드를 ocx가 실어주면 zero-config에 근접(선택 과제, out of scope 표기).

## 잔여

- grok 0.2.101이 `api_backend="chat_completions"` custom model에서 Responses 와이어를 태운 정확한 조건 (config 파싱? 하니스 goal-tracker 사이드카?) — wp1 검증 시 grok 디버그 로그로 재확인.
- tool-call 왕복 스모크는 wp2.
