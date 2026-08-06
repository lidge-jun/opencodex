# 030 — Phase 3: #915 cooldown early-recovery probe

Stack layer 2. Work class C3: crosses routing, auth resolution, quota parsing,
and the state sweeper. Account-pool state, so the audit gate applies.

## The defect, precisely

A reset-derived cooldown is a *prediction*. OpenAI can reset earlier than
predicted, and when it does, the cooled account should come back. It does not,
because the probe that would notice is gated behind a selection that will never
happen.

The chain, verified on `origin/dev`:

1. Cooled accounts are filtered out **before** every strategy runs
   (`src/codex/routing.ts:740-768`). All three selectors consume only the
   already-filtered list (`:869-905`, `:914-972`).
2. Probe eligibility exists and is correct — non-`retry-after` cooldowns, one
   lease per interval, generation-fenced (`:404-412`, `:459-471`).
3. But `resolveCodexAuthContext()` **selects the account first**
   (`src/codex/auth-context.ts:238-247`) and only then checks that account's
   lease (`:276-298`).

So with B eligible, A is never selected, never reaches the lease code, and
never gets probed. Selection-before-probe. The recovery mechanism is not
broken; it is unreachable.

A forced WHAM read does not help either: `setAccountQuotaFromParsed()`
(`src/codex/auth-api.ts:614-623`) writes the quota cache
(`src/codex/quota.ts:134-179`) and never touches routing state.

## Two corrections to the prior analysis

**The existing predicate is too permissive for this use.** It excludes only
`retry-after`, so it admits both `reset-derived` and `default` cooldowns
(`src/codex/routing.ts:127`, `:404-412`). A `default` cooldown is the 60-second
fallback for a 429 with no headers at all — there is no prediction to be early
against. The background worker must be strictly narrower than the request path:
`cooldownSource === "reset-derived"` exactly.

**`clearCodexAccountCooldown()` must not be used.** It clears account-wide
health and then iterates every scoped entry (`src/codex/routing.ts:579-614`),
and takes no generation argument. Recovering `shared` would silently clear
`spark`.

## Fences that must hold

Three independent generations already exist and all three matter here:

- **cooldown generation** — a newer 429 during the probe must not be erased by
  the older probe's result.
- **credential generation** — a pool credential replaced mid-probe invalidates
  the result (`src/codex/account-store.ts:131-145`).
- **main-account identity** — the main account has no numeric generation; its
  fence is the physical ChatGPT account ID (`src/codex/auth-collision.ts:70-74`).

## Design

`src/codex/routing.ts` — add `claimDueCodexQuotaRecoveryProbes(config, limit,
now)` and `settleCodexQuotaRecoveryProbe(claim, recovered, proof, now)`. The
claim enumerates accounts **independently of strategy selection**, requires
`reset-derived`, reuses the existing interval/in-flight checks, and captures
lease id + cooldown generation + scope + credential fence atomically in one
synchronous turn. At most one scope per account per pass.

Settle clears **only** the exact map entry, and only when every fence still
matches. Any mismatch — stale credential, replaced cooldown, incomplete
snapshot, failed fetch — releases the lease and **retains** the cooldown.

Recovery must not route through `recordCodexUpstreamOutcome(200)`: success
handling also mutates account-wide failure state (`:1261-1301`). A background
observation is not a request outcome and must not be laundered into one.

`src/codex/quota.ts` — add `isCompleteCodexQuotaRecoverySnapshot()`. WHAM can
return a credits-only payload with no usage windows at all
(`src/codex/quota.ts:360-410`); treating that as recovery would clear a
cooldown on no evidence. Go/Free require a finite `monthlyPercent`, other plans
a finite `weeklyPercent`, and recovery additionally requires not-exhausted.

`src/codex/auth-api.ts` — add `runCodexCooldownRecoveryProbes()`, coalesced by
a module-level promise, bounded by the existing `mapWithConcurrency(..., 4,
...)`. Registered on the state sweeper's existing 60s tick
(`src/lib/state-store-sweeper.ts:155-166`) — no new timer. Registration is
explicit at startup, after config and migrations complete
(`src/server/index.ts:290-333`); a module-load registration would not survive
the test resets that clear registrations while leaving modules cached.

### Audit correction: the main account has no single-flight

