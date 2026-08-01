# 090 — D 요약 (outcome: DONE)

## 무엇을 고쳤나

커밋 `f1d2b19b` (dev):

- `src/server/management-api.ts` — GET `/api/claude-code`에 `authMode` 필드 추가,
  PUT에 `authMode` 파싱/검증(proxy 저장, subscription 키 삭제, 그 외 400),
  live-apply 트리거를 `systemEnv || authMode` 변경으로 확장.
- `src/server/system-env.ts` — 재주입 시 proxy가 아니고, injectedKeys가 토큰을
  추적 중이며, launchctl 값이 정확히 `opencodex-proxy`일 때만 unsetenv + tracking
  갱신 (사용자 토큰 이중 가드로 보존).
- 테스트 6건 추가: 왕복/400 테이블/live-apply spy (claude-management-api),
  전환 unset + 값 가드 대조군 + 소유권 가드 대조군 (system-env).

## 증거

- `bun test` 코호트 6파일: 85 pass / 0 fail / 543 expects.
- `bunx tsc --noEmit` exit 0.
- 감사: sol explorer 2라운드 (R1 GO-WITH-FIXES=4 → 전부 fold, R2
  GO-WITH-FIXES=1 → fold), 최종 main 판정 near-pass, 잔여 블로커 없음.

## 사용자 반영 조건

실행 중인 프록시(:10100)는 수정 전 빌드 — GET 응답에 authMode 없음 확인.
**프록시 재시작 후** 대시보드에서 Proxy 저장 → 새로고침해도 유지된다.
systemEnv 사용자는 Subscription 복귀 시 잔류 더미 토큰이 자동 정리된다.

## LOOP-PESSIMIST-01

- 죽은 가설: "GUI 저장 로직 결함" — GUI는 처음부터 올바르게 보내고 있었다.
  서버 왕복 계약 누락이 단독 원인.
- 개선 안 된 것: `ocx claude` 직접 실행 경로는 config 재읽기 기반이라 원래
  정상 (persist만 되면 즉시 반영) — 별도 수리 불필요 확인.
- 반증 시나리오: 실사용에서 재시작 후에도 구독으로 복귀한다면 GUI가 다른
  포트의 구버전 프록시에 붙어 있는지부터 볼 것.
