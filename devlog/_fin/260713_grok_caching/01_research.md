# 01 — 조사 기록 (sol 병렬 cxc-search, Tier 2 증빙)

조사일: 2026-07-13. 에이전트: Socrates(공식 의미론), Pasteur(커뮤니티 사례·프록시 비교). 두 레인 모두 원문 열람(Tier 2) 완료.

## 공식 의미론 (Socrates)

| 항목 | 결론 | 출처 (Tier 2) |
|---|---|---|
| 캐시 방식 | 자동 prefix caching, cache-write API 없음 | docs.x.ai/developers/advanced-api-usage/prompt-caching |
| usage 경로 | Chat Completions: `usage.prompt_tokens_details.cached_tokens` / Responses: `usage.input_tokens_details.cached_tokens` | .../prompt-caching/usage-and-pricing |
| 가격 (grok-4.5) | input $2.00/M vs cached $0.50/M — 미스 시 4배 | docs.x.ai/developers/pricing |
| 미스 요인 | 시스템 프롬프트 변경, 이전 메시지 편집/순서 변경, **reasoning 모델의 이전 `reasoning_content` 누락("top cause")**, `x-grok-conv-id` 상이/생략 | .../prompt-caching/multi-turn, .../best-practices, .../maximizing-cache-hits |
| conv-id 역할 | sticky-routing 힌트(같은 서버=같은 캐시). Responses API에선 `prompt_cache_key`가 동일 역할 | .../best-practices |
| CLI 프록시 캐싱 | cli-chat-proxy.grok.com에서 cached_tokens>0 실측(3자 감사, CLI 0.2.3 / 2026-05-28). 공식 보장 문서 없음 | github.com/OnlyTerp/prompt-cache-skills audits/grok-cli.md |
| 미확정 | tools 배열 변경의 miss 유발(일반론만), 최상위 user 필드의 cache key 포함 여부 | candidate — unverified |

## 사고 사례 + 프록시 비교 (Pasteur)

- **xAI 공식 장애**: "Grok Build Caching broken" (status.x.ai INC62431056, 2026-05-26, 1h44m — rollout revert로 복구). 캐싱이 서버측에서 깨진 전례.
- **대량 소모**: SuperGrok+OpenCode 사용자 "5억 토큰/3일" (reddit r/LoveGrok 2026-05-25); Hermes #27228 — OAuth가 api.x.ai로 가서 15분에 월 쿼터 7% (2026-05-17); CLIProxyAPI #4213 — 동일 세션인데 cached_tokens:0, 매 턴 쿼터 번 (2026-07-11).
- **오라우팅 증상**: 검증된 429는 `subscription:free-usage-exhausted` (CPA-Manager-Plus #334). "RPM 0/0" 문구는 candidate — unverified. LINUX DO 비교: api.x.ai 경유 시 "200회에 1/3 소진", cli-chat-proxy + CLI 헤더 전환으로 Build 쿼터 경로 복귀 (2026-07-10).
- **프록시 대응 비교** (소스 스냅샷 Tier 2):
  - CLIProxyAPI: OAuth를 cli-chat-proxy로 보내고 **세션 id를 body `prompt_cache_key` + header `x-grok-conv-id` 동시 주입**, `prompt_cache_retention`은 xAI 비호환으로 제거 (xai_executor.go L827-872, L960-1028).
  - LiteLLM: OAuth Bearer만 부착, conv-id/CLI 헤더 없음, 기본 base api.x.ai — 오라우팅+캐시 미스 패턴 그대로.
  - CCR: usage 매핑만 존재, xAI 전용 캐시 대응 없음.
- **공식 Grok CLI 0.2.93 실캡처**: `POST cli-chat-proxy.grok.com/v1/responses`, 헤더 x-grok-client-version/identifier, x-xai-token-auth, `include:["reasoning.encrypted_content"]`, store:false (omni-llm-provider CAPTURE.md, 2026-07-11).

## opencodex 반영 결정

1. PR #113 (oauth→cli-chat-proxy 분리) = LINUX DO/CLIProxyAPI와 동일 방향. dev 통합 완료.
2. `x-grok-conv-id`: `parsed.options.promptCacheKey`(Codex가 보내는 세션 안정 키)를 sha256 32-hex로 해시해 xai 양 모드에 부여. CLIProxyAPI 선례와 공식 best-practices 근거. body `prompt_cache_key`는 chat/completions 비문서 파라미터라 보류(400 리스크 > 이득).
3. `preserveReasoningContentModels`: grok 추론 모델 4종 등록 — 공식 "top cause of cache misses" 대응.
4. usage 파싱은 기존 코드가 이미 `prompt_tokens_details.cached_tokens`를 읽음 — 수정 불요 확인.
