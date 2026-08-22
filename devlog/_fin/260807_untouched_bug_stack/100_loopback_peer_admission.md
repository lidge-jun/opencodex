# 100 — #1102: `0.0.0.0` 바인드에서 로컬 Codex 가 401 로 막힌다

> **개정 이력.** 첫 판은 "opt-in 으로 loopback 소켓 피어를 무인증 admit" 을
> 제안했다. 독립 감사가 P1 다섯 건으로 되돌렸고, 그중 둘이 설계를 바꿨다:
> (a) 그 스위치는 `resolveApiAuth` 를 타고 #1102 와 무관한 8개 엔드포인트까지
> 열고, (b) 공용 리스너의 피어 주소는 최종 사용자 신원이 아니다. 아래는
> 재설계된 판이다.
>
> **2차 개정.** 재설계본도 감사에서 P1 세 건을 받았다. 설계 방향은 유지됐지만
> 구현 계약이 비어 있었다: ephemeral 포트가 재시작마다 바뀌면 우리가 부정했던
> "재시작 후 app-server 가 깨진다" 를 우리 손으로 만들고, 로컬 리스너의
> auth/origin/WS 처리 경계가 미정이며, 두 bind 가 하나의 트랜잭션이 아니었다.
> 아래 §고정 포트 / §리스너 정책 / §바인드 트랜잭션 이 그 답이다.
>
> **3차 개정.** 세 번째 감사가 P1 둘을 더 찾았고 둘 다 검증된 사실이다:
> 카탈로그가 없을 때 app-server 가 `GET /v1/models` 로 폴백하는데 우리
> allowlist 가 그걸 404 로 막고, `allSettled` 만으로는 stop 실패가 삼켜져
> 재시작이 아직 포트를 쥔 리스너 위에 바인드를 시도한다.

## 이슈가 말한 것과 실제

리포터는 두 개의 트리거를 보고했다. 하나는 정확했고, 하나는 원인이 다르다.

**맞음 — direct-spawn 갭.** `app-server` 는 shim 의 `CODEX_INTERNAL_COMMANDS`
(`src/codex/shim.ts:42`) 에 있고 shim 은 디스패치 전에 토큰을 export 한다
(`:384-389`). 그러니 shim 을 거친 `codex app-server` 는 인증된다. 문제는 서드파티
호스트가 `require.resolve('@openai/codex/bin/codex.js')` 로 엔트리포인트를 직접
resolve 해서 spawn 할 때다. 그 경로는 shim 을 통째로 우회하고, 대안이 없다:
`/v1/responses` admission 은 `x-opencodex-api-key` 만 받고
(`src/server/auth-cors.ts:369-376`), 토큰 파일은 admission 시점에 읽히지 않는다.

**틀림 — "재시작하면 토큰이 회전된다".** `writeServiceApiTokenFile()` 은 이미
`process.env.OPENCODEX_API_AUTH_TOKEN` 에 있는 값을 쓰고, 없으면 아무것도 쓰지
않는다 (`src/service.ts:347`). 호출자는 service install/repair 뿐이고
(`:1707`, `:1799`, `:1937`, `:2116`), `ocx service start` 는 파일을 다시 쓰지
않는다 (`:2660`). 토큰은 애초에 사용자가 공급하는 값이고 OpenCodex 가 생성하지
않는다. 그러니 평범한 재시작이 살아 있는 app-server 를 무효화하지 않는다.

이 정정은 이미 이슈에 코멘트로 게시되어 있고, 리포터에게 두 가지를 물었다.
답은 아직 없다.

## 왜 파일 기반 대안이 전부 막히는가

토큰을 shim 밖 프로세스에 "실제로 전달" 하려면 그 프로세스의 환경을 바꿔야
하는데, OS 프로세스 환경은 spawn 시 복사되고 우리는 남의 프로세스 환경을 사후에
못 바꾼다. 남는 후보를 전부 확인했다:

