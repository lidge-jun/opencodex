# 261008 Claude Haiku 5.5 catalog, pricing and request contract

## Loop spec

- Class: C3 (catalog + pricing + adapter contract, cross-provider; no persistence or auth change).
- Goal: session 01a11911-4ca5-7252-a072-a46c7de5e759, goalplan `add-claude-haiku-5-5-claude-haiku-5-5-released-2`, work-phase wp1.
- Source worktree: `.tmp/lanes/h-haiku-5-5`, branch `codex/haiku-5-5-catalog` from origin/dev `bf9ecf3d79`.
- Write scope: files listed in the diff map below plus this unit. No GUI, no release.
- Tool/credential scope: public HTTP (models.dev, openrouter, vercel, cursor docs), Aside exec read-only docs, the local Anthropic OAuth credential read in memory for live contract probes (never printed or written).
- Budget: one PABCD cycle; wall clock bound 6h.
- SoT sync target: `structure/providers-and-adapters.md`, `structure/providers/chat-compat.md`, `structure/dashboard-and-usage.md` (line budgets 600; replace, do not append).

## Problem

Anthropic released Claude Haiku 5.5 (`claude-haiku-5-5`) on 2026-10-07. Nothing in the static catalog knows it, so live discovery shows no price, the native Anthropic seed lacks it, and the adapter would send Haiku 4.5's request shape: `thinking: enabled` with a budget (400 on Haiku 5.5) and non-default temperature/top_p (400). Its price is the first Claude price with a prompt-length band (5x above 100K prompt tokens). The same launch cut Claude Sonnet 5.5's cache-read price from 0.20 to 0.10.

## Evidence (2026-10-08)

| Source | Surface | Facts |
|---|---|---|
| platform.claude.com pricing, models overview, haiku-5-5 overview / whats-new / migration guide, effort, thinking, thinking-troubleshooting, fast-mode; anthropic.com/claude-haiku-5-5 | Aside exec (`.tmp/haiku55/aside-docs.md`) | id `claude-haiku-5-5` (fixed, no date); Bedrock `anthropic.claude-haiku-5-5`; Vertex/Foundry `claude-haiku-5-5`; 1M / 128K (300K batch beta); adaptive thinking on by default; effort low..max, default medium; `enabled` 400; `between_tools` 400; `disabled` OK at effort <= high, 400 at xhigh/max; forced tool_choice accepted; non-default temperature/top_p/top_k 400; assistant prefill 400; no fast mode; no Priority Tier; price <=100K 0.10 in / 0.50 out / 0.125 5m write / 0.20 1h write / 0.01 hit, >100K 0.50 / 2.50 / 0.625 / 1.00 / 0.05; Sonnet 5.5 cache hit now 0.05x (0.10) |
| models.dev/api.json | curl | anthropic, bedrock (anthropic., global. base; us./eu./jp./au. 1.1x), openrouter, vercel, kilo (no tier), opencode, opencode-go, venice (1.25x), vertex, azure: 1M/128K, base 0.1/0.5/0.01/0.125 with context tier size 100000 at 5x; Sonnet 5.5 cache_read 0.1 on anthropic, openrouter, vercel, kilo, github-copilot, edenai; 0.2 on bedrock, vertex, azure, cloudflare, opencode; venice Sonnet 5.5 2.5/12.5/0.125/3.125 |
| openrouter.ai/api/v1/models | curl | `anthropic/claude-haiku-5.5` 1M/128K, override min_prompt_tokens 100000 at 5x; Sonnet 5.5 cache read 1e-7 |
| ai-gateway.vercel.sh/v1/models | curl | `anthropic/claude-haiku-5.5` tiers min 100001; regional eu/us 1.1x |

Raw captures: `.tmp/haiku55/` (scratch, not committed).

## Architect consultation

Architect: gpt-6.1-sol subagent 01a1199b-4ba7-7193-b5d0-b4e0f68092fb, read-only, proposal D1-D10 (kept in the session transcript). Dispositions:

