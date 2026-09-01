# wp2 — p1(#2772) 재스택 + 카탈로그 중복 제거

브랜치 `codex/remote-hub-p1`, head `c10ef21a9`, 5커밋 / 14파일.

## 실측 충돌

`rebase --onto trial-remote-hub-design origin/codex/remote-hub-design` 에서
`4fa130bf6 feat(remote): serve authenticated catalog snapshots` 가 3파일에서 멈춘다.

- `src/server/catalog-download.ts`
- `src/server/index.ts`
- `src/server/management/model-routes.ts`

## 원인 — 재구현이 아니라 선행 랜딩

세 파일의 dev 쪽 마지막 변경은 전부 `f6367639c feat(server): add
least-privilege GET /v1/catalog for remote Codex clients (#2979)` 이다.
#2979는 이 스택이 설계한 `/v1/catalog`를 별도 PR로 먼저 랜딩시킨 것이다.

따라서 충돌 해소 원칙은 **dev를 이긴다**이다. p1의 카탈로그 델타 중 #2979가
이미 제공하는 부분은 버리고, p1에만 있는 부분(프로토콜 메타데이터, 런타임 role,
`x-opencodex-key-id` 처리)만 얹는다. 반대로 하면 랜딩된 최소권한 계약을
되돌리게 된다.

해소 후 반드시 확인할 것: `/v1/catalog`의 최소권한 admission이 p1 델타에 의해
느슨해지지 않았는가. `tests/api-catalog-route.test.ts`가 이 계약을 들고 있다.

## D2 구현 정합

010의 D2(identity-varying 응답의 ETag/304 제거)가 이 단계 코드에 걸린다.
`67e818da1 test(remote): cover phase one protocol and catalog contract` 와
`c10ef21a9 fix(remote): type catalog bytes over ArrayBuffer and scope the
key-id warn assertion` 이 해당 경로를 다룬다. 재스택 후 카탈로그 응답 헤더를
`no-store` + ETag 없음으로 맞추고 테스트를 그에 맞게 고친다.

## release-version-line

리뷰가 지목한 `tests/release-version-line.test.ts:108` 실패는 스택
`package.json`이 `2.34.0`이고 릴리스 태그 라인이 `2.40.0`이라서 난다.
재스택하면 dev 쪽 `2.40.0`으로 해소되어 자동 소멸한다. 테스트를 손대지 않는다.

## privacy:scan

p1에서 privacy 게이트가 실패한다고 기록돼 있다. 재스택 후 실제로 재현하는지
먼저 확인한다(`bun run privacy:scan`은 전체 스위트가 아니므로 허용 범위).
재현되면 로그/직렬화 경로에서 자격증명이나 계정 식별자가 새는 지점을 찾아
**게이트가 아니라 코드**를 고친다.

## 검증

- `git range-diff` 5커밋 보존.
- `bun test tests/api-catalog-route.test.ts tests/server-auth.test.ts tests/config.test.ts`
  (변경 파일 직결 포커스드).
- `bun run privacy:scan`.
- 최종 판정은 exact-head CI.
