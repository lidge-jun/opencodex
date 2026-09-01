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
린트 억제 주석으로 막고 있었다. 룰이 옳았다 — 한 파일이 전송 함수와 컴포넌트를
같이 export한다. 억제 대신 `connect-pairing-transport.ts`로 분리했다.
전송은 React 없이 테스트 가능하고, 폼은 그걸 호출하는 것 말고 로직이 없다.

(이 문서가 억제 지시자를 문자 그대로 적었더니 hygiene 게이트가 새 억제로 읽어
draft를 유지시켰다. 게이트가 옳게 동작한 것이므로 문구를 바꿨다.)

## 3. `gates` — 릴레이 pairing이 인증 없이 나간다 (p4 소유)

`submitConnectPairing`이 `fetchImpl: typeof fetch = fetch`를 받았다.

(정정 — 초판의 설명은 틀렸다. "기본 매개변수는 모듈 평가 시점의 전역을 묶는다"고
썼는데, 기본값 초기화식은 **호출 시점에** 평가된다. 스펙이 그렇고, 이 문서가
반대로 적어두면 다음 사람이 잘못된 모델로 디버깅한다.)

실제 실패는 바인딩 시점이 아니라 **어느 전역을 보느냐**의 문제였다. 테스트
환경에서 happy-dom의 `window`와 Bun의 `globalThis`가 갈리고,
`installApiAuthFetch`는 `window.fetch`에 래퍼를 씌운다. 호출 시점에 평가된
맨 `fetch`가 그 래퍼가 아닌 다른 실체로 해석될 수 있고, 래퍼 설치보다 모듈
참조가 먼저 굳는 경로도 있다. 릴레이는 래퍼가 붙이는 머신 세션 헤더를
요구하므로 허브가 교환을 거부했다. 호출 시점에 `window.fetch`를 명시적으로
집어오도록 고쳤다.

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

## 추가로 드러난 두 건

### 6. `test 1/4` — 미선언 관리 라우트 4개 (p6 소유)

`tests/management-route-registry.test.ts`가 선언 레지스트리를 소스와 대조해
이 단계가 서빙하면서 등록하지 않은 라우트 4개를 찾았다:
`/api/keys/rotate`의 POST/POST commit/DELETE와 `POST /api/session/logout`.

rotate 3개는 평범한 관리 뮤테이션이라 그대로 선언했다.
`/api/session/logout`은 session-only 예외로 이유와 함께 등록했다 — 현재
gui-session을 끝내며 그 세션 자신의 Origin과 CSRF를 요구하므로 CLI verb가
작용할 대상이 없다. CLI는 admin 토큰을 들고 있고, 이 라우트는 바로 그
admin 토큰을 거부한다. 자기가 만들지 않은 동의 세션을 끝내지 못하게 하려는
설계다.

### 7. dev의 websocket flake 근본 원인 — PR #3147로 분리

`server-auth`의 websocket refresh 단언이 macOS와 Linux 양쪽에서 실패했고,
dev HEAD도 같은 실패를 낸다. 원인을 찾았다.

`updateAccountQuota`가 `updatedAt: Date.now()`를 찍는데, 시드가 시계 고정
**전에** 실행된다. 그래서 그 타임스탬프만 실제 벽시계이고 이후 모든 것은
고정된 2027 값을 읽는다. 격차가 약 136일인데 신선도 창은 6시간이다
(`QUOTA_DISK_MAX_AGE_MS`, `src/codex/quota.ts:491`). 러너가 아무리 빨라도
시드는 stale로 읽히고, 시작 시 pool-quota 프라임이 첫 턴 전에 자격증명을
갱신해 `seenAuth[0]`이 이미 새 토큰이 된다. 실패 diff가 항상 첫 원소였던
이유다.

#3139는 `startServer` 앞에 시계와 fetch를 고정해 프라임 자신의 읽기 창을
닫았다. 하지만 그 둘이 놓이기 **전에** 쓰인 타임스탬프의 창은 닫을 수 없다.
시드를 고정 뒤로 옮기면 닫힌다.

이건 dev 소유라 스택에 섞지 않고 **PR #3147**로 분리해 `dev`를 타깃하게 했다.
로컬에서는 수정 전후 모두 재현되지 않으므로 증거는 red-to-green이 아니라
메커니즘이다 — 6시간 창에 136일 격차는 경쟁이 아니라 산술이다.

## 남은 것 — 사람이 해야 하는 항목

`enforce-target`이 #2776/#2781/#2789에 대해 UI 스크린샷을 요구한다.
세 PR 모두 실제 GUI 변경(각각 3/34/15 파일)을 담고 있으므로 요구가 정당하다.
스크린샷은 사람이 캡처해 PR 설명에 붙여야 한다.
