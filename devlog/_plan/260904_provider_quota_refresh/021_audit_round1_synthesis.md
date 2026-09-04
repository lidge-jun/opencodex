# Audit round 1 — synthesis and plan amendment

Independent reviewer returned `VERDICT: fail` with six blockers. Each was
re-verified against the tree before being accepted or rebutted; four are accepted
and amend the plan, two are rebutted with evidence.

## B1 — server-side 30-minute bound (ACCEPTED, narrowed)

Claim: `LAST_GOOD_MAX_AGE_MS = CODEX_CAPACITY_MAX_QUOTA_AGE_MS = 30 * 60_000`
(quota.ts:97, codex-capacity.ts:34) also drops the meta-muse row server-side, so
wp1 may not fix the symptom.

The strong form is DISPROVEN by live evidence: three consecutive
`GET /api/provider-quotas` calls each returned the meta-muse row with
`updatedAt = 1788491894216` (5.39h old). The reviewer's own reasoning explains why —
the `cutoff` at quota.ts:2518 filters `previous` rows only, and
`fetchPassiveProviderQuota` regenerates the row from `accountQuotaCache` on every
probe, so it always arrives in `fresh`, which is never age-filtered. The row reaches
the wire, and the client bound is genuinely what deletes it.

The weak form is REAL and worth fixing. The cache fast path at quota.ts:2477 requires
EVERY report to satisfy `now - item.updatedAt < LAST_GOOD_MAX_AGE_MS`. A passive row
is older than that by construction, so `cacheFresh` is permanently false while
meta-muse is configured — every dashboard poll re-probes anthropic, xai, cursor and
antigravity upstream instead of serving the 5-minute cache. That is a live regression
for anyone with Meta configured, caused by the same conflation of "old" with "stale".

**Amendment:** wp1 also exempts observed rows from the `cacheFresh` predicate.

## B2 — account-cache TTL reaps the observation (REBUTTED)

Claim: `sweepExpiredProviderAccountQuotaRows` (10-minute `ACCOUNT_QUOTA_TTL_MS`) is
global over `accountQuotaCache` and fires from other providers' probe writes.

Disproven: that function has NO call sites. A repository-wide search for
`sweepExpiredProviderAccountQuotaRows` outside its own definition at quota.ts:1601
returns nothing, and it is absent from `STATE_STORE_REGISTRATIONS` — only
`provider-quota-history` → `reconcileProviderAccountQuotaRows` is registered, and
that retires rows for accounts that no longer exist, not for age. The
`sweepExpiredOnWrite` calls the reviewer cites (quota.ts:1736-1757) run the
REGISTERED sweepers, which do not include this one. The passive row is not swept.

One adjacent fact IS worth recording, and the reviewer gets it right for a different
reason: `DISK_MAX_AGE_MS = 6h` (account-quota-disk.ts:28) bounds hydration, so an
observation older than six hours does not survive a proxy restart. The row in
evidence is 5.39h old — within an hour of that edge. This is upstream behaviour, out
of scope for this unit, and noted so a later reader does not mistake a
post-restart disappearance for a regression in this change.

## B3 — `fetchProviderQuotas(true)` awaits nothing (ACCEPTED, load-bearing)

Confirmed at use-providers-fetch.ts:60: it is `invalidateProviderQuotas(refresh)`,
a synchronous `setState` bump returning `Promise<void>`. The real fetch happens later
in the shell effect. wp2 as written would flip the button back to idle and report
"Quotas refreshed" before the response landed — a button that lies about the thing it
exists to do.

**Amendment:** the shell owns the fetch, so the shell must own the completion signal.
`ProviderWorkspaceShell` gains an `onQuotaRefreshSettled?: (ok: boolean) => void`
prop, invoked in the quota effect's `.then`/`.catch` when the read was a forced one.
`Providers.tsx` holds a promise resolver keyed to the current epoch and hands the
panels a handler that resolves when the shell reports, so the busy state and the
success/failure copy describe the actual read.

## B4 — `fetchAccountSets` cannot report quota failure (ACCEPTED)

Confirmed at useProviderAccountPools.ts:98-114: the `&quota=1` enrichment is a
floating `void (async () => {...})()` with a swallowing `catch`, outside
`results.every(Boolean)`.

**Amendment:** the Accounts-surface outcome is taken from the B3 settle signal, which
reflects the provider-quota read. The account-row enrichment stays best-effort — it is
a display nicety and its failure already degrades visibly — so the button reports what
it can actually observe rather than a value it cannot see.

## B5 — wp1's GUI test targets are not importable (ACCEPTED)

Confirmed: `ProviderWorkspaceShell.tsx` exports only `AddProviderIntent`,
`DetailSlotData` and the default component. `freshQuotaReport` and friends are
module-private.

**Amendment:** move the freshness predicate into
`gui/src/provider-workspace/report.ts`, which is already the pure-derivation module
for this surface and is imported by the shell. It gets a real unit test, the shell
keeps one import, and the test does not require exporting internals for testing's sake.

## B6 — missing prop-threading steps (ACCEPTED)

Confirmed: `ProviderCapacityQuota` takes `{ report, pending }` and forwards no
`observedAt` to either `QuotaBars` call site; `ProviderDetails` and `ProviderUsage`
prop types each need the new handler declared.

**Amendment:** wp1 and wp2 list these as explicit diff steps rather than "same
treatment".

## Rebuttal note on B-minor (api-key surfaces)

The reviewer notes a key-auth provider gets no refresh button under the OAuth-branch
placement. Accepted as scope, not as a defect: the user asked for the account-bundle
surface and the usage surface. The Usage-tab control is provider-agnostic and covers
every provider including key-auth ones, so no provider is left without a refresh path.
