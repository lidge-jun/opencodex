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
