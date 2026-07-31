# 040 — follow-up: default-on for ALL openai-chat providers

User decision (260709, post-DONE): flip the opt-in to default-on for every openai-chat
provider; `parallelToolCalls: false` becomes the per-provider opt-out. Class C1 fast-path
(policy flip on freshly shipped, fully tested wiring).

Changed:
- src/adapters/openai-chat.ts buildRequest: `provider.parallelToolCalls === false ? false :
  parsed.options.parallelToolCalls !== false` (was opt-in gated).
- src/codex/catalog.ts applyProviderConfigHints: advertise for `adapter === "openai-chat"`
  unless explicit false; non-chat adapters still need explicit true.
- src/types.ts flag docs, structure/04 SoT section rewritten to default-on semantics.
- tests/parallel-tool-calls-optin.test.ts: zai-like default now expects true; hints test
  covers default-on / explicit-false / non-chat-adapter cases.

Risk note carried over: Z.AI does not document `parallel_tool_calls`; GLM streaming bugs are
on record (vllm#42400, zai-org/GLM-5#15). The buffered parser is contamination-safe, so the
residual risk is provider-side malformed frames -> opt-out lever is `parallelToolCalls: false`
on the provider config.

Verification: bun test 1718 pass / 0 fail (174 files); bunx tsc --noEmit exit 0.
