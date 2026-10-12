# 030 Done (wp1): Haiku 5.5 catalog, pricing and request contract

## Outcome

- Contract (`src/adapters/anthropic-model-contract.ts`): Haiku >= 5.5 uses adaptive thinking, supports an explicit disable, and rejects sampling parameters. Between-tools and forced-choice rules are unchanged, so Haiku 5.5 keeps forced `tool_choice`.
- Pricing (`src/usage/expected-prices.ts`): `CLAUDE_HAIKU_55` 0.1 / 0.5 / 0.01 / 0.125 and a 5x `CONTEXT_TIERS` band above 100,000 raw input tokens (`inclusive: false`) for every provider/id in the plan, including the 18 generated Cursor ids. Kilo stays untiered. `CLAUDE_SONNET_55` cache read 0.2 -> 0.1 (pricing page: 0.05x on Sonnet 5.5).
- Snapshot rows and regenerated metadata, Anthropic seed (1M / 128K), Devin, Kiro, Cursor capability and effort tier, Claude Desktop suggestion. Defaults unchanged.

## Live evidence (2026-10-08, api.anthropic.com, OAuth, adapter-built bodies, streams read to message_stop)

| Request | Before (bf9ecf3d79) | After (ae66276dd7) |
|---|---|---|
| Haiku 5.5, reasoning none | 200, thinking omitted (adaptive on by default) | 200, `thinking: disabled`, no effort |
| Haiku 5.5, medium / max | 200 with `enabled` + budget, no thinking block | 200, `adaptive` + effort medium / xhigh / max |
| Haiku 5.5, caller temperature 0.2 | 400 (`temperature` is deprecated for this model) | 200, temperature and top_p stripped |
| Haiku 5.5, tool choice required | 200, `any` | 200, `any` kept, tool_use returned |
| Haiku 5.5, no reasoning field | 200 | 200, no thinking/effort (API default medium) |
| Direct `disabled` + effort max | 400 (effort max not supported when thinking is disabled) | adapter never builds it |
| Haiku 4.5 medium, Sonnet 5.5 none (controls) | 200 | 200, unchanged shapes (`enabled`+budget, `between_tools`) |

The documented 400 for `enabled` did not reproduce live: the API accepted it but returned no thinking block, so the old shape silently lost reasoning. Raw tables live in scratch (`.tmp/haiku55-probe/`), not committed.

## Verification

`bun run generate:model-metadata` output identical to the committed file; 15 focused files 616 pass / 0 fail (three new tests, Sonnet 5.5 contract, output maxima, usage cost, Antigravity 5.5, Cursor, Devin, Kiro, registry parity, metadata sync, layout and file-size ratchet); typecheck, structure:check, privacy:scan exit 0. Full suite delegated to PR CI (resource exception recorded in 010).

## Residuals

- Dotted Bedrock ids do not parse as a Claude family (all families); Messages-native passthrough forwards caller `thinking`/sampling verbatim.
- One-hour cache writes are estimated at the 5-minute price; whether cached tokens count toward the 100K threshold is unstated by Anthropic.
- Preemptive rows (Devin, Kiro, Cursor, Copilot, Cloudflare, ZenMux) are inert until those providers list the model; the Cursor row stays regular-only until the live roster shows a thinking variant.
- opencode-go Haiku request wire and Bedrock/reseller propagation of the Sonnet cache-read cut are unverified.

