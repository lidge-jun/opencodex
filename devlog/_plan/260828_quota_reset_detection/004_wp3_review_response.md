# wp3 adversarial review — response

Reviewer: independent subagent, dispatched against `f4fcbb547` (HEAD moved to `2e4b3be3e`
mid-review; the reviewer noted this and verified both). Verdict: GO-WITH-FIXES, 4 blockers.

Every blocker was reproduced here before being accepted, and every fix was driven red
against the pre-fix code before being committed green. Two of the reviewer's proposed
remedies were rejected on evidence and replaced; both are recorded below, because a review
response that only records agreement is not evidence of independent judgement.

## Blocker 1 (Critical) — out-of-order observations manufacture false resets

Accepted, reproduced, fixed.

The seam awaited two `import()` calls before swapping the baseline. Bun does not resolve
concurrent dynamic imports in call order, so a burst arrives reordered. Reproduced through
the real writer with 21 monotonically RISING writes (10% -> 90%, no reset anywhere):

```
write order: 10,14,18,...,90
events:      [{"k":"surprise","w":"5h","pb":82,"pa":10}]   # 4/4 isolated runs
```

The compounding harm is the durable claim: the false event takes the idempotence key, so
the genuine reset on that window is then suppressed permanently. That is what makes this a
correctness defect rather than noise.

**Fix.** Both seams now serialize observations through a module-level promise chain
reassigned SYNCHRONOUSLY at call time (`pendingObservation = pendingObservation.then(...)`),
so each link starts only after the previous one committed its baseline. The snapshot is also
copied before the boundary, because `next` is the live map value and the following write
mutates it.

The reviewer's alternative — statically import `window-mapping` and observe synchronously —
was rejected: it adds a static edge from a file that `src/server/responses/core.ts` reaches,
and `tests/quota-reset-core-boundary.test.ts` (added this phase) forbids exactly that. The
promise chain achieves the same ordering guarantee without spending the boundary.

Evidence, pre-fix vs post-fix, isolated `OPENCODEX_HOME` per run:

```
pre-fix:  FALSE_EVENT_COUNT: 1  1  1  1
post-fix: EVENTS: []  []  []  []
```

## Blockers 2 and 3 (High) — the account key was wrong in two ways

Accepted, fixed together, because both are the same mistake: identity was resolved
asynchronously from mutable global state, after the commit it describes.

- **Key-auth pool collapse.** `getAccountSet()` reads the OAuth store, so every key in a
  key-auth provider's `apiKeyPool` fell through to `"default"`. Rotating from a spent key to
  a fresh one inherited the spent key's history and read as a reset.
- **Mid-flight failover.** `promoteAnthropicActiveAccount` rewrites `activeAccountId` during
  request routing, so a 429 between the commit and a later async read attributes this
  report to a different account. `fetchAnthropicQuota` already captures `probedAccountId`
  before awaiting for precisely this reason.

**Fix.** `providerObservationAccountKey` resolves identity synchronously at the commit site,
and mirrors the discriminator the report cache already uses (`apiKeyPoolEntryId`) instead of
inventing a second notion of identity.

## Blocker 4 — the trap-3 regression test was vacuous

Accepted; this was the most useful finding, because the test was green and wrong.

`tests/quota-reset-observation.test.ts` called `resetQuotaResetStoreForTests()` between the
row clear and the fresh write. No production path does that: real reauth clears the quota
row only, and the observer's baseline lives in a separate file. Removing the line:

```
REAUTH_EVENTS: [{"k":"surprise","w":"5h","pb":91,"pa":0}]
```

So reauth of a used account fired a false reset on every occurrence, and the test that
existed to prevent it was simulating a state that never happens.

**Fix.** `forgetLastObservedWindows` in the store, `forgetQuotaBaseline` in the observer
(which owns the salted tag), called from `clearAccountQuota` on the same serialized chain so
it cannot be overtaken by an in-flight observation. The claim ledger is deliberately NOT
released — a cleared row must not re-notify a reset it already reported.

