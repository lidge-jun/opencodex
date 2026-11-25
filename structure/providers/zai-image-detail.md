# Z.AI Image Detail

## Responses image detail projection

Z.AI's Responses endpoint accepts `input_image.detail` values `auto`, `low` and `high`. codex-rs
sends `original` from `view_image`, code-mode `image()` and screenshot tool results when the
catalog row advertises `supports_image_detail_original`, and Z.AI answers that value with HTTP 400
`Invalid API parameter, please check the documentation.` for the whole request. The image stays in
thread history, so without a projection every later turn of that thread fails the same way.

`src/adapters/openai-responses/zai-input.ts` degrades `original` to `high`, the codex default, in
message `content` arrays and in every array-valued tool `output` (`function_call_output`,
`custom_tool_call_output` and siblings). Image bytes, part order, call ids and all other fields are
unchanged. The projection copies only changed items and returns the source body when nothing
changes. Historical images are rewritten on every send, so a thread that already holds an
`original` image recovers without client changes.

Eligibility is the exact final send URL `https://api.z.ai/api/v1/responses`, the registry `zai`
row's Responses resource. A custom-named provider that resolves to the same URL receives the same
projection; query-routed variants, lookalike hosts, other Z.AI resources and every other
destination keep `original`. `src/adapters/openai-responses/passthrough.ts` applies it immediately
after the [OpenGateway projection](opengateway.md), whose destination is disjoint. The Chat wire
already degrades `original` for every provider in `src/responses/parser-content.ts`.

`tests/adapters/openai/zai-input.test.ts` covers message and tool-output projection, identity
preservation, the destination boundary and adapter serialization for the registry row, a
custom-named provider at the same URL and an unrelated Responses destination.
