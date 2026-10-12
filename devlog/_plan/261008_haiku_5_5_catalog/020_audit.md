# 020 Audit (wp1): Haiku 5.5 plan

Auditor: gpt-6.1-sol subagent 01a119a8-3953-79f1-b689-052895c6470d, read-only, against origin/dev bf9ecf3d79.

## Round 1: FAIL (4 High blockers)

Root causes (REVIEW-SYNTHESIS-01):

- **Identity mismatch between price and tier lookup.** `findExpectedPriceOverlay` canonicalizes Cursor spellings, `findContextTier` matches the raw provider/model id. Blockers 1 and 2 are the two faces of this: regular effort ids (`claude-haiku-5-5-low` ... `-max`) do not canonicalize at all (`src/adapters/cursor/claude-id.ts` has no plain regular-effort suffix parser), so no price resolves; alternate spellings (`claude-haiku-5.5`, `claude-5.5-haiku`) resolve the base price but miss the tier.
- **Snapshot rows are not runtime consumers for unbundled providers, and shared constants fan out.** Venice, Vercel, Kilo, Copilot, Cloudflare, ZenMux and opencode-zen have no generated bundle; their snapshot rows are inert and pricing comes from the Anthropic vendor fallback. Blockers 3 and 4: the plan promised provider-specific Sonnet outcomes that the fallback cannot deliver, and `CLAUDE_SONNET_55` also feeds the Antigravity derived overlays pinned by `tests/usage/usage-antigravity-55.test.ts`.

| # | Finding | Disposition |
|---|---|---|
| 1 | Cursor regular effort ids price to null | FOLDED: explicit exact overlays for `claude-haiku-5-5` and each emitted regular id `-low/-medium/-high/-xhigh/-max`, plus matching tier rows. No change to the shared Cursor id parser (pre-existing gap for other families recorded as residual after checking whether Sonnet/Opus 5.5 effort ids share it) |
| 2 | Cursor alternate spellings miss the tier | FOLDED: tier rows also for `claude-haiku-5.5` and `claude-5.5-haiku`; acceptance estimates every Cursor spelling at 100,001 tokens |
| 3 | Inert snapshot rows for unbundled providers | FOLDED: snapshot rows kept for parity with #6210 and labelled inert; runtime behaviour per provider is now stated as what actually resolves. Venice gets exact overlays (Haiku 5.5 1.25x tuple and corrected Sonnet 5.5 tuple 2.5/12.5/0.125/3.125, verified-derived from the models.dev listing). opencode-zen, Cloudflare and ZenMux follow the Anthropic vendor fallback, so their Sonnet 5.5 cache read becomes 0.1 with the Anthropic correction (they resell at list); D7 text corrected. Tier rows name the serving provider and its exact id for every fallback provider (vercel, kilo excluded, github-copilot, cloudflare, zenmux, opencode-zen) |
| 4 | Antigravity test pins 0.2 | FOLDED: `tests/usage/usage-antigravity-55.test.ts` in write and focused scope; fixture moves to 0.1 and gains a case with cache-read tokens |
| n1 | `estimateSingleCost` does not exist | FOLDED: acceptance uses `estimateRequestCost` / `estimateAttemptCost` |
| n2 | PLAN-FIELD-CHAIN-01 consumer chains | FOLDED: chain table added to 010 |
| n3 | Cursor publishes Haiku tier and Sonnet 0.10 cache read directly | FOLDED: Cursor overlays `verified` from cursor.com docs; shared `CLAUDE_SONNET_55` change applies to Cursor (no separate constant) |
| n4 | Cursor docs advertise a thinking variant | RESIDUAL: regular-only until the live GetUsableModels roster lists the id, as #6210 did |
| r1 | Architect reflection: alternate spellings also carry effort suffixes (`claude-haiku-5.5-medium`, `claude-5.5-haiku-medium`) | FOLDED: 18 generated Cursor ids (3 spellings x bare + 5 rungs) get overlays and tiers; selection-to-estimation test |
| n5 | `test:changed` selected 0 tests at the base | NOTED: it is meaningful only after edits; focused set remains authoritative |


## Round 2: PASS

Same reviewer re-audited plan hash 7294db4146d2 against bf9ecf3d79: all four blockers closed (108 Cursor request/attempt/cache estimates across both boundary values, 15 selection-to-estimation cases, Venice overlay precedence over fallback, 8 Antigravity cache-read estimates, all in memory). No new High/Critical blockers. Non-blocking: overlays grow from 160 to 184. Architect reflection ALIGNED after the D2/D3/D7 amendments.
