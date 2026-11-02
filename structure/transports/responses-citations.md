# Replayed URL Citations

OpenAI-operated Responses destinations repair replayed `url_citation` annotations to the required
string title and non-negative integer indices through `repairUrlCitationAnnotations` in
`src/adapters/openai-responses/request-strips.ts`. Provider metadata stripping remains an
independent projection. The ordinary HTTP/WS adapter in
`src/adapters/openai-responses/passthrough.ts` applies citation repair only after destination
classification.

The direct native `/responses/compact` path in `src/server/responses/compact.ts` applies the same
gate in its final body builder for every physical send, including a provider destination refreshed
after key admission. It keeps the shared history free of citation repair so an OpenAI-to-gateway
refresh preserves the gateway's original annotations and the reverse refresh still repairs OpenAI
history. Opting a third-party gateway into native compaction declares protocol support, not
permission to rewrite its citations. `tests/responses/compact-key-selection.test.ts` covers exact
gateway preservation and both refresh directions;
`tests/responses/responses-native-item-extensions-compact.test.ts` covers official API and ChatGPT
compact repair, while `tests/responses/responses-url-citation-title-repair.test.ts` covers ordinary
HTTP/WS projection, helper independence and input immutability.

The separate [Responses include normalization](responses-wire-shapes.md) is gated to xAI and Meta; it does not change this projection or its destination boundary.