| 후보 | 왜 안 되는가 |
|---|---|
| Codex `env_http_headers` 를 파일 기반으로 | 값이 **환경변수 이름**이다. 업스트림 설계이고 우리 쪽 변경 범위 밖 |
| static `http_headers` | 시크릿을 `~/.codex/config.toml` 에 평문으로 직렬화한다. 백업·저널·동기화 경로로 퍼진다 |
| `auth.command` | bearer credential 을 공급하는데, `/v1/responses` 는 전용 헤더만 받는다. Codex Direct 와 충돌 방지를 위한 의도적 거부 (`auth-cors.ts:369-372`) |
| OS 전역 환경 주입 | 무관한 GUI/터미널 자식까지 credential 을 상속한다. 이미 떠 있는 호스트에는 적용도 안 된다 |

전부 막힌다. 그래서 이건 credential **전달** 문제가 아니라 admission **정책**
문제다.

## 첫 설계가 왜 틀렸나

처음에는 `isApiAuthRequired()` 를 우회하는 opt-in 스위치
(`trustLoopbackPeersOnRemoteBind`) 를 제안했다. 감사가 두 가지를 지적했고 둘 다
코드로 확인된다.

**하나 — 폭발 반경.** `resolveApiAuth` 는 8곳에서 호출된다
(`src/server/index.ts:692, 882, 903, 937, 1009, 1024, 1087, 1121`): `/v1/models`,
Images generations/edits, artifacts, alpha search, Messages, Live/Realtime,
sideband WebSocket. `resolveResponsesApiAuth` 도 `/v1/responses` 만이 아니라
compact 와 Chat Completions 경로에서 쓰인다. resolver 안에 피어 예외를 넣으면
#1102 가 요청하지 않은 표면 전부가 같이 열린다. 수용 기준이
`/v1/responses` 만 검사했으므로 이 확대를 탐지하지도 못했을 것이다.

**둘 — 피어 주소가 증명하는 것.** `requestIP()` 는 **마지막 transport hop** 만
알려준다. Docker Desktop 의 포트 포워딩, `--network host` 컨테이너, WSL2 의
mirrored networking 과 `netsh portproxy`, Kubernetes sidecar, VPN/터널 종단 —
전부 원격 연결을 로컬 TCP 연결로 다시 연다. 그 배포에서는 원격 호출자가
loopback 피어로 보인다. 흔한 구성이고, 첫 판은 리버스 프록시와 SSH 터널만
예시로 들어 이 계열을 과소평가했다.

"opt-in 이니까 괜찮다" 로는 부족하다. 켜는 사람이 자기 배포가 저 목록에
해당하는지 모를 수 있다.

## 재설계 — 인증을 우회하지 않고, 별도 리스너를 연다

감사가 제시한 대안이 더 낫다. 공용 리스너의 admission 정책은 **한 줄도** 바꾸지
않는다. 대신 `127.0.0.1` 에만 바인드된 **두 번째 리스너**를 옵션으로 연다.

```
0.0.0.0:10100  ← 기존 리스너. 인증 정책 불변. 모든 원격 호출자는 키가 필요하다.
127.0.0.1:PORT ← 새 리스너. 커널이 원격 연결을 아예 받지 않는다.
```

차이가 핵심이다. 첫 설계는 "원격에서 온 연결인데 로컬처럼 보이면 통과" 였다.
이 설계는 **커널이 원격 연결을 애초에 accept 하지 않는다.** 판정할 주소가 없고,
속일 피어 필드도 없다. Docker 포트 포워딩도 `127.0.0.1` 바인드는 기본적으로
호스트 밖으로 내보내지 못한다.

주입되는 Codex provider block 은 이미 wildcard 바인드에서 `base_url` 을
`127.0.0.1` 로 쓴다 (`tests/codex-inject.test.ts:47-54`). 그 URL 의 포트만 로컬
리스너로 바꾸면 shim 을 우회해 직접 spawn 된 app-server 도 인증 없이 붙는다 —
**공용 리스너의 경계는 한 줄도 건드리지 않고.** (넓히는 것이 없다는 뜻은
아니다 — 명시적인 로컬 신뢰 표면이 하나 추가된다. 아래 §여전히 opt-in 인
이유 참조.)

