# 002 — Google primary-doc facts used by this unit

Captured 2026-11-15 through Aside (`browse.readText`, fetch source, `complete=true`) from the
`.md.txt` renditions of ai.google.dev. Line references point into those captures; the canonical
pages are the URLs below. Only facts this unit relies on are recorded.

## Interactions API

Sources: <https://ai.google.dev/gemini-api/docs/interactions>, <https://ai.google.dev/api/interactions-api>,
<https://ai.google.dev/gemini-api/docs/thought-signatures>, <https://ai.google.dev/gemini-api/docs/function-calling>.

- Status: generally available since June 2026 and "the recommended interface for all new projects";
  `generateContent` is called legacy but "remains fully supported" (guide, intro).
- Methods (reference, "Methods"): `POST /v1beta/interactions` (create), `POST /v1beta/interactions/{id}/cancel`,
  `GET /v1beta/interactions/{id}`, `DELETE /v1beta/interactions/{id}`. A stable `v1` version also exists.
- Auth: `x-goog-api-key` header in every REST sample (guide, REST tabs).
- Streaming: `"stream": true` in the body; the REST sample also sets `?alt=sse`
  (function-calling guide, REST streaming sample). Events are SSE.
- Interaction resource (reference, "Interaction"): output-only `id`, `status`, `created`, `updated`, `steps`;
  `model` or `agent`; input-only `input` (Content, content list, or string), `system_instruction` (string),
  `tools`, `generation_config`, `response_format`, `stream`, `store`, `background`,
  `previous_interaction_id`, `agent_config`; output `usage`, `errors`, `continuation_token`.
- `status` values: `in_progress`, `requires_action`, `completed`, `failed`, `cancelled`, `incomplete`
  (completed but truncated, e.g. max tokens), `requires_continuation`.
- `generation_config`: `seed`, `stop_sequences`, `max_output_tokens`,
  `thinking_level` (`minimal|low|medium|high|xhigh`), `thinking_summaries` (`auto|none`),
  `tool_choice` (string `auto|any|none|validated` or `{allowed_tools:{mode,tools[]}}`), plus media configs.
  `temperature` and `top_p` appear in the guide's samples, not in the reference's GenerationConfig list.
- The stable `v1` reference (`?api-version=v1`, captured the same way, 156,304 chars) lists the same four
  methods under `/v1/interactions` and the same create fields this unit reads.
- `usage` fields: `total_input_tokens`, `input_tokens_by_modality[]`, `total_cached_tokens`,
  `total_output_tokens`, `total_tool_use_tokens`, `total_thought_tokens`, `total_tokens`,
  `grounding_tool_count[]`. (CPA uses `input_tokens`/`output_tokens` in non-stream bodies; the reference
  does not, so this unit follows the reference.)
- Step types (reference, "Step"): `user_input`, `model_output`, `thought`, `function_call`,
  `function_result`, and hosted-tool pairs (`google_search_*`, `url_context_*`, `code_execution_*`,
  `file_search_*`, `google_maps_*`, `mcp_server_tool_*`, `processing_*`). `interactions.create` returns only
  model-generated steps; `interactions.get` also returns `user_input` steps (guide, "How it works").
- SSE event types (reference, "InteractionSseEvent"): `interaction.created`, `interaction.status_update`,
  `step.start` (`index`, `step`), `step.delta` (`index`, `delta`), `step.stop` (`index`),
  `interaction.completed` (`interaction` with usage), `error` (`error:{code,message}`). Each event may carry
  `event_id` for stream resumption. Delta types include `text`, `thought_summary`, `thought_signature`,
  `arguments_delta`, `function_result`, `image`, `audio`, `text_annotation_delta`, plus hosted-tool deltas.
- State: `previous_interaction_id` preserves only conversation history; `tools`, `system_instruction` and
  `generation_config` are interaction-scoped and must be re-sent (guide, "Server-side state management").
  `store=false` "prevents using `previous_interaction_id` for subsequent turns" and is incompatible with
  `background` (guide, "Data storage and retention").
- Thought signatures: in stateful mode the server keeps them; in stateless mode they live inside `thought`
  steps, not on user/model/function parts (thought-signatures page).
- Not yet in Interactions: Batch API, Python automatic function calling, explicit caching (guide, "Limitations").

## generateContent (legacy, still supported)

Source: <https://ai.google.dev/api/generate-content>.

- `POST /v1beta/models/{model}:generateContent` and `:streamGenerateContent` (reference, "Methods");
  streamed responses are a JSON array by default, or SSE with `alt=sse` (as implemented by #8742 and by
  opencodex's outbound adapter, which always requests `?alt=sse`).
- `Part.thoughtSignature` is a string field on content parts (reference, Part).

## Live API

Sources: <https://ai.google.dev/gemini-api/docs/live>, <https://ai.google.dev/api/live>.

- Transport: stateful WebSocket, `WSS /ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`;
  ephemeral tokens via `POST /v1beta/auth_tokens` (reference, "Methods").
- Audio in: raw 16-bit PCM 16 kHz; audio out: 24 kHz PCM; images JPEG at most 1 FPS (guide, "Technical specifications").
- Messages: `BidiGenerateContentSetup`, `ClientContent`, `RealtimeInput`, `ToolResponse` from the client;
  `SetupComplete`, `ServerContent`, `ToolCall`, `ToolCallCancellation`, `GoAway`, `SessionResumptionUpdate`
  from the server.
- CPA has no Live support (`rg -i bidigenerate` in the CPA tree finds nothing); see matrix row L-01.
