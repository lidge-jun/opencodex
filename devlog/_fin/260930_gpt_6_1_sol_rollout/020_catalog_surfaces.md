# 020 Catalog surfaces for gpt-6.1-sol (wp2)

Rule: add a row wherever a gpt-6-sol row exists and 010 says listed or preemptive; comment preemptive rows `260930 preemptive`. No gpt-6.1-luna / gpt-6.1-astra anywhere.

| File | Change |
|---|---|
| scripts/model-metadata.source.json | Clone the gpt-6-sol row as gpt-6.1-sol in openai, openai-codex, github-copilot, kilo, openrouter, vercel-ai-gateway, opencode-zen, amazon-bedrock (preemptive), cloudflare-ai-gateway (preemptive); cache_read 0.10 (0.20 on opencode-zen per its published figure); release_date 2026-09-29; knowledge 2026-04-30. ZenMux not added. Then `bun run generate:model-metadata`. |
| src/usage/expected-prices.ts | `GPT61_SOL` cost4 (2 / 10 / 0.10 / 2.50) with long-context tier; rows for openai-apikey (verified), openai (verified-derived), devin, devin-cli (verified-derived); pricing-list id. |
| src/providers/registry/model-seeds.ts | `OPENAI_GPT6_MODELS` gains gpt-6.1-sol (flows to openai-apikey 1,050,000 / 922,000 / 128,000 / low..max and OpenRouter models); OpenRouter context map adds openai/gpt-6.1-sol. |
| src/providers/registry/entries-core.ts | OpenRouter `modelSupportsServiceTier` adds openai/gpt-6.1-sol; BizRouter seed adds openai/gpt-6.1-sol; Devin seed adds gpt-6-1-sol (preemptive). |
| src/providers/registry/entries-extended.ts | Copilot models + `modelWireDefaults` gpt-6.1-sol -> openai-responses. |
| src/providers/codebuddy-models.ts, src/providers/kiro-models.ts, src/adapters/kiro/reasoning.ts, src/adapters/devin/live-models.ts | Mirror the gpt-6-sol rows (preemptive). |
| src/codex/catalog/native-models.ts | `NATIVE_GPT61_SOL_MODEL = "gpt-6.1-sol"` in built-in list, SELF_DESCRIBED set, drain-sentinel set; configured-native template moves to gpt-6.1-sol. |
| src/codex/catalog/metadata.ts | DOCUMENTED_NATIVE_OPENAI_ADDITIONS and context map (NATIVE_GPT6_CONTEXT). |
| src/codex/catalog/effort.ts | Ladder entry low..ultra like Sol. |
| src/codex/data/roster-pinned-models.json | Append the upstream gpt-6.1-sol row verbatim from openai/codex models.json (codex-rs bundle, #49318); pinned-models.ts comment updated. |
| src/codex/model-entitlements.ts | Comment: 6.1 Sol ungated like Sol. |
| docs-site providers.md, structure/catalog.md, structure/providers/openai-accounts.md | Document the row. |

Tests that enumerate the roster by value and must gain gpt-6.1-sol (audit A1 blocker 4):

- tests/codex-integration/native-model-toggle.test.ts:95 (built-in native roster) and :127 (flagship list)
- tests/providers/provider-registry-parity.test.ts:314 (exact openai-apikey model list)
- tests/codex-integration/codex-catalog.test.ts:6842 (catalog roster; file is 7974/7985 lines, so edit in place without adding lines)
- tests/providers/github-copilot/github-copilot-wire-defaults.test.ts:33, tests/service/service-tier-capability.test.ts:73 (OpenRouter tier map), tests/routing/subagent-model-fallback.test.ts:276
- tests/providers/kiro/kiro-adapter.test.ts:1744 is at 2047/2050: edit the existing list in place only.
- tests/codex-integration/configured-native-models.test.ts:93-102: a configured native must now borrow gpt-6.1-sol's pinned capabilities and hash (wp2 audit NEAR-PASS item). catalog-routed-comp-hash.test.ts:75 keeps its gpt-6-sol forward-alias expectation.
- BizRouter is not added: 010 has no evidence it lists gpt-6.1-sol, and live discovery picks it up once it does.

New focused test `tests/codex-integration/gpt61-sol-rows.test.ts` (registered in scripts/test-layout/layout.json and tests/fixtures/test-layout-expected.json) asserting: native row ladder low..ultra, default effort low, 272,000/872,000 context; openai-apikey 1,050,000/922,000/128,000 and low..max; Copilot Responses wire; expected price 2/10/0.10/2.50; no gpt-6.1-luna/astra id in any registry entry.
