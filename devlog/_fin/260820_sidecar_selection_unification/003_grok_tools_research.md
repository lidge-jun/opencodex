# 003 — Grok built-in tool deep research (2026-08-21, Luna swarm 2 + live OAuth probes)

## Full built-in tool inventory (docs.x.ai, primary)
| Tool | tools[].type | Output item | Price |
|---|---|---|---|
| Web search | web_search | web_search_call | $5/1k |
| X search | x_search | x_search_call (docs) / custom_tool_call (observed) | $5/1k |
| Code execution | code_interpreter | code_interpreter_call | $5/1k |
| Collections/RAG | file_search | file_search_call | $2.50/1k |
| Remote MCP | mcp | mcp_call | tokens only |
| Image generation | image_generation | image_generation_call | Imagine rates |
Internal server-side sub-tools (not request types): search_images, view_image, view_x_video, attachment_search ($10/1k when files attached).

## Live OAuth-transport captures (this machine, grok-4.6)
- web_search + include ["web_search_call.action.sources"]: ws_ item carries action {type:"search", query, sources:[{type:"url",url}...]}. VERIFIED live.
- Annotation SSE envelope (VERIFIED live): response.output_text.annotation.added { annotation: {type:"url_citation", url, start_index, end_index, title}, item_id: msg_..., annotation_index, content_index, output_index }.
- x_search: server emits custom_tool_call items — names observed live: x_user_search; community capture (Vercel ai#10607, API-KEY transport): x_semantic_search. id prefix ctc_, call_id prefix xs_call-. NOT x_search_call on either transport in practice → parse annotations for sources, tolerate both discriminators.
- Inline citation text format: [[N]](url); disable via include ["no_inline_citations"].
- response.citations array documented as always-returned post-tool-execution (docs) — not asserted in our stream capture; treat as secondary channel.

## Params (validated limits)
- web_search: filters.allowed_domains XOR excluded_domains, ≤5 each; enable_image_search, enable_image_understanding.
- x_search: allowed_x_handles XOR excluded_x_handles, ≤20 each; from_date/to_date ISO-8601 inclusive; enable_image_understanding, enable_video_understanding (video is X-only).
- max_turns bounds agentic turns; multiple tool calls can run parallel within a turn; multiple output indexes per response (SDK changelog fix) → reducer-style parsing, never assume 1 tool item.
- tool_choice forced form documented only for functions — do NOT assume forced built-ins.
- action may be ABSENT on response.output_item.added (skeleton-first; fills at .searching) → optional field.

## Transport verdict
OAuth (Grok CLI creds via auth.x.ai) hits the same api.x.ai/v1/responses with Bearer; hosted-tool JSON identical; entitlement 403 is the failure mode distinct from wire errors. API key is the documented default. Our executor uses the stored xai OAuth (present on this machine), fail-closed on 401/403.

## Executor consequences (070)
1. Sources = union of (a) message annotations url_citation urls, (b) ws action.sources urls when include requested. Dedupe by url.
2. Accept both x_search_call and custom_tool_call (name x_*) as x-search activity markers; never fail parse on unknown item types.
3. Buffer text from response.output_text.delta on msg items; strip [[N]](url) markers optional — keep text as-is (they're valid markdown), collect annotations as sources.
4. Bound raw SSE bytes like parseSidecarSSE does; timeout via settings.timeoutMs.

