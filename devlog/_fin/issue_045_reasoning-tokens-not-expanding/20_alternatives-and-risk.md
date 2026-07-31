# 20 — Alternatives & risk

## Approaches considered

### A. Reroute to summary-only (CHOSEN — see 10)
Send reasoning_content through the existing summary path; retire/skip the raw
content emission for this producer.
- Pros: single channel, no dedupe ambiguity, reuses proven thinking path + tests.
- Cons: if some consumer specifically wanted the raw `content` channel, it no
  longer receives it (no known opencodex consumer relies on it).

### B. Mirror into BOTH summary[] and content[] (00_review Approach 1)
Keep `content` and ALSO populate `summary` with the same text.
- Pros: most conservative wire-compat; nothing removed.
- Cons: same text in two channels → codex-rs receives both
  `ReasoningSummaryDelta` and `ReasoningContentDelta`; low but nonzero
  double-render risk; ambiguous source of truth.

### C. Provider-gated reroute
Reroute only for providers flagged (e.g. extend `preserveReasoningContentModels`
or a new `reasoningContentAsSummaryModels`).
- Pros: surgical; leaves other providers untouched.
- Cons: more config surface; most chat providers want the same behavior, so a
  global reroute (A) is simpler and likely correct for all.

## Recommendation
Ship A (global reroute for chat reasoning_content). Revisit C only if a provider
is found that needs the raw content channel preserved.

## Risk
- Low. Touches only reasoning-item shaping for chat reasoning_content.
- No change to text/tool/usage flows or the Anthropic thinking path.
- codex-rs needs NO change (renders summary channel for any model).
