# 060 — wp6: refresh a stored token before quarantining it on WHAM 401 (#3019)

Score 70/80 (blast 17, credential 17, evidence 18, shippability 18). Branch:
`codex/3019-wham-401-refresh`, based on `dev`. One PABCD cycle.

The first draft declared this a stacked child of wp4 on the theory that both touch the
pool quota path. Audit round 1 (`002`, blocker 7) disproved it: wp4 changes
`src/codex/routing.ts` scoring, wp6 changes auth/token recovery, and PR #3020's file
set contains no `routing.ts`. A false dependency serializes two independent phases and
invents a rebase that can only add conflict, so wp6 bases on `dev`.

## The defect

Account-list quota calls `getValidCodexToken`, sends one WHAM request, and converts
any 401 straight into `needsReauth` (`src/codex/auth-api.ts:971`, `:978`). A bare 401
with no structured body is exactly what a stale-but-refreshable bearer produces after
a plan change, so a valid credential gets marked as needing re-login and the operator
is told to re-authenticate an account that was fine.

The recovery primitive already exists: `forceRefreshCodexPoolToken` at
`src/codex/account-store.ts:588`. Nothing calls it from this path.

17/20 on credential risk is not about leakage — it is that the system throws away a
working grant and demands the user replace it.

## What changes

Carry PR #3020's core sequence, and only that: first WHAM 401 →
`forceRefreshCodexPoolToken` → exactly one replay with the rotated bearer. Terminal
classification (`needsReauth = true`) only after structured terminal evidence in the
response body, or after the refresh itself fails terminally.

Bounded recovery state in a new `src/codex/quota-401-recovery.ts`: one record per
(account, credential generation), registered with the existing state sweeper so the map
cannot grow for process lifetime — the same unpruned-map defect the scan lane found in
PR #3003.

### Amendment after audit round 1 (`002`, blocker 5): generation is not lineage

The first draft said generation-keying fences a concurrent rotation. The primitive's own
documentation says it does not. `forceRefreshCodexPoolToken` returns `selfRefreshed`
precisely because generation alone cannot distinguish this caller's refresh CAS from
somebody else's replacement (`src/codex/account-store.ts:575-590`), and the comment
there spells out the trap: a successful token response can rotate the refresh grant
while returning a byte-identical access token, so `rotated === false` does not mean
"nothing happened".

The concrete failure the draft would have shipped: a concurrent reauthentication moves
`G → G+1`; the recovery record marks `G+1` spent on behalf of the *old* rejection; the
new credential's own first 401 then finds its budget already consumed and is quarantined
without ever being refreshed. The plan's own bug, arriving as the issue it set out to
fix.

So the record must key on lineage, not on a generation number alone:

- Spend the budget when this caller's CAS moved the credential (`selfRefreshed`), **and
  also when this caller joined an in-flight refresh of the same lineage**.
- Only a genuine external replacement resets the budget: a new grant deserves its own
  recovery attempt.
- Fence the replay on the generation **returned** by the refresh, never on the one that
  was rejected. The comment at `:583-586` says this explicitly.
- `rotated === false` means replaying would earn the same 401, so do not replay; report
  transient and let the next poll try.

### Amendment after audit round 3 (`004`, blocker 5): false means two different things

Keying on `selfRefreshed` fixed the generation error and introduced a subtler one. The
primitive returns `selfRefreshed === false` in two unrelated situations: an external
replacement, and a caller that joined an in-flight refresh and adopted the stored result
(`src/codex/account-store.ts:639-645`). The second is the *same* lineage, not a
replacement.

Under "reset on false", two concurrent 401 callers produce one refresh, the joiner
clears the owner's spent fence, and a later 401 refreshes again — the bounded-retry
property this phase exists to establish, gone. Regression case 4 does not catch it,
because it observes only the concurrent exchange and never the third call.

So the recovery record distinguishes three states, not two:

