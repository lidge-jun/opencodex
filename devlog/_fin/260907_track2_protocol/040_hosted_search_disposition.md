# Hosted search passthrough disposition

Outcome: DEFER #3761; no production diff in this track.

## Source findings

src/web-search/loop.ts mutates normalized messages, while src/adapters/openai-responses.ts serializes passthrough _rawBody. Existing loop parsing is compaction-oriented and does not preserve the native tool/reasoning conversation needed for search-result continuation. src/server/sse-payload-rewrite.ts is synchronous rewriting rather than an asynchronous execution loop. Mixed ordinary tools/search and replay need a separate raw conversation contract; continuation storage alone does not supply it.

Official Ollama local middleware supports hosted Responses search, including cloud model execution, but that does not establish the direct ollama.com/v1 endpoint contract. References opened during investigation: https://github.com/ollama/ollama/pull/17686 and https://docs.ollama.com/integrations/codex . Local official client source: corpus 121_openai-codex. No direct-cloud authenticated run was performed.

## Resume criteria

Define destination/backend execution policy; preserve raw Responses tools/reasoning when inserting search results; exercise mixed tools, cancellation, bounded iteration, SSE/JSON/WS, compact and replay remotely with a confirmed destination contract. A guard-only change is rejected because it cannot deliver these results. The issue remains open and will receive this disposition; no claimed fix, workflow or client change.
