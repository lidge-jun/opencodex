# wp2 결과 — p1(#2772) 재스택 + 카탈로그 계약 재조정

브랜치 `codex/remote-hub-p1`: `c10ef21a9` → `07d7f1006`.
베이스는 재스택된 `codex/remote-hub-design@36992baa9`.

## 충돌과 해소

예측대로 `4fa130bf6`에서 3파일이 충돌했고, 이후 두 커밋에서도 테스트 파일이
걸렸다. 원인은 020이 적은 그대로다: #2979(`f6367639c`)가 이 단계가 설계한
`/v1/catalog`를 먼저 랜딩시켰다.

**다만 020의 "p1 고유 기여" 판정은 절반이 틀렸다.** 초기 조사에서 dev의
`src/server/index.ts`에 `withRemoteCatalogKeyId`와 프로토콜 메타데이터가
보이길래 "dev가 이미 갖고 있다"고 적었는데, 그건 이전 리베이스 시도가 남긴
작업 트리 잔재였다. `git show origin/dev:src/server/index.ts`로 확인하니
dev에는 그 헬퍼가 **아예 없었다**. p1의 key-id 에코는 실재하는 고유 기여였고,
그걸 버렸다면 다중 키 운영자의 카탈로그 읽기 귀속이 사라졌을 것이다.

교훈: 작업 트리의 grep은 브랜치의 내용이 아니다. 리베이스 중에는
`git show <ref>:<path>`로 확인해야 한다.

## 최종 병합 결정

| 항목 | dev(#2979) | p1 | 채택 | 근거 |
| --- | --- | --- | --- | --- |
| 메서드 | GET+HEAD | GET only | dev | 랜딩된 기능 회귀 금지 |
| 크기 캡 | 256 MiB / 507 | 32 MiB / 503 | dev | 2000모델≈92MB, 32MiB는 유효 입력 거부 |
| malformed | 404 | 500 | dev | "파일 손상"과 "카탈로그 없음"을 구별시키지 않음 |
| `x-api-key` | 허용 | 거부 | dev | 상류로 자격증명 전달 없음 → 추가 권한 없음. 거부하면 유효한 Anthropic-SDK 클라이언트가 401 |
| `x-opencodex-key-id` | 없음(죽은 코드) | 있음 | **p1** | 실재하는 고유 기여, 라우트에 배선 |
| 캐시 헤더 | private,no-cache + ETag | ETag + no-cache | **둘 다 아님** | D2: `no-store`, validator 없음 |

`AUTH_MATRIX`에 `/v1/catalog` 행이 둘 생겼고 `xApiKey`가 정반대였다.
행렬이 자기모순이라 라이브 서버 검증이 어느 행을 먼저 읽느냐로 갈렸다.
p1 행을 제거했다.

## 테스트 조정

p1이 자기 구현에 맞춰 쓴 단언들을 dev+D2 계약으로 다시 썼다. 지운 게 아니라
뒤집었고, 각각 왜 반대가 됐는지 주석으로 남겼다.

- `api-catalog-route`: malformed→404, `no-store`/ETag 없음, HEAD 동일,
  조건부 요청이 200을 받는다(관리 라우트 ETag를 흉내내도).
- `server-auth`: 304 테스트를 "어떤 조건부 요청도 304를 끌어낼 수 없다"로 반전.
  사라진 `catalogDataPlaneResponse` API를 쓰던 캡 테스트는 제거(dev의
  `api-catalog-route`가 같은 경계를 이미 커버한다). ETag 스펠링을 dev의 hex로.
- `api-key-attribution`: dev 쪽 주석 있는 버전 채택.

## 검증

- `bun run typecheck` 통과.
- 포커스드 7파일 **412 pass / 0 fail**
  (server-auth, api-catalog-route, api-key-attribution, config,
  proxy-liveness, release-version-line, server-live).
- `bun run privacy:scan` 통과 — 리뷰가 보고한 privacy 실패는 상속된
  staleness였고 재스택으로 소멸했다.
- `release-version-line` 통과 — 020의 예측대로 `package.json`이 dev의
  2.40.0으로 해소됐다.
- 부수 확인: `server-auth`의 websocket refresh flake도 함께 사라졌다.

## 남은 것

T19(확장된 readiness 응답을 `docs-site/.../cli/lifecycle.md`에 문서화)는
아직 열려 있다. wp8에서 처리한다.

## 커밋

| 커밋 | 내용 |
| --- | --- |
| `733d0e62b` | feat(remote): add protocol metadata and runtime role (원본 보존) |
| `f65484844` | feat(remote): serve authenticated catalog snapshots (원본 보존) |
| `b24a15a22` | fix(remote): derive management origin from request host (원본 보존) |
| `0d81baffa` | test(remote): cover phase one protocol and catalog contract (원본 보존) |
| `58ab13df0` | fix(remote): type catalog bytes over ArrayBuffer (원본 보존) |
| `07d7f1006` | fix(remote): reconcile the phase-one catalog contract with the landed /v1/catalog (신규) |

원본 5커밋은 authorship과 메시지가 보존됐다. 충돌 해소로 내용이 바뀐 부분은
커밋을 다시 쓰지 않고 마지막에 조정 커밋 하나로 모았다 — 원저자의 커밋을
내가 편집한 것처럼 보이게 만들지 않기 위해서다.
