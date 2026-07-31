# Consolidate process-wide singleton runtime state

Date: 2026-07-01
Surface: module-level mutable state across server + routing + quota + auth.
Class: C4 (cross-module state ownership; test-isolation risk).
Status: SCAFFOLD - inventory from code, plan drafted, NOT started.
Source: gajae/architect repo review (gpt-5.5), risk item 4 / priority 5.

## Inventory (measured, grep-confirmed)

Module-level mutable singletons found:

- src/server.ts:95  const activeTurns = new Set<AbortController>()
- src/server.ts:96  let draining = false
- src/server.ts:99  const nativePassthroughSseResponses = new WeakSet<Response>()
- src/codex-routing.ts:25  const threadAccountMap = new Map<...>()
- src/codex-routing.ts:42  const upstreamHealth = new Map<...>()
- src/codex-quota.ts:25  const accountQuota = new Map<...>()
- src/codex-auth-api.ts:42 const codexAuthLoginState = new Map<...>()
- src/codex-auth-api.ts:265 let primeInFlight: Promise<void> | null

## Why it matters (and the honest caveat)

- Single local daemon: this is mostly fine today; one process, one state.
- The cost shows up in: test isolation (state leaks between tests unless each
  module exposes a reset), multi-instance/profile separation, and reasoning
  about lifetime/ownership (who clears threadAccountMap on logout? when does
  primeInFlight reset?).
- This is the LOWEST-urgency review item. It is a maintainability/testability
  improvement, not a defect. Sequence it AFTER the two adapter bugs, and ideally
  BEFORE or WITH the server.ts split (the split will move some of this state, so
  decide ownership first to avoid moving it twice).

## Two candidate approaches

Approach A - explicit RuntimeState object (review's suggestion):
- Define a RuntimeState holding the maps/flags; instantiate once at startup and
  thread it through (or via a single accessor). Pros: explicit ownership,
  trivially resettable in tests. Cons: wide signature churn if threaded as a
  param; or a thin singleton accessor if not.

Approach B - per-module state object + reset() (smaller blast radius):
- Each module keeps its own state but wraps it in a small object with an
  exported resetState() for tests. Pros: incremental, low churn, immediately
  helps test isolation. Cons: still N owners, not one.

Recommendation: start with B (cheap, unblocks test isolation now), and only
adopt A if/when multi-instance or profile separation becomes a real
requirement. Do not over-engineer a DI container for a single-daemon tool.

## Hard constraints

- ZERO behavior change in the single-daemon path.
- Any reset()/lifecycle hook must be opt-in for tests; production startup keeps
  the current lifetimes exactly.
- Coordinate with the server.ts split: pick the final home for activeTurns /
  draining / nativePassthroughSseResponses ONCE.

## Open questions

- Is any of this state already reset between tests today (afterEach)? If tests
  currently pass only because of process-per-run isolation, document that as
  the motivating gap.
- Does primeInFlight need a reset on account-pool change, or is its current
  null-on-resolve lifetime sufficient? Verify against codex-quota priming flow.
