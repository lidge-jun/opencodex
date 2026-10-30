# Response Citation Projection

`src/adapters/openai-responses/request-strips.ts` repairs `url_citation` annotations
inside `output_text` content records on OpenAI-operated outbound history, including
HTTP and WebSocket projections. A missing/non-string title falls back to the URL
(or an empty string when it is absent); digit-string indexes become non-negative
safe integers, while invalid indexes become zero. The projection copies only
changed input/content/annotation containers and preserves other fields and
annotation kinds; a valid body retains its identity. Third-party destinations
keep their existing projection.

`src/bridge/response-json.ts` and `src/bridge/sse.ts` always emit a string citation
title, falling back to its URL, so new history avoids the deterministic
missing-title refusal that replay repair handles for older history.
`tests/responses/responses-url-citation-title-repair.test.ts` covers generated
JSON/SSE, outbound HTTP/WebSocket bodies, copy-on-write and the third-party control.

This normalization prevents old bridge history from repeatedly failing with a
missing-title error; it does not validate source URLs, establish actual citation
spans or prove provider acceptance beyond the exercised serialization fixtures.
The existing destination gate owns eligibility, and the test layout explicitly
registers the regression beside other Responses tests.

The separate [Responses include normalization](responses-wire-shapes.md) is gated to xAI and Meta; it does not change this projection or its destination boundary.
