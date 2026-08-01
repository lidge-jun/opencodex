# Resolution - premise already satisfied (no code change)

Date: 2026-07-01
Outcome: VERIFIED NO-OP. WP3 closed without code change; adding reset wrappers
would be redundant over-engineering.

## What the investigation found (evidence)

The scaffold assumed the singletons lacked test-reset hooks and risked
cross-test leakage. Grep proved otherwise - the reset surface already exists
and is already used for isolation:

- src/codex-quota.ts -> exports clearAccountQuota(accountId?) (clears all when
  called with no arg).
- src/codex-routing.ts -> exports clearThreadAccountMap(),
  clearCodexUpstreamHealth(), plus per-account variants
  clearThreadAccountMapForAccount(), clearCodexUpstreamHealthForAccount().
- src/codex-auth-api.ts -> exports clearCodexQuotaPrimeState() which resets the
  primeInFlight promise.
- tests/codex-routing.test.ts (beforeEach, lines ~73-85) already calls
  clearThreadAccountMap(); clearCodexUpstreamHealth(); clearAccountQuota();
  for isolation.

The one singleton without an explicit reset export, codexAuthLoginState
(codex-auth-api.ts:42), self-cleans via setTimeout deletes (auth-api:144 error
30s, :624 done 300s) and the login tests use distinct flowIds, so there is no
observed cross-test leak.

## Decision

No change. The codebase already follows the per-module reset convention
(matching __resetAntigravityReplayCache / __resetVertexTokenCache elsewhere).
Introducing a global RuntimeState container or extra __reset* wrappers would add
abstraction without removing real complexity - explicitly out of scope per the
"do not over-engineer a single-daemon tool" constraint in the original plan.

## If this ever becomes real

Re-open only if a concrete need appears: multi-instance/profile separation, or a
demonstrated cross-test leak (a test that passes alone but fails in-suite due to
one of these maps). Until then, the existing clear* hooks are sufficient.
