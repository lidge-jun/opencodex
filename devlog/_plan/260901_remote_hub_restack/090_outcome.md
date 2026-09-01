# 결과 — remote hub 스택 재스택

## 상태

7단계 전부 현재 `dev` 위로 재스택되어 푸시됐고, 실질 CI 실패는 0건이다.

| PR | 브랜치 | head | CI |
| --- | --- | --- | --- |
| #2771 | design | `36992baa9` | 그린 |
| #2772 | p1 | `07d7f1006` | 그린 |
| #2776 | p2 | `2b36ad496` | 그린 (스크린샷 대기) |
| #2777 | p3 | `38c361362` | 그린 |
| #2781 | p4 | `158424f05` | 그린 |
| #2786 | p5 | `ff3ce26bd` | 그린 |
| #2789 | p6 | `4ab13b463` | 그린 (스크린샷 대기) |

체인 6개 엣지 전부 부모가 자식의 조상이고, PR base ref도 같은 부모를 가리킨다.
오염 커밋 0건. 원본 64커밋 전부 authorship과 메시지를 보존했고, 계약 변경은
단계마다 조정 커밋으로 분리했다.

## 닫은 것

**설계 계약 5건** — D1 평문 pairing 제거(설정 키까지, 4개 문서), D2
identity-varying 응답의 validator 제거(서버+클라이언트), D3 Origin verbatim
전달(안전 읽기 허용 보존), D4 로테이션 크래시 복구를 실행 가능한 상태 기계로,
D5 릴레이 응답 no-store.

**P1 리뷰 스레드 6건** — T1(공개 devlog 프레이밍), T20(미인증 바디 무제한
버퍼링), T22(process 소유 journal이 연결을 가둠), T25(relay가 항상 throw),
T26(supervised 클라이언트가 disconnect 후 안 돌아옴), T31(abort 실패 시 토큰
identity). T32도 함께 닫았다.

**CI 실패 6건** — sync 러너 종료 코드, eslint suppression, 릴레이 pairing
미인증, happy-dom prompt, GUI 테스트 격리, 미선언 관리 라우트 4개 +
capability 미선언.

## 실제로 스택 문제가 아니었던 것

리뷰가 지목한 실패 중 상당수가 상속된 staleness였다.
`release-version-line`, privacy 게이트, `update-stop-first`,
`cli-headless-parity`의 일부는 재스택만으로 사라졌고 각 단계 head에서
확인했다.

`server-auth`의 websocket refresh flake는 **dev 자체의 결함**이었다.
dev HEAD도 같은 단언으로 실패한다. 근본 원인(시계 고정 전에 찍히는 두 개의
타임스탬프)을 찾아 **PR #3147**로 분리했다. 스택에 섞지 않은 이유는 소유가
dev이기 때문이다.

## 감사가 바꾼 것

로드맵 1차 감사가 FAIL 10건을 냈고 전건 수용했다. 그중 둘이 실제 작업 순서를
바꿨다: 미해결 인라인 스레드 33건이 로드맵에 아예 빠져 있었고,
블로커 2건이 한 단계씩 늦게 배정돼 있었다(`/api/machine/*`는 p4가 도입,
`api-auth-memory`는 p2가 터치). diff로 실측해 재배정했다.

설계 수정 1차에 대한 적대적 리뷰도 FAIL을 냈다. D1을 040에서만 지우고
010/050/070에 계약이 살아 있었고, D4는 새 규칙을 쓰면서 옛 규칙을 안 지워
문서가 자기모순이었다. 둘 다 리뷰 지적대로 닫았다.

## 남은 것 — 사람이 해야 함

1. **UI 스크린샷** — `enforce-target`이 #2776/#2789에 요구한다. 세 PR 모두
   실제 GUI 변경을 담고 있어 요구가 정당하다.
2. **리뷰 승인** — 7건 전부 `CHANGES_REQUESTED` 상태다.
   `MAINTAINERS.md`가 비저자 메인테이너 승인과 보안 리뷰를 요구하고,
   Ingwannu가 유일한 비저자 메인테이너다. CI가 초록이어도 이 상태로는
   머지 버튼이 열리지 않는다.
3. **P2/Minor 스레드** — T2/T3/T7/T10/T11/T19/T21/T23/T24/T27/T28/T29/T30/T33과
   #2771의 마크다운 린트 6건. 수정하거나 근거를 갖춘 반박을 남기고 resolve한다.

사용자 요청은 "머지 가능한 정도까지 세팅"이었다. 자동화 게이트 기준으로는
도달했다. 승인은 우리 손 밖이다.

## 분리한 PR

**#3147** `test(auth): seed the pool quota and credential after the clock is pinned`
— `dev` 타깃, 테스트 파일 한 개. 이 스택의 브랜치가 아니라 dev가 소유하는
flake라서 섞지 않았다. 스택 7건과 독립적으로 리뷰·머지된다.
