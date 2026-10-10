# 030 Default swap gpt-6-sol -> gpt-6.1-sol (wp2)

Precedent: #5640 (`8adda594fd`) set the subagent default to the GPT-6 trio and upgraded stored rosters from 5.6 once, by version.

| Surface | Change |
|---|---|
| src/config/subagent-models.ts | `DEFAULT_SUBAGENT_MODELS = [astra, gpt-6.1-sol, luna]`; `SUBAGENT_MODELS_VERSION = 3`; the v3 step replaces bare `gpt-6-sol` with `gpt-6.1-sol` in place (deduped), once. A later deliberate re-pick of gpt-6-sol stays. v0/v1 installs chain through v2 then v3. |
| scripts/ci/docker-smoke.ts | subagentModels default trio. |
| Codex configured-native template | borrows gpt-6.1-sol's row (020). |
| docs-site agents.md (10 locales), guides/claude-code.md (10 locales), structure/subagents.md | Name the new default. |
| Tests | subagent-roster-migration (v2 -> v3, idempotence, re-pick retained, routed ids untouched), claude picker/intercept/management expectations that read the default trio, server startup reconcile. |

Out of scope: removing gpt-6-sol anywhere; it stays listed and selectable.

