# Source contract and observed boundaries

This is protocol research, not a billing diagnosis.

## Native reference anchors

- `codex-rs/core/src/client.rs:165-169`: HTTP Lite header `x-openai-internal-codex-responses-lite`; WS key `ws_request_header_x_openai_internal_codex_responses_lite`.
- `client.rs:905-924`: Lite selects reasoning context `all_turns`.
- `client.rs:938-985`: Lite tool/instruction layout belongs to the native client, not the proxy transport.
- `client.rs:1132-1146`: routing hint uses the outgoing model and service tier.
- `client.rs:1332-1355`: the HTTP path emits Lite via request headers.
- `client.rs:1501-1556`: successful same-session connections can be reused; endpoint change or closed connection reconnects.
- `codex-api/src/rate_limits.rs:23-103,135-178`: header families and `codex.rate_limits` contain provider-reported state.
- `codex-api/src/endpoint/responses_websocket.rs:756-784`: metadata and quota events are processed separately from Responses items.

## Local boundaries

- `src/adapters/openai-responses.ts:36-54` has the genuine-caller header allowlist; canonical credential forwarding is separately gated in `buildRequest`.
- `src/server/responses/fetch-helpers.ts:66-88` selects the final URL/body/headers and existing HTTP fallback.
- `src/server/responses/ws-upstream.ts` currently creates one socket per request, emits a synthetic SSE Response on open, and drops non-Responses metadata events.
- `src/server/responses/core.ts` captures selected auth provenance and applies observed response headers to that account; transport must not select or refresh credentials itself.
- `src/server/relay.ts` owns the bounded inspection callback sequence. Add no second body reader and no unbounded tee.
- `src/lib/optional-shutdown-hooks.ts` is the existing teardown seam; activating a transport pool must not introduce a Lab import.

## Evidence interpretation

Earlier isolated read-only probes established header/metadata loss and identical tiny-request token counters with/without Lite. They did not establish any billing cause. Regressions must therefore assert actual wire fields and state transitions, not expected money or percentage movement.

The initial tests intentionally asserted that WS-only quota events were dropped. Replace that obsolete behavior assertion with stronger checks of safe metadata preservation, request ownership and bounded processing; retain framing, abort, overflow and HTTP fallback assertions.

No current public API lets a transport helper distinguish an arbitrary stable conversation from a caller-supplied string on its own. Reuse must additionally bind the selected outbound credential/account and all immutable handshake policy; missing identity means one-shot operation rather than cross-request guessing.
