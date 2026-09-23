# 260923 Claude Opus 5.5 catalog, pricing and 1M context

## Problem

Anthropic released Claude Opus 5.5 (`claude-opus-5-5`) on 2026-09-22. Live Anthropic discovery
already lists it, so the picker shows the row, but nothing in the static catalog knows it:

- `/v1/models` on the running proxy returns `anthropic/claude-opus-5-5` with no
  `max_output_tokens`, no input modalities, `supports_reasoning: false` and no effort ladder,
  while `anthropic/claude-opus-5` carries all of them.
- The price resolver has no overlay, no bundled metadata row and no vendor fallback for the id,
  so the ~$ column and every price surface render blank. 560 logged anthropic requests and 10
  `anthropic-native` requests (`claude-opus-5.5` / `claude-opus-5-5`) are currently unpriced.

## Evidence (collected 2026-09-23)

| Source | Surface | Facts |
|---|---|---|
| platform.claude.com/docs/en/about-claude/pricing | Aside repl | Opus 5.5: $4 in, $5 5m write, $8 1h write, $0.20 cache hit (0.05x footnote), $20 out; batch $2/$10; fast $8/$40. Opus 5 now listed at $5/$6.25/$10/$0.50/$25 |
| platform.claude.com/docs/en/models/opus-5-5/overview | Aside repl | id `claude-opus-5-5`, 1M context, 128K output (300K batch beta), adaptive thinking always on, default effort medium, Bedrock `anthropic.claude-opus-5-5` |
| platform.claude.com/docs/en/build-with-claude/effort | Aside repl | Opus 5.5 supports all five levels (low..max) |
| platform.claude.com/docs/en/models/opus-5-5/migration-guide | Aside repl | thinking disabled/enabled 400; tool_choice any/tool 400 |
| cursor.com/docs/models/claude-opus-5-5 | Aside repl | Cursor id `claude-opus-5-5`, 300K default / 1M max context, no long-context multiplier, $4/$5/$0.2/$20; fast `claude-opus-5-5-fast` $8/$10/$0.4/$40; thinking variant |
| docs.devin.ai/desktop/models | Aside repl | Opus 5.5 not in the modelCostData table yet |
| running proxy `/v1/models` | curl | `devin/claude-opus-5-5` is live, context 1_000_000, efforts low..max |
| kiro.dev/docs/models | Aside repl | no Opus 5.5 |
| models.dev/api.json | curl | anthropic, amazon-bedrock (6 ids, regional 1.1x), kilo `anthropic/claude-opus-5.5`, venice `claude-opus-5-5` (4.8/24/0.24/6), openrouter `anthropic/claude-opus-5.5`, all 1M/128K |
| openrouter.ai/api/v1/models | curl | `anthropic/claude-opus-5.5` 1M/128K, 4/20/0.2/5 |
| ai-gateway.vercel.sh/v1/models | curl | `anthropic/claude-opus-5.5` 4/20/0.2/5 and `-fast` 8/40/0.4/10 |

GitHub Copilot and opencode-zen have no Opus 5.5 upstream yet; Kiro has none; they stay unchanged.

## Diff-level plan (wp1, one PABCD cycle)

1. `src/usage/expected-prices.ts`
   - Add `CLAUDE_OPUS_55: Cost4 = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }` with a
     comment naming the 0.05x cache-hit footnote.
   - Overlays: `anthropic` and `anthropic-apikey` (verified, ANTHROPIC_PRICING),
     `cursor` (verified-derived, cursor.com/docs/models/claude-opus-5-5 vendor page),
     `devin` and `devin-cli` (verified-derived, absent from Devin table, Anthropic list price).
   - Promote the three Opus 5 rows from the user-confirmed derived source to the now-published
     Anthropic list price (`CLAUDE_OPUS_5` constant, anthropic row `verified`, cursor/kiro keep
     `verified-derived`). Tuple unchanged.
2. `scripts/model-metadata.source.json` (snapshot rows copied from each provider's claude-opus-5
   row shape, values from models.dev / vendor APIs) then regenerate `src/generated/model-metadata.ts`:
   anthropic `claude-opus-5-5`; amazon-bedrock `anthropic.`, `global.`, `us.`, `eu.`, `jp.`,
   `au.anthropic.claude-opus-5-5`; openrouter `anthropic/claude-opus-5.5`; vercel-ai-gateway
   `anthropic/claude-opus-5.5` and `anthropic/claude-opus-5.5-fast`; kilo
   `anthropic/claude-opus-5.5`; venice `claude-opus-5-5`.
3. `src/providers/registry/model-seeds.ts`: `claude-opus-5-5` first among Opus in
   `ANTHROPIC_MODELS`, `1_000_000` in `ANTHROPIC_MODEL_CONTEXT_WINDOWS`, provenance comment.
4. Devin: `claude-opus-5-5` in the devin registry seed list (entries-core) and
   `DEVIN_MODEL_CONTEXT_WINDOWS` = 1_000_000 (value read from the live catalog).
5. Cursor: `CURSOR_CAPABILITIES["claude-opus-5-5"]` (Claude Opus 5.5, 1M window, thinking default,
   regular/thinking/fast/thinkingFast FULL ladder, preemptive until the live roster is measured);
   effort-map tiers for base, -fast, -thinking, -thinking-fast and thinking families;
   `models-capabilities.ts` local picker family regex `^claude-opus-5(?:-5)?$`.
6. Docs: `reference/configuration/providers.md` Cursor Fast base list gains `claude-opus-5-5`
   in English and every locale carrying the same token list.
7. Tests: add focused assertions next to existing ones (usage-cost overlay/resolver, anthropic seed,
   cursor capability) without growing any file past its ratchet cap; update pinned rosters.

Adapter check: `claudeFamilyVersion("claude-opus-5-5")` = opus 5.5, so adaptive wire is used and
explicit `thinking: disabled` (sonnet >= 5 only) is never sent. Forced `tool_choice` mapping is a
generic path shared by all models; out of scope, reported as a residual.

## Verification

- `bun run generate:model-metadata` then `bun test tests/codex-integration/model-metadata-sync.test.ts`
- `bun test tests/usage tests/providers/cursor tests/providers/model-presets.test.ts tests/providers/devin-adapter.test.ts` plus
  registry/anthropic tests selected by `bun run test:changed`
- `bun run typecheck`, file-size ratchet + test-layout tests, `bun run structure:check`,
  `bun run privacy:scan`
- Post-change: resolver probe prints the Opus 5.5 tuple for anthropic, anthropic-native dot id, cursor, devin.

## Bounds

Write scope: files above plus this devlog unit. No push, merge, release or service restart inside
the loop. Wall clock: single session.

