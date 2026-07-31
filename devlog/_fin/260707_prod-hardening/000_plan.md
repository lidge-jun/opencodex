# 프로덕션 하드닝 (260707) — dev-B 머지 준비

Goal: dev-B(=dev)를 CI 전체 그린 + 감사 통과 상태로. Session 019f34f2-3c06-7250-a2ee-dd3707f8130d.

## WP1 — CI 복구 (DONE)

실패 3원인 → 커밋 4개, push c134c4f 후 CI 전부 success 확인 (Cross-platform CI, Service lifecycle × dev/dev-B):
- 0e7a584 워크플로 구경로(src/cli.ts ×13, bun-runtime ×2) — 재구조화 때 .github/ 누락분
- f76066d privacy scan 픽스처(@x.io→example.com, sk- 접두 제거)
- 77a91ec Windows history sync 타임아웃: RCA(Singer/gpt-5.5) = openStateDb PRAGMA busy_timeout 5000 == bun 5s 테스트 타임아웃. setHistoryDbBusyTimeoutForTests(250) 노브. guardian 무관 확인.
- c134c4f key-failover 정식 커밋(+7 유닛 테스트, 관리 API 쿨다운 클리어)

## WP2 — 하드닝 감사 (gpt-5.5 × 2 병렬)

Socrates(보안) + Noether(견고성) 감사: **P0 없음.** P1 수정 반영:
- [S-P1] responses-state.json 디렉토리 재하드닝: persistNow가 기존 디렉토리에 chmod 0o700 (mkdir mode는 생성시에만 적용)
- [S-P1] 업스트림 에러 바디 시크릿 스크럽: formatErrorResponse 전에 redactSecretString
- [N-P1] 429 페일오버 재시도 전 실패 응답 body.cancel() (소켓 누수 방지)
- [N-P1] web-search 사이드카 스트림 trackStreamLifetime 등록 (drainAndShutdown이 대기/중단 가능)
- [N-P1] service stop/uninstall + /api/stop이 restoreNativeCodex() 결과를 검사 — 실패 시 성공 위장 대신 ocx restore 안내
- [S-P2] key-failover 로그에서 사용자 라벨 제거(id만)
- [N-P2] flushResponseState가 schedule 시점 캡처 경로 사용(OPENCODEX_HOME 스왑 안전)

### 수용된 리스크 (수정 안 함)
- Windows 네이티브 패스스루가 raw body 유지(클라이언트 disconnect 시 JS cancel 훅 없음): Bun#32111 JS-sink 세그폴트 회피용 의도적 설계. Bun 픽스 후 재평가.
- compact 빈 요약 시 "(no summary available)" 손실성 성공: codex-rs는 compact 실패에 세션 하드페일이므로 fail-open이 사용자 보호에 유리. 의도적.

### 감사 무발견 확인 항목
auth.json/config/usage.jsonl 퍼미션, apiKeyPool 마스킹 전 표면(safeConfigDTO 미직렬화, /api/providers hasApiKey만, keys API 마스킹, CLI 마스킹), 관리 API 인증 게이트(신규 oauth/keys 엔드포인트 포함), DNS 리바인딩 기본 방어, /v1/responses/compact 게이트 동등성, 429 루프 종료 보장, 라우트 순서.

## WP3 — 검증

- 로컬: 1587 pass / 0 fail, tsc 0 (P1 수정 후 재확인)
- CI: push 후 전 워크플로 success 확인 필요
