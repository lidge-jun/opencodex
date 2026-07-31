# 040 — WP4: cursor

Pre-analysis: Boyle (sol explorer, 2026-07-10). Re-verify at WP4's P.
260709 gpt-5.6 preview models + bridge header hardening already landed — do not redo.

## P scope decision (260710, main session)

IN this cycle (loud-failure + dead-code class, bounded blast radius):
- I1 transport-retry.ts unreachable tail `throw lastError` — verify truly
  unreachable, then remove (or keep if actually reachable — verify first).
- I2 (AMENDED A-round1) native-exec.ts: diagnostics false-success (:183) =>
  typed error reply (schema supports it per reviewer); unknown exec cases (:189)
  => EXPLICIT TURN FAILURE (adapter error ending the turn) — wire schema has no
  generic error-reply variant (reviewer blocker 1 disposition: turn failure).
- I3 (AMENDED A-round1) live-transport.ts setupVmEnvironment (:272) + unknown
  interaction queries (:283) => same disposition: explicit turn failure, no
  fabricated success/empty replies.
- I4 MCP prep failure silent-disable (:354) => turn error (fail loudly).
- I5 (AMENDED A-round1) deprecated allowNativeLocalExec alias => remove from
  native-exec.ts:72 AND the provider-config type field AND every doc/comment
  promising the compat alias (rg allowNativeLocalExec src/ tests/ docs-site/);
  tests pinning the alias inverted (reviewer blocker 2 folded).
- I6 live-models.ts fetchCursorUsableModels null-collapse => typed
  { ok } | { error: class } result; catalog callsite logs/warns the failure
  class loudly. Degradation ORDER unchanged this cycle (see OUT).

OUT (deferred, recorded honestly — not silently kept):
- Catalog degradation-chain narrowing (fresh->live->stale->static) + live-only
  id materialization: shared surface with all liveModels providers
  (catalog.ts:1046/1083/1108 also in WP8 scope); changing it per-provider now
  risks catalog regressions across providers. Re-scoped to WP8 where the shared
  catalog surface is the unit.
- baseUrl HTTPS/host allowlist + forwarded-Bearer restriction: security posture
  changes touching login flows and the smoke-test seam; needs its own focused
  cycle with QA against a real cursor login — appended as WP10 candidate if
  user confirms; freezing would be silent, so it is NAMED here.

## Hardening targets

1. live-models.ts:29 — discovery collapses auth/protocol/outage failures to null
   => typed success/error result surfacing failure class (loud, no new fallback).
2. catalog.ts:1066-1071 — silent degradation chain fresh-cache -> live -> stale
   -> static; `available.length>0?available:configured` dead (auto always kept)
   => remove dead branch; narrow degradation: static only when discovery disabled
   or logged out (this REMOVES a fallback layer).
3. transport-retry.ts:110 — unreachable final `throw lastError` => remove.
4. live-transport.ts:354 — MCP prep failure silently disables MCP => fail turn.
5. live-transport.ts:272 / native-exec.ts:183/189 — false-success (VM setup,
   diagnostics, unknown exec silently no-reply) => explicit protocol errors.
6. Security: baseUrl HTTPS+host allowlist for OAuth token sends
   (live-transport.ts:568, exfiltration risk); remove deprecated
   allowNativeLocalExec alias (native-exec.ts:72) keeping only
   unsafeAllowNativeLocalExec; forwarded-Bearer fallback (live-transport.ts:74)
   restrict.
7. Discovery filters static seed only — live-only ids invisible (discovery.ts:84)
   => consider conservative materialization; verify catalog impact first.

## Tests
ADD (activation scenarios, AMENDED A-round2 — every changed conditional path
activated): discovery error-taxonomy (I6, per failure class); alias-removal
migration (I5, old key inert => native exec stays denied); MCP-failure turn
error (I4); unknown-exec turn failure (I2); diagnostics typed-error reply (I2);
setupVmEnvironment turn failure (I3); unknown interaction-query turn failure
(I3). Existing cursor suites stay green (alias-pinning tests inverted).
