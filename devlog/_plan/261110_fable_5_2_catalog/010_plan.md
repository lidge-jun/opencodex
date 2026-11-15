# 261110 Claude Fable 5.2 catalog, pricing and fast mode

## Problem

Anthropic released Claude Fable 5.2 (`claude-fable-5-2`) on 2026-11-09. Live Anthropic
discovery will list it, but no static row knows it: the picker would show no price, no max
output, no effort ladder, and every logged request would be unpriced. Fable 5.2 is also the
first Fable model with Claude API fast mode, which the Anthropic fast wire currently limits to
Opus models.

## Evidence (collected 2026-11-10)

| Source | Surface | Facts |
|---|---|---|
| platform.claude.com/docs/en/models/fable-5-2/overview | Aside repl | id `claude-fable-5-2`; 1M context; 128K output; adaptive thinking always on; default effort high; text+image in; $8 in / $40 out / $10 5m write / $16 1h write / $0.20 cache read; Bedrock `anthropic.claude-fable-5-2`; forced tool_choice 400; omit temperature/top_p/top_k |
| platform.claude.com/docs/en/models/fable-5-2/whats-new-fable-5-2 | Aside repl | breaking changes vs 5.1: prefix check on every account, 5.2 thinking blocks readable only by 5.2/Mythos 5.2, computer_20251124 removed (toolset only), advisor must be 5.2. thinking enabled/disabled 400; forced tool_choice 400 (same as 5.1) |
| platform.claude.com/docs/en/about-claude/pricing | Aside repl | Fable 5.2 row 8 / 40 / 10 / 16 / 0.20 (0.025x footnote); fast mode Fable 5.2 $16 / $80 on the Claude API (2x) |
| platform.claude.com/docs/en/about-claude/models/overview | Aside repl | Fable 5.2 row, default effort high, 1M |
| cursor.com/docs/models/claude-fable-5-2 | Aside exec | id `claude-fable-5-2`, 300K default / 1M max, low..max, always thinks with no toggle, 8 / 40 / 10 / 0.20 |
| docs.github.com copilot models-and-pricing; github.blog changelog 2026-11-09 | Aside exec | Claude Fable 5.2 GA, 8 / 40 / 0.20 cached / 10 write; Pro+, Max, Business, Enterprise |
| opper.ai/models/claude-fable-5-2 | Aside exec | `anthropic/claude-fable-5-2` route (Anthropic US), 1M / 128K, 8 / 40 / 0.20 / 10 |
| docs.devin.ai/desktop/models | Aside exec | Claude Fable 5.2 listed, low..max plus fast variants, 8 / 40 / 0.20 / 10; raw id not published |
| kiro.dev/docs/models | Aside exec | NOT FOUND (Fable 5.1 only) |
| openrouter.ai/api/v1/models | curl | `anthropic/claude-fable-5.2` 1M / 128K 8 / 40 / 0.2 / 10; `~anthropic/claude-fable-latest` now 8 / 40 / 0.2 / 10 |
| ai-gateway.vercel.sh/v1/models | curl | `anthropic/claude-fable-5.2` 8 / 40 / 0.2 / 10 and `-fast` 16 / 80 / 0.4 / 20 |
| api.kilo.ai openrouter models | curl | `anthropic/claude-fable-5.2` and `~anthropic/claude-fable-latest` 8 / 40 / 0.2 / 10 |
| api.venice.ai/api/v1/models | curl | `claude-fable-5-2` 8 / 40 / 0.2 / 10 |
| models.dev/api.json | curl | anthropic, amazon-bedrock (`anthropic.`, `global.` at list; `us.` at 1.1x), opencode, kilo, venice, vercel, openrouter rows, all 1M / 128K |

## Diff-level plan (wp1, one PABCD cycle)

1. `src/providers/registry/model-seeds.ts`: `claude-fable-5-2` first in `ANTHROPIC_MODELS`,
   1M in `ANTHROPIC_MODEL_CONTEXT_WINDOWS`, 128K in `ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS`,
   provenance comment; Opper pool seed `claude-fable-5-2` (1M / 128K) beside `claude-opus-5-5`.
