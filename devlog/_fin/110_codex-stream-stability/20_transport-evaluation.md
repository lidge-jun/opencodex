# 110.20 — Transport Evaluation: SSE Multiplexing and WebSockets

## Question

Would **SSE multiplexing** or **WebSockets** improve performance, or reduce the stream
errors? Is adding WS to the `chat/completions` adapter worthwhile?

**Verdict: No on all counts.** The stream errors are lifecycle/reliability defects
(`10_root-cause-analysis.md`), not transport-bandwidth defects. No transport change touches
RC1–RC5. The phase 100 "no WebSocket" decision stands and is reaffirmed here.

> **Cross-link (amended, not reversed):** this verdict is about routed *reliability/performance*
> — still correct. Native transport *parity* (satisfying Codex's `supports_websockets`
> capability so `ocx` is a drop-in for the native OpenAI provider) is a different axis, tracked
> in `devlog/120_codex-websocket-parity/`. See `120/02_transport-decision.md`.

## Phase 100 already decided this

> "Decision: no 100.6 websocket spike / routed providers keep `supports_websockets`
> absent/false / Reason: upstream routed providers are HTTP/SSE, so websocket is not
> end-to-end" — `devlog/100_codex-native-parity/00_overview.md:82-84`

> "enabling websocket only between Codex and opencodex cannot make a provider/model
> websocket-capable when the upstream provider is not websocket-capable end-to-end … a
> websocket first hop would still block on the same upstream SSE chunks, so it is unlikely to
> improve first-token latency or throughput … setting `supports_websockets = true` would
> advertise a native capability opencodex does not actually provide for routed models."
> — `devlog/100_codex-native-parity/40_responses-lite-websockets.md:102-108`

## Why WebSockets do not help

opencodex sits **mid-chain**: `Codex CLI → opencodex → upstream provider`. The upstream
(ChatGPT backend for native, or a chat/completions provider for routed) speaks **HTTP/SSE**.

- A WS first hop (Codex↔opencodex) still **blocks on the upstream SSE** opencodex is reading.
  First-token latency and throughput are bounded by the upstream, unchanged by the hop's
  framing.
- WS would add a second protocol surface (frame assembly, ping/pong, close codes) — *more*
  ways to produce a "stream error," not fewer.
- For routed models, advertising `supports_websockets` would be **false advertising**:
  there is no end-to-end WS.
- **Adding WS to the `chat/completions` adapter is pointless**: the upstream is HTTP/SSE
  chat/completions. Wrapping the proxy hop in WS changes nothing upstream and adds a
  translation surface. (Matches the reporter's own conclusion.)

## Why SSE multiplexing does not help the errors

"SSE multiplexing" usually means carrying many SSE streams over one HTTP/2 connection.

- The Codex CLI opens **one Responses stream per request**; there is no fan-out to multiplex.
- HTTP/2 multiplexing is a **transport-layer** concern handled by the server/runtime and the
  client below the application — it does not change whether a stream is terminated correctly,
  aborted on disconnect, or kept alive during a stall. None of RC1–RC5 are connection-count
  problems.
- opencodex already disables proxy buffering (`X-Accel-Buffering: no`, `server.ts:211`) and
  sets `Cache-Control: no-cache` (`:209`), which are the SSE-relevant transport knobs.

## Where the real performance wins are

| Lever | Effect | Touches an RC? |
|-------|--------|----------------|
| Keep **native passthrough** for `gpt-*` | Zero re-encode CPU; backend pacing/keep-alives inherited | avoids RC1/RC3 by construction |
| **Abort upstream on disconnect** (RC2) | No leaked sockets, no wasted upstream tokens/time | RC2 |
| **Idle heartbeat** (RC3) | Avoids false idle-timeout aborts that force a full, expensive retry | RC3 |
| **Guaranteed terminal event** (RC1) | Avoids "stream closed" aborts → full retries | RC1 |
| WebSockets | none | none |
| SSE/HTTP-2 multiplexing | none (one stream per request) | none |

The dominant cost of the errors is not transport overhead — it is the **full re-run** Codex
performs after an `ApiError::Stream`. Eliminating the aborts (RC1–RC3) removes those re-runs.
That is the performance win, and it comes from reliability fixes, not a new transport.

## Conclusion

Do not invest in WebSockets or SSE multiplexing for this problem. Invest in the SSE
lifecycle fixes in `30_patch-direction.md`. Revisit WS only if a provider ever exposes a
real end-to-end WS endpoint opencodex can bridge without converting back to HTTP/SSE
internally (the phase 100 condition, `00_overview.md:87-89`).
