# Primary external contracts

All facts below were opened from primary provider documentation on 2026-07-17. Later implementation P phases must reopen the relevant source because provider contracts drift.

## Sakana Fugu

- Official setup: <https://console.sakana.ai/get-started>
- Base: `https://api.sakana.ai/v1`
- Auth: `Authorization: Bearer $SAKANA_API_KEY`
- APIs: Responses and Chat Completions.
- Models: `fugu`, `fugu-ultra`.
- Efforts: `high`, `xhigh`; `max` is accepted and currently aliases `xhigh`.
- Context: official Codex model catalog publishes 1,000,000 tokens.
- Operational warning: long tasks need larger client timeouts and reconnect policy. This roadmap does not silently widen global timeout/retry behavior in WP1.

## DeepInfra

- Official reference: <https://docs.deepinfra.com/api-reference/introduction>
- Base: `https://api.deepinfra.com/v1/openai`
- Auth: Bearer token.
- Surface: OpenAI-compatible Chat Completions, with a separate native inference API kept out of the initial preset.

## Cohere

- Official compatibility guide: <https://docs.cohere.com/docs/compatibility-api>
- Base: `https://api.cohere.ai/compatibility/v1`
- Surface: OpenAI-compatible Chat Completions.
- Initial documented model example: `command-a-plus-05-2026`; live availability must be rechecked before choosing a static fallback.

## AI21

- Official chat reference: <https://docs.ai21.com/reference/jamba-1-6-api-ref>
- Endpoint root: `https://api.ai21.com/studio/v1`, Chat Completions at `/chat/completions`.
- Auth: Bearer API key.
- Current stable aliases: `jamba-large`, `jamba-mini`; tool calling is documented for Jamba.

## Databricks

- Official model-serving guide: <https://docs.databricks.com/aws/en/machine-learning/model-serving/score-foundation-models>
- Base: workspace-specific `https://<workspace>/serving-endpoints`.
- Auth: Databricks token for development; machine-to-machine OAuth is the production recommendation.
- Model id: the serving endpoint name, so static global model seeds are inappropriate.

## Amazon Bedrock

- Official endpoint comparison: <https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints.html>
- `bedrock-mantle.{region}.api.aws` offers OpenAI-compatible Responses/Chat/Messages and supports Bedrock API keys or SigV4.
- `bedrock-runtime.{region}.amazonaws.com` remains the native InvokeModel/Converse lane for models/features not on Mantle.
- Native ConverseStream correlates events with `contentBlockIndex` and requires `bedrock:InvokeModelWithResponseStream`.
- The two surfaces remain separate work-phases because they have different auth, model availability, event, and retry contracts.

## Vertex AI

- Google recommends ADC and documents `gcloud auth application-default login` for local user credentials.
- OCX already implements the authorized-user refresh flow in `src/lib/gcp-adc.ts` with cloud-platform scope.
- The roadmap productizes setup and diagnostics; it does not add a second embedded OAuth client unless a later P proves a real gap and a safe client-registration boundary.
