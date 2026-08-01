# 132 — 조사: Cursor usage/캐시 보고 (Einstein, sol high + cxc-search)

전부 Tier 2 원문 검증 (jthweny/Cursor_Deobfuscation 추출 스키마 + 공식 Admin API 문서).

## 확정 사실
- `StreamUnifiedChatWithTools` 스트림에는 **완전한 usage 프레임이 없다**.
  존재하는 것: `StreamUnifiedChatResponse.usage_uuid`(field 27, 사후 조회 키),
  `context_window_status`(field 30, `ContextWindowStatus.tokens_used` = 활성 컨텍스트 크기),
  `debugging_only_token_count`(field 3, 의미 미보장).
- 우리 어댑터가 checkpoint로 읽는 값 = `ContextWindowStatus.tokens_used` — per-turn 합계가
  아니라 **활성 컨텍스트 점유량**. 현행 `in = context - out` 추정은 그 한계 안에서 타당.
- 사후 조회: `DashboardService/GetTokenUsage(usage_uuid)` → input/output만 (캐시 없음).
  캐시(read/write)는 usage-event 조회(`GetFilteredUsageEvents`/`GetAggregatedUsageEvents`,
  공식 Team Admin API)에만 존재하고 usage_uuid로 join할 수단이 공개 스키마엔 없다.
- 타 프록시들도 동일 한계: wisdgod/cursor-api는 usage variant 주석 처리, auth2api는 0 표기.

## 이 사이클에서의 결론
- 스트림만으로 캐시 수치는 **원리적으로 불가** → "캐시 미보고(프로바이더 미제공)" 명시 표기가 정직한 처리.
- per-turn input의 신뢰 가능한 소스도 없음 → estimated 마킹 + 요청측 추정(estimateTokens) 보정이 정공.
- (선택, 차기 유닛) `usage_uuid` 파싱 + GetTokenUsage 사후 조회로 in/out 정밀화 가능성 —
  인증/타이밍 미확정이라 이번 스코프 OUT.
