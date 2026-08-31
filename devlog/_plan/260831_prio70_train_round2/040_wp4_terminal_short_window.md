# 040 — wp4: a 100% burst window is not "unknown" (#3029)

Score 72/80. Branch: `codex/3029-terminal-short-window`, based on `dev`.
One PABCD cycle. No open PR targets this.

## The three-branch trace

`shortPercent` survives quota parsing as a real blocking window
(`src/codex/quota.ts:587`), then `computeCodexUsageScore` throws it away when no long
window is known (`src/codex/routing.ts:374`). From there:

- unknown passes the headroom check (`src/codex/routing.ts:1173`), so an exhausted
  account stays selectable;
- unknown suppresses auto-switch for an already-affined thread, in
  `reevaluateAffinityQuota` (`src/codex/routing.ts:1745`, called at `:1965`), so the
  thread never moves. The first draft cited `:1604`; that line is the unbound path, and
  the affined path returns before it (audit `002`, nit 1).

The user's report — the pool does not switch after 5-hour exhaustion — is exactly the
conjunction of those two branches.

## Why the current behaviour is right, and where it stops being right

The comment at `routing.ts:374` is worth reading before changing anything. Its
argument: the short window only *refines* a known long-window position. A snapshot
carrying just `shortPercent: 0` would score a flat 0 and make an account whose
weekly/monthly usage is entirely unverified look like the emptiest in the pool, so
`pickLowestUsageAmong` would send every request to it.

That argument is sound and must be preserved. It does not extend to a terminal value.
`shortPercent: 100` is not an optimistic guess about an unobserved window — it is a
direct observation that this account cannot serve a request right now, whatever its
monthly position turns out to be. Unknown-means-selectable is correct for uncertainty
and wrong for a measured refusal.

## What changes

`computeCodexUsageScore` in `src/codex/routing.ts`: a **fresh** short-only snapshot at
`CODEX_EXHAUSTED_USAGE_PERCENT` returns 100. Every non-terminal short-only value, and
every terminal one whose window has already reset, keeps returning
`CODEX_UNKNOWN_USAGE_SCORE`.

That is the whole production change, and its narrowness is the point. Scoring
short-only values generally — say, passing `shortPercent` through when it is the only
window — would resurrect precisely the flat-0 hazard the comment describes.

### Amendment after audit round 1 (`002`, blocker 4): freshness is not optional

`shortPercent` travels with `shortResetAt` (`src/codex/quota.ts:23-25`), and nothing
downstream checks it: `getAccountQuota()` performs no expiry check (`:510`), partial
updates preserve the old short tuple (`:319`), and disk hydration accepts a persisted
reading for six hours.

So scoring 100 from `shortPercent` alone would keep excluding an account whose
five-hour window has since reset, or whose refresh failed — turning a transient
exhaustion into a durable exclusion. That is #3029 pointed the other way: the issue is
"an exhausted account stays selected", and shipping "a recovered account stays
excluded" trades one unusable pool for another.

The terminal branch is therefore gated on freshness: a snapshot whose `shortResetAt` is
in the past scores unknown, not 100. When `shortResetAt` is absent the reading cannot
be aged, so it also scores unknown — the conservative direction here is the one that
keeps an account selectable, because a wrongly-selected account fails one request while
a wrongly-excluded account is invisible until someone reads the pool by hand.

The gate is not vacuous: `shortResetAt` is populated on the very path that produces a
short-only snapshot (`src/codex/quota.ts:596-598`, where the burst primary window's
`reset_at` is retained alongside `shortPercent`), and partial updates carry it forward
(`:321`, `:327`). So the terminal branch is reachable in the case #3029 reports.

**The unit has to be established, not assumed.** `normalizeResetAt`
(`src/codex/quota.ts:192-200`) accepts any finite non-negative number and normalizes
nothing about scale, and the GUI disambiguates by magnitude at read time —
`resetAt < 10_000_000_000 ? resetAt * 1000 : resetAt`
(`gui/src/components/QuotaBars.tsx:355`). That means both seconds and milliseconds
reach storage today. A comparison written against the wrong assumption is off by a
factor of 1000, which for a seconds value read as milliseconds means the window looks
like it reset in 1970 and every terminal reading scores unknown — a silently vacuous
fix.

So the scoring path must apply the same magnitude normalization the GUI does, take
`now` as an injected parameter for determinism, and carry a regression for each unit.

### Amendment after audit round 4 (`005`, blocker 3): the clock has eight call sites

`computeCodexUsageScore` takes `(quota, plan)` and no clock (`src/codex/routing.ts:363-367`),
and its `quota` parameter type does not even include `shortResetAt`. Threading a third
argument touches eight production call sites:

`routing.ts:1169`, `:1356`, `:1377`, `:1600`, `:1720`, `:1755`, `:1848`, and
`subagent-model-fallback.ts:229`.

Two of them already receive a `now` and drop it before scoring —
`reevaluateAffinityQuota` (`routing.ts:1745`) and `isNativeModelQuotaExhausted`
(`subagent-model-fallback.ts:218`). Those two are where a stale reading would otherwise
survive an injected clock, because the fixture's `now` and the scorer's `Date.now()`
would silently diverge.

**Subagent model fallback is a consumer this phase had not accounted for.** It reads the
same score to decide whether a native model is exhausted, so a stale terminal reading
pushes subagents off a model whose window has already reset — the same durable-exclusion
failure as the pool case, on a surface the plan never mentioned. Widen the quota
parameter type to carry `shortResetAt`, thread `now` through all eight sites, and add
that file's focused test to the verification list.

