# 011 — Realtime surface (local codex-rs + app-server README)

- Upstream tip measured: `4462b9dee` in `/Users/jun/Developer/codex/120_codex-cli`
- Primary local docs: `codex-rs/app-server/README.md`
- Primary code: `codex-rs/core/src/realtime_conversation.rs`, `codex-rs/app-server-protocol/src/protocol/v2/realtime.rs`, `codex-rs/protocol/src/protocol.rs`, `codex-rs/codex-api/src/endpoint/realtime_call.rs`

## App-server methods (experimental)

From local README:

- `thread/realtime/start`
- `thread/realtime/appendAudio`
- `thread/realtime/appendText` (role required: user/developer/assistant; older clients default user)
- `thread/realtime/appendSpeech`
- `thread/realtime/stop`

Notifications (ephemeral; not returned by `thread/read|resume|fork`):

- `thread/realtime/started` — `{ threadId, realtimeSessionId }`
- `thread/realtime/itemAdded`
- `thread/realtime/transcript/delta|done`
- `thread/realtime/outputAudio/delta`
- `thread/realtime/error|closed`
- `thread/realtime/sdp` for WebRTC answer SDP

## Protocol versions

`RealtimeConversationVersion` in `protocol.rs`:

- `V1` legacy Bidi handoffs (`conversation.handoff.*`)
- `V2` Realtime Voice API (default enum)
- `V3` Frameless Bidi / `delegation.*` while preserving Codex Voice behavior

WebRTC: supported for v1/v3; **v2 WebRTC rejected**.

## Important fields / behaviors measured in source

- `realtimeSessionId` is upstream Realtime API session id, not Codex thread-group id.
- V3 can seed `initial_items` / `initialItems` at session start (max count enforced in core).
- Session start can attach headers including `x-session-id` when a realtime session id is present (`realtime_conversation.rs` header insert path).
- Handoff controls: `client_managed_handoffs`, `codex_responses_as_items`, `codex_response_handoff_mode` (`thinking|commentary|bemTags`), configurable BEM channel prefixes (recent commit `4ebd97631`).
- Crate `realtime-webrtc` removed on current tip; WebRTC path still documented via transport params in app-server.

## Recent related commits (local log slice)

- `963cda85a` session headers on realtime starts
- `312caf176` seed realtime V3 initial text items
- `025db2205` route realtime V3 handoffs by response channel
- `2e1607ee2` Frameless Bidi support
- `b93dcf341` remove unused realtime WebRTC crate

## OpenCodex boundary

OpenCodex is a Responses-compatible local proxy. Realtime app-server methods are **not** implemented by OpenCodex. Relevant proxy obligations:

1. Unknown `/v1/*` paths must JSON 404 (already in `src/server/index.ts` comment + handler) so codex-rs clients do not parse HTML.
2. Do not feature `gpt-realtime*` as ordinary subagent models.
3. Do not claim voice passthrough through the Responses proxy without a dedicated design.