2. `src/providers/registry/entries-core.ts`: `ANTHROPIC_FAST_MODELS["claude-fable-5-2"] = true`
   with the comment updated (Fable 5.2 accepts `speed`; Fable 5 and 5.1 still reject it); Devin
   seed list gains `claude-fable-5-2` next to `claude-fable-5-1`.
3. `src/usage/expected-prices.ts`: `CLAUDE_FABLE_52 = { 8, 40, 0.2, 10 }`; overlays anthropic,
   anthropic-apikey (verified), cursor (verified, Cursor model page), devin and devin-cli
   (verified-derived, Devin model page lists the price, uid unpublished); Anthropic fast
   priority rule (2x, response confirmation) for anthropic and anthropic-apikey.
4. Cursor: price overlay only. No preemptive capability or effort-map row: Cursor documents no
   wire ids, and a registered base would parse a future `-thinking` roster id as a known variant
   and compose the bare base when that variant is absent (catalog.ts composeWireId). The capability
   row lands once the live GetUsableModels roster shows the real ids. `normalizeCursorClaudeId`
   already canonicalizes every 5.2 spelling onto `claude-fable-5-2` without a capability row.
5. `src/adapters/devin/live-models.ts`: seed id and 1M window (preemptive; Devin publishes the
   model but not its uid, so live discovery owns the real id).
6. `scripts/model-metadata.source.json` then `bun run generate:model-metadata`: rows cloned from
   each provider's `claude-fable-5` / `claude-fable-5-1` shape with 5.2 values: anthropic;
   amazon-bedrock `anthropic.`, `global.` (list) and `us.` (1.1x); github-copilot; openrouter,
   kilo `anthropic/claude-fable-5.2`; vercel-ai-gateway `anthropic/claude-fable-5.2` and `-fast`;
   venice and opencode-zen `claude-fable-5-2`; reprice the openrouter and kilo
   `~anthropic/claude-fable-latest` alias rows to 8 / 40 / 0.2 / 10 (both APIs list the alias at that
   price; the kilo row was all-zero, which the resolver treats as unpriced).
7. Tests: `tests/usage/usage-cost.test.ts` (overlays, snapshot rows, both alias reprices, cursor
   spellings, overlay roster count); `tests/usage/usage-anthropic-fast-pricing.test.ts` (Fable 5.2 in
   the shared price table, so confirmed / assumed / downgraded costs are all pinned);
   `tests/adapters/anthropic/anthropic-fast-speed.test.ts` (registry map equality, Fable 5.2
   eligible and Fable 5.1 unclassified, Fable 5.2 request carries `speed: fast` and the beta);
   devin seed test; opper seed; pinned rosters the change trips.
8. Docs: English `reference/configuration/providers.md` Anthropic Fast list and
   `guides/claude-code.md` native Fast list gain `claude-fable-5-2`.

