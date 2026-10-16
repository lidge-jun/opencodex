# Implementation

1. Add a Cursor Claude Fast multiplier helper in `src/usage/expected-prices.ts` using the existing `normalizeCursorClaudeId` parser. It returns 2 only for fast Opus 4.8, 5 and 5.5 IDs.
2. Add Cursor priority pricing rules for the canonical base IDs. These rules do not require a response echo because the Cursor adapter's variant serialization is the observed wire evidence.
3. In `resolveMatchedPriceExact`, return user overlays first as today. For compiled Cursor expected or model-level prices, multiply only explicit fast IDs. Preserve `source`, `sourceRef`, and user overlay behavior.
   Unsupported Fast spellings are fail-closed; supported explicit Fast rows carry Cursor's
   direct source URL and `verified` provenance.
4. Add a new usage test file in the usage domain and register it in both layout registries.
