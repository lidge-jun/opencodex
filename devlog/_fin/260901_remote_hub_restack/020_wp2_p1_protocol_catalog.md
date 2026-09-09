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
`#2979`는 이 스택이 설계한 `/v1/catalog`를 별도 PR로 먼저 랜딩시킨 것이다.

"dev wins"를 통째로 적용하면 안 된다(감사 A4). 두 구현은 의미가 갈린다:

| 항목 | dev (#2979) | p1 | 채택 |
| --- | --- | --- | --- |
| 메서드 | GET + HEAD | GET only | **dev** — HEAD 제거는 랜딩된 기능 회귀 |
| `x-api-key` | 허용 | 거부 | **판단 필요** — 아래 |
| 크기 캡 | 라우트 한정 256 MiB | 32 MiB | **dev** — 랜딩된 지원 크기를 줄이지 않는다 |
| 초과 시 | 507 | 503 | **dev** |
| `x-opencodex-key-id` | 없음 | 있음 | **p1** — 고유 기여 |
| 프로토콜 메타데이터 | 없음 | 있음 | **p1** — 고유 기여 |
| 캐시 헤더 | — | ETag + private,no-cache | **둘 다 아님** — D2에 따라 `no-store`, validator 제거 |

근거: dev 쪽 구현은 `src/server/index.ts:1073-1120`과
`src/server/catalog-download.ts:18-29`에 있다.

`x-api-key` 허용/거부는 의도적으로 판정한다. p1이 거부하는 것은 최소권한
의도로 보이지만, dev가 이미 허용한 상태로 랜딩됐으므로 좁히는 것은 동작 회귀다.
좁히려면 별도 근거와 함께 PR 설명에 명시하고 테스트를 함께 바꾼다. 기본은 dev 유지.

해소 후 반드시 확인할 것: `/v1/catalog`의 최소권한 admission이 p1 델타에 의해
느슨해지지 않았는가. `tests/api-catalog-route.test.ts`가 이 계약을 들고 있다.

## D2 구현 정합

010의 D2(identity-varying 응답의 ETag/304 제거)가 이 단계 코드에 걸린다.
`67e818da1 test(remote): cover phase one protocol and catalog contract` 와
`c10ef21a9 fix(remote): type catalog bytes over ArrayBuffer and scope the
key-id warn assertion` 이 해당 경로를 다룬다. 재스택 후 카탈로그 응답 헤더를
`no-store` + ETag 없음으로 맞추고 테스트를 그에 맞게 고친다.

## release-version-line

`:108`은 equality 분기다(000 참조). 리베이스로 해소되지만 자동 소멸을 가정하지
않는다 — 이 단계 head에서 `bun test tests/release-version-line.test.ts`를
명시적으로 돌려 확인한다. 테스트를 손대지 않는다.

## 미해결 스레드

T19 (#2772, P2): 확장된 readiness 응답을 `docs-site/src/content/docs/reference/cli/lifecycle.md`에
문서화. `src/server/index.ts:1013`이 대상.

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
