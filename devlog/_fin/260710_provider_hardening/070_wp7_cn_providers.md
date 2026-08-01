# 070 — WP7: CN providers (deepseek, zai, minimax, minimax-cn, qwen-portal, qianfan, alibaba)

Pre-analysis: Mencius (sol explorer xhigh, 2026-07-10). Re-verify at WP7's P.

## P scope decision (260710, main session — post-tree-re-read)

Tree re-read corrections vs pre-analysis: deepseek v4 ids ALREADY seeded
(registry.ts:427 models include v4 via DEEPSEEK_THINKING_MODELS) — only the
default + ctx map are stale. Bracket-strip has LIVE Tier-2 evidence in-code
(Z.AI 400 code 1211 rejects bracketed ids on OpenAI path; comment at
openai-chat.ts:8-13) — global REMOVAL would break the working zai [1m] flow;
the honest narrowing is provider scoping, not deletion.

IN this cycle:
- D1 deepseek: defaultModel "deepseek-chat" -> "deepseek-v4-flash"; ADD ctx
  1_000_000 for deepseek-v4-flash/pro; deprecation note comment on the
  chat/reasoner aliases (removal after 2026-07-24 — keep until then).
- Z1 zai: ADD ctx map glm-5.2: 1_000_000 (Tier-2 002); keep both ids ([1m]
  spelling is the documented Anthropic-path convention).
- Z2 (AMENDED A-round1) bracket-strip scoping: new flag `modelSuffixBracketStrip:
  true` on zai only; openai-chat strips ONLY when set. Flag propagates through
  the FULL chain (reviewer-enumerated): OcxProviderConfig + ProviderRegistryEntry
  + ProviderConfigSeed picks + providerConfigSeed + enrichProviderFromRegistry +
  routedProviderConfig. Tests: seed AND routed activation assertions (flagged
  zai strips; unflagged provider sends bracketed id verbatim). Reviewer
  confirmed no other openai-chat entry advertises [1m].
- M1 minimax + minimax-cn: defaultModel "MiniMax-M2.5" -> "MiniMax-M3"; seed
  models [MiniMax-M3, MiniMax-M2.7, MiniMax-M2.7-highspeed, MiniMax-M2.5,
  MiniMax-M2.5-highspeed, MiniMax-M2.1, MiniMax-M2.1-highspeed, MiniMax-M2]
  (legacy still API-supported per Tier-2); ctx M3 1_000_000, all M2.x 204_800.
- F1 qwen-portal / qianfan / alibaba: FREEZE + note comments (unverified docs).

OUT: no new Anthropic-path sibling entries (auth-header proof missing); router
adapter-override loudness (cross-cutting, named); deepseek /anthropic base.

## Verdicts

- deepseek UPDATE: default deepseek-chat -> deepseek-v4-flash; advertise
  v4-flash/pro + 1M ctx; aliases deprecated 2026-07-24 (keep until then, note).
- zai UPDATE: OpenAI coding entry should advertise bare glm-5.2 only (+1M ctx);
  glm-5.2[1m] is Anthropic-path spelling — currently served via global bracket
  stripping in openai-chat.ts:10/194 (silent fallback; test-locked in
  openai-chat-model-suffix.test.ts). Fix = registry-scoped, not global strip.
  Older glm ids: keep (no proven deprecation).
- minimax + minimax-cn UPDATE: default MiniMax-M3; seed M3 (1M), M2.7(-highspeed)
  (204_800) + legacy M2.x supported; exact case; metadataModelIdNormalize exists.
- qwen-portal FREEZE; qianfan FREEZE; alibaba FREEZE (all unverified docs).

## Notes

- router.ts silently reverts configured adapter/baseUrl for registry names —
  users cannot point deepseek at /anthropic; use sibling ids if ever needed
  (defer; not this unit's scope to add new entries without user ask).
- Anthropic-path vendor entries would need auth-header proof (bearer vs
  x-api-key) before adding — OUT (no new entries).
- 384K max-output not representable in registry schema — note only.

## Tests
deepseek/minimax registry assertions (default/ctx/adapter/base); zai suffix
tests rewritten for scoped behavior; freeze rows untouched.
