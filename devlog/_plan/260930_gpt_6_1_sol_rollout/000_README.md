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
