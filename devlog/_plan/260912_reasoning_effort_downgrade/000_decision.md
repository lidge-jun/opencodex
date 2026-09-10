# 260912 — A refused reasoning rung is learned and replayed once

## Decision

When a routed upstream answers 400/403 and names reasoning effort in the body, the pipeline records
that (provider, model, effort) as refused, replays the request once at the next lower published rung,
and keeps the rung out of every later ladder (see the metadata record in
devlog/_plan/260912_reasoning_metadata/). The attempt is logged with recovery kind
reasoning-effort-downgrade, so requestedEffort and effectiveEffort stay distinguishable in usage.

## Why the ladder is not enough

The published ladder describes the model, not the account. Live 2026-09-12:
muse-spark-1.3-contributor answered 400 for max with

  Error from provider (Console Go): Upstream request failed: [invalid_request_error]
  reasoning_effort max requires an active Muse Code subscription for model
  muse-spark-1.3-contributor.

while xhigh answered 200. Clamping against the published ladder removes that case before dispatch,
but any entitlement-driven refusal for a published rung would otherwise fail the turn outright.

## Shape

- Detection is narrow on purpose: 400/403 only, the body must be complete and display-safe (the same
  contract as the other rejection peeks), and the text has to name reasoning effort. An unrelated 400
  never triggers a replay, which keeps the single extra send honest.
- One replay per request, guarded per recovery loop. The streamed passthroughRecovery loop and the
  non-streamed recovery loop both carry the same block, matching the file's existing convention that
  recovery kinds stay in sync across the two.
- Before the rebuild the parsed effort is replaced and the same-target cache is invalidated
  (invalidateSameTargetRequest), because that cache keys on parsed identity and would otherwise
  replay the original body byte-for-byte.
- No new failure surface: when the refusal is the only rung (or every lower rung is known-refused),
  the original error is returned untouched.

## Evidence

tests/responses/responses-reasoning-effort-downgrade.test.ts (4 cases, mocked upstream):
pre-dispatch clamp, learn-then-replay on the non-streamed path, learn-then-replay on the streamed
path, and no replay for an unrelated 400. tests/responses runs 2040 pass / 0 fail with the change.
