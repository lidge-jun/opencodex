# A Claude input estimate the settled route actually sends

Unit opened 2026-09-26.

- [010_estimation.md](010_estimation.md) — the Messages ingress. **DONE.**

Origin: a Paseo agent on a DeepSeek V4.1 Flash conversation through this proxy drew its context
meter at 221%. The rate implied the agent had run far past the window without compacting, so the
report read as a broken compaction loop. Compaction was healthy; the number above it was not. Same
body, same upstream: the proxy published 432,068 input tokens on `message_start` for a prompt the
upstream billed at 131,907 — **3.28x**.

This is the `#4857` family (the floor `message_start` publishes when the upstream has sent no
confirmed usage before the first frame), but not a recurrence: `#4891` and `#5057` fixed *when* the
floor is used and *whose* count it reports. The floor faithfully reports
`estimateClaudeRequestTokens`, and that estimate was measuring the wrong body.