| observed | meaning | budget |
| --- | --- | --- |
| `selfRefreshed === true` | this caller's CAS moved it | spend |
| joined an in-flight refresh, adopted the stored result | same lineage | spend |
| credential replaced by someone else | new grant | reset |

If the returned contract cannot express the middle row today, the phase adds that
distinction to the primitive's return rather than guessing at the call site. Inferring
it from generation arithmetic is what blocker 5 of round 1 already ruled out.

## What of PR #3020 to leave behind

Seven files, ~1300 lines, conflicting with `dev`, and its own full-suite run timed
out. The core sequence is right and the surrounding scope is not reviewable in one
cycle. Carry the sequence with credit; do not rebase the branch.

## Security note

This phase touches credential handling, so it needs explicit security review per
`MAINTAINERS.md`. Two properties to state in the PR description and assert in tests:
the rotated bearer is never logged or serialized, and a single 401 can trigger at most
one refresh-and-replay per credential generation — an unbounded retry against an
upstream 401 is a self-inflicted credential-stuffing loop.

## Regressions

In `tests/codex-auth-api.test.ts`:

1. Request order `old bearer → 401 → refresh → rotated bearer → WHAM 200`; the result
   carries quota and `needsReauth: false`. RED against `dev`, which never refreshes.
2. A second bare 401 after the replay stays transient — `needsReauth` remains false and
   no second refresh is issued for the same generation.
3. A 401 carrying structured terminal evidence sets `needsReauth: true` without
   attempting a refresh.
4. Two concurrent quota calls for one account issue at most one refresh.
5. An externally-replaced credential (`selfRefreshed === false`, generation advanced)
   gets its own refresh-and-replay budget rather than inheriting the old rejection's
   spent one. RED against the generation-only design blocker 5 describes.
6. `rotated === false` on a successful refresh does not replay, and does not quarantine
   either.
7. Delete-and-re-add of the account clears any recovery record for it.
8. Three calls, not two: two concurrent 401s that collapse into one refresh, then a
   third 401 on the returned generation. Assert **no second refresh** is issued. RED
   against the round-1 amendment as written — case 4 passes there and this one does not,
   which is the whole reason it exists.

Case 3 is the one that keeps this from becoming "never quarantine anything". Cases 5-8
are the lineage proofs: case 5 is red against the plan as originally written, and case 8
is red against the round-1 amendment. Quote both reds in the receipt.

## Verification

Focused: `bun test tests/codex-auth-api.test.ts tests/codex-account-store.test.ts`.
Suite, typecheck and privacy scan on `ssh lidge`. `bun run privacy:scan` is
load-bearing here rather than routine.

## Close-out

`Closes #3019`. Comment on PR #3020 crediting the sequence and naming the scope that
was left out.

## P-phase re-verification against the landed tree (wp6 start)

Checked at `330470e74`, the dev head after wp5 merged. The plan holds:

- `fetchFreshPoolAccountQuota` still converts any 401 straight into
  `needsReauth` (`src/codex/auth-api.ts:979-983`). One WHAM request, no refresh attempt.
- `forceRefreshCodexPoolToken` is still at `src/codex/account-store.ts:588` with the
  contract the plan's amendments depend on: `rotated` false means replaying earns the same
  401, and `selfRefreshed` true means this caller's own CAS moved the credential.
- Nothing in the quota path calls it. The only two callers are the response lanes
  (`src/server/responses/compact.ts:302` and `core.ts:1806`).

### The existing callers are the template

Both response lanes already do the sequence this phase needs, and both encode the two
amendments the audit rounds forced into the plan:

```ts
if (!refreshed.rotated) {
  return { ok: false, quarantine: true, quarantineGeneration: refreshed.generation, ... };
}
if (refreshed.selfRefreshed) {
  handOffThreadAffinityGeneration(authCtx.accountId, authCtx.generation, refreshed.generation);
}
```

Two things to carry deliberately:

