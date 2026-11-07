# Canonical Mistral Chat wire policy

`src/adapters/openai-chat/destination-policy.ts` uses `isCanonicalMistralChat` for key-auth
`https://api.mistral.ai/v1` destinations, including custom provider names. Both Chat builders rename
`max_completion_tokens` to `max_tokens` without overwriting an existing non-null limit, and omit `user`, `store`,
`thinking`, `include_reasoning`, `reasoning` and `top_k`. Native effort follows the declared model ladder
using the shared at-or-below resolver: DeepSeek/GLM `medium` becomes `low`, supported rungs and `none`
remain, and an operator ladder wins. Other destinations retain native caller controls. The Mistral
registry seeds `foldDeveloperRoleToSystem: true`; explicit false still wins.

`src/adapters/openai-chat/native-content.ts` reuses `chatContentEvents` for native JSON messages and SSE
deltas, including a JSON upstream answered as SSE or an SSE upstream collected as JSON. Typed text joins
into string `content`, and typed thinking joins `reasoning_content`; arrays never reach native clients.
Other choice fields, tool calls and usage survive. Unsupported blocks fail through the existing upstream
error policy. Tests: `tests/adapters/openai/openai-chat-mistral-policy.test.ts` and
`tests/responses/chat-native-mistral-content.test.ts`.
