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