The first draft said the worker "joins the existing per-account single-flight".
That is true for pool accounts (`src/codex/auth-api.ts:646-660`, which matches
a flight by live generation) and **false for the main account**:
`fetchMainAccountInfo()` (`src/codex/auth-api.ts:366-369`) has no in-flight map
at all. The worker-level promise coalesces worker passes only, so a sweeper
probe of `__main__` could race a dashboard refresh or startup priming into two
parallel WHAM requests.

The main account is therefore **excluded from the first cut**. Pool accounts
are where a multi-account pool starves a cooled account in the first place —
the reported scenario needs at least two accounts. Adding main-account recovery
requires giving main WHAM the same single-flight and admission semantics pool
has, which is its own change with its own race tests.

### Audit correction: fairness

Bounded claims with stable config-order enumeration can starve. Probe
eligibility recurs every five minutes (`src/codex/routing.ts:98`), so if more
accounts are due than `limit` and the early ones keep failing, they become due
again and consume the budget forever while later accounts are never reached.

Claims are ordered by oldest `lastProbeAt ?? cooldownSince`, which rotates
naturally: a probed account moves to the back of the queue whether it recovered
or not. The test uses a pool larger than `limit` and asserts every cooled
account is probed within a bounded number of ticks.

The worker never pauses an account, changes the active account, clears
affinity, or synthesizes an upstream outcome.

`src/codex/auth-context.ts` — unchanged. Background recovery removes the
selection dependency without touching request admission.

## The Spark honesty constraint

`GET /backend-api/wham/usage` takes no model or scope parameter
(`src/codex/auth-api.ts:589-592`) and returns generic weekly/monthly windows
(`src/codex/quota.ts:29-47`). So a generic WHAM result cannot be proven
authoritative for the `spark` scope.

The claim/settle layer fences scopes exactly, and a Spark cooldown is
**retained** when the snapshot cannot be proven to describe Spark. Under-
recovering is a delay; over-recovering sends traffic to an account that is
still restricted.

## Tests

New `tests/codex-cooldown-recovery.test.ts`; routing contract tests stay in
`tests/codex-routing.test.ts`.

The red-green case that defines this phase: A cooled reset-derived, B eligible,
ordinary routing selects B, worker runs after the interval — assert WHAM
receives **A's** credential, A's matching cooldown clears, and no routing call
ever selected A. That is the whole defect in one test.

Then the retention cases: still-100% WHAM, credits-only/windowless snapshot,
non-2xx, timeout, parse failure, admission-busy — each retains. The race cases:
credential replaced mid-probe, newer 429 mid-probe, concurrent worker passes
collapsing to one WHAM. The scope cases: shared recovery leaves Spark cooled,
and the reverse. The never-claimed cases: `retry-after` and `default` cooldowns
produce no WHAM request at all.

One assertion to **not** write: "a 100% snapshot never rebinds an existing
thread." Quota strategy deliberately rebinds an over-threshold bound thread
(`src/codex/routing.ts:1179-1205`) while fill-first and round-robin preserve
affinity (`:1186-1188`). Asserting otherwise would encode a policy change this
phase is not making — the maintainer scoped it out in
`devlog/_plan/260803_cooldown_recovery_probe/000_plan.md:41-43`.

## Line budget

This phase spans routing, quota, auth-api, startup registration, and two test
files, and the case matrix above is large enough to approach the 500-line PR
guidance. Checkpoint before opening the PR: if the diff exceeds it, split the
claim/settle primitives in `routing.ts` (with their unit tests) from the worker
integration. The primitives are independently reviewable and the worker is
meaningless without them, so that split is dependency-correct.

## A note on the clear→429 cycle

Clearing a cooldown can lead to selection, a fresh 429, and another cooldown.
That is not a tight loop: the new 429 opens a new cooldown and the next probe
cannot occur for five minutes. It is the same cost as the account having been
eligible in the first place, which is the state we are trying to restore.

## PR #922 overlap

#922 touches neither `routing.ts`, `auth-api.ts`, nor `quota.ts`, so it does
not supersede this. It does add a sidecar `releaseProbeLease` finalizer and
releases request leases on account-neutral transport failures. Sharing the same
lease fields makes a stale claim a harmless no-op. The only file both touch is
`src/server/index.ts`, in unrelated hunks. #922 currently has changes
requested, so this phase must not import its classifier.
