# Source comparison

Pinned upstream: openai/codex b01c3986fd2e79b8a477a08d81430f52f22bc0dc (2026-09-07 UTC).
The local corpus is `/Users/jun/Developer/codex`; its 120 and 121 upstream checkouts had older
working heads, so the named commit was fetched without modifying their worktrees.

- https://github.com/openai/codex/commit/1b53f6a44eff890b5169bde8d3bd5b12b8766946:
  local voice helper offer/answer, ordered oai-events data channel and UDP/TCP transport.
- https://github.com/openai/codex/commit/b01c3986fd2e79b8a477a08d81430f52f22bc0dc:
  feature-gated TUI voice commands, captions, handoff answer delivery and lifecycle cleanup.
- `codex-rs/codex-api/src/endpoint/realtime_call.rs` at the pinned head:
  backend JSON and API multipart call creation, Frameless `/live`, AVAS `/realtime/calls`.
- OpenCodex `src/server/live.ts` already implements these call-create and sideband shapes;
  `src/server/index.ts` transparently relays frames and bounds pending queues and teardown.
- `tests/server/server-live.test.ts` already covers call creation, protocol headers, pool identity,
  sideband joins and frame delivery. Existing implementation is reused, not duplicated.

Fast-tier display text and local audio negotiation do not demonstrate a proxy latency gain.
The TUI merge date does not establish when a desktop binary shipped. Live microphone/audio
verification is outside the automated evidence gathered here.

The Fast-tier metadata commit is 0e0f55fc4ec9308840e54ceba1f1f1dc9547380f,
2026-09-04T00:12:18Z; it changes only `codex-rs/models-manager/models.json`.
It describes the supported service tier, not OpenCodex voice transport performance.
