# 070 — Native GPT-5.6 default follows Codex 272k

## Change

- `NATIVE_GPT56_CONTEXT_WINDOW` is 272,000 (Codex live advertised default).
- Measured ceiling / 1M opt-in stays `NATIVE_GPT56_MAX_INPUT_TOKENS` = 922,000.
- For the GPT-5.6 family only, `providerContextCaps.openai` and per-model overlays may RAISE the default up to 922k. Values above 922k clamp. Other native slugs still only lower.
- Native group switch ON without a value sends 922,000. Switch OFF displays 272k.
- API-key 1,050,000 / 922,000 path is unchanged. gpt-5.4 stays 1M. gpt-5.5 stays 272k.

## Files

- `src/codex/catalog/metadata.ts`
- `gui/src/pages/Models.tsx`
- `gui/src/pages/models-shared.ts`
- `structure/08_openai-provider-tiers.md`
- focused tests listed in the same commit

## Accept

- `nativeOpenAiContextWindow("gpt-5.6-sol") === 272000`
- `nativeOpenAiContextWindow("gpt-5.6-sol", 922000) === 922000`
- `nativeOpenAiContextWindow("gpt-5.6-sol", 2000000) === 922000`
- `nativeOpenAiContextWindow("gpt-5.5", 922000) === 272000`
- Claude default sol is unmarked; opted-in 922k marks `[1m]`
