# 037 — Ticket #28: WebSocket bridge parity

Unit: `260905_go_sidecar_takeover`
Date: 2026-09-06
Ticket: [#28](https://github.com/waxiangzi/opencodex/issues/28)

## Scope discipline

This increment covers Responses WebSocket *frame production* only. Public
handshake admission, origin policy, capacity, socket ownership, cancellation,
logging and provider routing remain in Bun. Realtime/Live sockets and direct
provider WebSocket transport are outside this ticket.

## Design decision

We chose **(b), a Bun front door that forwards one authenticated client turn to
a Go loopback WebSocket endpoint**. Bun cannot transfer its accepted client
descriptor to another process and the Go standard library has no server
WebSocket package. The front door therefore retains the browser/Codex socket;
Go implements the small RFC6455 handshake/frame subset with the standard
library and calls a private parent bridge for the existing Responses pipeline.
It then emits the text and error frames that Bun copies unchanged to the
client. This proves Go produced the observable framing while retaining the
existing authority boundary.

The route requires the per-activation parent request token. Go→parent calls
require the distinct bridge token. Neither hop carries an API key, cookie, or
other client credential. `OPENCODEX_GO_WS_BRIDGE=1` is independent and
default-off; it requires an attached sidecar. Failed bridge startup produces a
retryable frame before any provider turn begins.

## Security boundary

The Go listener remains loopback-only and 404s requests without the request
token. The private parent bridge verifies its bridge token. Maximum client and
Go text frames are 50 MiB, matching Bun's Responses WS policy. No payloads or
credentials are logged.

## Proof (as landed)

- Go's RFC6455 endpoint accepts a masked text request only after token-gated
  upgrade, calls the parent bridge, and emits one text frame per SSE data
  block, terminal stop behavior, JSON event synthesis, and structured errors.
- The Bun differential boots an in-process oracle and an attached Go sidecar,
  captures every client text frame, and compares each UTF-8 payload byte for
  byte across SSE, JSON, upstream error, malformed/incomplete streams and a
  large frame.

## Delivery notes (filled in at close)

- Implementation keeps normal WebSockets on the existing Bun path unless the
  explicit Go WS gate is enabled. Direct streaming relay, multi-turn cancel
  propagation and Realtime/Live ownership remain for follow-up tickets.