1. **Quarantine fences on the RETURNED generation**, never the rejected one. A successful
   token response can rotate the refresh grant while returning a byte-identical access
   token, so the credential has already moved by the time `rotated` is false.
2. `selfRefreshed` gates only the affinity handoff there, because those lanes have no
   per-credential retry budget. The quota path does need one, which is where the round-3
   amendment applies: `selfRefreshed === false` means *either* an external replacement
   *or* a caller that joined an in-flight refresh of the same lineage
   (`account-store.ts:639-645`). Spending the budget on the joined case and resetting only
   on a genuine replacement is the distinction regression 8 exists to prove.

### Scope confirmed unchanged

`src/codex/auth-api.ts` plus a new bounded recovery module and
`tests/codex-auth-api.test.ts`. PR #3020 stays unrebased; its core sequence is carried
with credit.


## Amendment after the wp6 plan audit (round 1)

Four findings, all accepted. The plan had the right recovery direction and could not have
established either security property as written.

### 1. The lineage rule needs an account-store contract change — mandatory, not conditional

The plan said "if the returned contract cannot express the middle row today, the phase adds
that distinction to the primitive's return". It cannot. `forceRefreshCodexPoolToken`
returns `rotated` and `selfRefreshed` only (`account-store.ts:588-607`), and the
join-and-adopt path at `account-store.ts:639-660` returns nothing that separates it from an
external replacement — which is exactly the ambiguity the round-3 amendment was written
about.

So `src/codex/account-store.ts` **is in scope**, and the change is a provenance value
rather than a boolean:

| provenance | meaning | budget |
| --- | --- | --- |
| `self-refresh` | this call's own CAS moved the credential | spend |
| `joined-lineage` | joined an in-flight refresh of the same grant and adopted its result | spend |
| `external-replacement` | the stored credential was replaced by someone else | reset |

`selfRefreshed` stays as a derived boolean so the two response lanes
(`compact.ts:302`, `core.ts:1806`) keep working unchanged; it is `provenance === "self-refresh"`.
Every return path of `resolveCodexToken` gets a regression asserting its provenance,
because a value nothing tests is a value that will drift.

### 2. Cases 4 and 8 could not produce a refresh joiner

Same-account quota calls already coalesce at `auth-api.ts:1043-1051`: a second caller for
the same account joins the existing **quota** flight and never reaches WHAM, let alone
`forceRefreshCodexPoolToken`. Two concurrent quota calls therefore produce one flight, not
an owner and a joiner — so case 8 would have passed under the precise reset-on-join bug it
was written to catch. That is the wrong-reason pattern this train has hit repeatedly.

Replacement:

- **8a (primitive level).** Two concurrent `forceRefreshCodexPoolToken` calls against one
  account, one owner and one joiner, asserting the joiner reports `joined-lineage` and that
  exactly one token request was issued.
- **8b (path level).** Drive the joiner through the recovery module directly rather than
  through two quota calls, then issue a third 401 on the returned generation and assert no
  second refresh.
- **9 (new).** A late quota caller arriving after the generation advanced but before the
  WHAM replay finished. The flight's `resolvedCredentialGeneration` must be updated to the
  RETURNED generation before the replay, or the join predicate at `auth-api.ts:1045` sees a
  stale generation and starts a redundant flight.

### 3. "Bounded" was asserted, not designed

`registerStateStore` only registers callbacks (`state-store-sweeper.ts:49`); it imposes no
bound. One live account churning lineages would accumulate records forever.

The design is now explicit: **one replaceable record per account.** A new lineage replaces
the previous record rather than adding to it, so the map is bounded by the number of
accounts, which is already bounded by config. The record additionally carries a TTL so a
stale budget cannot outlive its usefulness, and the store registers centrally in
`STATE_STORE_REGISTRATIONS` (`state-store-registrations.ts:76`) with both
`sweepExpired` and `reconcileGeneration`, so a deleted or re-added account drops its record.
`src/lib/state-store-registrations.ts` is in scope.