### 여전히 opt-in 인 이유

`127.0.0.1` 바인드라도 그 머신의 **모든 로컬 프로세스**가 접근할 수 있다.
단일 사용자 워크스테이션에서는 받아들일 만하고, 멀티테넌트 호스트에서는 아니다.
그래서 기본값은 꺼짐이고, 이름은 결과가 드러나게 짓는다:
`unauthenticatedLoopbackListener`.

더 정확히 말하면, 이 설계는 **보안 경계를 넓히지 않는** 것이 아니라
**공용 리스너의 경계를 그대로 두고 명시적인 로컬 신뢰 표면을 하나 추가하는**
것이다. 그 표면에서 무인증 로컬 프로세스는 active-turn capacity, 계정 풀 쿼터,
유료 provider credential 을 소비할 수 있다 — 즉 인증된 원격 클라이언트를 굶길
수 있다. 문서 경고는 "모든 로컬 프로세스가 접근 가능" 에서 멈추지 않고 이
비용·DoS 측면까지 적는다.

## 고정 포트 — ephemeral 은 우리가 부정한 버그를 우리가 만든다

첫 재설계본은 포트 미지정 시 OS 할당을 허용했다. 그건 틀렸다.

`ocx sync` 와 startup sync 는 공용 `port` 만 `injectCodexConfig()` 에 넘긴다
(`src/codex/sync.ts:100`, `src/cli/index.ts:353`). 로컬 리스너의 실제 포트를
발견할 경로가 없다. 그리고 ephemeral 포트는 재시작마다 바뀔 수 있는데,
`config.toml` 이 새 포트로 다시 쓰여도 **이미 실행 중인 app-server 는 시작 시
읽은 옛 `base_url` 을 계속 쓴다.**

그 실패 모드를 그대로 읽어보면 — "재시작하면 이미 떠 있는 app-server 가 깨진다"
— 이 이슈가 신고했고 우리가 코드로 부정한 바로 그 증상이다. 원인이 토큰 회전이
아니었을 뿐이고, ephemeral 포트로는 진짜로 만들어낸다.

**포트는 설정에 필수로 둔다.** 오프라인 `ocx sync`, 재시작, 이미 실행 중인
app-server 가 전부 같은 값을 본다. 활성화 시 포트를 안 주면 config 검증이
거부한다.

## 리스너 정책 — 무엇을 어떻게 다르게 취급하는가

로컬 리스너는 같은 프로세스, 같은 라우팅, 같은 계정 풀을 쓴다. 다른 것은 두
가지뿐이다.

**1. auth/origin 판정용 config view.** 같은 `config` 객체를 그대로 넘기면
`hostname` 이 `"0.0.0.0"` 이라 `resolveResponsesApiAuth()` 가 여전히 인증을
요구한다. 그렇다고 config 전체를 `{...config, hostname:"127.0.0.1"}` 로 복제해
오래 들고 있으면 management 로 설정을 바꿨을 때 로컬 리스너가 낡은 값을 쓴다.

그래서 **비즈니스/라우팅은 canonical config 를 공유하고, auth 와 origin 판정에만
매 요청 만든 view 를 넘긴다.**

**resolver 시그니처는 바꾸지 않는다.** `resolveResponsesApiAuth(req, config)` 에
`allowUnauthenticated` 같은 파라미터를 추가하면 공용 리스너에서도 호출 가능한
admission 우회 스위치가 생긴다. 정책 선택은 resolver 밖, 리스너 클로저에서
한다.

view 를 받는 함수는 이것들 전부다 — 하나라도 빠뜨리면 그 지점만 공용 정책으로
판정한다:

- `resolveResponsesApiAuth`
- `isAllowedRequestOrigin`
- `withCors`, `corsHeaders`
- `jsonResponse` — `/v1/models` 의 성공 응답이 이걸 통과하며 내부에서 CORS
  헤더를 만든다 (`src/server/auth-cors.ts:187-191`). 빠뜨리면 그 경로만 공용
  정책으로 헤더를 붙인다
