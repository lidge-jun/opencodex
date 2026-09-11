# wp6 — #3023: implement the audited ensure-freshness design

Status: implemented, verified, landed via PR #3054.

## What wp2 established and deliberately did not build

wp2 closed as a planning cycle. Four audit rounds each found a real hole in the
cross-answering behaviour, and the round-4 output was a flight key, not a patch:

    (normalized candidate set, client version, mutation epoch, identity vector, workset)

The reason wp2 did not implement is that the first three candidate designs each
answered a caller from a flight that had been started for a *different* question.
A memo keyed only on "are we logged in" cannot distinguish a roster derived
before a credential swap from one derived after it, so a fresh entitlement and a
revoked one both read as a hit.

## The defect in observable terms

`/api/models`, `/api/client-config` and `ocx export` share
`listManagementModelRows`. The entitlement snapshot behind it carried an expiry
but no binding to the credential state that produced it. Two consequences:

1. After `MODEL_ROSTER_TTL_MS` elapsed, the surfaces kept answering from the
   expired snapshot instead of re-deriving.
2. When `auth.json` was replaced out of band, the snapshot stayed authoritative.
   A newly entitled account saw the old roster; a logged-out account still saw
   models it no longer had.

## Implementation

`src/codex/credential-mutation-epoch.ts` (new) holds a monotonic counter bumped
at every credential mutation point — `account-store`, `main-account`,
`native-profile-manager`. An entitlement snapshot records the epoch it was
derived under. A read is a hit only when both the epoch and the expiry still
match; otherwise it re-derives. Consumers move to the freshness-checked accessor
(`server/management/model-rows.ts`, `sidecar/candidates.ts`).

The logged-out result is memoized deliberately, because the dashboard polls this
path ~24 times a minute and c-9 requires zero credential enumerations after the
first.

## Cost contract

Steady state, nothing mutated and the snapshot live: **0** additional
`accountCredentialSnapshot` calls, **0** token refreshes, **0** network
requests. This is the property that makes the fix safe to put on a polling path.

## Evidence

Nine regressions written red-first against the unfixed code: steady-state
credential reads, logged-out memo, memo invalidation on mutation,
`/api/client-config` fetch count 1 vs 0, expired `/api/models`, real-handler
`ocx export`, local epoch write during an in-flight derive, external
`auth.json` replacement during an in-flight derive, and account B expiring
during an A-only flight.

The rejection-path tests are labelled characterization, not red-first. They
describe behaviour that already held; calling them regressions would overstate
what they prove.

`ssh lidge` at exact head `6298fae32`: privacy scan clean, typecheck clean,
full suite **16524 pass / 0 fail / 16 skip**, `EXIT=0`. 208 focused tests pass
locally across the touched suites.

## Residual

The epoch is process-local. Two proxies sharing one `OPENCODEX_HOME` still
observe each other only through the expiry, not the epoch. Not reachable in the
supported single-proxy topology, and out of scope here.
