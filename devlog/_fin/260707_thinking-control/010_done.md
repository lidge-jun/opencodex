# DONE — routed-model thinking control (260707)

Research: 2x gpt-5.5 Tier-2 lanes (Volta: vendor docs; Archimedes: peer proxies /
LiteLLM / CLIProxyAPI / models.dev / OpenRouter) + live authenticated Zen Go probes.

## Evidence (probed live, 2026-07-07)
- Zen Go PASSES vendor `thinking` body params through.
- kimi-k2.7-code: thinking.disabled -> upstream error (always-thinking; matches
  platform.kimi.ai docs). NO control possible -> stays unadvertised ([]). Correct.
- glm-5.2: reasoning_effort ladder works (existing high|max map kept).
- mimo-v2.5: thinking {enabled} -> reasoning_content present; {disabled} -> absent,
  clean direct answer. TOGGLE VERIFIED end-to-end.

## Shipped
1. types.ts + registry seed/derive/router merge: `thinkingToggleModels` provider key.
2. registry opencode-go: mimo-v2.5/-pro/v2-omni/v2-pro + glm-5/glm-5.1 advertise a
   two-step Codex ladder (low = thinking off, high = thinking on; default high via
   applyReasoningLevels) with effort->toggle map (none/minimal/low->disabled,
   medium..max->enabled).
3. openai-chat adapter: thinkingToggleModels emit `thinking: {type}` instead of
   reasoning_effort (mapped value is the toggle state); non-toggle models unchanged.
4. Tests +5 (toggle enabled/disabled/omitted, non-toggle isolation, opencode-go
   registry end-to-end incl. kimi stays knob-free).
5. `ocx sync` run — catalog now advertises the [low, high] ladder for mimo/glm5 slugs.

## Design notes
- Peer-proxy consensus (CLIProxyAPI internal/thinking, LiteLLM): normalize effort ->
  metadata-driven per-vendor emit. This phase implements the openai-chat toggle vendor
  branch; anthropic-wire models (minimax/qwen on Zen Go) already get budgets via the
  anthropic adapter path.
- kimi: deliberately no fake knob — only omission is documented-safe.

## Verification
bun test ./tests/ -> 1555 pass / 0 fail; tsc exit 0; live mimo toggle probe both ways.

## Post-sync note
Live catalog currently exposes only glm-5.2 + kimi-k2.7-code for opencode-go (other
Zen Go models are disabled/not-enabled in this install). The toggle ladder activates
automatically in catalog + wire the moment mimo-v2.5 / glm-5 / glm-5.1 are enabled.
