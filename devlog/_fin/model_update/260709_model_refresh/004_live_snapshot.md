# 004 — Live /api/models snapshot (2026-07-09, local proxy, read-only)

Captured from the RUNNING ocx proxy (pre-Phase-1 binary) via GET http://127.0.0.1:10100/api/models.
xai rows come from live /v1/models via the user OAuth token; cursor rows are the old static seed
filtered by live GetUsableModels (survival == live-callable base id).

- cursor claude-4-sonnet
- cursor claude-4.5-opus
- cursor claude-4.5-sonnet
- cursor claude-4.6-opus
- cursor claude-4.6-sonnet
- cursor claude-fable-5
- cursor claude-opus-4-7
- cursor claude-opus-4-8
- cursor claude-sonnet-5
- cursor composer-2.5
- cursor composer-2.5-fast
- cursor gemini-3-flash
- cursor gemini-3.1-pro
- cursor gemini-3.5-flash
- cursor glm-5.2
- cursor gpt-5-mini
- cursor gpt-5.1
- cursor gpt-5.1-codex
- cursor gpt-5.1-codex-max
- cursor gpt-5.1-codex-mini
- cursor gpt-5.2
- cursor gpt-5.2-codex
- cursor gpt-5.3-codex
- cursor gpt-5.4
- cursor gpt-5.4-mini
- cursor gpt-5.4-nano
- cursor gpt-5.5
- cursor gpt-5.5-extra
- xai grok-4.20-0309-non-reasoning
- xai grok-4.20-0309-reasoning
- xai grok-4.20-multi-agent-0309
- xai grok-4.3
- xai grok-4.5
- xai grok-build-0.1
- xai grok-composer-2.5-fast

## Conclusions
- xai live discovery WORKS: grok-4.5 present live; grok-composer-2.5-fast account-verified.
- Cursor live ids are DOT-form (claude-4.5-opus etc. survived) => Carson dash renames rejected.
- Cursor live has NO grok-* for this account => cursor grok-4.5 NOT added (resolves 010 HOLD).
- gpt-5.5-extra SURVIVED the live filter => Phase 1 removal was wrong; restore in Phase 2.
- kimi-k2.5 / grok-4.x absent live => Phase 1 removals confirmed.
