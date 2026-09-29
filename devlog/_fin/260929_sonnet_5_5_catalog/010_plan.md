# 260929 Claude Sonnet 5.5 catalog, pricing and adapter contract

## Problem

Anthropic released Claude Sonnet 5.5 (`claude-sonnet-5-5`) on 2026-09-28. Live Anthropic discovery on
the running proxy already lists `anthropic/claude-sonnet-5-5` (1M context) but with no
`max_output_tokens`, `supports_reasoning: false`, no effort ladder and no price, because nothing in
the static catalog knows the id. Every other provider that carries `claude-sonnet-5` has no row at all.

The model also changes the request contract. Sonnet 5 accepts `thinking: {type: "disabled"}`, and the
Anthropic adapter sends exactly that for reasoning `none` on every Sonnet >= 5.0. Sonnet 5.5 rejects it
with a 400 and adds `thinking: {type: "between_tools"}` as its lowest setting. It also rejects forced
`tool_choice` (`any`/`tool`) like Opus 5.5, and non-default temperature/top_p/top_k.

## Evidence (collected 2026-09-29)

| Source | Surface | Facts |
|---|---|---|
| platform.claude.com/docs/en/about-claude/pricing | Aside exec | Sonnet 5.5: $2 in, $2.50 5m write, $4 1h write, $0.20 hit (standard 0.1x), $10 out; batch $1/$5; no fast mode; no long-context premium; `inference_geo: us` 1.1x |
| platform.claude.com/docs/en/models/overview | Aside exec | id and alias `claude-sonnet-5-5`; Bedrock `anthropic.claude-sonnet-5-5`; Google Cloud / Foundry `claude-sonnet-5-5`; 1M context; 128K output; adaptive thinking; default effort high |
| .../models/sonnet-5-5/whats-new-sonnet-5-5 and migration-guide | Aside exec | `thinking.type` accepts only `adaptive` and `between_tools`; `disabled` and `enabled` 400; `between_tools` 400 at xhigh/max; forced tool choice 400; non-default sampling params 400 |
| .../build-with-claude/effort | Aside exec | low, medium, high, xhigh, max; default high |
| .../build-with-claude/fast-mode | Aside exec, kimi | fast mode is Opus-only; no Sonnet 5.5 fast anywhere |
| models.dev/api.json | curl, kimi | anthropic, azure, vertex, kilo, openrouter, vercel, bedrock `global.anthropic.claude-sonnet-5-5`; all 1M / 128K, 2 / 10 / 0.2 / 2.5 |
| openrouter.ai/api/v1/models | curl | `anthropic/claude-sonnet-5.5` 1M / 128K, 2 / 10 / 0.2 / 2.5 |
| ai-gateway.vercel.sh/v1/models | curl | `anthropic/claude-sonnet-5.5` 1M / 128K, 2 / 10 / 0.2 / 2.5; no -fast |
| api.kilo.ai gateway models | kimi | `anthropic/claude-sonnet-5.5` 2 / 10 / 0.2 / 2.5 |
| api.venice.ai/api/v1/models | kimi | `claude-sonnet-5-5` 1M / 128K, 3.75 / 18.75 / 0.375 / 4.6875 |
| cursor.com/docs/models/claude-sonnet-5-5 | kimi | id `claude-sonnet-5-5`, 200K default / 1M max, thinking supported, 2 / 2.5 / 0.2 / 10; no fast; not yet in the live Cursor roster |
| github.blog changelog 2026-09-28, docs models-and-pricing | kimi | Copilot GA; $2 / $0.20 cached / $2.50 write / $10; 1M context; no API id published |
| docs.devin.ai/desktop/models, running proxy devin/* | kimi | no Sonnet 5.5 |
| kiro.dev/docs/models, changelog | kimi | no Sonnet 5.5 |
| api.commandcode.ai/provider/v1/models | kimi | no Sonnet 5.5 |
| opencode.ai/zen/v1/models, zen/go | kimi | no Sonnet 5.5 (go has no Claude at all) |
| api.opper.ai/v3/models | kimi | no Sonnet 5.5 |
| zenmux.ai/api/v1/models, Cloudflare catalog | kimi | no Sonnet 5.5 |
| installed Claude Code 2.1.283 binary | strings | `sonnet` alias still resolves to `claude-sonnet-5`; no `claude-sonnet-5-5` string |

Raw captures: `.tmp/sonnet55/` (scratch, not committed).

## Provider classification

| Provider | Decision | Id | Numbers |
|---|---|---|---|
| anthropic, anthropic-apikey | ADD seed, context, snapshot row, overlays (verified) | `claude-sonnet-5-5` | 2 / 10 / 0.2 / 2.5, 1M / 128K |
| amazon-bedrock | ADD 6 snapshot rows; `global.` published, `anthropic.` from Anthropic docs, us/eu/jp/au preemptive | `*.anthropic.claude-sonnet-5-5` | base 2 / 10 / 0.2 / 2.5; regional 1.1x = 2.2 / 11 / 0.22 / 2.75 (same rule as Opus 5.5 rows) |
| openrouter, vercel-ai-gateway, kilo | ADD snapshot rows (published) | `anthropic/claude-sonnet-5.5` | 2 / 10 / 0.2 / 2.5 |
| venice | ADD snapshot row (published) | `claude-sonnet-5-5` | 3.75 / 18.75 / 0.375 / 4.6875 |
| github-copilot | ADD snapshot row (published price; hyphen id convention of its Sonnet 5 / Opus 5.5 rows) | `claude-sonnet-5-5` | 2 / 10 / 0.2 / 2.5 |
| cursor | ADD capability, effort tiers, picker family, price overlay (published price; roster shape preemptive) | `claude-sonnet-5-5` | 2 / 10 / 0.2 / 2.5; 1M window |
| devin, devin-cli | ADD preemptive seed, context and derived overlays | `claude-sonnet-5-5` | 1M; Anthropic list price |
| kiro | ADD preemptive model and 1M context (dot spelling like its other rows) | `claude-sonnet-5.5` | price via vendor fallback |
| opencode-zen | ADD preemptive snapshot row | `claude-sonnet-5-5` | 2 / 10 / 0.2 / 2.5 |
| zenmux | ADD preemptive snapshot row (its dot convention) | `anthropic/claude-sonnet-5.5` | 2 / 10 / 0.2 / 2.5 (its Sonnet 5 row shape) |
| cloudflare-ai-gateway | ADD preemptive snapshot row (its hyphen convention) | `anthropic/claude-sonnet-5-5` | 2 / 10 / 0.2 / 2.5 |
| Claude Desktop picker suggestions | ADD `claude-sonnet-5-5` (suggestion list only) | | |
| Command Code, Opper | NO static site: neither seeds `claude-sonnet-5` today; live discovery owns the roster and price resolves through the Anthropic vendor row | | |
| opencode-go | NO: carries no Claude model | | |
| any fast tier | NO: Anthropic has no Sonnet fast mode | | |
| Claude Code native tier map, web-search / vision sidecar defaults | UNCHANGED: Claude Code 2.1.283 still sends `claude-sonnet-5`; the sidecars send `thinking: disabled`, which Sonnet 5.5 rejects | | |

## Diff-level plan (wp2)

1. `src/adapters/anthropic.ts`
   - `supportsExplicitThinkingDisable`: Sonnet 5.0 <= v < 5.5 only (5.5 rejects `disabled`).
   - New `usesBetweenToolsFloor`: Sonnet >= 5.5. Reasoning `none` sends `thinking: {type: "between_tools"}`
     with no effort (the API default high is inside the accepted low..high range) and drops temperature/top_p.
   - `rejectsForcedToolChoice`: Opus 5.5 and Sonnet >= 5.5.
   - `rejectsSamplingParameters`: Sonnet >= 5.5 drops temperature/top_p on every path.
2. `src/usage/expected-prices.ts`: `CLAUDE_SONNET_55` = 2 / 10 / 0.2 / 2.5; overlays anthropic,
   anthropic-apikey (verified), cursor (verified, Cursor model page), devin and devin-cli
   (verified-derived, preemptive).
3. `scripts/model-metadata.source.json` rows listed above, cloned from each provider's claude-sonnet-5
   row with the new id/name/cost; regenerate `src/generated/model-metadata.ts`.
4. `src/providers/registry/model-seeds.ts`: `claude-sonnet-5-5` before `claude-sonnet-5` in
   `ANTHROPIC_MODELS`, 1M in the context map, provenance comment.
5. Devin: `entries-core.ts` seed list and `DEVIN_MODEL_CONTEXT_WINDOWS`.
6. Kiro: `KIRO_MODELS` + `KIRO_MODEL_CONTEXT_WINDOWS` (`claude-sonnet-5.5`).
7. Cursor: `CURSOR_CAPABILITIES["claude-sonnet-5-5"]` shaped like Opus 5.5 (flat effort ids, regular
   FULL ladder, no fast/thinking variant until the live roster is measured); effort-map tier row;
   `models-capabilities.ts` picker family regex.
8. `src/claude/intercept/model-bindings.ts` suggestion list.
9. `structure/providers/chat-compat.md`: Sonnet 5.5 thinking floor, forced tool choice and sampling.
10. Tests next to existing ones, within ratchet caps: adapter wire shape (none -> between_tools, forced
    choice -> auto, sampling stripped, Sonnet 5 unchanged), usage-cost resolver across providers,
    kiro/cursor rosters if pinned.

## Verification

- `bun run generate:model-metadata`, model-metadata sync test
- focused: tests/adapters/anthropic, tests/usage, tests/providers/cursor, tests/providers/kiro,
  devin tests, registry parity; `bun run test:changed`
- `bun run typecheck`, file-size ratchet + test-layout, `bun run structure:check`, `bun run privacy:scan`
- Live: adapter-built requests against api.anthropic.com for Sonnet 5.5 with reasoning none, medium,
  required tool choice; expect 200 after the fix (token read in memory, never printed).
- Fresh-process resolver probe for every provider row.

## Bounds

Write scope: files above plus this unit. PR to `dev`, exact-head CI, merge, then release via
`scripts/release.ts` (user asked to deploy on 2026-09-29).


## Plan after audit (020)

- Item 5 is two files: `src/providers/registry/entries-core.ts` devin seed list and
  `DEVIN_MODEL_CONTEXT_WINDOWS` in `src/adapters/devin/live-models.ts`. `DEVIN_STATIC_MODELS` stays
  untouched; live discovery owns the roster.
- Item 6: no `KIRO_NATIVE_EFFORT_FIELDS` entry. Kiro's `claude-sonnet-5` uses emulated effort and only
  Opus has a measured native field.
- Item 7: no `models-capabilities.ts` regex change, matching what Opus 5.5 actually shipped. The Cursor
  row is regular-only until the id appears in the live GetUsableModels roster; that listing is the
  trigger to re-shape it (thinking variant or flat effort ids, whichever the roster shows).
- Sidecars: add a shared `anthropicThinkingOff(modelId)` in the adapter and use it in the web-search
  and vision sidecars, so a sidecar pointed at Sonnet 5.5 sends `between_tools` instead of a
  rejected `disabled`. Defaults stay `claude-sonnet-5`.
- Tests: `kiro-adapter.test.ts` gets only the in-line roster element (3 lines of ratchet headroom);
  new assertions go to sibling files registered in `scripts/test-layout/layout.json` and
  `tests/fixtures/test-layout-expected.json`. Update the usage-cost surface loops, the cursor catalog
  flat-wire case, the devin context pin and add anthropic wire-shape cases.
- Residuals recorded, not fixed here: dotted Bedrock ids do not parse in `claudeFamilyVersion` (all
  families), and the Messages-native passthrough forwards caller `thinking`/sampling verbatim.

