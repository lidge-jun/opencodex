
## Narrow audit confirmation (Ampere, 01a067a9-1a22-7650-b739-434533aac908)

- Canonical openai forward (pool/direct) never reaches bridgeToResponsesSSE/buildResponseJSON —
  including stream:false (bounded JSON, spread-preserving transforms) and compaction (upstream body
  copied byte-verbatim; only headers reduced).
- openai-responses adapter is ALWAYS the passthrough adapter (adapters/registry.ts:78-82), so B1's
  blast radius is: translated adapters parsing Responses-shaped upstreams (future providers, Lab
  conformance executor) and any buffered rebuild. Fix stands as #41980 parity + future-proofing.
- WS→SSE drops non-`response.*` sideband frames (codex.rate_limits, websocket_timing) — SSE clients
  have no semantic for them; recorded as residual, not a gap.
