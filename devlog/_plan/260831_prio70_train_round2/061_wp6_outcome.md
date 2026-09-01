# 061 outcome — wp6 (#3019): what the reviews changed

Seven plan-audit rounds before any code, then five implementation rounds. The plan that
was implemented is materially different from the one written at wp0, and the difference is
the point of this record.

## What the plan audits changed, before a line was written

| round | what the plan got wrong |
| --- | --- |
| 1 | "Add provenance to the primitive **if** the contract cannot express it" — it cannot; the change is mandatory, and `account-store.ts` belongs in scope |
| 1 | The concurrency cases could not produce a refresh joiner at all: same-account quota calls coalesce at `auth-api.ts:1043` **before** reaching the primitive, so case 8 would have passed under the exact bug it targeted |
| 2 | The TTL contradicted the security property — expiring a spent record hands the same lineage another refresh |
| 3 | Keying the claim on the lineage cannot separate an old claimant from a later retry on the same lineage |
| 4 | The refresh commits `G → G+1` before the claimant settles, so a liveness sweep would delete a live claim and a `G+1` claim would replace it |
| 4 | Two sections contradicted each other on `external-replacement`: fencing the returned generation there denies a fresh credential its own budget |
| 5 | "Whichever caller observes the outcome settles" is not implementable — `awaitOwnCancellation` rejects the wrapper while the flight continues privately, so with no joiner nobody observes the commit |
| 6 | Attaching settlement to the raw flight settles the wrong thing: provenance is per caller, and one grant-flight can serve several aliases each holding their own claim |
| 6 | The timing layout was an import cycle — `auth-api` must import the recovery store, so the store cannot import `auth-api` for the WHAM timeout |

## What the implementation reviews changed

The same defect kept reappearing: **something is unknown, and the code treats it as
settled.** Every instance either opened the retry loop this phase exists to close, or made
a dead credential look healthy.

| round | defect |
| --- | --- |
| 1 | `onSettled` on the caller-cancellable await: a cancelled poll reported "failed" for a refresh that was committing, released the budget, and the refreshed lineage could claim again |
| 1 | A joiner inherited the flight's `self-refresh`, so a caller that performed no CAS was told the credential was its own lineage |
| 1 | An external replacement from the flight's grant-mismatch and freshness branches was labelled `joined-lineage` |
| 1 | `resp.clone()` tees the body while the bounded parser cancels only its own reader |
| 2 | The terminal route was in the commit message and not in the code — every failure still released into backoff |
| 2 | Moving settlement off the caller signal bypassed `resolveCodexToken`'s own pre-abort guard, so an already-cancelled request started a refresh |
| 3 | Structured terminal evidence was reported and forgotten: the claim was already settled non-terminally, so the next poll called a dead credential healthy |
| 3 | `isTerminalRefreshError` matched message substrings while `TokenRefreshError` carries a `reason` discriminator |
| 4 | The reauth mark was account-wide, so a terminal response still in flight when the operator re-authenticated would quarantine the replacement |

## Tests that proved nothing

Five separate times a regression passed against the defect it named:

- The first suite drove the budget store in isolation and stayed green with the recovery
  entirely disconnected from the quota path.
- The cancellation test swallowed the caller's rejection, so an implementation ignoring
  the signal passed.
- The provenance test accepted any enum value — including the wrong one.
- The terminal test reimplemented the production callback locally, so deleting the real
  wiring left it green.
- The secrecy test watched `console.debug` rather than the debug buffer the dashboard
  reads, built its own account row by hand, and scanned a list that never contained the
  account under test.

Each is now driven through the real path: `listCodexAuthAccounts` for the terminal and
serialization cases, `forceRefreshCodexPoolToken` for cancellation and provenance, and the
actual `getDebugLogEntries` buffer for secrecy. Every fix was driven RED against its own
defect and restored.

## The shape that survived

- **Claim id, not lineage.** A clear or settle is a compare-and-set on
  `(accountId, lineage, claimId)`, so a late completion is a no-op rather than somebody
  else's budget.
- **`spent` is durable, `claimed` is a lease.** Expiring a spent record would grant a
  second refresh; an abandoned lease is reclaimable but never promoted to spent.
- **Settlement rides the refresh, not the caller.** Cancellation rejects what the caller
  awaits; the flight still settles.
- **Evidence is scoped to what it condemns.** A terminal mark names the generation it is
  about, so it cannot outlive the credential and quarantine its replacement.

