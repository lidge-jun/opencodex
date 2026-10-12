# 260930 GPT-6.1 Sol rollout, TokenLab protocol follow-up, release

Status: open. Loop session `01a0ef42-da06-7200-8394-aa35ebbe4ba9`, branch `codex/gpt-6-1-sol-rollout` from `origin/dev` `b78bfb8f00`.

OpenAI released GPT-6.1 Sol on 2026-09-29 as the successor to GPT-6 Sol. Only Sol moved to 6.1; Astra and Luna stay on GPT-6. This unit adds the model everywhere GPT-6 Sol is served, moves every place where GPT-6 Sol is the *default* to GPT-6.1 Sol (the same move #5640 made from GPT-5.6 to GPT-6), folds in TokenLab's protocol request from mail 546, and ships a release.

| Doc | Work-phase | Content |
|---|---|---|
| 010_research_digest.md | wp1 | Sourced facts for GPT-6.1 Sol and the TokenLab contract |
| 020_catalog_surfaces.md | wp2 | Diff-level list of provider, catalog, pricing and docs rows |
| 030_default_swap.md | wp2 | Defaults moving from gpt-6-sol to gpt-6.1-sol, roster migration v3 |
| 040_tokenlab_protocols.md | wp3 | Per-model wire routing; TokenLab JEV decision backend deferred to its own unit |
| 050_release.md | wp4 | PR, CI, merge, preview/main promotion, release.yml, npm verification |

## Audit record (wp1)

Read-only reviewer on gpt-6-sol (high), 2026-09-30:

- Round 1 FAIL, four blockers. Three concerned the JEV backend (combo dispatch passes no combo settings, combo normalization/persistence and the GUI editor would drop new fields, credential/URL/outbound guard must switch together). One named roster tests that enumerate models by value.
- Fold: the roster tests are listed in 020; the JEV backend is deferred to its own unit (040 records why and sketches it).
- Round 2 PASS. Non-blocking notes kept for B: the v3 roster migration must run after the v2 step and touch only bare `gpt-6-sol`; TokenLab's anthropic wire sends `x-api-key` to `/v1/messages`, which TokenLab accepts; `kiro-adapter.test.ts` (2047/2050) and `codex-catalog.test.ts` (7974/7985) take in-place edits only.
