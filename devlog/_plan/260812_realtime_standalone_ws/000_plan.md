# 260812_realtime_standalone_ws — standalone Realtime WS relay (voice 404 fix)

## Objective

ChatGPT/Codex 데스크톱 앱의 보이스 채팅이 프록시 경유 시
`failed to connect realtime websocket: HTTP error: 404 Not Found` 로 실패한다.
앱(app-server `thread/realtime/start`, standalone WebSocket transport)이 여는
`GET /v1/realtime?intent=quicksilver&model=gpt-realtime-1.5` 를 opencodex가
릴레이하지 못해 `/v1/*` unknown-endpoint guard 에서 JSON 404 를 반환하기 때문이다.

## Evidence (조사 요약)

- 앱 로그 (jun-macbookpro, verbatim): 2026-08-12T14:23:16~14:26:01Z,
  `[electron-message-handler] Realtime voice session failed ... 404 Not Found` 5회.
- 재구성된 요청 URL: `ws://127.0.0.1:10100/v1/realtime?intent=quicksilver&model=gpt-realtime-1.5`
  (config: `openai_base_url = http://127.0.0.1:10100/v1`, 번들 codex 0.147.0-alpha.6.5,
  앱 ChatGPT.app 26.803.41515).
- codex-rs 최신(9dd22890f) 기준 standalone realtime 경로:
  - V1: `/v1/realtime?intent=quicksilver&model=<m>` (methods.rs:919, methods_v1.rs:81)
  - RealtimeV2: `/v1/realtime?model=<m>` (methods_v2.rs:178)
  - FramelessBidi: `/v1/live?model=<m>` (methods.rs:997)
- opencodex 현재 지원: call-create `POST /v1/live`, `POST /v1/realtime/calls`,
  sideband join `/v1/live/{id}`, `/v1/realtime/calls/{id}`, `/v1/realtime?call_id=`.
  standalone (call_id 없음) 은 미지원 → `src/server/index.ts:1360` 404.
