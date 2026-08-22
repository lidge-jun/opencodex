# 260 — bare resource_exhausted refinement (T01 follow-up, live-evidenced)

## Problem

#2320 classifies a bare 0-token resource_exhausted (no quota cue, no size
phrase) as CONTEXT OVERFLOW -> 400-class so Codex compacts. Live probe 210
found a counterexample: a ~20-token prompt on claude-opus-4-7-low-fast
returns the SAME bare shape. (Re-probe note: the cause of that RE is
tier-specific and unknown — the entitlement story was withdrawn — but the
evidence stands as-is: NON-OVERFLOW rejections share the bare shape, so the
shape alone cannot justify compaction.) Misclassifying a tiny turn as
overflow makes Codex compact it — wrong remedy, and the retry can never
succeed.

## Design

Classification needs a size prior: only classify bare RE as overflow when the
REQUEST was plausibly large relative to the model's context window; small
requests keep the 429-class quota/entitlement mapping. The adapter already
computes an input-token estimate (prepareCursorRunRequest
estimateInputTokens; estimateTokens lib). Shape:

- cursor-errors.ts: classifyCursorError gains an optional context
  { estimatedInputTokens?, contextWindow? }.
- live-transport/adapter passes the estimate it already has for the turn.
- Rule: bare RE + estimate >= OVERFLOW_MIN_FRACTION (0.5) * contextWindow ->
  overflow (current behavior); otherwise -> existing rate-limit mapping.
  Unknown estimate/window -> keep current overflow mapping (fail toward
  compaction, today's behavior) so the refinement only ever REDUCES
  false overflows it can prove.
- Tests: tests/cursor-errors.test.ts — tiny-estimate bare RE -> 429 class;
  large-estimate -> overflow; no-estimate -> overflow (unchanged).

## Verdict: IMPLEMENT (beyond-senpi refinement; senpi T01 shares this bug)
