# 120.00 — Overview: Responses WebSocket Parity for opencodex

## What this phase is

Make the opencodex provider able to speak the Codex **Responses WebSocket** protocol, so that
Codex's native WS-first transport works *through* `ocx` — reaching transport parity with the
native OpenAI provider. Today opencodex serves only HTTP `POST /v1/responses` (SSE); it has no
WebSocket endpoint. This phase designs and plans that endpoint.

This is a **foundation cycle** (research + decision). It produces three docs (00–02) and does
**not** change production code. The implementation-ready sub-phase plans live in `10_`–`13_`.

## Why now — and why it is NOT a 110 bug

Codex chooses the WS path purely on the provider capability flag
`Provider.supports_websockets` (`/Users/jun/Developer/codex/codex-cli/codex-rs/core/src/client.rs:772`).
**The catalog opencodex serves advertises that flag on no entry today** — verified against the
live served catalog `/Users/jun/.codex/opencodex-catalog.json` (zero `supports_websockets`
occurrences, native or routed). The mechanism differs by entry class, which matters for the
rollout in `12_`:

- **Routed** entries are explicitly stripped: `src/codex-catalog.ts:78`
  (`delete entry.supports_websockets`, inside `normalizeRoutedCatalogEntry`).
- **Native** `gpt-*` entries are cloned from the installed Codex template by `deriveEntry`
  (`codex-catalog.ts:145-154`) **without** a strip — they simply inherit no flag because the
  current installed template carries none. **Latent risk:** if a future Codex template adds
  `supports_websockets` to native entries, `deriveEntry` would leak it and Codex would start
  attempting WS against `ocx` with no endpoint → a new handshake-failure error ("RC6"). `12_`
  must guard the native path, not only manage the routed strip.

So today Codex **never attempts a WS first-hop** against `ocx` (no current error). Two consequences:

1. The absence of WS causes **zero** current stream errors — which is exactly why phase
   `110/20_transport-evaluation.md` correctly concluded "WebSockets do not help" for routed
   **reliability**. That verdict still stands and is **not** reversed by this phase.
2. WS parity is therefore a **capability/feature**, not a bug fix. 120 adds an opt-in transport;
   it is a *different axis* (native transport parity) from 110 (SSE lifecycle correctness).

**Guard (the one real link to 110):** never advertise `supports_websockets = true` until the
endpoint actually exists. A flag flip without an endpoint makes Codex attempt a WS upgrade that
fails the handshake — a *new* stream-error source (call it "RC6") that 110 never had. The flag
deletion at `codex-catalog.ts:78` stays until `12_metadata-enable-fallback.md` ships.

## Relationship to phases 100 / 110

| Phase | Axis | Status |
|-------|------|--------|
| 100 | catalog/policy/error parity (HTTP) | implemented |
| 110 | SSE **lifecycle** reliability (RC1–RC5 + F1–F5 closure) | P0 done; closure planned (`110/50_`) |
| **120** | **WebSocket transport parity** (new) | this phase — foundation only |

110.20 gets a one-line cross-link to 120 (it is amended, not reversed): "WS adds nothing to
routed *reliability*; native *transport parity* is tracked in phase 120."

## Scope of the foundation cycle

- `00_overview.md` — this doc: framing, premise, non-bug status, guard.
- `01_codex-ws-protocol-analysis.md` — the exact Codex WS wire protocol (frames, handshake,
  lifecycle, minimum server obligations), cited to the stable codex checkout.
- `02_transport-decision.md` — the two implementation strategies (Codex-facing WS bridge MVP vs
  native upstream WS), the recommendation, effort, and the capability-flag rollout.

## Out of scope (this cycle)

- Any production code. (Implementation plans are `10_`–`13_`; implementation itself is a later,
  approval-gated step.)
- Reversing 110.20's routed-reliability conclusion.
- A routed-provider end-to-end WS (structurally impossible — routed upstreams are HTTP/SSE; the
  best routed WS can be is a Codex-facing first hop, covered by the MVP option in `02_`).

## Implementation sub-phases (planned in 10–13)

| Doc | Sub-phase | Summary |
|-----|-----------|---------|
| `10_` | 120.2 WS endpoint MVP | Bun WS upgrade on `/v1/responses`; parse `response.create`; reuse the existing route/adapter/bridge pipeline; emit Responses events as WS Text frames; `response.processed` no-op; close→abort upstream |
| `11_` | 120.3 native upstream WS | native `gpt-*` → connect to upstream ChatGPT backend WS (true end-to-end parity) |
| `12_` | 120.4 metadata enable + fallback | selectively re-advertise `supports_websockets`; verify Codex HTTP fallback; terminal/heartbeat parity on WS |
| `13_` | 120.5 live E2E | Codex CLI over WS against `ocx` (native + routed), interrupts/stalls/tools |