Tests: lineage churn on one account leaves exactly one record; an expired record is swept;
delete-and-re-add clears it.

### 4. Terminal classification and secrecy need their own cases

"Structured terminal evidence" needs an allowlist, and one already exists for the main
account: `MAIN_TERMINAL_AUTH_CODES` at `auth-api.ts:602` (`invalid_workspace_selected`,
`invalid_refresh_token`) with the bounded-parser reasoning documented right below it. The
pool path reuses that set and that parser rather than inventing a second vocabulary.

The pool catch currently marks EVERY `TokenRefreshError` terminal (`auth-api.ts:1024`), so
the phase must separate a revoked or expired grant from an unknown or transient refresh
failure; only the former sets `needsReauth`.

Added cases:

- **10.** Replay returns a 401 carrying a terminal code — `needsReauth: true`, no second refresh.
- **11.** The refresh itself fails transiently (not a terminal code) — `needsReauth` stays
  false and the budget is not marked spent, so the next poll may try again.
- **12.** Neither the rejected bearer nor the rotated one appears in any log line, debug
  buffer, or serialized response on any of these paths. Asserted at runtime by capturing
  the log surfaces during the flow; `privacy:scan` is a static check and does not prove it.

### Scope, corrected

`src/codex/auth-api.ts`, `src/codex/account-store.ts`, a new
`src/codex/quota-401-recovery.ts`, `src/lib/state-store-registrations.ts`, and
`tests/codex-auth-api.test.ts` plus `tests/codex-account-store*.test.ts` for the provenance
regressions.


## Amendment after the wp6 plan audit (round 2)

Two findings, both accepted. The provenance enum, the coalescing bypass in 8a/8b, case 9,
and reusing `MAIN_TERMINAL_AUTH_CODES` were confirmed sound and are unchanged.

### 5. The recovery record needs claim/settle, not replacement — and the TTL contradicted the guarantee

"One replaceable record per account" bounds memory and says nothing about ordering. The
interleaving that breaks it: lineage A starts a refresh; meanwhile the credential is
externally replaced by lineage B, which receives a 401 and spends its own budget; A then
resolves as `external-replacement` and resets the record — handing B a second refresh it
already used. Replacement is the wrong primitive.

**Claim/settle with an expected lineage.** A caller claims the budget for the lineage it is
about to refresh, and may settle only the record it claimed:

- `claim(accountId, lineage)` returns `granted` when no record exists for the account, or
  the record's lineage differs AND that record is not for a lineage the store considers
  current; otherwise `spent`.
- `settle(accountId, lineage, provenance)` is a compare-and-set on the lineage. If the
  stored record has moved to a newer lineage, the completion is stale and is **dropped** —
  it may never downgrade a newer lineage's spent state to unspent.
- `external-replacement` does not reset in place. It settles the claimed record as spent
  for the OLD lineage and lets the NEW lineage claim on its own next 401, which is what
  "a new grant deserves its own recovery attempt" actually means.

Interleavings to test: a stale completion arriving after a newer lineage has spent; a
joiner settling after an external replacement; simultaneous external and self outcomes on
one account.

**The TTL is removed.** It was load-bearing for boundedness in the previous draft, and it
directly contradicts the security property: expiring a still-live spent record grants the
same lineage another refresh, which is the unbounded-retry loop this phase exists to
prevent. Boundedness comes from one record per account plus `reconcileGeneration`, and the
record is retained until the credential is replaced or the account is deleted. That is a
strictly stronger guarantee and one less knob.

### 6. The terminal-refresh oracle was unfalsifiable

Case 11 covers only a transient refresh failure, so an implementation that made **every**
refresh failure transient would pass cases 1-12 — while today's code does the opposite and
marks every `TokenRefreshError` terminal (`auth-api.ts:1024`). A test suite that cannot
distinguish the two extremes is not an oracle.

