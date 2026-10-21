# OpenGateway

The `opengateway` key preset uses the OpenAI Chat adapter at
`https://apis.opengateway.ai/v1`. Sionic AI operates the gateway. Registry-owned live
discovery refreshes the public `/v1/models` catalog and retains active Chat Completions rows plus Responses-only rows that the registry pins to
Responses (`openai/o3-pro`); public discovery does not establish key validity. Sionic-served
`deepseek/deepseek-v4.1-flash-ultrafast` and `z-ai/glm-5.3-flash-ultrafast` are listed first. A custom model that replaces one of the discovered rows keeps
that row's slot (`src/codex/catalog/routed-gather.ts`).
Keys are created at `https://opengateway.ai/api-keys`.

`src/adapters/openai-responses/opengateway-input.ts` normalizes only this gateway's
`/v1/responses` input. Text tool-result arrays become strings; every call/result and its
`call_id` stays present. Image-bearing results retain their text, image bytes and part order
in user messages after the aligned tool group, with a call-id marker in image-only results.
Image detail `original` becomes `high`. Unsupported or malformed result parts fail explicitly
before dispatch with a client input error. Other destinations and the source body are untouched.
`tests/adapters/openai/opengateway-input.test.ts` tests normalization independently of completion
recovery; `tests/providers/opengateway-provider.test.ts` covers adapter serialization.
`src/adapters/openai-responses/passthrough.ts` applies projection immediately before serialization.

`src/server/responses/opengateway-completion-guard.ts` inspects HTTP 200 SSE/JSON only at
`https://apis.opengateway.ai/v1/responses`. Before any answer or action, a well-formed empty
completion (including reasoning-only output) becomes `incomplete/max_output_tokens` if reported
output tokens exhaust the requested limit. A malformed empty terminal fails as `invalid_completion`.
Otherwise replay requires explicit `store: false`, complete input and client-executed tools only,
as judged by `selfContainedResponsesBody` on the outbound body. Hosted/unknown tools, continuation,
background mode and nonreplayable responses prevent replay. This destination defaults to recovery;
`emptyCompletionRetry: false` and `OCX_EMPTY_COMPLETION_RETRY=0` disable it.
`src/server/responses/passthrough-completion.ts` connects one replacement to the existing send
budget, pacing, accounting and abort path. Even a replacement HTTP 503 or connection reset cannot
add another physical send. Discarded usage is recorded once per attempt; a second empty completion
fails as `empty_completion_retry_failed`, while HTTP failures and budget refusals retain their response.
`src/server/responses/passthrough-dispatch.ts` caps that recovery's allowance at one send and disables ambiguous reset resends on it.
Text, refusal, tool/action or unknown events release the original bytes without replay. Inspection
holds at most 1 MiB, 1,024 events/chunks or 30 seconds, then hands the held prefix and pending read
to the consumer without cancelling a healthy source. Consumed/cancelled prefix references are
released; terminal disposal and consumer cancellation do not await upstream cleanup. SSE inactivity
keeps the existing stall-timeout policy. Rewritten responses preserve tool ownership.
`tests/responses/opengateway-completion-receipts.test.ts` covers wire outcomes and resource release;
`tests/responses/empty-completion-core.test.ts` and `tests/responses/empty-completion-hardening.test.ts`
cover integration and replay barriers. Other destinations and translated retry defaults are unchanged.