## Finding 6 (Medium) — fixed, but NOT by the proposed remedy

The finding is correct: a rolling window's percent decays naturally, and the surprise branch
accepted a bare drop. Confirmed at 88% -> 61% one hour into a 5h window, no reset.

The proposed remedy — bound the drop by `elapsed/windowLength * previousPercent` — was
implemented, measured, and **rejected**. Decay magnitude cannot be bounded from elapsed time:
the percent that ages out depends on WHEN the usage occurred, so an hour of idling can retire
a burst that all landed in one minute. Measured against the proportional bound, 88% -> 5%
one hour in (a 83-point drop) was suppressed as "explainable decay" while the genuine
27-point decay case it was written for still fired. It was wrong in both directions.

**What shipped instead:** deadline MOVEMENT against elapsed time. While a window is merely
rolling, its deadline advances by roughly the elapsed gap; a genuine out-of-band reset issues
a deadline a full window into the future, hours beyond a gap measured in minutes. A deadline
that stands still while usage falls is the clearest surprise signature there is, and is
explicitly allowed through. Fails OPEN whenever the evidence is missing.

## Finding 5 (Medium) — accepted

The eviction comment described behavior the code did not have: re-setting a key does not move
it in a Map, so the EARLIEST-INSERTED row was evicted — on a real install the long-lived
codex account, while 63 transient rows survived. Fixed with delete-then-set, making it a true
LRU and making the existing comment true. The regression test fails against the old code.

## Findings 4 and 7 — deferred to wp5, with reasons

- **Finding 4 (debounce starvation).** Real: a write cadence under 250 ms defers the baseline
  write indefinitely, so a SIGKILL loses the baseline. Not a correctness defect in the
  detection contract (the trailing write lands once traffic quiesces, and a lost baseline
  re-baselines rather than misfires), and the maximum-staleness cap belongs with the other
  persistence hardening in wp5. Recorded in `040_phase5_hardening_delivery.md`.
- **Finding 7 (`updateAccountQuota` does not notify).** Has no in-repo caller, but is public
  API through `src/codex/auth-api.ts`. wp5 will either notify or state why not.

## Reviewer claim NOT accepted

`settle()` flakiness: the reviewer measured it and concluded it is sound (0.51 ms against a
5 ms budget, 14 runs clean including under CPU load). Agreed, and the earlier plan to
rewrite it is dropped. The burst test does not rely on it — it spawns a child process,
because an in-process burst test PASSED against the unfixed seam: earlier tests in the file
leave the observer module cached, and a cached import resolves in call order. Only a cold
module registry reproduces the defect. A test that cannot fail is worth less than no test,
so this one was driven red 3/3 in a child process before being trusted.

## Boundary guard (the wp3 deliverable itself)

`tests/quota-reset-core-boundary.test.ts`. `tests/core-lab-boundary.test.ts:63` hardcodes
`/src/lab/`, so nothing enforced the same obligation for `src/quota/`. The walker was
EXTRACTED to `tests/helpers/import-graph.ts` and shared rather than copied, because the Lab
guard already records what a duplicated predicate costs: its own self-test re-declared a
private copy of the matcher and so proved a local literal behaved, not that the guard did.

Guards: no load-time edge from the 4 protected entrypoints into `src/quota/` (whole
directory, not a `reset-` prefix — a prefix would let a future sibling through); both seams
reach the observer and reach it ONLY dynamically; the composition-root exemption is pinned to
an exact chain and the poller is asserted to pull in nothing at load time.

Driven red three ways: a static import in `src/router.ts` (4 assertions fail, including the
two files that transitively reach it), a seam converted to a static import (1 fails), and the
observer wiring deleted entirely (the reachability assertion fails, proving the
dynamic-only check is not vacuously satisfiable by absent wiring).
