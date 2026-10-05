# 010 — Picker listener HTTP/2 (issue #6511)

## Problem

With Claude Desktop picker mode on, claude.ai chat stops loading. The reporter's same-process A/B
(issue #6511) isolates the cause: Desktop's `messages/stream` SSE subscriptions reach the picker
listener and receive headers in ~250 ms, six of them stay open, and every later claude.ai request
times out **before reaching the listener**. Blind tunnels (picker off, or reused pre-intercept
tunnels) recover in the same process; new intercepted connections re-break it.

Code pointer: `src/claude/intercept/picker-listener.ts` creates a `node:https` server with
`ALPNProtocols: ["http/1.1"]`. Chromium caps HTTP/1.1 connections per origin (6 per socket group,
which includes proxied CONNECT tunnels), and each open SSE response occupies one connection.
A blind tunnel negotiates HTTP/2 with Anthropic's edge, where all streams share one connection.
The listener is the only party that downgrades the origin to HTTP/1.1.

Picker mode is on by default for first-party Desktop on macOS (`pickerDesired`), so every such
user who has not opted out is affected once Desktop opens six streams.

## Change (diff level)

`src/claude/intercept/picker-listener.ts`
- Replace `https.createServer` with `http2.createSecureServer({ allowHTTP1: true, maxHeaderSize,
  settings: { maxHeaderListSize: PICKER_MAX_HEADER_BYTES } })`. ALPN becomes `["h2","http/1.1"]`.
  Chromium negotiates h2 and multiplexes every claude.ai request; WebSocket connections, which
  Chromium opens as HTTP/1.1 when the server does not advertise SETTINGS_ENABLE_CONNECT_PROTOCOL,
  and clients without ALPN fall back to the existing HTTP/1.1 handlers (`request` and `upgrade`).
- h2 request -> HTTP/1.1 upstream: drop pseudo-headers, add `Host` from `:authority` (default
  claude.ai) unless present, join cookie crumbs with "; " into one `Cookie`, keep everything else.
  Enforce the 64 KiB inbound header budget for h2 explicitly (431, no upstream, no log), matching
  the HTTP/1.1 contract.
- h2 response: no status message (HTTP/2 has none); raw header array passes through the compat
  `writeHead` (hop-by-hop headers are already filtered).
- `clientError`: write the exact `431 ... Connection: close\r\n\r\n` / 400 responses for parser
  errors (Bun's fallback string omits the terminating blank line), destroy otherwise.
- `close()`: track TLS sockets and h2 sessions and destroy them (Http2SecureServer has no
  `closeAllConnections`, and a graceful session close would wait on open SSE streams forever).
- Upstream stays one HTTP/1.1 request per client request (unchanged), bootstrap rewrite unchanged.

Tests (hosted CI only; owner forbids local test runs) — add to
`tests/claude-integration/claude-picker-listener.test.ts` (328 lines, unbaselined, cap 2000):
1. ALPN: client offering [h2, http/1.1] gets h2; [http/1.1] and no ALPN get HTTP/1.1.
2. Starvation characterization: an HTTP/1.1 agent bounded to 6 sockets holding 6 SSE streams
   queues a 7th ordinary request before it reaches the listener (upstream sees no request).
3. Fix: one h2 session holds 8 open SSE streams and an ordinary request on the same session
   completes; the listener accepted exactly one TLS connection.
4. h2 bootstrap rewrite (gzip) injects the model row with identity headers.
5. h2 cookie crumbs arrive upstream as one Cookie; Host comes from :authority; POST body intact.
6. h2 stream cancellation (RST) destroys the upstream request.
7. h2 inbound headers over 64 KiB never reach upstream.
Existing HTTP/1.1 and upgrade cases keep passing unchanged (they use no ALPN -> fallback path).

Docs: `structure/clients/claude-desktop.md` (relay description), `docs-site/.../guides/claude-code.md`
picker section (HTTP/2, troubleshooting: `ocx claude desktop picker off`).

## Not in scope / limits

No live Desktop, keychain, certificate or system-proxy contact. Native Chromium negotiation is
inferred from standard behaviour and the reporter's evidence; #6511 stays open until the reporter
retests. Fallback plan if Bun's HTTP/2 server cannot pass the regression set in hosted CI: picker
default-off + dashboard/CLI warning + docs known issue.


## Amendment after audit 1 (verdict FAIL, all blockers folded)

Audit 1 (gpt-6.1-sol, static reading of Bun 1.4.0 sources) found:
- P1 Bun's `allowHTTP1` fallback (internal/http1_server_fallback.ts) ignores socket.write
  backpressure and req.push() results -> moving existing HTTP/1.1 traffic onto it regresses
  streaming under slow peers.  **Fold:** do not use `allowHTTP1`. The listener port becomes a
  plain TCP front that reads the TLS ClientHello (no TLS termination there), checks whether the
  ALPN extension offers `h2`, and splices the connection (net pipe, real backpressure) to one of
  two loopback servers: an HTTP/2-only `http2.createSecureServer` (clients offering h2, i.e.
  Chromium's ordinary requests) or the existing native `https.createServer` with ALPN http/1.1
  (no ALPN, http/1.1-only, WebSocket connections, malformed/fragmented ClientHello). The HTTP/1.1
  path, its 431 bytes, upgrade relay and tests stay byte-identical. ClientHello parsing is a pure
  bounded function in `src/claude/intercept/client-hello.ts` (single TLS record; anything it cannot
  parse routes to HTTP/1.1, i.e. today's behaviour; 10 s head timeout like connect-proxy).
- P1 HEAD cancellation can bypass the compat `close` hook. **Fold:** for h2 also listen to the
  underlying `req.stream` `close` and destroy the upstream request there.
- P1 Native h2 header overflow (Bun counts name+value+32/field against maxHeaderListSize and sends
  RST_STREAM ENHANCE_YOUR_CALM before JS sees headers) makes an app-level 431 dead code.
  **Fold:** adopt native stream rejection as the h2 contract; drop the JS 431 guard; test zero
  upstream requests and that the same session still serves a later request.
- P2 Host vs :authority. **Fold:** `:authority` replaces any client Host; dial target stays fixed.
- P2 Test set too thin / unsynchronized. **Fold:** test list below; event barriers only, bounded
  rejection timers, cleanup in finally.
- Notes: root cause is a strongly supported hypothesis, not native proof (PR wording says so);
  the Bun fallback 431 string was misread (moot now); track real TLS sockets for close().

Revised tests (hosted CI only) in tests/claude-integration/claude-picker-listener.test.ts:
1. ClientHello parser: offers-h2 / http1-only / no ALPN / non-handshake / truncated -> null until
   complete / garbage -> false (unit, pure function).
2. ALPN through the listener: [h2,http/1.1] -> h2 + "picker session h2" log; [http/1.1] and none
   -> http/1.1 (existing tests already cover the no-ALPN path).
3. Starvation characterization: https.Agent{keepAlive,maxSockets:6} holds 6 SSE responses (wait for
   6 first-byte events), a 7th request sits in agent.requests and upstream has seen exactly 6;
   ending one stream lets the 7th arrive upstream.
4. Fix: one h2 session holds 8 SSE streams (first bytes awaited) and an ordinary GET on the same
   session completes; listener front accepted exactly one TCP connection.
5. h2 bootstrap gzip rewrite + duplicate Set-Cookie order + binary body + SSE first-bytes-before-end.
6. h2 request translation: cookie crumbs -> one Cookie, conflicting Host replaced by :authority,
   binary POST body intact, no pseudo-headers upstream.
7. h2 cancellation: RST during SSE and RST of a HEAD before upstream headers both close the
   upstream request.
8. h2 upstream failures: untrusted upstream -> 502 empty; upstream header overflow -> 502 + log.
9. h2 inbound headers > 64 KiB: stream rejected, upstream 0, same session serves the next request.
10. HEAD/204/304 over h2 complete without body; close() with open h2 SSE streams and a half-open
    TLS handshake resolves and the upstream request closes.
## Amendment after audit 2 (verdict FAIL, blockers folded in the draft)

- P1 fragmented ClientHello: `clientHelloOffersH2` now reassembles the handshake message across up
  to 16 records and any TCP split, bounded at 64 KiB of wire bytes and the front's 10 s deadline;
  unknown/GREASE extensions are skipped by declared length; the original wire bytes are replayed.
- P1 splice lifecycle: `spliced` owns every front and bridge socket from accept to close; a closing
  listener refuses new connections; a bind failure closes all three servers; the captured head is
  replayed exactly once, then `pipe()` carries bytes and FIN with backpressure; a side that closes
  without having ended its peer destroys the peer, otherwise queued bytes are flushed first.
- P2 header-overflow fixture: compressible headers whose decoded size (name + value + 32 per
  field) exceeds 64 KiB while the encoded block stays below it; assert native stream rejection
  (RST ENHANCE_YOUR_CALM), zero upstream requests and a working next stream on the same session.

Added tests: ClientHello reassembly (multi-record, split length fields, GREASE order, real client
ClientHellos captured from tls.connect), cancellation during peek, slow-reader backpressure through
the front for HTTP/1.1 and h2 downloads, close() with upgraded HTTP/1.1 and open h2 streams.