- 에러 응답 헬퍼 (CORS 헤더를 붙이는 것들)

모델 수집과 응답 내용 구성에는 계속 canonical config 를 넘긴다 — view 는 오직
auth/CORS 판정용이다.

view 타입은 `Pick<OcxConfig, "hostname" | "corsAllowOrigins" | "apiKeys">` 수준으로
좁힌다. 완전한 비즈니스 config 로 위장할 수 없어야 실수로 라우팅 경로에 흘러도
타입에서 걸린다.

**2. origin 게이트는 반드시 적용한다.** 인증만 우회하고 origin 검사에 공용
config 를 넘기면 `isAllowedRequestOrigin` 의 remote 분기를 타서
`isSameOriginAsRequest()` 로 허용될 수 있다 (`src/server/auth-cors.ts:76-82`).
공격자 서버가 피해자 브라우저로 `127.0.0.1` 에 붙는 DNS rebinding 이 정확히 그
모양이다 — 커널 관점에서는 정상 로컬 연결이다. 로컬 리스너는 loopback 분기를
타야 하고, 그 분기는 `Host` 헤더까지 검사한다.

커널 바인드와 Host/Origin 게이트가 **함께** 경계다. 바인드만으로는 브라우저를
경유한 접근을 막지 못한다.

**3. WebSocket upgrade 는 그 요청을 받은 서버로.** 현재 Responses WS 는 클로저
바깥의 primary `server.upgrade()` 를 부른다 (`src/server/index.ts:621`). 그대로
공유하면 로컬 리스너가 받은 Request 를 primary 서버에서 upgrade 하려 든다.
반드시 해당 fetch 호출의 `requestServer.upgrade()` 를 쓴다.

### 라우트 allowlist

"data-plane 만" 은 너무 넓었다. 정확히 고정한다:

- `POST /v1/responses`
- `/v1/responses` WebSocket upgrade
- `POST /v1/responses/compact`

- `GET /v1/models`

`/v1/models` 를 넣는 이유는 증거가 나왔기 때문이다. `syncCodex` 는 카탈로그
생성이 실패하거나 소스가 없으면 경고만 남기고 `catalogPath: null` 로
`injectCodexConfig()` 를 부른다 (`src/codex/sync.ts:129-156`). 그러면 Codex 는
static catalog 매니저 대신 online 매니저를 고르고, app-server 의 `model/list` 가
`GET {base_url}/models` 로 나간다. 우리가 404 를 주면 모델 목록이 낡은 채로
남거나 번들 캐시로 떨어진다. 정확히 direct-spawn 호스트를 고치겠다면서 그
호스트의 모델 목록을 깨뜨리는 셈이다.

대안은 카탈로그 설치 실패 시 활성화를 fail-closed 로 막는 것인데, 카탈로그
없음은 이미 경고로 관용되는 상태다. 그걸 이 옵션 때문에 에러로 승격시키는 건
범위를 넘는다.

나머지 — Chat Completions, Messages, Images, search, artifacts, Live/Realtime,
`/api/*`, GUI, health/readiness — 는 404.

## 바인드 트랜잭션

config 검증으로 두 포트가 다른지 보는 것만으로는 부족하다. 로컬 포트를 다른
프로세스가 이미 잡고 있을 수 있다.

두 bind 를 **하나의 startup 트랜잭션**으로 다룬다. 어느 쪽이 실패하든 이미 열린
리스너를 `await stop(true)` 로 닫고 원래 오류를 다시 던진다. 그렇지 않으면
primary 만 살아남고, CLI 의 기존 포트 재시도가 이걸 공용 포트 충돌로 오인해
다른 포트를 고르면서 리스너를 누적한다 (`src/cli/index.ts:234`).

로컬 포트 충돌과 공용 포트 충돌은 구분한다. 로컬 충돌 때문에 공용 포트를 바꾸지
않는다.

