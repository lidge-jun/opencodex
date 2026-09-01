# Remote hub 스택 재스택 — 리서치

측정 시각 2026-09-01, base `origin/dev@15b0f701e`.

## 대상

7단계 스택. 베이스만 `dev`를 향하고 나머지는 직전 단계의 head 브랜치를 향한다.

| PR | 브랜치 | base | 커밋 | 파일 | draft |
| --- | --- | --- | --- | --- | --- |
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
| --- | --- | --- |
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

### (1) stale 아티팩트 — 재스택이 곧 해소

`tests/release-version-line.test.ts:108` 실패가 #2772/#2777/#2786에 공통으로
걸려 있다. 정확히 말하면 `:108`은 "뒤처짐" 분기가 아니라 **동일(equality)**
분기다(`:99-108`): 트리 버전이 최고 릴리스 태그와 같은데 이 커밋이 그 태그가
가리키는 커밋이 아니면 거절한다. 스택의 `package.json`은 `2.34.0`이고 당시
최고 태그가 `v2.34.0`이었다.

현재 `origin/dev`는 `2.40.0`, 최고 태그는 `v2.39.0`이므로 지금 리베이스하면
해소된다. p1은 `package.json`을 수정하지 않으므로 dev 값이 그대로 온다.
**다만 자동 소멸을 가정하지 않는다** — `v2.40.0`이 dev 전진보다 먼저 태깅되면
재발한다. 리베이스된 head마다 `bun test tests/release-version-line.test.ts`를
포커스드로 돌려 확인한다. **게이트는 건드리지 않는다.**

### (2) 구조적 보류 — 자동화는 통과, 사람 리뷰는 별개

`#2776`/#2781/#2789는 "중간 스택 head라 최종 승인 불가"라는 보류다.
`AGENTS.md:278-281`과 `.github/workflows/enforce-pr-target.yml:533-557`은
열린 부모 head를 타깃하는 stacked child에 대해 wrong-base 게이트를 실제로
면제한다. 저자가 `lidge-jun`(push 권한)이라 기여자 readiness 체크리스트
(`enforce-pr-target.yml:740-746`)도 적용되지 않는다.

**그러나 이건 자동화 게이트만 통과시킨다.** 리뷰어의 CHANGES_REQUESTED는
draft 해제로도 CI 그린으로도 해제되지 않는다. `MAINTAINERS.md:57-61`은
비저자 메인테이너 승인과 보안 리뷰를 요구하고, Ingwannu가 유일한 비저자
메인테이너다. 우리가 도달할 수 있는 종료선은 **재리뷰 요청 가능 상태**이며,
승인 자체는 외부 의존이다.

### (3) 실질 결함 — 코드/문서 수정 필요

- #2771 문서 계약 4건 (아래 010).
- `gui/tests/api-auth-memory.test.ts:23` — #2777에 보고됐지만 **소유 단계는 p2**다.
- `tests/cli-headless-parity.test.ts:287` 미선언 `/api/machine/*` 7개 —
  #2786에 보고됐지만 **소유 단계는 p4**다.
- `tests/update-stop-first.test.ts:225`, `tests/loopback-listener-admission.test.ts:196`,
  privacy 게이트 — p5.
- 미해결 인라인 리뷰 스레드 **33건**(P1 6건 포함). 전수는 `003` 원장 참조.

### 소유 단계 실측

"어느 PR에서 실패가 보고됐는가"와 "어느 단계가 그 결함을 도입했는가"는 다르다.
diff로 측정했다:

- `/api/machine/` 추가 라인: p1~p3 = 0, **p4 = 49**, p5 = 0, p6 = 2.
  라우트를 도입한 건 p4다.
- `gui/tests/api-auth-memory.test.ts`를 건드리는 단계: **p2**와 p4. p3은 0.

상류에서 고쳐야 한다. 하류에서 고치면 그 사이 단계들은 자기 head에서 빨간 채로
남고, 그 위에 다음 단계를 쌓게 된다.

**단계 초록 불변식:** 각 단계는 자기 head에서 초록이어야 다음 단계를 그 위에 쌓는다.

(3)만 실제 작업이다. (1)은 재스택의 부산물이고 (2)는 절차 + 외부 의존이다.

## 제약

- 푸시는 `--no-verify` (사용자 지시). `prepush`가 전체 스위트를 부르므로 로컬에서
  돌 수 없다.
- 로컬 전체 스위트 금지. 판정은 exact-head CI.
- 머지 금지. "머지 가능한 상태까지"가 종료선이다.
- `dev`/`main`/`preview` 직접 푸시 금지.
