# 001 — 조사 확정: CLI 컨텍스트 회계 (2.1.207 바이너리 디컴파일 + 구소스 대조)

## 컨텍스트 윈도우 결정 (2.1.207 실물, strings 추출 — 최고 신뢰)
`sw(model, betas)` (구소스 getContextWindowForModel 대응):
1. `DISABLE_COMPACT && CLAUDE_CODE_MAX_CONTEXT_TOKENS` → 그 값 (모든 모델, 컴팩션 사망).
2. `/\[1m\]/i.test(model)` → **1,000,000 무조건** (CLAUDE_CODE_DISABLE_1M_CONTEXT로만 끔).
3. betas에 context-1m 헤더 + 알려진 1M 모델 → 1M.
4. 내장 capability 테이블 native_1m 모델 → 1M.
5. kelp_forest_sonnet statsig (sonnet-4-6 전용) — 무관.
6. `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 단독 → **canonical id가 "claude-"로 시작하지 않을 때만** 적용.
   우리 별칭(claude-ocx-*, claude-opus-4-8-*)은 전부 claude- 시작 → **무시됨. 200k 고정의 직접 원인.**
7. 기본 200k.

## 죽은 경로 (헛수고 방지)
- model-capabilities.json 캐시: 구소스에선 `USER_TYPE==='ant'`+firstParty 게이트,
  **2.1.207에선 eligibility 함수가 `return !1`(하드코딩 false)** — 공개 빌드에서 완전 사장.
  /v1/models max_input_tokens 광고로 CLI 컨텍스트를 움직일 수 없다 (Desktop과 동일 결론).

## 설계 귀결 (P 확정 방향)
- **1M 라우팅 모델 = `[1m]` 픽커 변형이 정답**: anthropic-flavor /v1/models에
  contextWindow>=1M 모델의 `<id>[1m]` 항목 추가(id는 claude- 접두 유지, 규칙 만족).
  CLI가 [1m]을 보면 회계 1M — env 불필요, 컴팩션 보존, 모델별 정확.
  인바운드 [1m] 스트립은 이미 구현(738 유닛). CLI 기본 슬롯(claudeCode.model)도
  1M 모델이면 [1m] 자동 부여 옵션.
- 비-1M 커스텀 창(272k 등): env 경로가 claude- 접두에 막혀 모델별 불가 — 200k 기본이
  안전 하한이므로 유지, 100k 미만 모델(spark)만 문서 경고. (env+DISABLE_COMPACT는
  수동 옵트인으로 기존 유지.)

## 캐싱 (Heisenberg 레인, Tier2)
- LiteLLM/CCR 모두 비-Anthropic 백엔드로 cache_control을 사실상 버림(치환 없음) —
  우리의 prompt_cache_key/session_id 전략은 이미 그들보다 앞서 있음.
- OpenAI 공식: prompt_cache_key는 라우팅 어피니티(정확 prefix 매칭은 별도), 키당 ~15 RPM,
  1024 토큰 문턱. GPT-5.6+: `prompt_cache_breakpoint {mode:explicit}`(요청당 write 4개),
  `prompt_cache_options.ttl="30m"`, 구모델 `prompt_cache_retention="24h"`.
- P0 개선: 캐시 코호트 키를 system 단독이 아닌 tenant+model+effort+system+tools 해시로;
  user 식별은 safety_identifier로 분리. P1: Anthropic cache_control breakpoint를
  GPT-5.6+ prompt_cache_breakpoint로 변환(기능 게이트). ChatGPT 비공식 backend의
  session_id 전략은 별도 정책으로 분리 유지.
- CLI 표시 규약 확인: context = input+cache_read+cache_creation (exclusive input).
  우리 outbound anthropicUsage는 이미 exclusive 변환 — 규약 일치 확인됨.

## 미해결 (Herschel 대기 + 캡처 과제)
- 토큰 3-4배 인플레이션(스킬 로드 시): outbound 규약은 정상 → 원인 후보는 전사 재전송의
  실측인지, 번역 중복(system/tool 중복 직렬화)인지 — 연속 턴 캡처 diff로 판정 필요.
- 서브에이전트 모델 오버라이드(fable/opus/sonnet/haiku 4별칭+부모상속): 별칭이 어떤 실제
  id로 해석되어 프록시에 도달하는지(ANTHROPIC_DEFAULT_*_MODEL 슬롯 매핑 가능성) — Herschel 질의 범위.
- count_tokens의 회계 역할 (Herschel).