합성 `stop()` 은 두 가지를 **동시에** 만족해야 한다. 한쪽만 하면 다른 쪽이
깨진다.

1. **정리는 끝까지 시도한다.** 한쪽 stop 이 실패해도 나머지 stop 과 native
   lifecycle release 를 건너뛰지 않는다.
2. **실패는 호출자에게 전파한다.** `allSettled` 로 삼키면 안 된다.

2번이 중요한 이유: 기존 `stopServerListener` 는 stop 실패를 의도적으로
전파하고, 모든 호출자가 같은 결과를 본 뒤에야 교체 프로세스가 포트를 잡게
되어 있다 (`src/server/lifecycle.ts:290-305`). 삼키면 `drainAndShutdown` 이
종료 완료로 오인하고, 아직 포트를 쥔 리스너 위에 교체가 바인드를 시도한다.
정리는 다 했는데 실패는 보고되는 상태여야 하므로, 결과를 모아 하나라도
실패했으면 `AggregateError` 로 reject 한다.

### 이 설계가 P1 다섯 건에 어떻게 답하는가

| 감사 P1 | 재설계에서 |
|---|---|
| 피어 주소는 최종 신원이 아니다 | 피어 주소를 아예 판정하지 않는다. 커널 바인드 + Host/Origin 게이트가 경계다 |
| 8개 무관 엔드포인트가 같이 열린다 | 공용 리스너 정책 불변. 로컬 리스너는 4개 라우트만 노출하고 나머지는 404 |
| 새 admission kind 의 로그 파급 | `{ kind: "loopback" }` 재사용 — 이미 존재하는 kind 이고 의미도 정확하다 (인증 없는 로컬 바인드). 새 kind 없음 |
| 문자열 모양 주소 판정 | 판정 함수 자체가 없다 |
| 수용 기준이 실제 경로를 증명 못 함 | 실제 리스너를 띄우고 원격 인터페이스에서 연결 거부를 확인한다 |

`admissionKind` 를 새로 늘리지 않는 것이 특히 크다. 감사가 지적한 대로
`RequestLogContext`, `RequestLogEntry`, `PersistedUsageEntry` 가 전부 세 kind 로
고정돼 있고 (`src/server/request-log.ts:52,119`, `src/usage/log.ts:56`),
`KNOWN_ADMISSION_KINDS` 가 모르는 값을 조용히 버린다 (`src/usage/log.ts:115`).
새 kind 는 타입체크를 깨거나 감사 로그에서 사라진다.

## 변경 파일

- `src/types.ts` — `unauthenticatedLoopbackListener?: { enabled: false } | { enabled: true; port: number }`
  (판별 유니온: 꺼져 있을 때 포트를 요구하지 않는다)
- `src/config.ts` — 스키마 + 검증 (포트 필수, 공용 포트와 동일 거부)
- `src/server/index.ts` — 두 번째 `Bun.serve`, 바인드 트랜잭션, 합성 stop,
  라우트 allowlist, 요청별 auth/origin view, `requestServer.upgrade()`
- `src/codex/inject.ts` — 켜져 있으면 `base_url` 이 로컬 리스너 포트를 가리킴
- `src/codex/sync.ts`, `src/cli/index.ts` — 로컬 포트를 주입 경로로 전달
- `src/cli/index.ts` — 실효 공용 포트 검증, 폴백 선택에서 로컬 포트 제외
- `docs-site/` — 설정 문서 + 로컬 접근·비용·DoS 경고
- `tests/` — 아래 기준

## 수용 기준

1. 설정 없음 → 리스너가 하나뿐. `0.0.0.0` 동작은 오늘과 동일 (401 유지).
2. 설정 켬 → `127.0.0.1:PORT` 로 키 없이 `POST /v1/responses` 가 admit 되고
   `{ kind: "loopback" }` 로 기록된다. 실제 WS upgrade 와
   `POST /v1/responses/compact` 도 같다.
