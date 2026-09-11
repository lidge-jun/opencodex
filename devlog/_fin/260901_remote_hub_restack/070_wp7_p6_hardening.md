# wp7 — p6(#2789) 재스택 + D4 로테이션 크래시 복구

브랜치 `codex/remote-hub-p6`, head `207254fe0`, 17커밋 / 95파일, draft.
dev와 겹치는 파일 58개 — 스택 전체에서 가장 크다.

## 겹침

`src/cli/{access,index,registry}.ts`, `src/config.ts`,
`src/lib/service-secrets.ts`, `src/server/auth-cors.ts`,
`src/server/index.ts`, `src/server/management-api.ts`,
`src/server/management/{context,oauth-account-routes}.ts`,
`src/types/config.ts`, i18n 9개, docs-site 7로케일 다수.

docs-site 겹침이 큰 덩어리인데 대부분 로케일 문서라 기계적이다.
실제 판단이 필요한 건 `management-api.ts`, `management/context.ts`,
`oauth-account-routes.ts` — dev가 이번 트레인에서 계속 건드린 곳이다.

## D4 — 크래시 복구 판정 수정

010의 D4가 여기서 코드가 된다. 관련 커밋:

- `a83073115 feat(hardening): recover client key rotation through token backup`
- `cc620f7b7 fix(hardening): gate startup on rotation recovery state`

현재: current와 backup 둘 다 probe 성공이면 로테이션 완료로 본다.
문제: `pendingOperation` 저장 직후 크래시 시 두 파일 모두 옛 키를 담고
둘 다 probe에 성공한다 → 로테이션이 조용히 유실된다.

수정(감사 A7): 010 D5 계약을 그대로 구현한다.

1. probe 이전에 두 후보의 identity를 비교한다.
2. 동일하면 교체 이전 상태다 — commit하지 않는다.
3. abort/restore는 확인된 권위가 있을 때만.
4. abort가 불확실하게 실패하면 증거를 보존한다.

레드-퍼스트 회귀 3종: 동일-구세대 후보, abort 실패, 진행 중 백업을 지우는
동시 status 실행.

## 이 단계가 소유하는 스레드

### T31 (P1) — abort 실패 시 토큰 identity 보존

`src/client/connect.ts:304`. 새 토큰 설치 후 abort 요청이 일시적으로 실패하면
현재 코드가 잘못된 세대를 복원한다. D4 계약의 3/4항이 바로 이 사안이다.

### T32 (P2) — status가 진행 중 백업을 삭제

`src/client/state.ts:95`. `rotateConnectedClientKey`가 `/api/keys/rotate`를
기다리는 동안 `ocx connect status`가 돌면 in-flight 백업이 지워진다.

### T33 (P2) — 릴레이 오류를 과대 응답 노출 전에 반환

`src/client/hub-relay.ts:282`. `Content-Length` 없는 chunked 업스트림 응답 처리.

### D5 적대적 커버리지

wp5가 구현한 릴레이 no-store / validator 제거에 대해 이 단계에서 적대적
테스트를 추가한다.

## 리뷰어가 예고한 최종 보안 심사 항목

`#2789` 코멘트가 재리뷰 시 볼 항목을 나열했다. 재스택 시 이 목록을 체크리스트로
쓴다: 로테이션 크래시 복구, 토큰 백업 소유권/정리, 일회성 시크릿 노출,
세션 무효화, pairing 레이트 리밋, 릴레이 SSRF/헤더 스트리핑, 취소.

## draft 해제

wp3와 동일 근거.

## 검증

- `git range-diff` 17커밋 보존.
- 로테이션/시크릿 관련 포커스드 테스트.
- `bun run privacy:scan`
- exact-head CI.
