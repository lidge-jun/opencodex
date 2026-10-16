# 060 wp5 결과 기록: src/server/index.ts

## 최종 수치

파사드 893줄. 리프 5개: bounded-request 88, startup-warnings 205, websocket-handler 335,
live-sideband 540, serve-options 1,766.

## 계약서와 달라진 점

040_server_index.md 는 리프 4개(bounded-request, live-sideband, startup-warnings, route-guards)와
serveOptions 추출을 예정했다. 실제로는 route-guards 를 만들지 않았다. serveOptions 를 빼내면 파사드가
893줄이 되어 route-guards 를 옮길 이유가 사라졌고, 옮기지 않은 쪽이 변경 면적이 작다.

대신 계약서에 없던 websocket-handler 리프가 생겼다. serveOptions 를 그대로 빼면 리프가 2,010줄이 되어
ratchet 의 NEW_OVERSIZED 에 걸린다. 임계값은 2,000 이고 `updateBaseline` 은 기준선 파일이 없을 때만
새 파일에 캡을 심으므로, 2,000 을 넘는 새 리프는 캡을 받지 못하고 그대로 위반이 된다. websocket 핸들러
244줄을 별도 리프로 빼서 1,766 으로 내렸다.

## 순수 이동이 아닌 부분

캡처 24개 중 21개는 팩토리에서 구조 분해해 본문을 그대로 뒀다. 가변 3개(`server`, `boundPort`,
`remoteWorkspaceStopping`)는 구조 분해하면 생성 시점의 `undefined`/`null`/`false` 로 굳으므로
파사드가 getter 로 넘기고 본문 7줄을 `ctx.x` 로 바꿨다. 이 7줄이 순수 이동에서 벗어난 전부다.

`startupCacheInvalidationWrote` 는 추가 조정이 필요했다. 파사드가 두 곳에서 이 값에 대입하는데
변수는 리프로 갔고 ES import 바인딩은 읽기 전용이라 컴파일되지 않는다. 변수와 그것을 읽고 지우는
`consumeStartupCacheInvalidationWrite` 를 한 모듈에 유지하고 setter 를 export 했다.

## 검증이 잡은 결함 3건

계약서 초안이 route-guards 범위를 1191-1329 로 적었는데 `runAdmittedHttpTurn` 의 닫는 중괄호는 1330 이다.
괄호 깊이 검증기가 거부했다. 결과적으로 그 리프를 만들지 않았지만, 검증기가 비-vacuous 하다는 증거는 남았다.

코드모드가 `startup-warnings.ts` 에 `import { startServer } from "../index"` 를 넣었다. 그 이름은
JSDoc 문단에만 나온다. 주석을 사용처로 오인한 버그다. 그 한 줄이 파사드와 리프를 값 순환으로 만들어
`server/index.ts` 와 무관한 테스트까지 red 가 됐다. CI 가 잡았다.

파사드가 `startupCacheInvalidationWrote` 에 대입하는 문제는 로컬 `--ignoreConfig` tsc 가 못 봤고
CI typecheck 가 잡았다. 이 워크트리에 node_modules 가 없는 한 이 계열은 CI 가 유일한 오라클이다.

## 오라클

`src/server/index.ts` 를 텍스트로 읽는 테스트 8개 중 4개를 재지정했다. 단언 문자열은 하나만 바꿨다
(ws-endpoint 의 `websocket: {` → `websocket: createWebsocketHandler(ctx),`). 그런데도 같은 파일 안
세 번째 describe 를 시뮬레이션이 빠뜨려 감사자가 잡았다. 손으로 목록을 만드는 방식의 한계이고,
core.ts 쪽이 쓴 "모듈 목록 상수 + 목록과 import 그래프 일치 단언" 방식이 이 문제를 구조적으로 닫는다.
다음 라운드는 그 방식을 먼저 쓴다.


## 오라클 누락 세 번째, 그리고 방법을 바꾼 이유

`tests/server/loopback-listener-integration.test.ts` 의 "seams the runtime cannot defend" 가
세 번째 누락이었다. `bun run test:changed` 가 40초에 잡았다.

이 오라클은 경로를 `join(process.cwd(), "src", "server", "index.ts")` 로 조립한다. 내가 만든 탐지기는
문자열 리터럴을 뽑아 `src/` 를 붙여 해석해보는 방식이라 후보가 `index.ts`, `src/index.ts` 였고
`src/server/index.ts` 에 닿지 못했다. bridge 때는 `repoPath("src", ...relative.split("/"))` 에,
server/index 때는 같은 파일 안 다른 describe 에, 여기서는 다중 세그먼트 조립에 걸렸다.

세 번 다 형태가 다르다. 탐지기를 한 번 더 넓히는 것으로는 닫히지 않는다는 뜻이다. 실제로 닫는 방법은
두 개뿐이었다.

하나는 `core.ts` 쪽이 쓴 방식이다. 모듈 목록을 상수로 두고, 그 목록이 실제 import 그래프와 같은지
테스트가 단언한다. 목록에 없는 리프를 추가하면 그 테스트가 실패하므로 오라클이 조용해질 수 없다.

다른 하나는 `bun run test:changed` 다. 변경 파일의 import 그래프를 따라 테스트를 고르므로 어떤 형태로
경로를 조립했든 그 테스트를 실행한다. 이번에 주 체크아웃의 `node_modules` 를 링크해서 처음 돌렸고,
40초에 105파일 2,249개를 돌려 한 건을 찾았다. 앞선 두 번은 CI 한 바퀴(수십 분)를 태워서 알았다.

다음 라운드의 순서는 이렇게 고정한다. 링크를 먼저 걸고, 분해 직후 `test:changed` 를 돌리고,
그 다음에 오라클 목록을 손으로 본다. 정적 탐지기는 보조 수단이지 1차 방어선이 아니다.

