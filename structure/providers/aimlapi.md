# AI/ML API

The `aimlapi` key preset in `src/providers/registry/entries-extended.ts` uses the existing OpenAI Chat adapter at `https://api.aimlapi.com/v1`.
Its public `GET /v1/models` mixes chat, image, video, audio, embedding and Anthropic-batch rows,
and only the row `type` tells them apart, so registry-owned discovery admits rows whose `type` is
`openai/chat-completions`. The catalog answers 200 for any Bearer value, so key validation is
`unknown`. Seven vendor-prefixed chat ids are seeded with their catalog context and output limits.
The preset's `staticHeaders` carry `X-AIMLAPI-Source` and `X-AIMLAPI-Partner-ID` attribution.
Registry static headers are merged only while the row matches the registry transport. For a
same-named row that no longer matches, `withoutRegistryStaticHeaderCopies` in
`src/providers/registry-static-headers.ts` (re-exported from `src/providers/registry.ts`) decides
on inference (`src/providers/routed-config.ts`) and model discovery (`src/oauth/index.ts`): if the row still targets the registry origin (same scheme, host
and port; only the path or adapter changed) its headers are sent as saved; if it targets another
origin, every header named like a preset static header is dropped, whatever its value (so an older
seeded copy, or one the operator edited, does not follow the row), and headers with other names
are kept.
`tests/providers/aimlapi-provider.test.ts` covers derived entry points, type-filtered discovery,
key validation, routing, and the headers on the wire for the preset, a row retargeted to another
host, and a row that stays on the registry host with another path or adapter.
