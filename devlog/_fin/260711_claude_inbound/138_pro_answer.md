# 138 — ChatGPT Pro 답변 (수신 2026-07-12 02:5x, 대화 6a527685-3578-83ee-a82d-8a7a7e886e91)

## 판정 요지 (구현에 직접 반영)
1. **정적 목록이 discovery를 덮는다 — 병합 없음.** inferenceModels가 있으면 피커는 정확히
   그 목록. CCR의 병기(discovery:true+목록)는 버전 방어일 뿐. 결정적 배포는
   `modelDiscoveryEnabled:false + inferenceModels`. → hybrid 기본값 폐기, **static이 기본**.
2. **컨텍스트**: supports1m은 bare 행을 1M로 만드는 게 아니라 **별도 1M 행(variant)을 추가**.
   사용자가 그 행을 선택해야 accounting이 1M. 선택 시 wire는 bare id +
   `anthropic-beta: context-1m-2025-08-07` (internal 표기 `id[1m]`은 클라이언트가 벗김).
   프록시 의무: [1m] 잔류 방어적 스트립, anthropic-beta 원본 보존/기록.
   알려진 Desktop 결함 2종: 1M 행 미생성 리그레션, 선택 미영속(__model_selector_state가
   suffix를 정규화) — 프록시로 못 고침.
3. **effort**: 3P 스키마에 effort 필드 없음 — 내장 코어의 id 인식이 게이트. opus-4-8 형태
   별칭이면 전체 사다리(low..max) 가능. **high는 기본값이라 필드 생략과 동일** — 우리 로그의
   'high 부재'는 정상. 검증은 low/max로. 선택 시 `thinking:{type:adaptive}` +
   `output_config:{effort}` + effort beta 헤더로 직렬화 기대.
4. **env 레버**: CLI는 공식 지원(MAX_CONTEXT_TOKENS + DISABLE_COMPACT 쌍, ALWAYS_ENABLE_EFFORT,
   EFFORT_LEVEL). **Desktop은 비보장** — env 큐레이션으로 임베디드 에이전트에 전달 안 될 수
   있음(Cowork 특히). launchctl setenv + 앱 재시작은 진단용.
5. 권고 프로필: static 목록 + discovery:false + opus-4-8 형태 bare 별칭 + supports1m:true +
   anthropicFamilyTier:opus + isFamilyDefault. /v1/models는 같은 bare id 반환(추가 필드는
   Desktop이 무시하나 무해). anthropic-beta/thinking/output_config는 allowlist 없이 보존.
6. 검증 매트릭스: Desktop에서 low/max 선택 → output_config.effort 도달 확인(B1 캡처),
   1M 행 선택 → beta 헤더 + /context≈1M, 새 세션 영속성 확인(미영속이면 알려진 결함).

## 우리 구현 보정 (사이클 2 B 진행 중 반영)
- 기본 모드 hybrid → **static**. hybrid는 옵션(--hybrid)으로 존치(CCR 방어 패턴).
- resolveInboundModel: 앞단에서 trailing `[1m]` 스트립 (방어).
- B1 캡처 링에 `anthropic-beta` 헤더 기록 추가 (1M/effort beta 실측용).
- B6 env 레버는 유지하되 문서/GUI 문구에 "Desktop은 보장 안 됨(CLI용)" 명시.
