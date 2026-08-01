# Work-phase 6: routed-model thinking control (260707)

## Research (2x gpt-5.5 Tier-2 lanes: Volta=vendor docs, Archimedes=peer proxies; + live Zen Go probes)
- Zen Go passes vendor `thinking` body params through (PROBED with real key):
  kimi-k2.7-code + thinking.disabled -> upstream error (always-thinking, per platform.kimi.ai);
  thinking.enabled -> ok. glm-5.2 thinking disabled -> no reasoning_content; enabled -> thinks.
  minimax-m2.7 / qwen3.6-plus / mimo-v2.5 accept the shape.
- Official knobs (Tier-2, docs opened): Kimi K2.7 = none (always-on); GLM-5.2 =
  thinking.type + reasoning_effort(high|max ladder, already mapped); MiniMax M3 =
  thinking adaptive|disabled (M2.x cannot disable); Qwen dashscope = enable_thinking/
  thinking_budget; MiMo v2.5 = thinking enabled|disabled.
- Peer design (CLIProxyAPI internal/thinking, LiteLLM, OpenRouter): normalize effort ->
  per-vendor emit, metadata-driven; kimi handled as reasoning_effort or thinking.disabled.

## Current state
- openai-chat adapter only emits `reasoning_effort` (openai-chat.ts:197).
- opencode-go anthropic-wire models (minimax-*, qwen3.5+/3.6+/3.7-*) already get
  thinking via anthropic adapter budgets — out of scope.
- MiMo (mimo-v2*, openai-chat wire) + glm-5/5.1: toggle-capable but proxy sends nothing;
  picker shows default low..xhigh ladder that maps to an ignored reasoning_effort.

## Scope (B)
1. types.ts OcxProviderConfig + registry.ts entry key: `thinkingToggleModels?: string[]`.
2. registry opencode-go: thinkingToggleModels = [mimo-v2.5, mimo-v2.5-pro, mimo-v2-omni,
   mimo-v2-pro, glm-5, glm-5.1]; those models get modelReasoningEfforts ["low","high"]
   (picker: low = thinking off, high = thinking on; default high) and
   modelReasoningEffortMap {none/minimal/low->disabled, medium/high/xhigh/max->enabled}.
3. router.ts routedProviderConfig + derive.ts enrich: merge thinkingToggleModels.
4. openai-chat adapter: for thinkingToggleModels, interpret the mapped wire value as
   `thinking: {type: enabled|disabled}` and do NOT send reasoning_effort.
5. Kimi: unchanged ([] levels; omit thinking entirely — docs: only omission is safe).
6. Tests: adapter thinking emission (disabled/enabled/non-toggle unchanged), registry
   parity, reasoning-effort map.

## Verification
bun test ./tests/ && bun x tsc --noEmit
