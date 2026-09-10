# 122 — 머지 후 `dev` 검증

9건이 랜딩한 `dev`(`3275b5a27`)가 실제로 정합한지 확인했다. 머지가 성공했다는
것과 트리가 멀쩡하다는 것은 다른 주장이라서다.

## 스택 코드가 실제로 있다

`src/client/machine-listener.ts`, `src/client/connect.ts`,
`src/client/hub-relay.ts`, `src/routing/compatibility/provider-slot.ts` 전부
`origin/dev`에 존재한다. T20 캡은 `src/server/index.ts`의 `declaredLength`
2회 참조로 확인된다.

## 구조 불변식이 살아 있다

`AGENTS.md`가 가장 크게 지키라고 적은 두 가지를 좁게 돌렸다:

```
bun test tests/core-lab-boundary.test.ts tests/repo-hygiene.test.ts
29 pass / 0 fail / 71 expect() calls
```

이건 스타일 검사가 아니다. core-lab boundary는 Lab이 코어 요청 경로로 새어드는
것을 런타임 import 그래프로 막고, 그 안의 activation-window 스캔은
`startServer`가 동기로 남아 있는지를 본다. 리모트 허브는 `startServer` 주변에
라우트와 런타임 롤을 추가하는 스택이므로, 이 둘이 초록인 것이 "코어 경로를
건드리지 않았다"의 실질 증거다. repo-hygiene은 gitlink와 벤더 클론이 인덱스에
다시 나타나지 않았음을 본다.

전체 스위트는 돌리지 않았다(금지). 나머지 검증은 각 PR의 exact-head CI다.
