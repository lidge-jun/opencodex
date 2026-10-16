# Incompatibility matrix: Codex realtime 6cfe29984..41acdad24 and Desktop 26.930.31730 vs opencodex

Each row is a request or behavior the current Codex clients produce, checked against opencodex at `fde8eebd61`. Status values: **confirmed-broken** (source plus runtime evidence), **ok** (opencodex relays it unchanged), **unresolved** (not proven either way; outside this unit unless stated).

| # | Client behavior | opencodex behavior | Status | Evidence |
|---|---|---|---|---|
| 1 | V3 `existingCall` sideband join `GET /v1/live/<call_id>` (WebSocket upgrade) for a call the client created itself: ChatGPT iOS remote 1.2026.266/267, and Desktop when the renderer owns the call (`clientOwnsCall`, creating it at `chatgpt.com/backend-api/wham/realtime/calls`) | Replaces the caller's `authorization`/`chatgpt-account-id` with a Pool-selected account; the call belongs to the caller's account, so the upstream handshake fails and opencodex answers 502 | **confirmed-broken** (overwrite confirmed; refusal cause inferred) | Codex `logs_2.sqlite` V3 ExistingCall starts with five 502 retries each; `~/.opencodex/usage.jsonl` twenty `gpt-live` 502 rows on two different Pool accounts, both unlike the 2026-09-30 working account; `src/server/live.ts` `resolveLiveRelay`; `src/providers/openai-sidecar.ts` Pool selection; Desktop `app-initial-576fc7ca620e.js:4605,4611` |
| 2 | V3 WebRTC call-create `POST /v1/live` through opencodex, then join on the same thread | Pool account chosen at create; thread affinity keeps the join on the same account | ok | `tests/server/server-live.test.ts` #35830 continuity case; 2026-09-30 201 then 101 on one account |
| 3 | `thread/realtime/listVoices` (#49073 now aborts voice on failure) | Not a network request: the app-server answers from a built-in list | ok | `codex-rs/core/src/session/handlers.rs:66`; `app-server/src/request_processors/turn_processor.rs:328` |
| 4 | V3 `backend_reasoning_status` (#47377) as `delegation.context.append` on `commentary` | Sideband frames relayed byte for byte, no event allowlist | ok | `src/server/index/websocket-handler.ts:146-183`; `src/server/index/live-sideband.ts:580-600` |
| 5 | `partial_answer` phase (#51241, #51260), per-request realtime context (#47596), transcript tail flush (#50531), stale answer filter (#47975), live tool-call metadata (#49401) | Client-local, or carried inside existing frames and Responses requests | ok | L3 report; no realtime serializer/parser file changed in the range |
| 6 | RTP timestamps on a 20 ms grid (#48824), microphone channel selection (#49836), device selection (#49437) | WebRTC media does not pass through opencodex | ok | `structure/data-planes/inbound-compat.md` (no media relay); `codex-rs/voice-host` |
| 7 | Realtime WebSocket network-policy errors (#47101 and follow-ups) | Client-side error mapping; loopback still dialed | ok | `codex-rs/codex-api/src/endpoint/realtime_websocket/methods.rs` diff |
| 8 | `in_app_voice` managed feature gate (#49683) | Requirements-only client gate | ok | commit `6996cde69` |
| 9 | Desktop 26.930.21537 → 26.930.31730 voice transport selection, start RPC, call-create endpoint and headers | No contract change found between the two bundles | ok (bounded) | L4 paired-bundle comparison |
| 10 | Provider-table injection mode and the Design B fallback file omit `experimental_realtime_ws_base_url` | Sideband would bypass opencodex in those modes | unresolved, out of scope | L7; the user's logs show the sideband reaching the loopback proxy |
| 11 | External audio-key create on the `/backend-api/codex/live` alias tests the raw path | Non-Frameless defaults for that alias | unresolved, out of scope | L5; affects opencodex audio keys, not Codex clients |
| 12 | Public GPT-Live API `/v1/live/sessions` family | Not used by Codex clients | out of scope | Aside report; Codex URL builders unchanged |
| 13 | Upstream handshake status behind opencodex's 502 | Bun hides the upstream handshake status; the precise upstream code (likely 404) is not recorded | unresolved | `src/server/index/live-sideband.ts` handshake failure mapping |

Row 1 is the only confirmed incompatibility and is the scope of `020_existing_call_join.md`.
