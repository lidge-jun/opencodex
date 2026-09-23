# 050 Done (wp2)

Opus 5.5 now reaches every non-Anthropic provider that publishes it. Opper gains the
`claude-opus-5-5` pool (1M / 128K); GitHub Copilot's snapshot gains a `claude-opus-5-5` row at
GitHub's published $4 / $20 / $0.20 / $5. Command Code lists the id live and prices through the
Anthropic vendor row, now pinned in `tests/usage/usage-cost.test.ts` together with Opper and Copilot.

Evidence: receipt 1557 pass / 0 fail across 75 files at `50be43a386` after rebasing onto dev
`b7351ddef3`; typecheck, structure:check and privacy:scan pass; fresh-process probe prices all three.
Reviews: grok-4.7 plan audit PASS, meta-muse final branch review PASS.

Not added, with reason: Kiro (no Opus 5.5 on kiro.dev; static user-visible list), opencode-zen/go
(absent from live lists), OpenRouter/Venice/Kilo fast tiers (absent upstream).
What would show this wrong: a provider shipping a different id spelling. Copilot's id is the
catalog's hyphen convention, unconfirmed by GitHub; the row is inert until live discovery lists it.

