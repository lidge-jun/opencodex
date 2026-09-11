# 010 — GPT-Live 400 root cause: dropped Frameless protocol headers

Unit: 260724_gpt_live_hotfix / WP1
Base: `dev` @ `9f953d8e` (PR #379 merged)
Status: B implemented, verified locally (66 pass in server-live/server-auth)

## Symptom

GUI log `ocx-mrygl56k-6` (2026-07-24 13:47 KST): `POST /v1/live` relayed to ChatGPT
backend returns 400 `invalid_request_error` in ~743ms. Direct curl probing showed the
backend demanding `Field session must be an object` and `session.type: "quicksilver"`
when `intent=quicksilver` — i.e. it was validating our forwarded call-create as a
**v1 quicksilver** session.

## Root cause

The Frameless (v3 / GPT-Live) session JSON legitimately has **no `type` field**
(upstream `codex-rs/codex-api/src/endpoint/realtime_websocket/methods_frameless_bidi.rs`
`session_json`, lines 45-89: `{instructions, audio.output.voice, delegation:{type:"client"},
model?, initial_items?}`). Protocol selection is carried by the **request header**
`openai-alpha: quicksilver=v2` (Frameless) vs `quicksilver=v1` (V1) —
`codex-rs/core/src/realtime_conversation.rs:1595-1601` `realtime_request_headers` — plus
`x-session-id`, `session-id`/`thread-id` (`codex-api/src/requests/headers.rs`),
`originator` (`login/src/auth/default_client.rs`), and `x-oai-attestation`
(`core/src/client.rs:661`).

opencodex `resolveLiveRelay` built outbound headers **only** from provider headers +
pool auth, dropping every client protocol header on both the call-create POST and the
sideband WS upgrade. Without `openai-alpha: quicksilver=v2` the backend fell back to v1
validation and rejected the type-less Frameless session → 400.

Contract verified against the app-bundle runtime tag `rust-v0.146.0-alpha.3.1`
(`ff75c5b93`) and GitHub `main` (`f61b51ddd`): `realtime_call.rs`,
`methods_frameless_bidi.rs`, `realtime_conversation.rs` byte-identical to local checkout
HEAD `4462b9dee`. Sol subagent claim-ledgers (call-create headers, sideband WS contract)
confirmed: Frameless sideband sends **no** post-join `session.update`; call id parsed from
the `Location` response header; no `Sec-WebSocket-Protocol` used.

## Fix (src/server/live.ts, src/server/auth-cors.ts)

- `LIVE_CLIENT_PROTOCOL_HEADERS = [openai-alpha, x-session-id, session-id, thread-id,
  originator, x-oai-attestation]` forwarded verbatim on call-create and sideband upgrade
  (shared `resolveLiveRelay`), seeded **before** provider/auth headers so proxy-owned
  `authorization`/`chatgpt-account-id` always win.
- Explicitly NOT forwarded (reviewer-audited): `x-openai-fedramp` (account-claim-derived;
  contradictory in pool mode, upstream `model-provider/src/auth.rs:108`),
  `x-openai-internal-codex-residency`, cookies, `host`, `origin`, `user-agent`.
- CORS `Access-Control-Allow-Headers` extended with the six headers for browser/Electron
  voice preflights.

## Audit trail

Independent reviewer (sol) 3 rounds: R1 FAIL (missing x-oai-attestation + CORS),
R2 FAIL (fedramp must stay pool-derived), R3 PASS on final six-header scope.

## Tests

`tests/server-live.test.ts`: forwarded-headers assertion (present → relayed, fedramp
blocked, auth pool-owned), absent-stays-absent, sideband WS upgrade header capture,
CORS preflight allow-list. 66 pass / 0 fail with `tests/server-auth.test.ts`.

## WP2 smoke result (2026-07-24, service pid 79964 on this tree)

`POST http://127.0.0.1:10100/v1/live` with a real opus WebRTC offer +
Frameless session `{model:"gpt-live-1-boulder-alpha", instructions, audio.output.voice:"cove",
delegation:{type:"client"}}` + header `openai-alpha: quicksilver=v2`:

- **201 Created** in ~0.5-0.8s, real SDP answer (ice-lite, fingerprint, ufrag),
  `Location: /v1/realtime/calls/rtc_u0_E52xSxAjvyO0yAcpamyDl`.
- Control without the alpha header: **403 "Voice session access denied"** — the
  forwarded header is exactly what unlocks the backend.
- `model:"gpt-realtime"` rejected with `session.model not allowed` (backend expects the
  gpt-live model family); malformed-CRLF SDP gave `invalid_offer` — both errors are
  post-session-validation, confirming the old session-shape 400 is gone.
- Note for GUI-log readers: the pre-fix failure `ocx-mrygl56k-6` (400, 743ms) came from
  the Codex App sending its normal headers which the proxy dropped; the fix relays them.

Gates on this tree: typecheck exit 0; full suite 4024 pass / 0 fail; privacy scan pass.

## Remaining (WP3)

- Push `dev`, promote `preview`/`main`, npm release (version chosen live at
  release time; 2.7.36/2.7.37 burned-status re-verified then).