| ID | Proposal | Disposition |
|---|---|---|
| D1 | Keep existing owners; per-family contract, no shared "5.5" contract | ACCEPT |
| D2 | Edit-site map from c34c4d20db plus native max output 128K | ACCEPT |
| D3 | Exact CONTEXT_TIERS rows, threshold 100_000, inclusive false, multiplier 5x on all four, omit confirmedPriorityRelation | ACCEPT with scope: anthropic, anthropic-apikey, six Bedrock ids, openrouter, vercel-ai-gateway, opencode-go, opencode-zen, venice; reference tiers on every preemptive surface that gets a Haiku 5.5 row or overlay (cursor regular ids, devin, devin-cli, kiro, claude-cli if it resolves a price, zenmux, cloudflare, github-copilot). Kilo untiered (its listing has no tier). REJECT google-vertex `@default` overlay: the preset uses the Google bundle and has no Claude transport; pricing an unsupported surface is out of scope |
| D4 | Add opencode-go row; no wire override without gateway evidence | ACCEPT; residual recorded |
| D5 | Contract: adaptive minimum haiku 5.5; explicit disable for haiku >= 5.5; sampling rejection haiku >= 5.5; between_tools stays Sonnet-only and forced-choice rejection stays Opus 5.5 / Sonnet >= 5.5 / Fable >= 5.1 (`rejectsForcedToolChoice` in `anthropic-model-contract.ts`) | ACCEPT; no change to those two predicates |
| D6 | Keep all defaults; built-in `haiku` alias becomes ambiguous and is suppressed | ACCEPT: same rule already suppressed `sonnet` and `opus` when Sonnet 5.5 / Opus 5.5 landed; default aliases are opt-in; add regression |
| D7 | Sonnet 5.5 cache-read 0.2 -> 0.1 by provenance | ACCEPT as amended by 020: anthropic snapshot + `CLAUDE_SONNET_55` (anthropic, anthropic-apikey, cursor verified from cursor.com, derived devin/devin-cli/antigravity), openrouter, vercel, kilo, github-copilot snapshots to 0.1; venice exact overlay 2.5/12.5/0.125/3.125. Bedrock unchanged (partner pricing still 0.2/0.22). opencode-zen, cloudflare, zenmux have no bundle and follow the Anthropic fallback to 0.1 |
| D8 | Sibling tests within ratchet headroom | ACCEPT |
| D9 | structure docs at budget: replace prose | ACCEPT. docs-site scope exception: docs-site has no per-model Claude roster or Claude price table (only illustrative Haiku 4.5 examples; `reference/configuration/providers.md` documents OpenAI/xAI bands only) and #6210 changed no docs-site page. The roster reaches users through the live catalog and Claude CLI picker; the price band is documented in `structure/dashboard-and-usage.md` |
| D10 | Verification set | ACCEPT plus live probes and the broader-validation exception recorded under Verification |

## Diff-level plan

