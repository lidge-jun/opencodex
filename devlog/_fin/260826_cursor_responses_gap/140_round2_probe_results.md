# 140 — QA round 2 on patched dev service (gap-10 branch code)

Service: local :10100 running codex/cursor-gap-10 (envelope-echo detection +
corrective retry). All probes via raw Responses API, 2026-08-26.

## Results (7/7 PASS)

| Probe | Model(s) | Result |
|---|---|---|
| Multi-round replay batch (v4, 8 runs) | kimi-k3-1m | 8/8 PASS, zero envelope leaks (was ~30% leak pre-fix) |
| Parallel 10-call | composer-2.5 | PASS (final string exact) |
| Parallel 10-call | kimi-k3-1m | PASS (final string exact) |
| Model switch mid-conversation | grok-4.6 → composer-2.5 | PASS — second model recalled tool token from replayed history |
| Hook-feedback rejection loop (5 turns) | kimi-k3-1m | PASS — no repetition collapse, pushed back once with commentary, terminated on DUPLICATE_HOOK_STOPPED |
| Zero-output minimal answer | grok-4.6 / composer-2.5 / kimi-k3-1m | PASS ×3 — visible text + nonzero output_tokens (18/17/65) |

## Observations (recorded, not failures)

- **Parallel batching not exercised:** both models satisfied the 10-command
  request with ONE tool call (hop 0: n_calls=1) — presumably a chained
  command — rather than a 10-call parallel batch. Final strings were exact
  because the values were prompt-known. The adapter supports parallel calls;
  this is model-side call-planning. If strict N-call parity matters, a probe
  asserting per-call args (not just the final string) is needed.
- Hook-loop turn 4 replied with meta-commentary containing the receipt string
  rather than the bare receipt — reasonable pushback, not a failure mode.
- One v3-round residual: a 30s zero-output R1 timeout on a fresh conversation
  (no replay, no echo) — stays on the gap-10-candidate watch list with the
  clisu-oracle observation window.