- **11a.** Refresh fails with a revoked grant — `needsReauth: true`.
- **11b.** Refresh fails with an expired grant — `needsReauth: true`.
- **11c.** Refresh fails with an unknown or network error — `needsReauth` stays false, the
  claim is released rather than settled spent, so the next poll may try again.

Case 6 is also strengthened: after `rotated === false`, issue another 401 on the RETURNED
generation and assert no second refresh is issued before the lineage actually changes.


## Amendment after the wp6 plan audit (round 3) — final state design

Four findings, all accepted. This section is the authoritative description of the recovery
store; earlier sketches in this doc are superseded where they conflict.

### 7. The claim identity is a claim id, not the lineage

Lineage alone cannot separate an old claimant from a later retry on the same lineage:
claim L₁ → transient failure releases L₁ → another poll claims L₁ → the first caller settles
late and spends the second caller's claim.

```
claim(accountId, lineage) -> { granted: true, claimId } | { granted: false, reason }
settle(accountId, claimId, outcome)   // CAS on (accountId, lineage, claimId)
release(accountId, claimId, backoff)  // same CAS
```

Settling or releasing an unclaimed or superseded claim is a **no-op**, not an error: a late
completion is exactly the case that must not disturb a newer claimant.

`settle` also carries the **returned** generation and the provenance, because that is what
becomes the spent fence — case 6 and 8b both depend on the fence being the generation the
refresh returned, never the one that was rejected.

### 8. `spent` is durable; `claimed` is a lease

Removing the TTL was right for spent records and wrong for in-flight ones. A caller can be
cancelled between claim and settle — `forceRefreshCodexPoolToken` explicitly supports
caller-scoped cancellation while the shared flight continues
(`account-store.ts:639-660`) — and an abandoned claim would wedge that account's recovery
permanently.

So the record has two shapes:

| state | expires? | meaning |
| --- | --- | --- |
| `claimed` | yes — bounded lease | a refresh is in flight for this lineage |
| `spent` | no | this lineage already had its one refresh |
| `backoff` | at `nextAttemptAt` | a transient failure; retry allowed after the clock advances |

An expired `claimed` lease is reclaimable, which recovers from a cancelled or thrown
caller. An expired lease is **not** promoted to `spent`: the refresh may never have
happened.

Tests: owner cancellation between claim and settle; a settlement that throws; a stale
claim recovered by a later poll.

### 9. Transient failure releases into backoff, not into eligibility

Releasing outright reopens the loop the phase exists to close: a failed quota request does
not refresh the quota timestamp, so successive dashboard and background polls would each
issue another token refresh. `release` therefore records `nextAttemptAt` and the record
stays — still one per account.

Case 11c becomes: several immediate polls after a transient refresh failure issue exactly
**one** refresh; a poll after the clock advances past `nextAttemptAt` may issue another.

### 10. `reconcileGeneration` alone cannot see a credential change

`GenerationContext` carries `codexAccountIds` only (`state-store-sweeper.ts:3-11`), so it
can drop a record for a deleted account but not for one whose credential was replaced under
the same id. The promise that a record lives only until credential replacement needs a
second mechanism:

- `reconcileGeneration` drops records whose account id is gone (delete/re-add), and
- it additionally drops any record whose fenced generation fails
  `isCodexAccountGenerationLive(accountId, generation)` (`account-store.ts:196-199`), which
  is exactly "the credential this record fenced is no longer the stored one".

Tests: replace the credential without another 401, run a sweep, and assert the record is
gone; delete and re-add the account and assert the same.


## Amendment after the wp6 plan audit (round 4) — settlement and lease rules

Three findings, all accepted. This section is authoritative over every earlier one where
they conflict.

### 11. A live claim is not stale just because the credential moved

The refresh CAS commits G → G+1 (`account-store.ts:864`) **before** the quota caller can
settle. In that window the `claimed` record still fences G, so a naive liveness sweep sees
G as non-live and deletes it, and a G+1 claim can replace it. The late settle then no-ops
and G+1 is left unspent — a second refresh, which is the loop this phase closes.

