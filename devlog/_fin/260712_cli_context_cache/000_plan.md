# 000 — CLI 컨텍스트·캐싱 네이티브 하드닝 (P, 조사 중)

브랜치: claudecode (HEAD 복귀, Desktop 3P 신규 작업은 claudedesktop 소관).
목표: goalplan `claudecode-claude-code-cli-ccr-litellm` 참조 — CLI가 라우팅 모델의
자연 컨텍스트 한도를 수동 숫자 없이 반영하고, 캐싱 친화가 CCR/LiteLLM보다 자연스럽게.

## 배경 (이전 유닛에서 확정된 사실)
- CLAUDE_CODE_MAX_CONTEXT_TOKENS: custom id 직접 적용, 인식된 claude id는 DISABLE_COMPACT=1
  병행 필요 (공식 env 문서, devlog/260711_claude_inbound/135).
- 우리 별칭은 이제 본명/날짜접미사 체계(Desktop) + claude-ocx-*(CLI 하위호환) —
  CLI 피커의 id 형태에 따라 "custom vs recognized" 분류가 갈릴 수 있음 (조사 대상).
- 현재 구현: claudeCode.maxContextTokens(수동 숫자) → MAX_CONTEXT_TOKENS+DISABLE_COMPACT 쌍
  주입 (740 유닛/733a930d). 자동(auto) 모드는 없음.
- 캐싱: metadata.user_id → prompt_cache_key+session_id(ChatGPT), system 해시 fallback,
  cursor/kiro는 estimated 표기. anthropic 라우팅의 cache_control 보존은 미점검.

## 조사 레인 (진행 중)
- Herschel(sol high): CLI 컨텍스트 회계 — count_tokens 역할, env 의미론 정밀,
  /model 전환 시 env 재해석, settings 채널, CCR claudeCodeEffectiveMaxInputTokens 의도.
- Heisenberg(sol high): 캐싱 — LiteLLM cache_control 변환, OpenAI prompt_cache_key
  공식 의미론 최신판, CLI가 cache 수치를 읽는 필드.

## 플랜 초안 (조사 후 확정)
- B1: `claudeCode.maxContextTokens`를 3상태로: `"auto"`(기본 후보) | number | 미설정.
  auto = 런처가 기본 모델 슬롯(claudeCode.model)의 authoritative contextWindow 조회 →
  MAX_CONTEXT_TOKENS 주입. DISABLE_COMPACT는 조사 결과(2번 질문)에 따라.
- B2: count_tokens 추정 정확도 — 모델별 charsPerToken 계수/토크나이저 보정.
- B3: 캐싱 검증/개선 — 조사 결과 반영 (anthropic 라우팅 cache_control은 규모 보고 스코프 판단).
- Pro 검토: 플랜 확정본을 ChatGPT Pro(웹서치 ON)에 검토 요청 후 반영.