1. Contract (`src/adapters/anthropic-model-contract.ts`): add `haiku: [5, 5]` to the adaptive-thinking minimums and the sampling-rejection minimums; extend `supportsExplicitThinkingDisable` to Haiku >= 5.5 (alongside the bounded Sonnet range). `usesBetweenToolsFloor`, `rejectsForcedToolChoice`, `hasNoThinkingOffSwitch` unchanged. Comments in `src/adapters/anthropic.ts` updated where they name families. Resulting wire: reasoning none -> `thinking: disabled`; low..max -> adaptive + `output_config.effort`; omitted reasoning -> no thinking/effort (API default medium); temperature/top_p dropped on every path; forced tool choice kept.
2. Pricing (`src/usage/expected-prices.ts`): `CLAUDE_HAIKU_55` = 0.1 / 0.5 / 0.01 / 0.125 with provenance; overlays anthropic, anthropic-apikey (verified, official pricing page opened directly), venice exact 0.125 / 0.625 / 0.0125 / 0.15625 (`verified-derived`: models.dev listing, not a Venice page), cursor exact overlays for the 18 ids Cursor can emit, generated in code as `CURSOR_HAIKU_55_IDS` = three base spellings (`claude-haiku-5-5`, `claude-haiku-5.5`, `claude-5.5-haiku`) x (bare + `-low/-medium/-high/-xhigh/-max`) per `src/adapters/cursor/catalog.ts` effort-id composition (`verified`: cursor.com/docs/models/claude-haiku-5-5), devin/devin-cli (verified-derived, preemptive); Venice exact Sonnet 5.5 overlay 2.5 / 12.5 / 0.125 / 3.125 (verified-derived listing; its snapshot row is inert because Venice has no generated bundle); `HAIKU_55_LONG_CONTEXT` 5x multiplier and CONTEXT_TIERS rows per D3 (exact ids; cursor ids derived from the capability's regular level list). `CLAUDE_SONNET_55.cacheRead` 0.1 and source/date refresh per D7 (fans out to anthropic, anthropic-apikey, cursor, devin, devin-cli and the four Antigravity derived overlays). Tier rows: exact provider + id for anthropic, anthropic-apikey, six Bedrock ids, openrouter, vercel-ai-gateway, opencode-go, opencode-zen, venice, github-copilot, cloudflare-ai-gateway, zenmux, kiro `claude-haiku-5.5`, devin, devin-cli, claude-cli (if it resolves a price), and all 18 `CURSOR_HAIKU_55_IDS`. Kilo untiered.
3. Snapshot (`scripts/model-metadata.source.json`), regenerate `src/generated/model-metadata.ts` with `bun run generate:model-metadata`: Haiku rows anthropic, Bedrock x6 (base / 1.1x), openrouter, vercel, kilo, venice, opencode-zen, opencode-go (published); github-copilot, cloudflare, zenmux (preemptive, repository id conventions). All 1M / 128K, reasoning, text+image. Sonnet 5.5 corrections per D7. Runtime consumers: only bundled providers (anthropic, amazon-bedrock, openrouter, opencode-go) read these rows for catalog metadata; rows for venice, vercel, kilo, github-copilot, cloudflare, zenmux and opencode-zen are inert snapshot parity with #6210, and those providers price through the Anthropic vendor fallback (so opencode-zen, cloudflare and zenmux Sonnet 5.5 cache read follows the Anthropic correction to 0.1).
4. Seeds (`src/providers/registry/model-seeds.ts`): `claude-haiku-5-5` before `claude-haiku-4-5`, context 1_000_000, max output 128_000, provenance comment.
5. Devin (`entries-core.ts` seed list, `devin/live-models.ts` context), Kiro (`kiro-models.ts` `claude-haiku-5.5` + 1M), Cursor (`cursor/catalog.ts` regular-only FULL ladder, `cursor/effort-map.ts` low..max), Claude Desktop suggestion (`claude/intercept/model-bindings.ts`). All preemptive.
6. Structure docs per D9 (replace prose within budgets).
7. Tests: new `tests/adapters/anthropic/anthropic-haiku-5-5-contract.test.ts`, `tests/usage/usage-haiku-5-5-pricing.test.ts`, `tests/providers/haiku-5-5-catalog.test.ts` (registered in both layout maps, layout.json kept <= 1999 lines); updates to `usage-cost.test.ts` (Sonnet tuples, overlay count), `tests/usage/usage-antigravity-55.test.ts` (Sonnet cache read 0.1 plus a cache-read-token case), `anthropic-output-maxima.test.ts`, `cursor-catalog.test.ts`, `devin-adapter.test.ts`, `kiro-adapter.test.ts` (inline only, 3 lines headroom).

## Acceptance (activation scenarios)

- Tier boundary: `estimateRequestCost` / `estimateAttemptCost` for anthropic `claude-haiku-5-5` at 100,000 raw input tokens uses base; at 100,001 uses 5x on input, output, cache read and cache write. The same 100,001 case is asserted for every tier row: account-labelled anthropic provider, six Bedrock ids (regional at 1.1x base), openrouter/vercel slash ids, opencode-go, opencode-zen, venice, copilot, cloudflare, zenmux, kiro dotted id, devin, devin-cli, and every one of the 18 Cursor ids (three spellings x bare and five regular effort suffixes, including `claude-haiku-5.5-medium` and `claude-5.5-haiku-medium`), each with a non-null price; plus one selection-to-estimation case that resolves a Cursor effort selection through the catalog and estimates it at 100,001 tokens. Kilo stays base above 100K.
- Contract: adapter-built body for Haiku 5.5 with reasoning none has `thinking.type = disabled` and no effort; with medium/max has adaptive + effort; temperature/top_p absent; `tool_choice` required -> `any` retained. Controls: Haiku 4.5 still enabled+budget; Sonnet 5.5 still between_tools and forced->auto.
- Alias: two Haiku ids suppress the built-in `haiku` alias; an explicit user alias still wins.
- Sonnet correction: anthropic/openrouter/vercel/kilo/copilot Sonnet 5.5 resolve cache read 0.1; bedrock stays 0.2.

## Consumer chains (PLAN-FIELD-CHAIN-01)

| New value | Creation | Serialization | Deserialization | Consumers |
|---|---|---|---|---|
| `haiku: [5, 5]` in adaptive and sampling minimum tables, Haiku clause in `supportsExplicitThinkingDisable` | `anthropic-model-contract.ts` | N/A (in-memory predicate) | N/A | `anthropic.ts` thinking/effort/sampling builders, `sidecarThinkingOff` (vision, web-search), `rejectsCombinedSampling` guard |
| `CLAUDE_HAIKU_55`, `HAIKU_55_LONG_CONTEXT`, tier rows | `expected-prices.ts` | N/A | N/A | `findExpectedPriceOverlay`, `findContextTier` -> `cost.ts` `applyContextTier` -> `estimateRequestCost`/`estimateAttemptCost` -> usage records and dashboard |
| `CLAUDE_SONNET_55.cacheRead` 0.1 | `expected-prices.ts` | N/A | N/A | anthropic, anthropic-apikey, cursor, devin, devin-cli, Antigravity overlays |
| Snapshot rows | `model-metadata.source.json` | `generate:model-metadata` -> `src/generated/model-metadata.ts` | `resolveMetadataProvider` (bundled providers only) | catalog parsing, model hints, vendor price fallback |
| Seed id, context, max output | `model-seeds.ts` | N/A | N/A | Anthropic OAuth/key entries, Claude CLI roster, native context, effort/modality maps, default-alias claims |

## Verification

- `bun run generate:model-metadata` then `tests/codex-integration/model-metadata-sync.test.ts` (exists; reads the generated file).
- Focused: the three new tests plus updated files listed in item 7; `tests/adapters/anthropic/anthropic-sonnet-5-5-contract.test.ts`, `tests/providers/provider-registry-parity.test.ts`, `tests/usage/usage-antigravity-55.test.ts`.
- `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts tests/ci-workflows/file-size-ratchet.test.ts`, `bun run typecheck`, `bun run structure:check`, `bun run privacy:scan`.
- Live: adapter-built requests to api.anthropic.com with the local Anthropic OAuth credential (token in memory only) for Haiku 5.5 reasoning none, medium, max, required tool choice, temperature 0.2 set by the caller; expect 200 after the change and record the pre-change 400s. Control: Haiku 4.5 reasoning medium.
- Broader validation: `bun run test:changed` (import graph against the resolved dev merge base) in addition to the focused files. Full-suite exception (AGENTS.md resource clause): 15+ concurrent lane worktrees share this machine, so a full local `bun run test` would contend with them; the PR's exact-head CI runs all four test shards plus macOS/Windows legs and is required before merge. `tests/providers/provider-registry-parity.test.ts` imports the generated metadata and seeds directly, so `test:changed` reaches it; it is also run explicitly in the focused set. `tests/codex-integration/model-metadata-sync.test.ts` reads the generated file as data and is run explicitly.

## Residuals (recorded, not fixed here)

- Dotted Bedrock ids do not parse as a Claude family (all families).
- Messages-native passthrough forwards caller `thinking`/sampling verbatim.
- One-hour cache writes (0.20 / 1.00) are estimated at the 5-minute price; the estimator has one cache-write bucket.
- Whether cached tokens count toward Anthropic's 100K threshold is unstated; the existing tier mechanism uses inclusive raw input.
- OpenRouter publishes `min_prompt_tokens: 100000`; rule uses `> 100000` like Anthropic and Vercel.
- opencode-go Haiku request wire is unverified; Cursor roster and Bedrock/reseller propagation of the Sonnet cut are unverified.
- Claude CLI output default stays 64K.

## Bounds

PR to `dev`, exact-head CI, squash merge. No release.