State-aware rules, replacing the flat "drop non-live" from round 3:

- A valid, unexpired `claimed` record **blocks every other lineage for that account**. A
  `claim` for a different lineage while one is live returns `granted: false`.
- Reconciliation and the liveness sweep **must not remove a live `claimed` record** merely
  because its starting generation moved. Moving is the expected outcome of the refresh it
  is fencing.
- Only account deletion, a matching `settle`/`release`, or lease expiry may end a claim.
- Stale-generation cleanup applies to `spent` and `backoff` records only.

Tests: run a sweep between the refresh commit and settlement and assert the claim survives;
attempt a G+1 claim in the same window and assert it is refused.

### 12. Settlement follows the shared flight, not the cancelled waiter

Caller cancellation is scoped to the waiter; the shared refresh keeps running and may commit
after that caller is gone (`account-store.ts:639-660`). Releasing the claim on cancellation
would let that still-running flight rotate the credential with no spent fence at all.

- A cancelled waiter **does not release**. The claim stays `claimed` until the shared
  flight's terminal outcome is known, and whichever caller observes that outcome settles it.
- The lease is sized against the operations it covers, not a round number: the refresh
  flight's stale bound (`CODEX_REFRESH_FLIGHT_STALE_MS`) plus the WHAM request deadline
  (8s, `auth-api.ts:975`) plus margin. A lease shorter than the flight it fences would
  expire mid-refresh and admit a second claim — the same hole from the other side.

Tests: cancel the waiter, let the background flight commit successfully, and assert a
competing poll during that window is refused and the fence lands exactly once.

### 13. `external-replacement` must not fence the returned generation

Round 3 said the returned generation "becomes the spent fence". That is right for
`self-refresh` and `joined-lineage` and wrong for `external-replacement`: there the
returned generation is a **new** lineage that has had no recovery attempt and deserves its
own budget. Fencing it would deny the new credential the one refresh this phase exists to
grant.

Outcome-specific settlement, explicitly:

| outcome | what is spent | what the returned generation gets |
| --- | --- | --- |
| `self-refresh` | the returned generation | fenced — its one attempt is used |
| `joined-lineage` | the returned generation | fenced — same lineage, same budget |
| `external-replacement` | the claimed OLD lineage only | untouched — free to claim on its own next 401 |
| stale claim id | nothing | untouched |

Tests assert both stored fence generations, not just the presence of a record.


## Amendment after the wp6 plan audit (round 5) — flight-owned settlement, and one timing contract

Two findings, both accepted. These are the last two blockers; the plan is implementable
once they are specified.

### 14. Settlement attaches to the FLIGHT, not to any caller

"Whichever caller observes the terminal outcome settles it" is not implementable through
the proposed API. `forceRefreshCodexPoolToken` returns `awaitOwnCancellation(refreshPromise,
callerSignal)` (`account-store.ts:917`); cancellation rejects that wrapper while the
underlying flight keeps running privately. With no joiner, nobody observes the successful
commit at all — the claim expires and the already-refreshed lineage gets a second refresh,
which is precisely the hole being closed.

The flight itself is what must settle. `refreshPromise` is already held on the flight record
(`account-store.ts:912`), so:

- `forceRefreshCodexPoolToken` accepts an optional `onSettled(outcome)` callback and attaches
  it to `refreshPromise` — **before** the caller-scoped wait, so it fires on the flight's own
  terminal outcome whether or not any waiter is still there.
- The callback carries the claim id the caller opened with, so settlement remains a CAS on
  `(accountId, lineage, claimId)` and a superseded claim is still a no-op.
- It fires exactly once per flight, for both fulfilment and rejection: a rejected flight
  settles as the transient or terminal outcome rather than leaving the claim to expire.

