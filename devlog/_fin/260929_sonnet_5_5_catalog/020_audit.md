# 020 Audit (wp1): Sonnet 5.5 plan

Auditor: kimi/kimi-for-coding (max), read-only, 2026-09-29. Verdict: NEAR-PASS. The four adapter
predicates, the between_tools-without-effort choice and the provider classification were confirmed
against source. Dispositions:

| # | Finding | Disposition |
|---|---|---|
| 1 | `claudeFamilyVersion` matches only `^` or `/` before `claude-`, so dotted Bedrock ids (`us.anthropic.claude-sonnet-5-5`) never parse | RESIDUAL. Pre-existing for every family including Opus 5.5; widening the boundary changes wire shape for all Bedrock-style Claude ids and needs its own live evidence. Recorded in 030 |
| 2 | Messages-native passthrough forwards caller `thinking` and sampling fields verbatim | RESIDUAL. The passthrough contract is caller-owned bytes; a Messages client addressing Sonnet 5.5 gets Anthropic's own 400. Recorded |
| 3 | Web-search and vision sidecars hard-code `thinking: disabled`; a user who points them at Sonnet 5.5 gets a 400 | RESIDUAL. Defaults stay `claude-sonnet-5`. Recorded as an override hazard |
| 4 | Kiro native effort field for `claude-sonnet-5.5` | DECIDED: no entry. Kiro's `claude-sonnet-5` uses emulated effort today and only Opus has a measured native field |
| 5 | Cursor local picker family regex was promised for Opus 5.5 and never landed | DECIDED: skip for Sonnet 5.5 too; the live bundle table owns that prediction |
| 6 | claude-cli and native Anthropic catalog spread `ANTHROPIC_MODELS` | ACCEPTED: user-visible roster addition, intended |
| 7 | Devin context map lives in `src/adapters/devin/live-models.ts`; `DEVIN_STATIC_MODELS` stays untouched | FOLDED into wp2 diff |
| 8 | Cursor row shape is regular-only while the docs say thinking is supported | FOLDED: follow-up trigger is the model appearing in the live GetUsableModels roster; shape then follows the measured ids |
| 9 | `kiro-adapter.test.ts` has 3 lines of ratchet headroom | FOLDED: only the in-line roster element there; any new assertion goes in a sibling file registered in both layout maps |
| 10 | Pinned tests: kiro roster, usage-cost surface loops, cursor catalog flat-wire case, devin context pin, anthropic reasoning wire cases | FOLDED into wp2 test list |
| 11 | No docs-site locale diff needed (no Sonnet fast tier) | ACCEPTED |

