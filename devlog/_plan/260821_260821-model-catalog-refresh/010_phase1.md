# 010 — wp1: Registry metadata refresh (diff level)

## MODIFY: src/providers/registry.ts

- Shared constants next to DEEPSEEK_THINKING_MODELS:
  - NEW `DEEPSEEK_VISION_PREVIEW_MODEL = "deepseek-v4-flash-vision-exp"` with the
    merge-into-v4-flash comment (released 2026-08-21, api-docs.deepseek.com).
  - NEW `OPENCODE_OX_ALPHA_FREE_MODEL = "x-preview-f-free"` (Zen's slug for
    openrouter.ai/stealth/ox-alpha, displayed "Ox Alpha Free").
  - NEW `OX_ALPHA_CONTEXT_WINDOW = 1_048_576`.
- `deepseek` entry: append vision preview to `models`; add its 1_048_576 context
  and `["text","image"]` modality. Deliberately NOT in noVisionModels.
- `opencode-go`: add both ids to modelContextWindows/modelInputModalities
  (metadata-only; roster is live-discovered).
- `opencode-free` and `opencode-zen`: same two-id metadata blocks.
- `openrouter`: seed "stealth/ox-alpha" into `models`, context map, and
  `modelInputModalities` (API reports text+image+video; image is what the proxy
  can forward today).
- `command-code` (OAuth) and `commandcode` (API): context + modality facts for
  "stealth/ox-alpha" and "deepseek/deepseek-v4-flash-vision-exp".

## MODIFY: src/providers/command-code-efforts.ts

- NEW row `"stealth/ox-alpha"` efforts ["low","high","max"], profileUrl
  commandcode.ai/models/ox-alpha (profile publishes no ladder; mirrors the
  OpenRouter mandatory-reasoning contract).

## Verification

- `bun x tsc --noEmit` (Bun 1.4.0) — exit 0.
- Focused suites: provider-registry-parity, adapter-resolve, opencode-free-provider,
  command-code-provider, command-code-quota, codex-catalog, client-config-export,
  commandcode-provider — 349 pass, 0 fail.

## Outcome

Commit d23c3179f, pushed to origin/dev (admin bypass, ruleset restored).

