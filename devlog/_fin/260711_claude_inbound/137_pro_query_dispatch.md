# 137 — ChatGPT Pro 백그라운드 질의 기록

- 시각: 2026-07-12 02:11 KST, in-app 브라우저(사용자 로그인 세션)로 chatgpt.com에서 전송.
- 모델: Pro (컴포저 피커 확인). 대화 URL: https://chatgpt.com/c/6a527685-3578-83ee-a82d-8a7a7e886e91
- 상태: 전송 직후 리서치 모드 진입 확인 ("Searched Claude documentation, GitHub, ...",
  "Searched and fetched files and tests from CCR repository"). 예상 소요 50-60분 — 백그라운드 대기.

## 질의 요지 (135/136의 검증 사실을 전제로 첨부)
1. Desktop이 게이트웨이 모델의 컨텍스트 윈도우를 무엇으로 결정하는가 — supports1m이 200k
   accounting을 실제로 올리는가, 1M variant 선택 시 wire에 [1m]인가 beta 헤더인가,
   Desktop 프로세스가 CLAUDE_CODE_MAX_CONTEXT_TOKENS / ALWAYS_ENABLE_EFFORT 류 env를 읽는가.
2. Desktop effort selector의 게이트 — opus 4.8로 매칭된 별칭에 전체 사다리(low..max)를 열 수
   있는가, 선택값이 게이트웨이로 output_config.effort로 실제 직렬화되는가.
3. modelDiscoveryEnabled:true + 정적 inferenceModels 병기(CCR 패턴) 시 병합 규칙.
4. 프록시 저자 관점 최종 권고 (config/광고/헤더/id 형태; statsig·localStorage 플래그 포함).

## 수신 후 처리
- 답변을 이 유닛 138로 기록하고, B7 게이트 판정 + 136 플랜 수정 후 A 재감사 → B.
