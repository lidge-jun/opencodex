# 260903_voice_sideband_regression — 000 research

## Symptom (2026-09-03, live evidence)

- ChatGPT.app (bundled codex-cli 0.153.0-alpha.5) voice session:
  `Realtime voice session failed ... message="unexpected status 404 Not Found: realtime websocket handshake failed"`
  — app log `~/Library/Logs/com.openai.codex/2026/09/03/codex-desktop-7bd4860e-...-t0-i1-000150-0.log`
  lines 12425-12491 (two attempts, 11:29:04Z and 11:29:18Z).
  Transport line: `Starting realtime voice transport clientOwnsCall=false ... model=gpt-live-1-codex ... version=v3`,
  sideband line: `Starting realtime voice app-server sideband ... transport=webrtc`.
- Proxy usage log (`~/.opencodex/usage.jsonl` 627511/627513): two `gpt-live` requests, `status:201`,
  provider `openai-p3b640f` (a POOL account, not the app's own login). No `gpt-live` `status:101`
  (sideband upgrade) since 2026-07-29 (line 294981).
- `~/.codex/config.toml` line 10: `openai_base_url = "http://127.0.0.1:10100/v1"` (marker-owned, Design B).
  No `experimental_realtime_ws_base_url` present.
- App auth (`~/.codex/auth.json`) account hash `c602fb19` != every pool account hash in
  `~/.opencodex/codex-accounts.json` (the four active: d1f8d4d6 / c6a3378e / 6eff99ad / f462cf1e).

## Upstream contract (openai/codex main 728cb12fe, pulled 2026-09-03 into ~/Developer/codex/121_openai-codex)

1. `codex-rs/core/src/realtime_conversation.rs:1189-1206` — for `Webrtc` transport the sideband base is
   `config.experimental_realtime_ws_base_url` only; when unset the `RealtimeWebsocketClient` default applies.
2. `codex-rs/codex-api/src/endpoint/realtime_websocket/methods.rs:60,784` —
   `OPENAI_REALTIME_API_BASE_URL = "https://api.openai.com/v1"` is that default (since 438c9e98d / PR #35830,
   2026-07-28: "Use https://api.openai.com/v1 for WebRTC sideband websocket joins instead of deriving the URL
   from the model provider"). `normalize_realtime_path` (L1163-1172) maps FramelessBidi to `/v1/live/{callId}`.
3. `codex-rs/core/src/client.rs:726-754` — call-create goes through the model provider (= `openai_base_url`
   = the proxy) and the sideband reuses `sideband_websocket_auth_headers(client_setup.api_auth)`, i.e. the
   APP'S OWN token, sent straight to api.openai.com.
4. `codex-rs/codex-api/src/endpoint/realtime_call.rs:66-79` — API shape (non backend-api base) posts
   `{base}/live` for FramelessBidi; `decode_call_id_from_location` (L259) reads the `Location` header.
5. `codex-rs/config/src/config_toml.rs:404-408` — `experimental_realtime_ws_base_url` and
   `experimental_realtime_webrtc_call_base_url` are root keys; `config/src/loader/mod.rs:85-86` denies them
   only for PROJECT-LOCAL layers; user `~/.codex/config.toml` is honored.
6. `codex-rs/app-server/src/request_processors/turn_processor.rs:1232-1240` — desktop `Webrtc` transport
   never sets a per-call `sideband_base_url` (that override, PR #41923 34c4f7e72, exists only for
   `ExistingCall`).

Net: call-create is answered by pool account X (proxy choice); the sideband join goes to
api.openai.com with the app's own account Y. The call does not exist for Y → 404. Upstream's own tracker
has the same shape: openai/codex#35094 ("Realtime V3 WebRTC call succeeds, sideband WebSocket returns
404 call_id_not_found", 2026-07-24). Independent proxies (Aether WebSocket-Mode.md) document the same
rule: call-create and sideband must share origin + credential.

## Upstream commits since 94cbbddaf (local clone was at 2026-08-30) touching voice

- 34c4f7e72 #41923 per-call sideband endpoint for ExistingCall (no effect on desktop Webrtc path)
- 64c9cde45 #41924 realtime history in Core (new RealtimeEvent::History* variants; transparent relay unaffected)
- e1d0ef995 #42377 app-server realtime always available (feature flag removed)
- deb147116 / dc0dc4f15 / eb10d91e4 / 8d01cd42f / 8813bd4b0 / 13bc770ea / d60560f14 / 65237aeca / fc7d34ad6 / 379d50be3
  — third_party/voice helper runtime (local STT/TTS host), not a wire-contract change for the proxy.

## Why the previous fixes did not cover this

- 260724_gpt_live_hotfix (PR #379) added `/v1/live/{callId}` sideband relay on the proxy — correct, but the
  client stopped sending the sideband to the provider base four days later (438c9e98d).
- 260812_realtime_standalone_ws fixed the STANDALONE WebSocket transport (`GET /v1/realtime?intent=...`).
  The desktop now uses WebRTC v3 again (`transport=webrtc`), which is the sideband path.

## Fix options

A. (chosen) `ocx start` injects `experimental_realtime_ws_base_url` (marker-owned, same value as
   `openai_base_url`) so the sideband upgrade comes back to the proxy. The proxy already relays
   `GET /v1/live/{callId}` → `wss://api.openai.com/v1/live/{callId}` with pool auth
   (`src/server/live.ts:238-247, 348-368`). Both legs then run under the proxy-selected account, and
   `codexPoolAffinityKey` (`src/codex/auth-context.ts:84-98`, keyed on `session-id` + `thread-id` which
   codex-rs attaches via `build_session_headers`) keeps them on the same pool account.
B. Also inject `experimental_realtime_webrtc_call_base_url` — unnecessary: call-create already follows
   `openai_base_url`. Not injected (keeps the footprint to one key).
C. Proxy-side only (no config change) — impossible: the client never contacts the proxy for the sideband.

## Risks / residuals

- Upstream key is named `experimental_*`; if renamed the injected line becomes a no-op (fails back to the
  current broken state, not worse). Test pins the exact key.
- Users on a hand-written `openai_base_url` (user-owned) are already not injected; the new key follows the
  same ownership rule (never overwrite a user-owned value).
- The proxy's `loopbackRouteAllowed` (`src/server/index.ts:819`) allows WS upgrades on `/v1/realtime` and
  `/v1/live` only, NOT `/v1/live/{callId}`; a directly spawned app-server on the unauthenticated loopback
  listener would still 404 the sideband. Add the keyed paths for WS upgrades (020).

## Audit notes (Sol reviewer, PASS)

- `experimental_realtime_ws_base_url` redirects the sideband AND the standalone realtime WebSocket; it does
  NOT redirect WebRTC call-create (that follows `openai_base_url`; `experimental_realtime_webrtc_call_base_url`
  is the separate call-create override and stays un-injected).
- codex-rs snapshots sideband auth headers before call-create; both legs carry the same app identity.
- The app-server public Webrtc transport carries only `sdp` (`app-server-protocol/src/protocol/v2/realtime.rs:275`);
  no client-side field can redirect the sideband, so the config key is the only lever.
- With the override, the exact sideband URL is `ws://127.0.0.1:<port>/v1/live/{callId}` (methods.rs:1084/1129/1166).
