# 020 Audit (wp1)

Reviewer: independent read-only subagent (Hooke), static reads only. Verdict NEAR-PASS.

## Folded

- B1: promoting the Opus 5 overlay source breaks `tests/usage/usage-cost.test.ts` (asserts `user-confirmed`).
  Kept the promotion because the pricing page now publishes Opus 5 at the same tuple; the test is
  rewritten to assert the published Anthropic source, which strengthens provenance rather than weakening it.
- Scope: `src/adapters/devin/live-models.ts` added explicitly for `DEVIN_MODEL_CONTEXT_WINDOWS`.
- Anthropic resolves through the bundled row first, so new tests expect `source: "jawcode"`, `verified`;
  the anthropic/anthropic-apikey overlays cover account-label namespaces.
- Cursor: `CURSOR_THINKING_FAMILIES` entries for `claude-opus-5-5-thinking` (source `claude-opus-5-5`) and
  `-thinking-fast` (source `claude-opus-5-5-fast`), thinking-then-effort, required by the catalog oracle.
- Cursor fast ladder mirrors the measured `claude-opus-5-fast` (low/medium/high) instead of FULL.
- `models-capabilities.ts` regex change dropped: that table mirrors Cursor's shipped 3.18.25 bundle.
- Docs: only English providers.md carries the Cursor Fast base list.

## Residuals (reported, not fixed here)

- Cursor Fast rows price at the base $4/$20 rather than $8/$40; same pre-existing gap as `claude-opus-5-fast`.
- Anthropic adapter maps `tool_choice` required/named to `any`/`tool`, which Opus 5.5 rejects with 400.
- The running proxy memoizes prices; the new rows appear only after a service restart.

