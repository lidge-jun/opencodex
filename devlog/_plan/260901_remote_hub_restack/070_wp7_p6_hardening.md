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

수정: 완료 판정을 "probe 성공 쌍"이 아니라 세대 구별 증거에 건다.
어느 파일이 어느 세대인지 판별할 수 없으면 미완료로 보고 재개한다.
즉 판정이 애매하면 안전한 쪽(재개)으로 넘어져야 한다.

테스트: pendingOperation 저장 직후 크래시를 흉내낸 상태(양쪽 옛 키)에서
시작 시 로테이션이 재개되는지 확인하는 레드-퍼스트 케이스.

## 리뷰어가 예고한 최종 보안 심사 항목

#2789 코멘트가 재리뷰 시 볼 항목을 나열했다. 재스택 시 이 목록을 체크리스트로
쓴다: 로테이션 크래시 복구, 토큰 백업 소유권/정리, 일회성 시크릿 노출,
세션 무효화, pairing 레이트 리밋, 릴레이 SSRF/헤더 스트리핑, 취소.

## draft 해제

wp3와 동일 근거.

## 검증

- `git range-diff` 17커밋 보존.
- 로테이션/시크릿 관련 포커스드 테스트.
- `bun run privacy:scan`
- exact-head CI.
