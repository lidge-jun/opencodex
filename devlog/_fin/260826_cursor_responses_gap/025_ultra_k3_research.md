# 025 — Ultra / k3 / 1M research (luna swarm, 2026-08-26)

Three luna lanes (ultra-plan, k3, protocol) + prior in-repo maxmode work.
Claim ledger — status per cxc-search discipline:

| Claim | Status | Source |
|---|---|---|
| Cursor k3 = Moonshot Kimi K3 (2.8T MoE) | verified | kimi.ai blog 2026-07-20 (primary) |
| Kimi K3 native context up to 1M (k3-256k variant exists) | verified | kimi.com/code docs (primary) |
| Cursor default session context ~200k; Max Mode extends to model max | verified | cursor.com/docs/models-and-pricing (primary) |
| Some models show 1M "Max Context" in Cursor table (Fable/Opus/Sonnet 5, Gemini) | verified | same (primary) |
| Ultra = 20x usage ($400 API-agent allowance), NOT an exclusive catalog | verified | cursor.com/pricing + forum staff (primary) |
| Max Mode currently documented for legacy request-based plans | verified | prod.cursor.com/help/ai-features/max-mode (primary) |
| K3 1M specifically unlocked on Ultra | user-confirmed 2026-08-26 (operator saw the 1M option live in Cursor on the Ultra plan); public primary source still absent | user observation (authoritative for this deployment) + reddit lead |
| Wire: max mode = RequestedModel.max_mode (field 2) AND ModelDetails.max_mode (field 7); missing either can invalid_argument | lead (2 impl sources) | oh-my-pi #4969, cursor-opencode-provider |
| 1M exposure pattern: synthetic <model>-1m picker variant w/ limit.context=1M, wire sends original id + maxMode | lead | cursor-opencode-provider README |
| In-repo: GetUsableModels ModelDetails.maxMode=true observed on 28 -fast ids (260822); no contextTokenLimit field | verified (own probe) | devlog/_fin/260822_senpi_cursor_transfer/210_maxmode.md |

Design consequence for 070 (ultra toggle): treat "ultra" as a per-model
toggle that (a) sets the wire maxMode flag in both RequestedModel and
ModelDetails, (b) advertises a synthetic catalog variant with
context_window=1M ONLY where evidence supports it (kimi-k3, and any
ModelDetails.maxMode=true id), auto-detected from GetUsableModels, and
(c) never renames the wire model id. User-facing shape mirrors the
effort-suffix system (cursor/kimi-k3-max already exists; ultra adds the
big-context dimension).
