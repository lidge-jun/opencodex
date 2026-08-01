# runtime state consolidation - jawdev implementation plan (PABCD work-phases)

Date: 2026-07-01
Status: SCAFFOLD - ready to execute under cxc-loop.
Priority: LOWEST of the three structural items (testability, not a defect).
Ordering: do this BEFORE server.ts WP4 (turn-lifecycle) and codex-catalog WP2
(discovery cache) so state is moved exactly once. If the splits start first,
freeze state ownership here on paper before they touch it.

## Inventory (grep-confirmed, the exact targets)

- src/server.ts:95  activeTurns: Set<AbortController>
- src/server.ts:96  draining: boolean
- src/server.ts:99  nativePassthroughSseResponses: WeakSet<Response>
- src/codex-routing.ts:25  threadAccountMap: Map
- src/codex-routing.ts:42  upstreamHealth: Map
- src/codex-quota.ts:25  accountQuota: Map
- src/codex-auth-api.ts:42  codexAuthLoginState: Map
- src/codex-auth-api.ts:265 primeInFlight: Promise|null

## Decision: Approach B first (per-module reset), not a global container

Rationale: single local daemon. A DI container / threaded RuntimeState is
over-engineering today. Approach B gives the real near-term win (test isolation)
with minimal churn. Revisit Approach A only if multi-instance/profile
separation becomes a hard requirement.

## P - Plan / characterize current isolation (work-phase 0)

1. Determine whether tests rely on process-per-run isolation or already reset
   state. grep tests for any existing reset of these maps; note in
   11_state-isolation-findings.md.
2. For each singleton, document: owner module, who mutates it, current reset
   lifetime (e.g. primeInFlight nulls on resolve; threadAccountMap never
   cleared except by ...). This is the spec the refactor must preserve.
3. Baseline: tsc 0; bun test ./tests/ (count); privacy passed.

## Work-phases (one module per WP; each green)

### WP1 - codex-quota.ts
- Wrap accountQuota in a small state object with exported __resetQuotaState()
  (test-only; underscore-prefixed, documented as not for production).
- No production lifetime change. C-gate: tsc 0; quota tests green; suite ==
  baseline.

### WP2 - codex-routing.ts
- Same wrapper for threadAccountMap + upstreamHealth, with
  __resetRoutingState(). Preserve every current mutation/expiry path exactly.
- C-gate: codex-routing.test.ts + session-affinity.test.ts green; suite ==
  baseline.

### WP3 - codex-auth-api.ts
- Same for codexAuthLoginState + primeInFlight, with __resetAuthApiState().
  primeInFlight keeps its null-on-resolve lifetime; reset is additive for tests.
- C-gate: codex-auth-api.test.ts + codex-quota-prime.test.ts green.

### WP4 - server.ts turn/passthrough state
- Wrap activeTurns + draining + nativePassthroughSseResponses with
  __resetServerRuntimeState(). THIS is the join point with server.ts split WP4;
  coordinate so the state lands in its final module (turn-lifecycle.ts) with the
  reset hook, moved once.
- C-gate: shutdown-drain.test.ts green; suite == baseline.

## After WP1-WP4: opt-in test hygiene (optional follow-up)

- Add afterEach(reset...) to the affected test files so state cannot leak
  between tests. This is the payoff. Keep it test-only; production untouched.

## D - close

Per-WP C-evidence. Final D: every singleton has a documented owner + a test-only
reset; production lifetimes byte-for-byte unchanged; full suite green.

## Hard invariants

- ZERO production behavior change. Reset hooks are test-only and opt-in.
- Do not introduce a global mutable container or a DI framework.
- Coordinate WP4 with server.ts split so turn/draining state is moved once.
