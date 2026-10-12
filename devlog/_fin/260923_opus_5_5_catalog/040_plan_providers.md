# 040 Plan (wp2): Opus 5.5 on non-Anthropic providers

Continues 030: the Anthropic-family rollout is committed; the user asked for every other provider
that carries claude-opus-5. Five parallel xai/grok-4.7 research leaves checked each one on 2026-09-23.

## Classification

| Provider | Evidence | Decision |
|---|---|---|
| Opper | api.opper.ai/v3/models?limit=2000: pool `claude-opus-5-5` (anthropic, aws eu, vertex, vertex-eu), all 1M / 128K, vision, efforts low..max on the Anthropic member | ADD to `OPPER_MODELS`, context 1_000_000, max output 128_000 |
| GitHub Copilot | github.blog changelog 2026-09-22 (GA); docs models-and-pricing $4 / $0.20 cached / $5 write / $20; 1M context in VS Code and CLI; API id unpublished | ADD metadata row `claude-opus-5-5` (catalog's hyphen convention, same as `claude-opus-5`), shape of the Opus 5 row (64K output, effort minimal..high, openai-completions), GitHub-published price. Live discovery owns the roster, so a wrong id stays inert |
| Command Code | api.commandcode.ai/provider/v1/models lists `claude-opus-5-5`, 1M | NO static site (live-only registry entries). Price resolves through the Anthropic vendor fallback; add a regression assertion |
| Kiro | kiro.dev models, available-models, effort, changelog: no Opus 5.5 | NOT ADDED: `KIRO_MODELS` is a static user-visible list; an unpublished id would be a dead selection |
| opencode-zen / opencode-go | live /zen/v1/models and /zen/go/v1/models: no Opus 5.5 | NOT ADDED |
| OpenRouter / Venice / Kilo fast | live lists: no 5.5 fast | NOT ADDED (Vercel fast already present) |
| google-antigravity | only claude-opus-4-6-thinking live | NOT ADDED |
| Docs/README | `anthropic/claude-opus-5` used as routing examples | LEAVE (prose) |

## Diff

1. `src/providers/registry/model-seeds.ts`: `claude-opus-5-5` above `claude-opus-5` in the three Opper maps.
2. `scripts/model-metadata.source.json`: github-copilot `claude-opus-5-5` cloned from its `claude-opus-5`
   row with cost 4 / 20 / 0.2 / 5; regenerate `src/generated/model-metadata.ts`.
3. `tests/usage/usage-cost.test.ts`: Opus 5.5 test also asserts command-code, opper and github-copilot.

## Verification

model-metadata sync, usage-cost, opper/commandcode/registry tests, typecheck, ratchet, layout,
structure:check, privacy:scan, fresh-process probe. Then push, PR to dev, exact-head CI, merge
(user authorized merge on 2026-09-23).