3. 설정 켬 → 공용 리스너는 **여전히** 키를 요구한다.
4. 설정 켬 → 로컬 리스너가 비-loopback 인터페이스에 바인드되지 않는다. 머신의
   non-loopback 주소로 실제 연결을 시도해 거부를 확인한다. non-loopback
   인터페이스가 없어 skip 되면 기준 14 의 첫 ablation 이 green 이 되므로, 지원
   OS 에서는 skip 없이 돌거나 별도 결정적 보조 검사를 둔다.
5. allowlist 밖 라우트는 로컬 리스너에서 404: Chat Completions, Messages,
   Images, search, artifacts, Live/Realtime, `/api/*`, GUI, health/readiness 각
   대표 하나씩.
6. 적대적 `Host`/`Origin` (DNS rebinding 형태) 은 로컬 리스너에서도 거부된다.
   거부만이 아니라 **반환되는 CORS 헤더도** 로컬 정책 view 로 만들어졌는지
   확인한다 — 라우팅 전 origin 판정만 보면 응답 헤더 경로의 누락을 놓친다.
   성공 응답도 확인한다: 로컬 `/v1/models` 200 응답의 CORS 헤더가 로컬 view 로
   만들어졌는지.
7. 주입되는 `base_url` 이 설정된 로컬 포트를 가리키고, 재시작 후에도, 독립
   `ocx sync` 실행 후에도 같은 값이다.
8. 포트 필수: 활성화하면서 포트를 생략하거나 공용 포트와 같게 주면 config
   검증이 거부한다.
9. 로컬 포트를 다른 소켓이 이미 점유한 상태로 기동하면 startup 이 실패하고
   **두 포트 모두** 다시 바인드 가능한 상태로 남는다 (rollback).
10. `server.stop(true)` 와 `drainAndShutdown()` 양쪽에서 두 리스너가 모두
    닫힌다. 한쪽 stop 이 실패해도 다른 쪽 stop 과 lifecycle release 가 실행된다.
    **그리고 호출자는 reject 를 관측한다** — 정리 완주와 실패 전파 둘 다.
11. 실제 direct-spawn 수용 테스트: 격리된 `CODEX_HOME` 으로 app-server 를
    띄우고 `model/list` 를 부르고 턴을 하나 돌려서, 요청이 로컬 리스너에
    `loopback` 으로 도달하는지 확인한다. **카탈로그 있음과 없음 두 경로 모두.**
    라우트에 POST 를 날려보는 것만으로는 리포터가 신고한 통합이 동작한다는
    증명이 되지 않는다.

    **오라클이 없으면 이 기준은 공허하다.** Codex 의 models-manager 는 refresh
    실패를 catch 하고 기존 번들/캐시 목록을 반환한다. 그러니 `/v1/models` 를
    allowlist 에서 빼도 `model/list` 는 여전히 성공하고, 번들 모델로 턴을
    돌리면 그것도 성공한다 — 기준이 green 인 채로 호환 경로가 깨진다. 이
    저장소가 반복해서 데인 "통과만 하는 테스트" 의 교과서적 형태다.

    카탈로그 없음 경로는 **오직 우리 라우트를 통해서만 알 수 있는 모델**로
    판정한다:

    - Codex 의 번들 카탈로그와 캐시에 존재할 수 없는 고유 이름의 routed 모델을
      구성한다. 이름은 **런타임에 생성**한다 —
      `ocx-direct-spawn-${crypto.randomUUID()}` 형태. 하드코딩한 이름은 언젠가
      누군가의 카탈로그와 충돌할 수 있고, 그 순간 오라클이 조용히 죽는다.
    - `model/list` 응답에 **그 이름이 정확히** 들어 있는지 단언한다.
    - 턴도 **그 모델로** 돌리고, 의도한 가짜 업스트림에 도달하는지 확인한다.
    - 격리된 `CODEX_HOME` 은 `models_cache.json` 없이 시작한다. 기동 **전에**
      `models_cache.json` 부재와 활성 `model_catalog_json` 부재를 단언한다 —
      전제가 깨진 채로 도는 테스트는 오라클이 아니다.

    실행 경로도 고정한다. PATH 의 `codex` 가 아니라 resolve 된
    `@openai/codex/bin/codex.js` 를 직접 띄우고, 자식 환경에서
    `OPENCODEX_API_AUTH_TOKEN` 을 제거한다. 그러지 않으면 shim 인증 경로를
    실수로 타면서 아무것도 증명하지 못한다.

    증명은 둘로 나눈다. 이 저장소는 `@openai/codex` 를 테스트 의존성으로 설치하지
    않으므로, CI 에서 결정적으로 도는 부분과 실기동 증거를 구분한다:

    - **CI 결정적:** 로컬 리스너의 `/v1/models?client_version=...` 라우트가
      고유 모델을 반환하는지, allowlist 에서 빼면 404 가 되는지.
    - **활성화 증거 (skip 금지):** 실제 지원 버전의 Codex app-server 로 위
      시퀀스를 돌린 기록. 스킵된 채로는 이 기준을 충족한 것으로 치지 않는다.
