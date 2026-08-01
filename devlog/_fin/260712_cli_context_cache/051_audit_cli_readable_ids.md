# 051 — 감사 합성: CLI 가독형 id (Schrodinger/sol, NEAR-PASS → 전건 처분)

| # | 심각도 | 지적 | 처분 |
|---|---|---|---|
| 1 | Med | 해시 폴백 충돌 시 "모델 무손실" 보장 불성립 (provider명 `native` 등) | 수용(완화) — first-wins + 동일 seen dedupe로 명문화, 플랜 보장 문구 약화. 충돌 우주는 3char 해시 기존 정책과 동일 |
| 2 | Med | management aliases와 /v1/models의 폴백 불일치 위험 | 수용 — 공용 헬퍼 `claudeCodeAlias`/`claudeCodeNativeAlias` (readable ?? desktop3p 해시, anthropic passthrough) 를 양쪽에서 사용 + null 케이스 테스트 |
| 3 | Med | 어제 저장된 해시 선택값의 픽커 표시 전환 UX | 수용(문서) — 요청 디코드는 양 계열 영구 유지(무파손), 픽커 재선택 안내를 docs+사용자 답변에 명시. 마이그레이션은 비도입(설정 파일 무단 수정 금지) |
| 4 | Med | false-green 테스트 경로 | 수용 — 쿼리>UA 우선순위 / unknown UA 기본 해시 / ids=cli URL / 폴백 헬퍼 null 케이스 / readable [1m] 변형 / readable 티어 슬롯 마킹 테스트 추가 |
| 5 | Low | UA 문자열 변경 시 조용한 해시 회귀 | 수용(기록) — 주 경로(캐시 선기록)는 ?ids=cli로 결정적. UA 정규식은 보조 |

검증 확인: 디코드([1m] 선스트립 → claude-ocx 우선 해석), count_tokens 경로, 컨텍스트 맵의
readable 키 등록/티어 마킹은 현행 코드로 이미 건전 (감사 원문 결론).