Test: cancel the sole waiter, let the background flight commit successfully, assert the
spent fence lands exactly once and a competing poll during the window is refused.

### 15. One exported deadline, not three literals plus "margin"

The lease cannot be derived today. `CODEX_REFRESH_FLIGHT_STALE_MS` is private
(`account-store.ts:411`), the flight's own ceiling is a separate inline `30_000`
(`account-store.ts:749`), and the WHAM timeout is an inline `8000`
(`auth-api.ts:975`). "Plus margin" is exactly the kind of number that drifts out of
agreement with the thing it is supposed to cover.

So one authoritative value is exported and consumed by both operations:

```ts
// account-store.ts
export const CODEX_REFRESH_FLIGHT_CEILING_MS = 30_000;   // the flight's own AbortSignal.timeout
// auth-api.ts
export const WHAM_REQUEST_TIMEOUT_MS = 8_000;            // replaces the inline literal
// quota-401-recovery.ts
export const QUOTA_RECOVERY_LEASE_MS = CODEX_REFRESH_FLIGHT_CEILING_MS + WHAM_REQUEST_TIMEOUT_MS * 2;
```

The replay is counted twice because the sequence is request → refresh → replay, and both
WHAM legs sit inside the lease.

Test: the lease is strictly greater than the longest admitted flight plus its replay, and
the test derives that bound from the exported constants rather than restating a number —
a restated number is how the two drift apart.

### 16. Explicit cross-product case

`external-replacement` together with `rotated: false` is logically covered (no replay, the
old claim is spent, the returned generation stays free) but nothing asserts it. Added as
case 13.


## Amendment after the wp6 plan audit (round 6) — completion boundary and timing ownership

Two findings, both accepted.

### 17. The completion must be caller-specific, not the raw flight

Attaching `onSettled` to `refreshPromise` settles the wrong thing. Provenance is
**per caller**: the owner performed the CAS, a joiner awaits the flight and then runs the
adoption path (`account-store.ts:639-660`), and an early external replacement
(`account-store.ts:635`) has no flight at all. The raw promise cannot know which of those a
given caller became.

The cardinality was also wrong. One refresh-grant flight can serve several account aliases
sharing that grant, each holding its own claim, and "exactly once per flight" would settle
one of them and drop the rest.

So `forceRefreshCodexPoolToken` builds a **caller-specific completion**:

- It is created for every return path, including the no-flight external-replacement case,
  and it resolves with that caller's fully classified outcome — after the adoption or
  replacement branch has run, not before.
- It is **not** subject to `callerSignal`. Cancellation still rejects the value the caller
  awaits; the completion continues and fires.
- One callback is attached per `(accountId, claimId)`, so two aliases sharing one flight
  settle two claims independently.
- A throwing callback is swallowed: settlement bookkeeping must never reject the credential
  result or disturb another waiter.

Tests: sole cancelled owner; cancelled joiner; two aliases on one flight both settled once;
no-flight external replacement settles; a throwing callback leaves other waiters and the
returned credential unaffected.

### 18. Timing constants live in a leaf module

The previous layout was an import cycle: `quota-401-recovery.ts` would import
`WHAM_REQUEST_TIMEOUT_MS` from `auth-api.ts`, while `auth-api.ts` must import the recovery
module for claim/settle.

New file `src/codex/quota-recovery-timing.ts`, importing nothing from either:

```ts
export const CODEX_REFRESH_FLIGHT_CEILING_MS = 30_000;
export const WHAM_REQUEST_TIMEOUT_MS = 8_000;
export const QUOTA_RECOVERY_LEASE_MS =
  CODEX_REFRESH_FLIGHT_CEILING_MS + WHAM_REQUEST_TIMEOUT_MS * 2;
```

`account-store.ts`, `auth-api.ts` and `quota-401-recovery.ts` all import from it, replacing
their inline literals (`account-store.ts:749`, `auth-api.ts:975`). The derived-bound test
imports the same leaf rather than restating 46_000.

