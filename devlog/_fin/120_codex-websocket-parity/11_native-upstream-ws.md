# 120.11 — 120.3 Native Upstream WebSocket (Option B, deferred / native-only)

## Status: DEFERRED, OPTIONAL

This sub-phase delivers **end-to-end** WS for native `gpt-*` only: `Codex ⇄ ocx ⇄ ChatGPT
backend`, all WS. It is **not required** for WS parity — the MVP (`10_`) already answers Codex's
WS with a Codex-facing bridge over an HTTP/SSE upstream read. Do B only if native transport
parity (true upstream WS, no SSE re-encode for native) is independently wanted. Routed models
are permanently excluded (their upstream is HTTP/SSE).

## Objective

For native `gpt-*` (the passthrough path), connect to the upstream ChatGPT backend over WS using
the same protocol Codex uses (`01_codex-ws-protocol-analysis.md`), and forward the upstream
Responses event frames straight to the Codex-facing WS from `10_` — no SSE conversion on the
native path.

## Preconditions (MUST resolve before implementing — not derivable from static source)

These could **not** be pinned from the codex checkout and require a live capture (run the real
Codex against the native backend with WS on, capture the upgrade + first frames):

1. **Exact `OpenAI-Beta` WS header value.** `core/src/client.rs:912-914` references
   `RESPONSES_WEBSOCKETS_V2_BETA_HEADER_VALUE`; the literal was not resolvable by static grep.
   Capture it from a live native WS handshake.
2. **Upstream WS URL.** Confirm the ChatGPT backend WS endpoint reachable with the user's OAuth
   (scheme `wss`, path `/responses` per `provider.rs:92-103`), and whether the OAuth bearer is
   accepted at WS upgrade.
3. **`permessage-deflate`.** Confirm the backend negotiates it and Bun's WS client supports the
   negotiated extension (`01_§8`).

> Record the captures in a `12_`-adjacent note before coding B. If any precondition fails (e.g.
> the backend rejects third-party WS clients), **B is infeasible** and the MVP (`10_`) stands as
> the final native answer — state that and stop.

## Design

A Bun WebSocket **client** mirroring `ResponsesWebsocketClient`:

1. On a native `response.create` arriving at the Codex-facing WS (`10_`), open (or reuse) an
   upstream WS via `new WebSocket(wssUrl, { headers: { Authorization, "OpenAI-Beta": <value>, … } })`
   — Bun supports a headers option on the client constructor.
2. Forward the `response.create` payload upstream as a Text frame (`01_§4`).
3. Pipe every upstream event frame **verbatim** to the Codex-facing `ws.send` (native frames are
   already Responses events — no translation).
4. Map upstream `response.completed` → terminal; upstream close/idle/error → the same
   `ApiError`-equivalent classified failure the bridge emits (reuse `errors.ts`).
5. Reply to upstream `Ping` with `Pong` (Bun client auto-handles; verify).
6. **Fallback:** if the upstream WS upgrade fails, fall back to the existing HTTP/SSE passthrough
   (`server.ts:141-162`) for that turn — never hard-fail a native turn on a WS problem.

## Files

### NEW

```text
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/openai-responses-ws.ts
```

An upstream WS client: `connect(provider, authHeaders) → { send(frame), events: AsyncIterable }`,
plus close/idle/error → classified terminal. Mirrors `01_§3-§6`. (Full content authored after the
preconditions are captured — the handshake headers are the only unknowns; the framing is fixed by
`01_§4-§5`.)

### MODIFY

```text
/Users/jun/Developer/new/700_projects/opencodex/src/server.ts
```

In the WS `message` handler (`10_`), branch native vs routed: native + WS-upstream-available →
use `openai-responses-ws`; else → the `10_` re-frame path. Keep the HTTP/SSE fallback.

## Verification

- Unit: upstream-WS client framing + terminal/close mapping against recorded fixtures.
- Live: native `gpt-5.5` turn over end-to-end WS; confirm no SSE re-encode on the native path
  (instrument the passthrough to assert the WS-upstream branch ran); fallback fires when the
  upstream WS is forced to fail.

## Effort

~4–7 days, dominated by precondition capture + handshake correctness + fallback design.

## Commit

```text
[agent] feat: native upstream WebSocket passthrough (end-to-end WS for gpt-*)
```