12. 실효 공용 포트 충돌: `ocx start --port <로컬포트>`, `config.port = 0` 이
    로컬 포트로 해석되는 경우, 그리고 선호 포트가 막혀 `findAvailablePort()` 의
    ephemeral 폴백이 로컬 포트를 고르는 경우 — 전부 startup 이 실패하는 대신
    로컬 포트를 후보에서 제외해야 한다 (`src/cli/index.ts:146-180`).
13. 활성화 시 시작 로그에 눈에 띄는 경고가 나온다: `127.0.0.1:PORT`, 무인증
    로컬 접근, 유료 credential 소비, 로컬 DoS 위험.
14. ablation:
    - 로컬 리스너 hostname 을 `0.0.0.0` 으로 바꾸면 기준 4 가 red.
    - `inject.ts` 포트 배선을 되돌리면 기준 7 이 red.
    - origin 판정에 공용 config 를 넘기면 기준 6 이 red.
    - rollback 을 제거하면 기준 9 가 red.
    - 합성 stop 이 한쪽 reject 를 삼키게 하면 기준 10 이 red.
    - `/v1/models` 를 allowlist 에서 빼면 기준 11 의 카탈로그 없음 경로가 red.

## 상태 — 완결이 아니라 완화책

감사의 마지막 P1 을 그대로 받는다. 기본값이 꺼짐이므로, 리포터가 이 옵션을
수용하기 전까지 원래 재현은 여전히 401 이다. 그래서 이 유닛은 **#1102 를 close
하지 않는다.** PR 은 `Closes` 대신 이슈를 참조하고, 리포터에게 이 옵션이
배포에 맞는지 묻는 코멘트를 남긴다.

---

## 부록 — 첫 설계의 원 분석 (기록용)

`isApiAuthRequired()` 는 오직 바인드 hostname 만 본다:

```ts
export function isApiAuthRequired(config: OcxConfig): boolean {
  return !isLoopbackHostname(config.hostname);
}
```

`hostname: "0.0.0.0"` 이면 요청 피어가 `127.0.0.1` 이어도 인증을 요구한다.
그런데 우리가 Codex 에 주입하는 provider block 은 wildcard 바인드에서
`base_url` 을 `127.0.0.1` 로 쓴다 (`tests/codex-inject.test.ts:47-54`). 즉
우리가 만들어낸 구성이 정확히 이 상황을 만든다.

이 진단 자체는 유효하고 재설계도 같은 사실 위에 서 있다. 다만 해법이
"admission 을 우회" 에서 "별도 리스너" 로 바뀌었다.

## 범위 밖

토큰 grace window 와 `service rotate-api-token` 은 별개 유닛이다. 리포터가 보고한
회전 트리거는 원인이 다르다고 확인됐고 (자동 회전이 없음), operator 가 직접 값을
바꾸고 install/repair 한 경우만 남는데 그건 이 이슈가 신고한 것이 아니다.
