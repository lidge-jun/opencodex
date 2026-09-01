# wp8 — exact-head CI 실패 규명과 수정

7단계 재스택 후 각 PR의 exact head에서 CI를 돌려 실패를 하나씩 규명했다.
네 갈래였고, 그중 셋이 진짜 결함이었다.

## 1. `test 3/4` — sync 러너가 종료 코드를 삼킨다 (p3 소유)

`tests/cli-transport-honesty.test.ts`가 "핸들러를 await한 뒤 리터럴 0을
반환하는" 러너를 잡는다. 그 패턴은 핸들러가 `process.exitCode`에 기록한
실패를 지우기 때문이고, 예외는 이름이 아니라 검증된 이유와 함께 allowlist에
올려야 한다.

connected sync 분기에는 그런 이유가 없다. `handleConnectedSyncCatalogWrite`가
app-server 재시작을 구동하므로 거기서 난 실패는 살아남아야 한다.
다른 러너들과 같이 `process.exitCode`를 반환하게 했다.

## 2. `hygiene` — suppression (p4 소유)

`gui/src/connect-pairing.ts`가 `react-refresh/only-export-components`를
eslint-disable로 막고 있었다. 룰이 옳았다 — 한 파일이 전송 함수와 컴포넌트를
같이 export한다. 억제 대신 `connect-pairing-transport.ts`로 분리했다.
전송은 React 없이 테스트 가능하고, 폼은 그걸 호출하는 것 말고 로직이 없다.

## 3. `gates` — 릴레이 pairing이 인증 없이 나간다 (p4 소유)

`submitConnectPairing`이 `fetchImpl: typeof fetch = fetch`를 받았다.
기본 매개변수는 **모듈 평가 시점의** 전역을 묶는다 — `installApiAuthFetch`가
`window.fetch`에 씌우는 래퍼가 아니라 원본이다. 릴레이는 그 래퍼가 붙이는
머신 세션 헤더를 요구하므로 허브가 교환을 거부했다. 호출 시점에 해석하도록 고쳤다.

## 4. `gates` — happy-dom에 없는 prompt (p2 소유)

거부된 세션을 정리하는 테스트들이 admin 토큰 폴백에 도달하는데,
happy-dom은 `prompt`를 구현하지 않는다. 그래서 그 테스트들은 검증하려던
동작이 아니라 TypeError로 죽었다. 대부분의 테스트는 폴백에 안 닿아서
가려져 있었다. null을 반환하는 스텁이 "운영자가 프롬프트를 닫았다"에
해당하는 정직한 대역이다.

## 5. GUI 스위트 격리 — 제품 결함 아님

`tests/connect-pairing.test.ts`가 단독으로는 통과하고 전체 실행에서 실패했다.
App이 모듈 스코프에서 `installApiAuthFetch()`를 부르므로 최초 import에서만
실행된다. 나중에 App을 import하는 테스트는 캐시된 모듈을 받고 설치가 일어나지
않아, 래퍼가 **먼저 import한 테스트의 window**에 묶인 채로 남는다.

테스트가 마운트 전에 자기 window로 래퍼를 다시 묶도록 했고,
`claude-toggle-race.test.tsx`는 window를 닫을 때 설치 latch도 함께 지운다.
둘 다 테스트 격리이지 제품 동작이 아니다.

## macos 실패는 이 스택 탓이 아니다

`tests/server-auth.test.ts`의 websocket refresh 단언이 macos에서 실패했는데,
**dev의 HEAD도 같은 러너에서 같은 단언으로 실패한다.** #3139의 수정이 이미
dev에 들어가 있는데도 그렇다. #2772는 동일 head를 재실행하니 그린이 됐다.
즉 dev에 남은 미해결 flake이고, 재스택이 유발한 것이 아니다.

## 최종 체인

| 단계 | head |
| --- | --- |
| design | `36992baa9` |
| p1 | `07d7f1006` |
| p2 | `2b36ad496` |
| p3 | `38c361362` |
| p4 | `158424f05` |
| p5 | `ff3ce26bd` |
| p6 | `b6aa976e9` |

6개 엣지 전부 부모가 자식의 조상이고, PR base ref도 같은 부모를 가리킨다.
오염 커밋 0건, 변경 범위는 devlog/docs-site/gui/src/structure/tests뿐이다.
