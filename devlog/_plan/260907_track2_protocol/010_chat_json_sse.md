# JSON Responses to streaming Chat

Depends on roadmap only. Class C3; PR #3779 is the public implementation source.

## File delta

- MODIFY src/server/chat-completions.ts:455: keep responsesJsonToChatCompletion as semantic authority. Replace text-only extraction and constant stop with converted choice.message content/reasoning_content/refusal; project tool_calls with stable array-order indices; preserve converted finish_reason. One role event, at most one combined delta, one terminal and one DONE. No extra upstream inference.
- NEW tests/responses/chat-json-sse-fallback.test.ts from the source PR: actual loopback Responses upstream -> handleChatCompletions. Include one/two tools, reasoning+text, incomplete length, empty completion, cancellation and translator-budget release.
- MODIFY scripts/test-layout/layout.json and tests/fixtures/test-layout-expected.json: register new test under responses.
- MODIFY docs-site/src/content/docs/reference/proxy-formats.md and structure/04_transports-and-sidecars.md: buffered fallback delivery, semantic parity and no additional request.

## Activation and oracle

Streaming Chat request + JSON Responses upstream is the trigger. Native Chat and real SSE bypass this path. Hardcoded official Chat fixtures require indexed function calls, nullable finish for intermediate chunks and original terminal finish. First-choice scope follows the existing Responses single-result contract. Official openai-node ChatCompletionChunk/ChatCompletionMessage are the independent shape oracle; source PR tests are evidence candidates, not a passing result.

## Check and delivery

No local execution. Final remote CI must execute tests/responses/chat-json-sse-fallback.test.ts and existing chat-completions-endpoint coverage, typecheck and test-layout guards. Preserve upstream author credit in carried commit and final PR body. Lower refs are published with --no-verify; no native stack registration.
