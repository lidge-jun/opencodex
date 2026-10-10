# 020 — Phase 2: per-account quota wiring

Work class: C3. Depends on: `010` (the fetcher).

## Goal

Every logged-in Kiro account gets a quota row through the seam that already exists for
Anthropic — cache, TTL, generation reconciliation, failure isolation and all.

## The seam

`src/providers/quota.ts:1453`:

```ts
export function supportsPerAccountQuota(provider: string): boolean {
  return provider === "anthropic";           // → provider === "anthropic" || provider === "kiro"
}
```

`fetchAccountQuota` (`:1572`) currently hard-calls `fetchAnthropicUsageQuota(token)`.
Replace that single line with a per-provider dispatch:

```ts
let quota: ProviderQuota | null;
if (provider === "kiro") {
  const snapshot = await fetchKiroUsageSnapshot(await kiroUsageContextForAccount(accountId));
  quota = snapshot?.quota ?? null;
  // Written inside the SAME mayCommitAccountQuotaKey(key, writerGeneration) branch that
  // guards the quota row, so a superseded probe commits neither (070, blocker 2).
  kiroUsageStateToCommit = snapshot
    ? { exhausted: snapshot.exhausted, nextResetAt: snapshot.nextResetAt }
    : null;
} else {
  quota = await fetchAnthropicUsageQuota(token);
}
```

Everything around it is reused unchanged and that is the point: the TTL negative-caching,
the `unavailable` flag that preserves last-good bars, the in-flight join, the
`mayCommitAccountQuotaKey` generation guard, and `clearAccountQuotaCache` on logout.
Those behaviours took several PRs to get right; Kiro inherits them for free.

## New helper: `kiroUsageContextForAccount`

Lives in `src/providers/kiro-usage.ts`, reads the stored account credential and assembles
`KiroUsageContext`:

- `access` **and** the routing metadata from one
  `getValidAccessSnapshotForAccount(provider, accountId)` call
  (`src/oauth/index.ts:435`).
- `accountId` passed through, so the usage-state map is keyed exactly like the quota
  cache.

**Not** `getTokenForAccountQuotaProbe` (audit round 1, blocker 4). That helper refuses to
refresh a background `source: "local-cli"` account (`src/providers/quota.ts:1549`)
because Anthropic's lock can adopt a mismatched Claude CLI identity. Kiro's *imported*
credentials are marked `local-cli` for an unrelated reason — they came from the Kiro CLI
database (`src/oauth/kiro.ts:301`) — so reusing that rule would make every inactive Kiro
account's quota unavailable the moment its token expired, which is exactly when a pool
needs it. The fail-closed branch stays Anthropic-scoped.

Resolving both values from a **single** snapshot also strengthens the anti-cross-pairing
invariant below: token and profile ARN provably come from one read.

**The load-bearing invariant:** the bearer and the routing metadata must come from the
*same* account record. This is the exact class of bug #2841 fixed for Copilot origins —
one account's token paired with another account's destination. Here it would send account
B's bearer with account A's profile ARN, which at best 403s and at worst reports A's quota
under B's row. The helper therefore takes `accountId` and reads one record; it never
consults `getCredential(provider)` (the *active* account) for any field.

## Builder ID

An account with no stored profile ARN gets the request-scoped service profile the
generation path already uses (`resolveKiroRequestProfile`). Reuse that resolver rather
than re-deriving it — doc `001` and the existing comment at `src/adapters/kiro.ts:1888`
both stress that this value must never become stored identity.

## `ksk_` API keys

Not OAuth accounts. `fetchProviderAccountQuotas` iterates the OAuth account set, so they
are naturally absent. No special case needed; documented so a future reader does not add one.

## Provider-level row

Add a `kiro` branch to `maybeFetchProviderQuota` (`:2186`) that probes the **active**
account and reports it as the provider row, mirroring `fetchAnthropicQuota` (`:1387`)
including its "capture the account before awaiting" guard against a mid-flight switch.
Source string: `"kiro:usage-limits"`.

## Accept criteria

| # | Scenario | Observable proof |
| --- | --- | --- |
| 1 | `supportsPerAccountQuota("kiro")` | true |
| 2 | Two Kiro accounts, both healthy | two rows, each with its own percent |
| 3 | Account A ok, account B 401 | A has bars; B has `unavailable: true` and A is unaffected |
| 4 | Second call inside TTL | zero additional fetches (activation: assert call count) |
| 5 | `forceRefresh` | exactly one new fetch per account |
| 6 | Accounts with different profile ARNs | each request host/ARN matches its own account (cross-pairing regression) |
| 7 | Logout clears rows | `clearAccountQuotaCache("kiro")` empties them and cancels in-flight |
| 8 | Provider row present | `/api/provider-quotas` includes a `kiro` report with source `kiro:usage-limits` |
| 9 | Account removed, then a stale probe resolves | no usage-state row survives for the removed id |
| 10 | `clearAccountQuotaCache("kiro")` | usage-state rows for kiro are cleared too |
| 11 | Probe resolves after a generation bump | neither the quota row nor the usage state commits |
| 12 | Inactive imported (`local-cli`) account with an expired token | quota resolves, is NOT forced unavailable |

Criterion 6 is the security-relevant one and must be written first, red.

## Test file changes

- New: `tests/kiro-account-quota.test.ts`.
- Amend: `tests/provider-account-quota.test.ts:204` currently asserts
  `supportsPerAccountQuota("kiro") === false` with zero network calls. That assertion
  becomes false by design. Rewrite it to assert the **generic** exclusion still holds for a
  provider we genuinely do not support (e.g. `"xai"`), preserving the original intent —
  "unsupported providers make no network calls" — rather than deleting the coverage.

## Verifier

`bun test tests/kiro-account-quota.test.ts tests/provider-account-quota.test.ts tests/provider-quota.test.ts`
— all three read this change target directly.
