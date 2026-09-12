# Streaming dictation and external live voice

Depends on wp1 audio upstream resolution. Preserve existing Codex transport exports and native integrations.

## File changes

| Operation | Path | Contract change |
| --- | --- | --- |
| NEW | src/server/audio-dictation.ts | exact streaming route, canonical upstream URL/protocol construction and bounded session policy |
| NEW | src/server/live-call-bindings.ts | per-server bounded expiring call ownership, keyed by opaque call id and admission owner |
| MODIFY | src/server/live.ts | bind successful call-create to its resolved upstream; join via binding; proxy Bearer credential support; default V3 model/negotiation only on standalone /live when absent |
| MODIFY | src/server/index.ts | route dictation upgrades through existing bounded WebSocket bridge; thread lifecycle metadata and close cleanup |
| MODIFY | src/server/ws-bridge.ts | add only necessary session protocol/expiry fields to WsData |
| MODIFY | src/server/auth-cors.ts | advertise only HTTP call-create rows; WebSocket admission is separate audio metadata |
| MODIFY | tests/server/api-key-attribution.test.ts | valid SDP multipart fixtures for HTTP call-create matrix rows; WebSocket auth is tested by real upgrades in audio/server-live tests |
| NEW | tests/server/audio-dictation.test.ts | mock WebSocket upstream with real JSON audio events and close/cancel checks |
| MODIFY | tests/server/server-live.test.ts | external Bearer key and call-owner/session lifecycle regressions |
| MODIFY | scripts/test-layout/layout.json | register dictation test in server domain |
| MODIFY | tests/fixtures/test-layout-expected.json | matching expected test path |
| MODIFY | structure/data-planes/inbound-compat.md | document streams, ownership and source/test contract |
| MODIFY | docs-site/src/content/docs/reference/proxy-formats.md | document distinct dictation and GPT-Live wire examples and limitations |

## Before / after contracts

Before: existing native HTTP and WebSocket voice relay has no exported dictation transport. After: WS /v1/audio/transcriptions/stream resolves ChatGPT auth on the server and connects to wss://chatgpt.com/backend-api/dictation/stream with the observed chatgpt-dictation, openai-bearer token, codex-desktop subprotocols. Upstream token remains confined to server WebSocket construction, never the downstream selected protocol or errors. The route is explicitly an OpenCodex extension, not public Realtime API compatibility.

Client uses observed session.start/config, audio append and session.close shapes; server events include session.started, transcript.segment/final and session.updated closed. Preserve text frames without UTF-8 reframing. Reuse existing pending-frame and frame-byte limits, add finite session lifetime consistent with five-minute desktop contract, and close both directions on error/abort/shutdown. Unsupported keyed-only dictation reports an actionable unavailable response. No automatic replay after audio has been accepted.

Observed dictation audio is JSON {type: "audio.append", audio: "BASE64_PCM16"}; mono PCM16 uses the actual sample_rate_hz supplied by the client. transcript.segment/final revisions replace prior text for the same utterance_id. Closing acknowledgment is session.updated with session.status=closed. The requested limits are client policy, not proven upstream maxima. For browser clients the downstream protocol pair is opencodex-audio plus opencodex-key.<proxy-key>; only opencodex-audio can be selected back. Explicit HTTP admission headers retain precedence. Never accept this carrier on ordinary Responses routes.

Live call-create keeps SDP/multipart conversion and Location response. A successful call stores a bounded per-server binding to the resolved account/provider and caller admission identity for follow-up joins. Never retain raw client API keys in persisted state; no persistence is needed. Follow-up requests authenticate again, reject mismatched/expired owners, and cannot change the selected account. Existing native clients using the same local/session identity retain their workflow. Validate invalid Location before reporting usable creation.

Bindings survive sideband disconnect for bounded reconnect; server shutdown clears them. Resolve the recorded exact account before join, preserving physical account identity across credential refresh. Tagged ownership distinguishes configured key ID, environment admission and legacy loopback native session. Unknown calls are rejected for proxy-key clients; any native externally-created-call compatibility must remain limited to explicit caller-auth and documented separately. Reuse the existing socket bridge within the composition root for this layer; extracting all legacy socket machinery is optional and requires its own regression evidence.

Live resolves a presented proxy key before the global loopback shortcut, so a key-owned call remains configured-key owned on both listeners. Invalid explicit proxy credentials fail closed. Legacy native callers with no proxy key retain loopback/session identity only under existing local policy and cannot join configured-key-owned calls. The registry's tagged owner prevents any equality between native loopback and configured key IDs. Test same and different key joins on both primary and companion listeners. Do not add WS paths to the existing HTTP-only AUTH_MATRIX; advertise those through wp3 audio metadata and prove header/protocol admission with actual WebSocket upgrades.

For external proxy-key call-create, return a proxy-relative Location /v1/live/<validated-call-id> (or the matching realtime/calls form). Never return an absolute upstream Location to a proxy-key client. The upstream WebSocket destination is independently selected from trusted config, not from Location. Native legacy response compatibility remains scoped to its existing explicit caller-auth contract. A regression follows the returned relative Location with the creator key and checks the recorded account after pool rotation.

Standalone WS /v1/live accepts an explicit model or defaults to gpt-live-1-codex, with gpt-live-1 as documented alias if implemented. Missing V3 negotiation is added only to this Frameless path. /v1/realtime preserves its current adapter semantics. A raw live client receives delegation events; proxy does not execute tools or fabricate delegation results.

WsData fields are created at server.upgrade, serialized only by Bun in process, read at open/message/close, and disposed at relay closure; no disk reviver. Call binding types are in-memory only. Public query/model and protocol inputs are validated at ingress; no secret-bearing URL query authentication is added.

## Acceptance and checks

1. Synthetic streamed PCM JSON reaches the mock upstream under server-owned auth; transcript events reach the client byte-for-byte.
2. Wrong key/origin, malformed start/audio, large frames/pending data, missing ChatGPT capability: fail before further forwarding.
3. Session close, disconnect before upstream opens, expired session and upstream refusal: both sockets, timers and leases settle.
4. Two configured keys and two upstream accounts: creator can join even after pool selection changes; other key cannot join; unknown/expired binding fails.
5. Existing native sideband forms and standalone V1/V3 remain covered; HTTP SDP forwarding retains status/content-type and returns the documented proxy-relative Location for external clients.

Commands: bun test tests/server/audio-dictation.test.ts tests/server/server-live.test.ts; bun run typecheck; bun run structure:check; bun run privacy:scan. New paths are NOT RUN until implemented. Real socket fixtures observe the actual branch and cleanup, not only helper return values.