## What must NOT change

The scan lane flagged a tempting adjacent fix: treat `adapter_eof` as quota evidence.
Do not. An HTTP 200 followed by EOF is not independently reliable evidence of
exhaustion, and inferring quota state from a transport symptom would put accounts into
a blocking state on ordinary network faults. This phase fixes preselection for a
*known* 100%, which is what the reporter actually measured.

## Regressions

In `tests/codex-routing.test.ts`, beside the existing `shortPercent: 87` unknown case
at `:129`:

1. `shortPercent: 100` with a future `shortResetAt` and no long window scores 100.
   RED against `dev`.
2. `shortPercent: 87` with no long window still scores unknown. GREEN before and after
   — the guard that keeps this phase narrow.
3. Account A carries `shortPercent: 100` with a **future `shortResetAt`** and no long
   window; account B has headroom: a new thread selects B. RED against `dev` via
   `:1173`.
4. Same pool, same future `shortResetAt`, but a thread already affined to A: it rebinds
   to B. RED against `dev` via `reevaluateAffinityQuota` (`:1745`).

   Audit round 3 (`004`, blocker 3) caught these two describing A as carrying "only
   `shortPercent: 100`" — which, under the freshness gate added one section above,
   scores unknown and makes both switches unreachable. The fixtures were written before
   the gate existed and were not carried forward with it. Both cases take the same
   injected `now` used by the scoring assertions, threaded through the selection and
   affinity paths so the fixture and the production clock cannot drift apart.

   Use seconds in case 3 and milliseconds in case 4. That proves the magnitude
   normalization at the real consumers rather than only in the scoring unit test.
5. `shortPercent: 100` with `shortResetAt` in the past scores unknown and A stays
   selectable. RED against a freshness-blind implementation — this is the assertion that
   proves blocker 4 is closed, and it passes trivially on `dev`, so it must be quoted
   as red against the *naive fix*, not against `dev`.
6. `shortPercent: 100` with no `shortResetAt` scores unknown. Same reasoning.
7. `shortResetAt` expressed in seconds and `shortResetAt` expressed in milliseconds,
   both future, both score 100. This is the unit guard; without it case 1 can pass on a
   millisecond fixture while production stores seconds.

### Subagent cases, in `tests/subagent-model-fallback.test.ts` (audit `006`, blocker 3)

Round 4 added the subagent file to the verification command and left every new assertion
in `tests/codex-routing.test.ts`. Running a file is not testing a path: if
`isNativeModelQuotaExhausted` keeps dropping its injected `now`
(`src/codex/subagent-model-fallback.ts:218`) or substitutes `Date.now()`, every listed
test stays green while stale terminal quota pushes subagents off a native model whose
window has reset.

8. A native model whose account carries `shortPercent: 100` with a **future**
   `shortResetAt` is reported exhausted. RED against `dev`.
9. The same account with an **expired** `shortResetAt` is **not** reported exhausted.
   RED against a freshness-blind implementation.

Both pass an injected `now` deliberately far from wall-clock time. That is the assertion
that catches a `Date.now()` substitution: a test whose clock matches wall time cannot
tell the two apart.

Cases 3 and 4 are separate because they fail through different branches; one test
covering both would pass on a fix that only repaired selection.

## Verification

Focused: `bun test tests/codex-routing.test.ts tests/quota-scoring.test.ts tests/routing-policy-pool-quota.test.ts tests/subagent-model-fallback.test.ts`.
(`tests/codex-quota.test.ts` named in the first draft does not exist — blocker 8. The
subagent file was added by audit round 4, blocker 3.)
Suite, typecheck and privacy scan on `ssh lidge`.

## Close-out

`Closes #3029`. PR #3003 is unrelated to this issue and independently defective
(two pre-WHAM errors lack `quotaProbeSkipped` at its `src/codex/auth-api.ts:1013-1021`,
causing false five-minute suppression); do not link it here.

## What implementation added beyond this plan

Three adversarial review rounds (findings 2, 4, 0). The plan's scoring rule survived
intact; everything the rounds found was in the plumbing and in the tests:

- **The clock leaks below the scorer.** The plan enumerated eight `computeCodexUsageScore`
  call sites and I threaded all of them. That was not enough: `hasCodexQuotaHeadroom` and
  `pickLowestUsageAmong` each defaulted to `Date.now()`, and their callers omitted it — so
  the priority tier, fill-first, preemption, pin release and both shared-health checks all
  scored against wall time while the resolver above them used the request clock. An
  injected `now` with a `shortResetAt` between the two reads the same tuple two ways.
- **Three of my own tests were vacuous, and one was backwards.** The affinity case bound
  its thread while the account was already terminal, so it proved reuse rather than a
  rebind. The recovery case left both accounts unknown, where the active one is kept by
  default — true even against a freshness-blind scorer. And the tiered case had the
  priority order inverted: higher numbers run earlier
  (`src/codex/account-priority.ts:18`), so the account I meant to outrank actually lost,
  and it won for a reason unrelated to the window.

The last one is worth keeping as a rule: a test whose fixture encodes a directional
assumption should be driven red against the specific defect it names, not merely observed
to pass. Each of the eight assertions now has a named mutation it fails against, recorded
in the PR description.