Out of scope, recorded as residuals: Claude Code native `fable` tier default (stays 5.1; moves
with its GUI fill and docs in a separate change, as Opus 5.5's did in #5826), Claude Mythos 5.2,
Kiro (not published), Cursor fast ids (not published), cloudflare/zenmux rows (unverified).

## Verification

- `bun run generate:model-metadata`; `bun test tests/codex-integration/model-metadata-sync.test.ts`
- `bun test tests/usage tests/adapters/anthropic tests/providers/cursor tests/providers/devin-adapter.test.ts tests/providers/provider-registry-parity.test.ts tests/codex-integration/fast-row.test.ts`
  plus `bun run test:changed`
- `bun run typecheck`, file-size ratchet and test-layout tests, `bun run structure:check`,
  `bun run privacy:scan`

## Bounds

Write scope: files above plus this devlog unit. Push, PR and merge to `dev` are authorized by the
user for this goal; no release or deploy. Wall clock: none stated; host limits apply.

## Research reconciliation (terra lane, 2026-11-10)

The gpt-6.1-terra research lane confirmed the official facts and the touchpoint list. Its open
gaps resolve as follows:

- Kilo and Venice: verified directly from their public model APIs (table above).
- Copilot: price verified on docs.github.com copilot models-and-pricing (Aside exec); the snapshot
  id follows Copilot's existing dash spelling (`claude-fable-5`, `claude-opus-5-5`), so the row
  is `claude-fable-5-2`, copied from its `claude-fable-5` row shape.
- Devin: published UIDs include `claude-fable-5-2-high` and `claude-fable-5-2-high-fast`; the
  seed carries the base id the same way `claude-fable-5-1` does, and live discovery owns the rest.
- Native Claude Code `fable` alias: out of scope (residual above).
- Preserved thinking across model switches (Fable 5.1 cannot read 5.2 blocks; prefix check on every
  account): the API drops unreadable blocks and succeeds, so a combo fallback away from 5.2 loses
  reasoning without failing. No adapter change in this unit; recorded as a residual.

Retained as-is per the lane: `stale-no-vision-seed-migration.ts` (exact historical roster
equality), `stale-context-window-migration.ts`, `command-code-efforts.ts` (captured profile),
Kiro (unpublished).


## Audit round 1 fold (terra, FAIL -> revised)

1. BLOCKER fast roster test: `tests/adapters/anthropic/anthropic-fast-speed.test.ts` (registry
   `modelSupportsServiceTier` equality) joins the write scope; expected map gains
   `claude-fable-5-2` and the test asserts Fable 5.2 eligibility on both entries while Fable 5.1
   stays unclassified.
2. BLOCKER docs: `docs-site/src/content/docs/reference/configuration/providers.md` (Anthropic Fast
   section) and `docs-site/src/content/docs/guides/claude-code.md` (native Fast list) add
   `claude-fable-5-2`. No translated page enumerates the Anthropic Fast models (checked with rg),
   so locales need no change.
3. Opper pool verified: `api.opper.ai/v3/models?q=claude-fable-5-2` returns
   `anthropic/claude-fable-5-2` with `pooled: true`, model `claude-fable-5-2`, 1M / 128K.
4. Cursor: flat regular low..max stays provisional; tests cover the canonical id, its effort
   suffix spellings and that 5.2 never resolves to the 5.1 row. Thinking-suffixed ids from a
   future roster fall back to normal discovery handling.
5. Price coverage: tests pin anthropic / anthropic-apikey / cursor / devin / devin-cli overlays,
   the openrouter `~anthropic/claude-fable-latest` reprice, the new snapshot rows
   (bedrock us. 1.1x, vercel -fast), and confirmed vs unconfirmed Fable 5.2 fast cost in
   `tests/usage/usage-anthropic-fast-pricing.test.ts`. The kilo alias row is zero-cost in the
   snapshot already and stays untouched.
6. Write scope additionally includes `src/generated/model-metadata.ts` (generated), the tests
   above, and any test-layout registration if a sibling test file is created.


## Audit round 2 fold (terra, FAIL -> revised)

1. BLOCKER kilo alias: repriced to 8 / 40 / 0.2 / 10 (plan item 6) and pinned in usage-cost.
2. Cursor: preemptive capability dropped (plan item 4); price overlay only, pending live roster ids.
3. Fast checks: request-shape, eligibility, and confirmed / assumed / downgraded cost cases named in
   plan item 7; commands in Verification.
4. Earlier sections rewritten so item 4, 6, 7, 8 and Verification state the final decisions; the
   round-1 fold items 4 and 5 are superseded where they differ.

## Audit round 3 (terra, NEAR-PASS)

No blocker. Residual SHOULDs folded:

1. Cursor flat effort suffixes (`claude-fable-5-2-high`) do not canonicalize without an effort-map
   row, so they stay unpriced until the live roster confirms Cursor's ids; usage-cost pins the
   bare and `-thinking-high` spellings that do resolve, and the flat suffix as the known gap.
2. `tests/codex-integration/fast-row.test.ts` gains a Fable 5.2 case: with Anthropic Fast opted in,
   the anthropic entry publishes a fast row for `claude-fable-5-2` and none for `claude-fable-5-1`.