- 7/24 구현(#371/PR #379)은 당시 WebRTC call-create 계약만 겨냥했고,
  앱이 standalone WS transport 로 바뀐 것이 이번 회귀의 본질.

## 추가로 발견된 divergence (같은 단위에서 처리)

- (G2) realtime-query sideband 에 `intent=quicksilver` 를 무조건 붙이는 기존
  deliberate deviation (live.ts 주석 참조) — V2 semantics 변경 위험.
  **이번 범위에서는 유지** (기존 주석이 live smoke 게이트를 요구).
- (G3) keyed(API-key) call-create 가 inbound path 와 무관하게 항상
  `/v1/realtime/calls?...avas` 로 간다. codex-rs 는 Frameless API shape 에
  `POST {base}/live` (AVAS 없음) 를 사용 (realtime_call.rs:66,560).
  → 작은 수정이라 같은 단위에서 별도 커밋으로 처리.

## File change map

### A-round amendments (Mendel, GO-WITH-FIXES blockers=6 — 전부 fold)

A1. **loopback listener allowlist** (High): `unauthenticatedLoopbackListener` 는
`loopbackRouteAllowed` (src/server/index.ts:613-620) allowlist 밖을 전부 404 한다.
직접 spawn 된 `codex app-server` 가 이 리스너에 inject 되면 (src/codex/inject.ts:655)
standalone voice 도 같은 404 를 맞는다. → WS-upgrade 한정으로
`/v1/realtime`, `/v1/live` 두 경로를 allowlist 에 추가한다 (기존 `/v1/responses`
WS 허용과 같은 trust model). sideband join 경로들의 loopback 허용은 이번 범위 밖
(잔여 residual 로 기록).

A2. **live activation 의 mandatory 화** (High): 실 인증 live smoke 를 C 의 필수
게이트로 격상. 401/403 이 나오면 DONE 이 아니라 P 복귀 (backend-shape 대체 경로
재계획).

A3. **raw query 보존 시그니처** (Medium): `URLSearchParams.toString()` 재직렬화는
`%2f`/`%20`/`~`/bare key 를 바꾼다. → `parseLiveSidebandTarget(pathname,
searchParams, rawQuery)` 에 세 번째 인자로 `url.search` 의 `?` 를 뗀 원문을
넘긴다 (호출부 index.ts:1311 수정). target 의 `query` 는 이 raw 문자열.

A4. **query trust boundary** (Medium): credential-shaped 파라미터 denylist —
`access_token`, `api_key`, `apikey`, `token`, `key`, `authorization`, `auth`,
`signature`, `sig` 는 전달하지 않고 drop + warn 로그. 나머지는 verbatim 전달,
중복 파라미터는 그대로 통과(업스트림이 처리). negative 테스트 추가.

A5. **G3 upstream 경로** (Medium): keyed + inbound `/v1/live` 는
`forwardLiveUrl(relay.providerBaseUrl, false)` 재사용 → `{base}/live`
(canonical base 가 `https://api.openai.com/v1` 이므로 결과는 `/v1/live`).
`/v1/realtime/calls` 는 기존 `keyedLiveUrl` 유지. 테스트 assert 는 `/v1/live`.

A6. **테스트 매트릭스 확장** (Medium): 아래 목록 전부 추가 —
trailing slash (`/v1/realtime/`, `/v1/live/`), 무효 nonempty call_id
(`call_id=bad id!`), bare `/v1/realtime/calls` 의 WS upgrade 거부,
frameless standalone `/v1/live` e2e, standalone 의 인증 거부(401) 와
non-local Origin 거부(403), non-WS `GET /v1/live` 404 유지 (기존
tests/server-live.test.ts:414), loopback listener 의 허용/거부 동작.

### IN scope

1. `src/server/live.ts` (MODIFY)
   - `LiveSidebandTarget` union 에 추가:
     `{ style: "realtime-standalone"; query: string }`,
     `{ style: "frameless-standalone"; query: string }`
     (`query` = inbound `url.search` 에서 `?` 를 뗀 원문, 빈 문자열 허용).
   - `parseLiveSidebandTarget(pathname, searchParams, rawQuery)`:
     - `/v1/realtime` + 유효한 `call_id` → 기존 `realtime-query` (불변).
     - `/v1/realtime` (+ `/v1/realtime/`) + `call_id` 없음/무효 → `realtime-standalone`.
       분기 순서: `searchParams.has("call_id")` → 유효하면 realtime-query,
       무효/빈값이면 null(404) 유지; 키 부재 → realtime-standalone.
     - `/v1/live` (+ `/v1/live/`) 정확히 (path id 없음) → `frameless-standalone`.
   - `buildLiveSidebandUpstreamWsUrl(target, overrideBaseUrl?)`:
     - `realtime-standalone` → `httpsToWss(`${root}/realtime`)` + (query 비어있지 않으면 `?${query}`)
     - `frameless-standalone` → `httpsToWss(`${root}/live`)` + 동일 query 처리.
     - query 는 A4 의 denylist 를 거친 raw 문자열을 전달.
   - `handleLive` 의 keyed 분기: inbound `url.pathname === "/v1/live"` 이면
     `forwardLiveUrl(relay.providerBaseUrl, false)` (`/v1/live`, AVAS 없음),
     `/v1/realtime/calls` 이면 기존 `keyedLiveUrl` 유지. (G3/A5)
2. `src/server/index.ts` (MODIFY)
   - `parseLiveSidebandTarget` 호출부에 rawQuery 인자 전달 (url.search).
   - `loopbackRouteAllowed` 에 WS-upgrade 한정 `/v1/realtime`, `/v1/live` 추가 (A1).
   - upgrade 블록 주석에 standalone 경로 인식을 명시.
3. `tests/server-live.test.ts` (MODIFY) — 아래 테스트 추가 (line ~608 부근 기존
   sideband URL 테스트들 옆):
   - parser: `/v1/realtime?intent=quicksilver&model=gpt-realtime-1.5` →
     `realtime-standalone` + query 보존.
   - parser: `/v1/realtime` (query 없음) → `realtime-standalone`, query "".
   - parser: `/v1/live` → `frameless-standalone`.
   - regression: `/v1/realtime?call_id=rtc_2` → 기존 `realtime-query` 유지.
   - regression: 무효 `call_id` (`call_id=`, `call_id=bad id!`) → null (404 유지).
   - parser: trailing slash `/v1/realtime/`, `/v1/live/` 처리.
   - parser: bare `/v1/realtime/calls` WS → null (거부 유지).
   - query 정책: denylist 키(`access_token`, `api_key`, `token`, `key` 등) drop,
     나머지 raw 보존 (`%2f`, `%20`, bare key 포함), 중복 파라미터 통과.
   - builder: standalone 두 style 의 upstream URL
     (`wss://api.openai.com/v1/realtime?intent=quicksilver&model=...`,
     `wss://api.openai.com/v1/live?...`), override 적용, query 없을 때 `?` 미부가.
   - e2e: 기존 fake-upstream sideband e2e 하네스 재사용, 클라이언트가
     프록시 `/v1/realtime?intent=quicksilver&model=test` 로 WS 연결 → 101 +
     업스트림이 받은 URL 이 `/v1/realtime?intent=quicksilver&model=test` 임을 assert
     + 양방향 프레임 릴레이.
   - e2e: frameless standalone `/v1/live?model=test` 동일 검증.
   - 인증/오리진: standalone upgrade 의 무인증 401, non-local Origin 403.
   - non-WS `GET /v1/live` 404 유지 (기존 :414 케이스 보존 확인).
   - loopback listener: standalone 두 경로 WS 허용, 그 외 `/v1/*` 거부 유지.
   - keyed: `POST /v1/live` (API-key provider) → upstream 요청 URL 이
     `/v1/live` (AVAS 없음) 임을 assert; `POST /v1/realtime/calls` 는 기존 유지.

### OUT of scope

- G2 (call_id sideband 의 강제 `intent=quicksilver`) 변경 — live smoke 게이트 필요.
- push / release / 맥북 배포 (`~/Developer/opencodex` 갱신, ocx 재시작) — 별도 승인.
- RealtimeV2 semantic 해석 — transport passthrough 만 (기존 방침 유지).

## Verifier (P 단계 실측)

- `bun test tests/server-live.test.ts` — baseline 29 pass / 0 fail (bun install 후
  실측). 변경 파일을 직접 import 하므로 target 을 읽는다.
- `bun run typecheck` — 전체 strict tsc.
- (관련 서브셋) `bun test tests/` — D 전에 전체 스위트.

## Activation scenario (C-ACTIVATION-GROUNDING-01)

새 경로는 standalone WS upgrade 라는 조건부 분기다.

1. TRIGGER: e2e 테스트에서 fake upstream WS + 실제 프록시 upgrade 로
   `/v1/realtime?intent=quicksilver&model=...` 연결을 구동.
2. OBSERVE: fake upstream 이 수신한 request URL/헤더 + 클라이언트↔업스트림
   양방향 프레임 도착을 assert 로 읽는다 (101 + 첫 프레임).
3. live 증거 (A2: MANDATORY): 이 머신의 ocx 설정으로 패치된 프록시를 테스트 포트에
   띄우고 실제 OpenAI 업스트림까지 연결해 `session.created` 류 이벤트 수신을
   시도. ChatGPT 토큰이 api.openai.com standalone realtime 에서 거부되면
   (401/403 relay) DONE 불가 — 그 증거를 기록하고 backend-shape 대체 경로를
   P amendment 로 판단 (P 복귀).

## Loop spec

- Archetype: spec-satisfaction repair.
- Trigger: 보이스 채팅 404.
- Goal: 앱의 standalone realtime WS 가 프록시를 통과해 업스트림에 연결.
- Non-goals: G2, 배포, push.
- Verifier: 위 테스트/타입체크 + e2e activation.
- Stop: 테스트+typecheck 그린 + e2e activation 증거.
- Memory artifact: 이 디렉토리 (D 기록은 010_ 접두사 record doc).
- Terminal outcomes: DONE / BLOCKED(업스트림 인증 거부) / NEEDS_HUMAN.
- Escalation: live smoke 에서 업스트림 인증 거부가 나오면 P 로 복귀해
  backend-shape 대체 경로 재계획.

## Commit plan

1. `fix(server): relay standalone realtime websocket sessions (/v1/realtime, /v1/live)`
   — parser/builder + 테스트.
2. `fix(server): route API-key Frameless call-create to /live without AVAS` — G3.

push 는 승인 없이 하지 않는다.
