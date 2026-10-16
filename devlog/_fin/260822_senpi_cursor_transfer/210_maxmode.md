# 210 — P-1 maxMode probe (T06)

## Evidence (macmini live, 2026-08-22, redacted)

- GetUsableModels decoded: 204 entries; ModelDetails keys =
  modelId, displayModelId, displayName, displayNameShort, aliases, maxMode.
- maxMode=true on exactly 28 ids — ALL of them opus "-fast" variants
  (claude-opus-5-*-fast, claude-opus-4-8-*-fast, claude-opus-4-7-*-fast).
  No contextTokenLimit field is present in this response shape.
- Run A/B on claude-opus-4-7-low-fast, tiny prompt:
  - RequestedModel.maxMode=false -> bare Connect resource_exhausted.
  - RequestedModel.maxMode=true  -> same bare resource_exhausted.
  The server ACCEPTED the flag both ways (no invalid_argument); the model is
  plan-gated for this account regardless.

## Verdict: BLOCKED (plan tier) — WITHDRAWN by re-probe (see below)

Original interpretation: the account cannot run -fast at all. Wire flag
stayed hardcoded false pending an entitled account.

## Correction (same-day re-probe, supersedes the interpretation above)

A follow-up probe with a different tier disproved the entitlement story:
- claude-opus-4-8-high-fast -> SUCCESS ("FP-OK"); BOTH maxMode arms succeed.
- claude-opus-4-7-low-fast -> bare resource_exhausted persists
  (tier-specific; cause unknown — not account-wide).
- claude-opus-4-7-fast (bare) -> not_found (wire has only suffixed forms).
The original probe sampled ONLY 4-7-low-fast and over-generalized. -fast IS
callable on this account; maxMode therefore IS provable — the deciding
probe is 310 (big-context A/B). Catalog repair: 300.

## Side finding (feeds 260)

A TINY prompt on a plan-gated model returns the same bare 0-token
resource_exhausted shape that #2320 (T01) now classifies as CONTEXT OVERFLOW.
Live proof that bare RE != always overflow: entitlement rejections share the
shape. See 260_re_classification_refinement.md.
