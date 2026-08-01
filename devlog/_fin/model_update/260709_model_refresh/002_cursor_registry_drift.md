# 002 — Cursor lineup + registry drift audit (2026-07-09, gpt-5.5 explorer "Carson")

## Cursor (OFFICIAL cursor.com/docs sitemap + per-model pages)
Diff vs CURSOR_STATIC_MODELS (src/adapters/cursor/discovery.ts):
- ADD: grok-4-5 (https://cursor.com/docs/models/grok-4-5), kimi-k2.7-code
  (https://cursor.com/docs/models/kimi-k2-7-code), claude-opus-4-7-fast.
- RENAME (dot -> dash): claude-4.5-haiku -> claude-4-5-haiku; claude-4.5-sonnet -> claude-4-5-sonnet;
  claude-4.5-opus -> claude-4-5-opus; claude-4.6-sonnet -> claude-4-6-sonnet;
  claude-4.6-opus -> claude-4-6-opus (per-model modelId payloads).
- REMOVE (absent from current docs): composer-1.5, composer-2, grok-4.3, grok-4.20,
  grok-build-0.1, grok-code-fast-1, kimi-k2.5, gpt-5.5-extra. composer-2.5-fast UNVERIFIED
  (docs mention a faster variant; exposed modelId is composer-2.5 only).
- METADATA: glm-5.2 static 200k -> official 1M context / 128k output (https://docs.z.ai/guides/llm/glm-5.2).
- CAUTION (main-session note): Cursor list is PLAN-dependent and ocx filters live via
  GetUsableModels; static seed removals only affect logged-out fallback. Renames matter most
  (stale ids => ERROR_BAD_MODEL_NAME on the live filter path).

## Registry drift (src/providers/registry.ts) — actionable, evidence-backed
- anthropic / anthropic-apikey: ADD claude-fable-5 (OFFICIAL
  https://platform.claude.com/docs/en/about-claude/models/overview); default
  claude-sonnet-4-6 -> claude-sonnet-5 (current-gen; decision recorded).
- openai-apikey: ADD liveModels: true (OFFICIAL /v1/models:
  https://developers.openai.com/api/reference/resources/models/methods/list).
- umans: REMOVE umans-kimi-k2.6 (secondary: https://models.dev/providers/umans-ai-coding-plan
  current 6-row catalog lacks it).
- moonshot: check kimi-k2-0905-preview staleness during B (secondary models.dev).

## Deliberate NOOPs (recorded, not forgotten)
- zai: glm-5-turbo / glm-4.7* not added — registry entry intentionally mirrors the coding-plan
  subset, not the full Z.AI API.
- minimax default M2.5 -> M3: secondary-only evidence; defaults with unverified account
  availability are risk; revisit with live discovery (Phase 2).
- neuralwatt alias gaps: provider has authoritative live /v1/models (registry comment L328);
  Phase 2 dynamic path covers it; static churn skipped.
- opencode-go metadata arrays: owned by src/generated/jawcode-model-metadata.ts — refresh only
  via scripts/generate-jawcode-metadata.ts (attempted in Phase 1; network-dependent).

## Live models endpoints (for Phase 2)
OpenAI /v1/models OFFICIAL; Anthropic /v1/models OFFICIAL
(https://platform.claude.com/docs/en/api/models); xai /v1/models OFFICIAL (001 doc);
zai/moonshot/deepseek/minimax UNVERIFIED (likely OpenAI-compatible; verify before enabling);
neuralwatt live per registry comment; umans/opencode-go no public docs.
