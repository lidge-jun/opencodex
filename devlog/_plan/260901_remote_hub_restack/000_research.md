# Remote hub 스택 재스택 — 리서치

측정 시각 2026-09-01, base `origin/dev@15b0f701e`.

## 대상

7단계 스택. 베이스만 `dev`를 향하고 나머지는 직전 단계의 head 브랜치를 향한다.

| PR | 브랜치 | base | 커밋 | 파일 | draft |
|----|--------|------|------|------|-------|
| #2771 | codex/remote-hub-design | dev | 9 | 12 | no |
| #2772 | codex/remote-hub-p1 | design | 5 | 14 | no |
| #2776 | codex/remote-hub-p2 | p1 | 6 | 32 | yes |
| #2777 | codex/remote-hub-p3 | p2 | 11 | 34 | no |
| #2781 | codex/remote-hub-p4 | p3 | 8 | 48 | yes |
| #2786 | codex/remote-hub-p5 | p4 | 8 | 19 | no |
| #2789 | codex/remote-hub-p6 | p5 | 17 | 95 | yes |

전부 `Ingwannu`의 CHANGES_REQUESTED가 걸려 있다. 포크 지점은
`8b1b65b8d`이고 그 이후 `dev`는 336커밋 전진하면서 1075개 파일을 건드렸다.

## 충돌 표면 — 실측

시험 워크트리에서 `rebase --onto`를 단계별로 순차 실행해 측정했다.
design 단계는 문서 전용이라 충돌 없이 통과한다(`f17605021`). p1부터 걸린다.

| 단계 | 단계 파일 | dev와 겹치는 파일 |
|------|-----------|-------------------|
| design | 12 | 0 |
| p1 | 14 | 12 |
| p2 | 32 | 15 |
| p3 | 34 | 18 |
| p4 | 48 | 17 |
| p5 | 19 | 5 |
| p6 | 95 | 58 |

p1의 실제 충돌 3파일: `src/server/catalog-download.ts`,
`src/server/index.ts`, `src/server/management/model-routes.ts`. 세 파일 모두
`f6367639c feat(server): add least-privilege GET /v1/catalog for remote Codex
clients (#2979)`가 마지막으로 건드렸다. 이건 우연이 아니다 — #2979는 이 스택이
제안한 `/v1/catalog`를 별도 PR로 먼저 랜딩시킨 것이다. 즉 p1의 카탈로그 델타는
상당 부분 이미 dev에 있다. 재스택할 때 재구현이 아니라 **중복 제거**가 필요하다.

## 반복 후보 충돌원

`dev`가 포크 이후 스택 파일에 남긴 관련 랜딩:

- `f6367639c` (#2979) — `/v1/catalog` 최소권한 라우트. p1 카탈로그 델타와 직접 중복.
- `f83368dfd` (#3057) — entitlement 삼상태. `src/server/index.ts` 공유.
- `c3da277bc` (#2891) — entitlement roster 클라이언트 버전. `model-routes.ts` 공유.
- i18n 9개 로케일 파일 — p4/p6가 전부 건드리고 dev도 계속 건드린다. 텍스트 추가 충돌이라
  기계적이지만 건수가 많다.

## 블로커 재분류

리뷰 7건을 원인별로 다시 묶으면 세 종류뿐이다.

**(1) stale 아티팩트 — 재스택이 곧 해소**

`tests/release-version-line.test.ts:108` 실패가 #2772/#2777/#2786에 공통으로
걸려 있다. 원인은 확인됐다: 스택의 `package.json`이 `2.34.0`인데 현재 릴리스
태그 라인은 `2.40.0`이다. 테스트는 "트리 버전이 최고 릴리스 태그보다 뒤면
거절"을 주장한다. 스택이 오래된 것이 원인이고, 테스트는 정확히 설계대로
동작했다. 재스택하면 `package.json`이 dev 쪽으로 해소되어 사라진다.
**게이트를 건드리면 안 된다.**

**(2) 구조적 보류 — 재스택 + draft 해제로 해소**

#2776/#2781/#2789는 "중간 스택 head라 최종 승인 불가"라는 보류다. 리뷰어는
"stacked child가 부모 head를 타깃하는 것"을 정책 위반으로 읽었지만, 현행
`AGENTS.md`는 열린 PR의 head를 타깃하는 stacked child를 의도된 리뷰
워크플로로 명시하고 `enforce-target`의 wrong-base 게이트를 면제한다.
따라서 이건 정책 위반이 아니라 **리뷰 순서 문제**다. 해소 경로는 재스택 후
draft 해제 + exact-head CI 그린 + 스택 체인 정합 확인이다.

**(3) 실질 결함 — 코드/문서 수정 필요**

- #2771 문서 계약 4건 (아래 010).
- #2777 `gui/tests/api-auth-memory.test.ts:23`.
- #2786 `tests/cli-headless-parity.test.ts:287` 미선언 `/api/machine/*` 7개,
  `tests/update-stop-first.test.ts:225`, `tests/loopback-listener-admission.test.ts:196`,
  privacy 게이트.

(3)만 실제 작업이다. (1)은 재스택의 부산물이고 (2)는 절차다.

## 제약

- 푸시는 `--no-verify` (사용자 지시). `prepush`가 전체 스위트를 부르므로 로컬에서
  돌 수 없다.
- 로컬 전체 스위트 금지. 판정은 exact-head CI.
- 머지 금지. "머지 가능한 상태까지"가 종료선이다.
- `dev`/`main`/`preview` 직접 푸시 금지.
