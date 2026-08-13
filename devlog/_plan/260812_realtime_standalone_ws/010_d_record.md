# 010 D record — standalone Realtime WS relay (voice 404 fix)

Terminal outcome: **DONE** (수정 + 실환경 activation 증거 확보, 맥북 구동 프록시에 배포 완료).

## 원인 (확정)

ChatGPT/Codex 데스크톱 앱(26.803.41515, 번들 codex 0.147.0-alpha.6.5)의 보이스가
`thread/realtime/start` 의 standalone WebSocket transport 로 바뀌면서 call-create
(`POST /v1/live`) 없이 `GET /v1/realtime?...&model=gpt-realtime-1.5` 업그레이드를
직접 연다. opencodex는 call-create 와 `call_id` sideband join 만 인식했기 때문에
`/v1/*` unknown-endpoint guard(src/server/index.ts)가 JSON 404 를 반환했고,
앱은 "failed to connect realtime websocket: HTTP error: 404 Not Found" 를 표시했다.

- 앱 로그 verbatim 5건 (jun-macbookpro, 2026-08-12T14:23:16~14:26:01Z).
- 7/24 #371/PR #379 구현은 당시 WebRTC call-create 계약만 커버.
- codex-rs 기본 버전은 RealtimeV2 (protocol.rs, 4월 이후 불변) — intent 없는
  `/v1/realtime?model=` shape 가 기본 경로.

## 수정 (브랜치 codex/260812-realtime-standalone-ws)

- `022f6c0b3` fix(server): relay standalone realtime voice websockets
  - `parseLiveSidebandTarget`: standalone `/v1/realtime`, `/v1/live` 인식
    (raw query 보존, 무효 call_id 는 계속 거부)
  - `buildLiveSidebandUpstreamWsUrl`: standalone → canonical realtime root 매핑
  - `sanitizeStandaloneRealtimeQuery`: credential-shaped query key denylist
  - loopback listener allowlist: 두 standalone 경로 WS-upgrade 한정 허용
  - 테스트: parser/builder/query-policy 단위 + 두 경로 standalone e2e +
    인증/오리진 가드 + loopback admission
- `304fa003d` fix(server): route API-key Frameless call-create to /v1/live without AVAS
  (G3 — keyed `POST /v1/live` 가 항상 AVAS `/v1/realtime/calls` 로 가던 divergence)

## 검증 증거

- `bun run typecheck` — exit 0.
- `bun test tests/server-live.test.ts tests/loopback-listener-integration.test.ts` —
  58 pass / 0 fail (baseline 29 pass 에서 신규 29 케이스 포함).
- `bun run privacy:scan` — passed.
- 전체 스위트(`bun run test`) — **사용자 지시로 생략** ("ci는 무시하면서 그냥 집어넣어",
  2026-08-12). CI 후속 확인 필요.
- Activation (A2 mandatory):
  - 로컬 패치 인스턴스(포트 10201, 실 자격증명):
    `GET /v1/realtime?model=gpt-realtime-1.5` → 101 OPEN → 업스트림
    `session.created` (sess_EC5eE4oDu52ooumzaapzG) → close 1000.
  - **맥북 실환경(재시작된 10100 프록시)**: 동일 요청 → 101 OPEN →
    `session.created` (sess_EC6485aD5ieSaH7X6TCPl) → close 1000.
  - `/v1/live?model=` (frameless standalone) 도 101 + 업스트림 연결 확인.

## 알아낸 업스트림 사실 (후속 참고)

- api.openai.com `/v1/realtime` + ChatGPT OAuth 토큰은 **intent 없이** 세션이 열린다.
  `intent=quicksilver` 는 이 조합에서 `invalid_intent`, `openai-alpha: quicksilver=v1/v2`
  헤더는 `invalid_translation_alpha_header` 로 거부된다. codex-rs 자체도 ChatGPT/SIWC
  세션의 standalone realtime 에 API key 를 요구한다
  (realtime_conversation.rs `realtime_api_key`, "temporary fallback").
- chatgpt.com `/backend-api/codex/v1/realtime` 는 standalone WS 핸드셰이크를 받지 않는다.

## 배포

- 맥북(jun-macbookpro) `~/Developer/opencodex`: git bundle 로 이식, dev 가
  `304fa003d` 로 fast-forward, launchd `com.opencodex.proxy` kickstart 재시작
  (PID 32590). voice 채팅 재시도 시 정상 연결 기대.
- origin push / PR 은 승인 전 미수행. 전체 스위트 + CI 확인 후 PR 권장.

## 잔여 (비차단)

- G2: call_id sideband 에 강제 `intent=quicksilver` 부가 — 기존 deliberate deviation
  유지 (live smoke 게이트 후 별도 단위).
- loopback listener 의 sideband join 경로(`/v1/live/{id}` 등)는 여전히 미허용.
- V1 quicksilver standalone 은 ChatGPT 토큰 조합으로 업스트림이 거부 — 프록시
  문제가 아니라 upstream auth semantics. API-key provider 로는 유효할 수 있음
  (미검증).
