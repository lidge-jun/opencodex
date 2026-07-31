# 260713 — Grok/xAI 토큰 소모 사고: PR #113 통합 + 캐싱 조사·수정 플랜

세션: 019f519e-cb5e-7ee1-8a89-47cbd7d6e185 / 골플랜: grok-xai-pr113-preview-112-pr-113-github-dev-xai

## 배경

- 사용자 보고: "grok 프로바이더 캐싱이 안 되어 순식간에 6,400만 토큰이 소모"
- 이슈 #112: xAI OAuth 구독 토큰이 `api.x.ai`(API 크레딧 청구면)로 라우팅 → 429 RPM 0/0 또는 크레딧 소진
- PR #113 (shizhenwei1984-cell, 752c7dd): `authMode=oauth`일 때만 `https://cli-chat-proxy.grok.com/v1` + Grok CLI 헤더(x-grok-client-identifier/version, x-xai-token-auth)로 전환. key 모드는 `api.x.ai` 유지. 모델 디스커버리 동일 분기. 테스트 4종.

## 조사 근거 (sol Socrates, Tier 2 원문 확인 2026-07-13)

1. xAI prompt caching은 자동. usage 경로는 Chat Completions 기준 `usage.prompt_tokens_details.cached_tokens` (Responses는 `input_tokens_details.cached_tokens`). 출처: docs.x.ai/developers/advanced-api-usage/prompt-caching{,/usage-and-pricing}
2. grok-4.5 cached input은 $0.50/M vs 일반 $2.00/M — 캐시 미스면 입력 요금 4배. 출처: docs.x.ai/developers/pricing
3. 캐시 미스 요인(공식): 시스템 프롬프트 변경, 이전 메시지 편집/순서 변경, **reasoning 모델에서 이전 `reasoning_content` 누락("top cause of cache misses")**, `x-grok-conv-id` 헤더 상이/생략(sticky-routing 힌트). 출처: docs.x.ai .../prompt-caching/multi-turn, .../best-practices
4. cli-chat-proxy.grok.com도 캐싱 동작 실측 존재(3자 감사, cached_tokens=128 관측). 공식 보장 문서는 없음.

## opencodex 측 결함 확인 (코드 라인 근거)

- A. [src/providers/registry.ts](../../../src/providers/registry.ts) xai 프리셋에 `preserveReasoningContentModels` 부재 → [src/adapters/openai-chat.ts:67](../../../src/adapters/openai-chat.ts) 분기에서 grok 추론 모델의 assistant `reasoning_content`가 히스토리 재전송 시 탈락. xAI 공식 문서의 "캐시 미스 1순위 원인" 패턴에 정확히 해당.
- B. `x-grok-conv-id` 미전송 (rg 전역 0건) → 서버 라우팅이 고정되지 않아 prefix cache 히트율 저하. Codex 클라이언트는 `prompt_cache_key`를 보내고 파서가 `options.promptCacheKey`로 이미 노출([src/responses/parser.ts:520](../../../src/responses/parser.ts)) — 안정 키 재료 존재.
- C. usage 파싱은 이미 정상: [src/adapters/openai-chat.ts:163](../../../src/adapters/openai-chat.ts) `prompt_tokens_details.cached_tokens` → `cachedInputTokens`. 표시 계층 결함 아님.

## Diff-level 플랜

### WP1 — PR #113 통합
- 검증 완료: dev 위 체리픽(verify/pr113-on-dev) → typecheck PASS, 포커스 20 테스트 PASS, 전체 bun test 2379 pass/6 fail — 동일 6 fail이 순정 dev 전체 실행에서도 재현(oauth-refresh/status-privacy 테스트 간섭 플레이크, 단독 실행 시 양쪽 모두 PASS). 체리픽 무관.
- 실행: `gh pr merge 113 --repo lidge-jun/opencodex --merge` (main 대상) → **`git fetch origin main`으로 remote-tracking ref를 반드시 갱신**(감사 BLOCKER 반영: gh pr merge는 로컬 ref 갱신을 보장하지 않음) → `git checkout dev && git merge origin/main` (main은 dev 조상이므로 머지 커밋+752c7dd만 유입) → 이슈 #112 자동 닫힘 확인.

### WP2 — 캐싱 수정 (파일 단위)
1. `src/providers/registry.ts` xai 프리셋: `preserveReasoningContentModels: ["grok-4.5", "grok-4.3", "grok-4.20-multi-agent-0309", "grok-4.20-0309-reasoning"]` (noReasoningModels 제외). grok이 reasoning_content를 반환하지 않는 경우에도 thinking 파트가 없으면 no-op이라 무해.
2. `src/providers/xai-transport.ts` (PR #113 신설 파일 확장): `resolveProviderTransport`에 선택적 `promptCacheKey` 인자 추가 — providerName=xai일 때 authMode 불문 `x-grok-conv-id: sha256(promptCacheKey).hex[0:32]` 헤더 부여. 감사 MAJOR 반영: (a) **대소문자 무시 검사** — 사용자 headers에 어떤 케이스든 `x-grok-conv-id`가 이미 있으면 생성 생략(중복 헤더 결합 방지), (b) **`trim()` 후 빈 문자열이면 미부여**(모든 요청이 같은 conv-id로 수렴하는 오염 방지). 사용자 정의 헤더가 항상 우선. oauth 분기는 기존 CLI 헤더 유지.
3. `src/server/responses.ts` 호출부: `route.provider = resolveProviderTransport(route.providerName, route.provider, parsed.options.promptCacheKey)` + 감사 MAJOR 반영: **429 키 회전 경로 2곳(응답 헤더 회전, 스트림 중 회전)에서 rotated provider에 `resolveProviderTransport`를 재적용**해 conv-id/transport가 재시도에서 유실되지 않게 함.
4. 테스트: `tests/xai-transport.test.ts` 확장 — conv-id 부여/미부여(promptCacheKey 없음)/빈 문자열·공백/mixed-case 사용자 오버라이드(`X-Grok-Conv-Id`) 생성 생략/oauth+key 양 모드, reasoning_content 재전송 회귀(xai 프리셋 preserve 리스트).
5. devlog 01 조사기록, 02 검증기록.

### WP3 — 마무리
- **필수 게이트(감사 MAJOR 반영)**: 로컬 ocx 프록시(10100) 경유 xai OAuth 라이브 스모크 — 동일 conversation(prompt_cache_key 고정)으로 2회 요청, 2회차 usage에서 `cached_tokens > 0` 확인. 크레덴셜/쿼터 사유로 불가 시 정확한 실패 증적을 남기고 해당 항목만 BLOCKED 처리(코드 랜딩은 문서 근거로 유지하되 이슈에 미검증 명시).
- full gate(typecheck+test) → origin/dev 푸시 → dev→preview 머지 푸시 → CI 확인 → 이슈 #112에 요약 코멘트.

## 리스크

- reasoning_content 재전송을 xAI가 거부할 가능성: 공식 문서가 재전송을 권장하므로 낮음. 실패 시 등록만 롤백하면 됨(1줄).
- conv-id 헤더를 api.x.ai가 무시할 가능성: 무시되어도 무해(추가 헤더일 뿐).
- PR 머지 권한: repo 소유자 계정 gh 인증 사용 — 실패 시 BLOCKED 기록.
