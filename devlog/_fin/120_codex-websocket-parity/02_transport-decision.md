# 120.02 — Transport Decision: Codex-Facing WS Bridge vs Native Upstream WS

## The decision

opencodex sits mid-chain: `Codex CLI → opencodex → upstream provider`. WS parity can be
implemented at one or both hops. Two strategies, not mutually exclusive:

- **Option A — Codex-facing WS bridge (MVP).** Implement the WS *server* hop (Codex ↔ ocx).
  Upstream stays HTTP/SSE for every provider. ocx accepts the WS upgrade, parses
  `response.create`, runs the **existing** `handleResponses` pipeline, and emits the bridge's
  Responses events as WS **Text** frames instead of SSE.
- **Option B — Native upstream WS (true parity).** For native `gpt-*` only, ocx also speaks WS
  *upstream* to the ChatGPT backend (a Bun WS **client** re-implementing Codex's
  `ResponsesWebsocketClient`), so the native path is end-to-end WS.

**Recommendation: ship A first; treat B as an optional follow-up for native `gpt-*` only.**

## Why A first

- It satisfies Codex's capability requirement: once `supports_websockets` is advertised, Codex
  opens WS and A answers it correctly for **every** model (native + routed), because the
  server-side obligations (`01_§7`) are transport-agnostic and the *upstream* read is unchanged.
- It reuses everything already built: routing (`router.ts`), adapters, the bridge's terminal
  guarantee (RC1), abort-on-disconnect (RC2), and error classification (100.5/110). The WS
  endpoint is largely an **alternate emitter** over the same event stream.
- For routed models, A is the *only* possible WS (their upstream is HTTP/SSE — end-to-end WS is
  structurally impossible, see `110/20`). A gives them a valid Codex-facing WS first hop.
- Effort: **2.5–4 days** (see breakdown in `10_`).

## Why B is deferred (and native-only)

- B reproduces Codex's `ResponsesWebsocketClient` in Bun: upstream WS connect, beta/auth headers
  at handshake, `response.create`/`response.processed` framing, `permessage-deflate`, ping/pong,
  close/idle semantics (`01_§3–§6`). High surface, real value only for native `gpt-*` (the only
  upstream that actually speaks Responses WS).
- It buys end-to-end WS for native passthrough; it does **not** help routed models at all.
- Effort: **4–7 days** (see `11_`). Do it only if native transport parity is independently
  wanted.

## Side-by-side

| Dimension | A — Codex-facing WS bridge | B — Native upstream WS |
|-----------|----------------------------|------------------------|
| Hop implemented | Codex ↔ ocx (server) | + ocx ↔ ChatGPT backend (client) |
| Covers routed models | yes (first hop only) | no (native only) |
| Reuses existing pipeline | fully | partially |
| New surface | Bun WS server + WS emitter | + Bun WS client, upstream handshake |
| End-to-end WS | no (upstream still SSE) | yes (native only) |
| Effort | 2.5–4 d | 4–7 d |
| Risk | low (alternate emitter) | medium (re-impl client) |

## Integration point (feasibility)

opencodex runs on `Bun.serve({ fetch })` (`/Users/jun/Developer/new/700_projects/opencodex/src/server.ts:508-510`),
routing `POST /v1/responses` at `:547`. Bun's native WS support plugs in here without a new
dependency:

```ts
// server.ts — inside Bun.serve fetch(), before the POST handler:
if (url.pathname === "/v1/responses" && server.upgrade(req, { data: { /* auth, headers */ } })) {
  return; // upgraded to WS — handled by the `websocket` handler below
}
// ...
Bun.serve({
  fetch,
  websocket: {
    async message(ws, raw) { /* parse response.create → run pipeline → ws.send(event frames) */ },
    close(ws) { /* abort upstream (RC2 parity) */ },
  },
});
```

The same `parseRequest → routeModel → adapter → bridge` chain runs; only the **sink** changes
from an SSE `ReadableStream` to `ws.send(...)`. `10_` specifies extracting the bridge's event
generation so both SSE and WS share one emitter (no logic fork).

## Capability-flag rollout (the 110 guard, operationalized)

Today the served catalog advertises WS on no entry (verified, `00_overview.md`): routed is
stripped at `codex-catalog.ts:78`; native inherits none from the current template but *could*
leak it from a future template (no native strip). The rollout must therefore control **both**
paths — advertise intentionally when ready, and never let native leak it early. Sequence:

1. A shipped (`10_`) + verified (`13_`) → advertise `supports_websockets = true` for routed +
   native (A serves both). Done in `12_`.
2. If B is later shipped, native `gpt-*` upgrades to end-to-end WS transparently — the flag is
   already on; only the upstream hop changes.
3. Never advertise before the endpoint exists (a failed upgrade = a new "RC6" stream error).
   `12_` includes verifying Codex's HTTP fallback when WS is *not* advertised, as the safety net.

## Reconciliation with 110.20 (amend, do not reverse)

110.20 concluded WS does not improve routed **reliability or performance** — still true: A's
upstream read is the same SSE, so first-token latency/throughput are unchanged, and A adds a
protocol surface rather than removing an error class. 120 is justified on a **different axis**:
native transport **parity** and satisfying Codex's WS capability so `ocx` is a drop-in for the
native OpenAI provider. Action: add a one-line cross-link at the top of
`110/20_transport-evaluation.md` pointing here; do **not** delete its conclusion.

## Decision record

- **Adopt A as 120.2 (`10_`).** Build the Codex-facing WS server as an alternate emitter over
  the existing pipeline.
- **Defer B to 120.3 (`11_`), native-only, optional.**
- **Gate the flag (`12_`/120.4)**; **live E2E (`13_`/120.5)**.
- Keep routed end-to-end WS permanently out of scope (impossible).
