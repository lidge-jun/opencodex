# 020 — opencode zen/go를 커넥터로 붙이는 다른 프록시 교차 조사

조사일 2026-09-11. 판정 기준: 해당 저장소 **소스/설정**에 `opencode.ai/zen` 또는 `zen/go/v1`이 실제로 있는지. README 스니펫만 있으면 unverified.

## 지원 인벤토리

| 프로젝트 | zen go 지원 근거 | 비고 |
| --- | --- | --- |
| musistudio/claude-code-router | `packages/core/src/agents/local-providers/opencode.ts`, 테스트가 `https://opencode.ai/zen/go/v1` 고정 | 세션 헤더 주입 구현 있음 |
| Kiowx/opencode-cc | `OPENCODE_CC_UPSTREAM=https://opencode.ai/zen/go` | reasoning 캐시·thinking 정규화 구현 있음 |
| kartikkabadi/opencode-go-proxy | `src/opencode_go_proxy/upstream.py` | 세션 헤더 미구현 |
| tbosancheros39/opencode-thinking-fix | `proxy/proxy.js`, `proxy/core.js` | 라우트별 reasoning 키 분기 |
| NousResearch/hermes-agent | `plugins/model-providers/opencode-zen/__init__.py` | thinking XOR effort 처리 |
| cline/cline | `sdk/packages/llms/src/providers/providers.generated.ts` | 클라이언트 카탈로그 |
| chatboxai/chatbox | `src/shared/providers/definitions/opencode-go.ts` | 모델별 엔드포인트 분기 |
| openclaw/openclaw | first-class `opencode-go` | 카탈로그 드리프트 이슈 다수 |
| sst/opencode (anomalyco/opencode) | 게이트웨이 본체 | 업스트림 결함의 출처 |

**미지원으로 확인된 것** (`gh search code "opencode.ai/zen"` 빈 결과): router-for-me/CLIProxyAPI, BerriAI/litellm, songquanpeng/one-api, QuantumNous/new-api, oai2ollama. LiteLLM은 사용자 yaml에 `api_base: https://opencode.ai/zen/go/v1` + `drop_params: true`로 붙이는 방식이고 first-class 어댑터가 아니다.

## 증상별 교차표 (opencodex 관점)

| 증상 | 다른 프록시의 대응 | opencodex 현황 |
| --- | --- | --- |
| `MissingSessionID` 400 | CCR `upstream-header-sanitizer.ts:202-206`이 공식 Go 호스트에만 주입 | 이미 구현 (`src/providers/opencode-go-transport.ts`) |
| tool-call 이어가기 reasoning 재생 | opencode-cc v1.2.5 `4ac61aa` | 이미 구현 (`preserveReasoningContentModels` + `src/responses/reasoning-replay-cache.ts`) |
| compaction이 thinking을 버린 뒤 tool_use id로 회수 | opencode-cc v1.3.0 `internal/proxy/reasoning_cache.go` | 유사 캐시 존재. Chat 경로 커버리지는 **검증 필요** |
| Kimi/Go에서 `thinking`과 `reasoning_effort` 동시 전송 시 "cannot specify both" | hermes `__init__.py:45-55`가 XOR 강제 | `src/adapters/openai-chat.ts:1500-1565`가 if-else로 하나만 선택 → **현재 구조상 동시 전송 없음** |
| GLM `thinking.type=adaptive` + tools 400 | opencode-cc `b52b661`이 adaptive→auto | opencodex의 adaptive는 Anthropic 계열 전용. Go GLM chat 경로엔 해당 enum 미사용 |
| glm-5.2가 `reasoning` 거부, `reasoning_content`만 수용 | thinking-fix 3.3.0 라우트별 키 | `reasoningWireFormat` 분기 존재. Go glm 계열 실제 수용 필드는 **unverified** |
| 429 / Retry-After 없음 | ogp 백오프 재시도 | 이미 구현 (`src/providers/opencode-zen-rate-limit.ts`) |
| 모델 id 드리프트 | sst/opencode `ba72a6f` 문서 id 교체, ogp가 2회 거절 시 카탈로그에서 숨김 | **갭**. 030 참조 |
| `response_format` structured output 400 | 이 조사에서 외부 이슈 URL 미검출 | opencodex는 #1338/#1415 근거 보유 |

## 결론

외부 프록시가 이미 해결했고 opencodex에 없는 항목은, 재확인 결과 대부분 **이미 랜딩되어 있거나 우리 코드 구조상 발생하지 않는다.** 실제로 남는 교차 갭은 **모델 id 드리프트 대응** 하나이며, 이는 030의 정확-id 표 문제와 같은 뿌리다.
