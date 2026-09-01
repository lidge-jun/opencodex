# 축별 종결 원장

폴리싱은 하나의 감사(`100`)와 하나의 적대적 리뷰에서 출발해 세 브랜치에
수정으로 떨어졌다. goalplan은 축을 work-phase로 쪼개 두었으므로, 각 축이
어디에서 닫혔는지를 여기 기록한다.

| 축 | 닫힌 곳 | 증거 |
| --- | --- | --- |
| 부팅 요청 제거 | p4 `4aad8abbf` | `gui/tests/api-targets.test.ts` — standalone 0 fetch (null/standalone/hub), client는 여전히 discovery |
| standalone UI 미렌더 | p4 `4aad8abbf`, p6 `2349d39e8` | GUI 스위트 1207 pass / 0 fail |
| 서버 라우트 폐쇄 | 확인만 (수정 불필요) | `/api/machine/*`는 연결된 클라이언트 리스너 전용, standalone 프록시에 라우트 없음 |
| disconnect 롤백 | p3 `c5420db86` | client-connect 15 pass, codex-journal 25 pass, 둘 다 레드퍼스트 |
| 스택 전파 | p3→p4→p5→p6 | 체인 6엣지 정합, 오염 0 |

## 서버 축이 수정 없이 닫힌 이유

감사 시작 시 가장 걱정한 것이 "standalone 프로세스가 원격 라우트를 연다"였는데,
실측 결과 그렇지 않았다. `/api/machine/*` 핸들러는
`src/client/machine-listener.ts`에만 있고, 그 리스너는
`src/client/runtime.ts`가 연결된 클라이언트 롤에서만 띄운다. standalone
프록시의 `src/server/index.ts`에는 그 라우트가 없다.

`AGENTS.md`의 optional-subsystem 원칙과 같은 모양이다 — 켜지 않으면 코드가
돌지 않는다. 문제는 서버가 아니라 **클라이언트가 묻는 것**이었다.

## 남긴 것

리뷰가 지적한 두 건은 이번 스코프를 넘어 그대로 둔다:
`/healthz`·`/readyz`·관리 CORS의 프로토콜 메타데이터(롤 게이팅이 프로토콜
협상을 깨뜨릴 수 있음), disconnect의 비트랜잭션성(복구 상태 기계 신설이 필요).
둘 다 `101`에 이유와 함께 적혀 있다.

## 축별 검증 커맨드

각 축을 닫을 때 실제로 돌린 것. 기록해 두면 다음 사람이 같은 주장을 다시
확인할 때 무엇을 실행해야 하는지 찾을 필요가 없다.

| 축 | 커맨드 |
| --- | --- |
| 부팅 요청 | `cd gui && bun test tests/api-targets.test.ts` |
| standalone UI | `cd gui && bun test tests/usage-layout.test.ts tests/apikeys-actions.test.tsx tests/connect-pairing.test.ts` |
| 서버 라우트 | `bun test tests/cli-headless-parity.test.ts tests/management-route-registry.test.ts` |
| 롤백 | `bun test tests/client-connect.test.ts tests/codex-journal.test.ts` |
| 체인 | `git merge-base --is-ancestor`를 6개 엣지에 대해 |

## 서버 축 판정 근거 (수정 없음)

`src/client/machine-listener.ts:49-51`이 `/api/machine/*` 라우트를 정의하고,
`src/client/runtime.ts:70`의 `startMachineListener`가 연결된 클라이언트
상태에서만 그것을 띄운다. standalone 프록시(`src/server/index.ts`)를 grep하면
해당 경로가 나오지 않는다 — 라우트가 없으므로 인증된 요청도 일반 관리 디스패처를
거쳐 404가 된다.

즉 standalone 사용자의 프로세스는 이 표면을 열지 않는다. 고칠 것이 없어서
이 축은 확인만으로 닫혔다.

## 롤백 축이 가장 무거웠던 이유

사용자가 요구한 세 가지 중 "다시 로컬로 롤백"이 유일하게 **데이터를 잃을 수
있는** 축이었다. 노출과 요청은 거슬리는 것이고, 롤백 실패는 복구 불가능하다.

토큰은 재발급할 수 있고 Codex config는 저널에 원본이 있다. 카탈로그만은
다른 어디에도 사본이 없다 — connect가 덮어쓰고, disconnect가 지우면 끝이다.
그런데 그 상태에서 CLI는 "native Codex state was restored"를 출력했다.

수정 후에는 connect가 원본을 연결 상태에 실어두고 disconnect가 되돌려 쓴다.
두 결과(`restored` / `removed`)를 구분해 반환하므로, "복구했다"와
"원래 없었으니 지웠다"가 같은 신호로 뭉뚱그려지지 않는다.

## 최종 상태 (2026-09-01, 머지 완료)

위 표는 초판에서 폴리싱 시점 head를 "그린"으로 적었다. 그건 그 스냅샷의
주장이었고, 리뷰 시점 exact head에서는 #2781과 #2789가 빨갰다. 지금은
스냅샷이 아니라 머지 결과를 적는다.

| PR | 머지 커밋 |
| --- | --- |
| #2771 | `278fd613a` |
| #2772 | `87459f8c3` |
| #2776 | `39e5aefb6` |
| #2777 | `fd8b6b895` |
| #2781 | `163feb6ee` |
| #2786 | `6d732d3dc` |
| #2789 | `9232df0e6` |

분리 PR: **#3147** — `dev`의 websocket flake 근본 수정, `408652698`로 머지.
**#3149** — 이 로드맵 유닛.

`enforce-target` 2건은 스크린샷 요구였고 서로 다르게 닫혔다. #2776은
`gui-screenshot-waived` 라벨로 면제했다(`gui/src/api.ts` + 테스트 2개, 렌더
변화 없음). #2789는 면제 대상이 아니어서 키 교체 UI를 실제로 띄워 캡처하고
PR 설명에 붙였다.
