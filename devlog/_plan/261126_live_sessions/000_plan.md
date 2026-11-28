# Public GPT-Live sessions (/v1/live/sessions)

The coordinator chose to build this in Lane L and leave it unmerged (decision c1786517, 2026-11-26). It adds new public endpoints and an outbound credential route, so it needs maintainer sign-off before it can merge.

## Why

OpenAI's public GPT-Live API, read 2026-11-26, creates a WebRTC session with `POST /v1/live/sessions`. The request body is JSON `{ session: { model, ... }, transport: { type: "webrtc", sdp } }`, and the answer is `201 { session: { id }, transport: { type, sdp } }`. A WebSocket session opens `wss://api.openai.com/v1/live/sessions` and sends `session.start` first. A server-side control connection attaches with `wss://api.openai.com/v1/live/sessions/{id}/attach`. The public models are `gpt-live-1` and `gpt-live-1.1`, and the default voice is `marin`.
Sources: developers.openai.com/api/reference/resources/live/methods/create.md, guides/voice-webrtc.md, guides/voice-websockets.md, guides/voice-server-controls.md.

The existing OpenCodex `/v1/live` endpoint mirrors Codex's Frameless wire, so official SDK clients pointed at OpenCodex currently get 404. Codex itself does not use `/v1/live/sessions`.

## Change

| File | Change |
| --- | --- |
| src/server/audio-live-sessions.ts (new) | handles `POST /v1/live/sessions` for external audio keys: bounded JSON (1 MiB), `session.model` required, WebRTC transport with an SDP offer required, SIP refused. Uses the configured OpenAI API-key provider only, so a ChatGPT account is never substituted. The key's model scope is judged on `session.model`. Relays to `{provider base}/live/sessions` with the provider credential and the documented client headers (including `OpenAI-Safety-Identifier`), with manual redirects and a capped answer. The upstream session id is replaced by an `rtc_ocx_` alias bound to the creating key |
| src/server/live.ts | target styles `live-session-start` and `live-session` (attach), with the upstream WebSocket URLs `/live/sessions` and `/live/sessions/{id}/attach`. The native resolver never receives them |
| src/server/audio-live.ts | external sockets for those targets use the API-key provider only. A fresh session socket names its model in band, so it is an unnamed destination (stacked on the scope-alignment PR). An attach is judged on the model recorded for its session |
| src/server/live-call-bindings.ts | join style `live-session` |
| src/server/index/serve-options.ts, src/server/index.ts, src/server/inbound-body-admission.ts | route the POST, refuse requests without an external audio key (401), add the loopback route allowance, and list the path in the ungated loopback route set |
| tests/server/audio-live-sessions.test.ts (new) | fake HTTP and local WebSocket upstreams: create and alias, request validation and SIP refusal, no ChatGPT substitution, scope, native refusal, session socket, attach only by the creating key |

## Checks

The 8 new tests fail on the previous source and pass here. Also run: typecheck, the focused audio and live suites, structure:check, privacy:scan, and the docs, test-layout and file-size guards. NOT RUN: any call to OpenAI's GPT-Live API.

