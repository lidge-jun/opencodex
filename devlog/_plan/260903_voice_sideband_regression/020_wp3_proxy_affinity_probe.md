# 020 — wp3: proxy-side sideband parity + same-account affinity + probe

## Goal
With the sideband now arriving at the proxy as `GET /v1/live/{callId}` (Upgrade: websocket, headers from
codex-rs `build_session_headers`: `session-id`, `thread-id`, plus the app's Authorization), prove both legs
select the same pool account and that the unauthenticated loopback listener admits the keyed join paths.

## Files
- `src/server/index.ts` `loopbackRouteAllowed` (L807-822): allow WebSocket upgrades on
  `/v1/live/{callId}` and `/v1/realtime/calls/{callId}` (regex `^/v1/(live|realtime/calls)/[^/]+/?$`) and
  `/v1/realtime?call_id=`; plain HTTP on those paths stays 404. Same trust model as the existing
  `/v1/realtime` / `/v1/live` upgrade allowance (260812 A1).
- `src/server/live.ts`: no URL change needed (`buildLiveSidebandUpstreamWsUrl` already targets
  `wss://api.openai.com/v1/live/{callId}`). Add a comment block tying the design to 438c9e98d and to the
  injected override. Keep `LIVE_CLIENT_PROTOCOL_HEADERS` (session-id/thread-id are relayed verbatim).
- Affinity: `resolveLiveRelay` → `resolveFirstUsableOpenAiSidecar` → `codexPoolAffinityKey(headers)`
  (`src/codex/auth-context.ts:84-98`). The key is derived from `session-id` + `thread-id`; both legs carry
  the same pair, so the binding created on call-create is reused on the sideband. Regression test only.

## Tests
- `tests/server-live.test.ts` (or new `tests/live-sideband-affinity.test.ts`): two pool accounts
  configured; POST `/v1/live` with headers {session-id: S, thread-id: T} → record upstream account A;
  then WS upgrade `GET /v1/live/rtc_x` with the same headers → assert upstream auth is account A.
  Negative: different thread-id may pick a different account (no assertion on which).
- `tests/loopback-listener-admission.test.ts`: WS upgrade on `/v1/live/rtc_x` admitted (not 404);
  `GET /v1/live/rtc_x` without Upgrade → 404.

## Probe (isolated, never port 10100)
`OPENCODEX_HOME=$(mktemp -d) bun run src/cli/index.ts start --port <scratch>` with a copied pool credential
is NOT allowed (auth files out of scope). Instead run the in-process server test harness with a fake
upstream WebSocket (`experimentalRealtimeWsBaseUrl` pointing at a local ws server, as
`tests/native-profile-drain-server.test.ts:211` does) and assert the relayed upgrade URL is
`/v1/live/rtc_x` and the request reached the fake with pool auth. Record transcript in 021.

## Checks
`bun run typecheck`; `bun test tests/server-live.test.ts tests/loopback-listener-admission.test.ts tests/live-sideband-affinity.test.ts`.
