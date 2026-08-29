# 000 — Kiro quota + pool: problem statement and current state

Unit: `devlog/_plan/260829_kiro_quota_pool/`
Opened: 2026-08-29
Work classes: C3 (quota fetcher, pool selection), C2 (surfaces, docs)

## The ask

Two capabilities, plus one reconciliation:

1. **Quota display for Kiro.** Every other major OAuth provider in this proxy reports
   remaining capacity; Kiro reports nothing. `rg -n -i kiro src/providers/quota.ts`
   returns zero matches today.
2. **Pool-based automatic loading.** Multiple Kiro accounts should load into a pool and
   be selected automatically, preferring accounts that still have quota.
3. **429 PR reconciliation.** Confirm which of the previously-submitted 429 failover PRs
   actually landed on `dev`, and fold the landed behaviour into the Kiro path.

The comparison target is [minpeter/kiro-lb](https://github.com/minpeter/kiro-lb), an
AGPL-3.0 Python/FastAPI Kiro gateway with multi-account load balancing and an operations
dashboard. **We study its behaviour; we copy none of its code.** AGPL-3.0 is incompatible
with this repository's licensing, so every line here is written from the wire contract and
from our own existing seams.

## What we already have (verified 2026-08-29 against origin/dev 124a2b148)

Kiro is further along than it looks:

- **Multi-account storage exists.** Kiro credentials live in the generic multiauth store
  with `activeAccountId` plus an `accounts[]` array; each entry carries its own
  `credential.kiro` routing metadata (`profileArn`, `ssoRegion`, `apiRegion`,
  `clientId`, `clientSecret`). See `src/oauth/types.ts:14` and `src/oauth/store.ts:264`.
- **429 rotation already covers Kiro.** `isGenericFailoverProvider` excludes only
  `openai` and `anthropic`, so any OAuth provider — Kiro included — rotates on a 429
  once two non-reauth accounts are present (`src/oauth/generic-account-failover.ts:44`,
  `:81`, `:114`).
- **Rotation carries Kiro's routing metadata.** `applyFailoverSnapshot` reassigns
  `parsed._kiroAuthContext` from the rotated snapshot, so a rotated bearer travels with
  its own profile ARN and regions (`src/server/responses/core.ts:3063`). PR #2841
  (merged `5a829b7e9`) hardened exactly this class of bug for Copilot origins.
- **A per-account quota seam exists.** `supportsPerAccountQuota`,
  `fetchProviderAccountQuotas`, the per-account TTL cache, generation reconciliation and
  the GUI's `accounts[].quota` field are all built — but wired to Anthropic only
  (`src/providers/quota.ts:1453`, `:1572`, `:1619`).

## What is actually missing

| Gap | Evidence |
| --- | --- |
| No Kiro quota fetcher at all | `rg -i kiro src/providers/quota.ts` → 0 matches |
| `supportsPerAccountQuota("kiro")` is false, and a test locks it | `tests/provider-account-quota.test.ts:204` |
| Rotation is quota-blind: it walks stored order, skipping cooled accounts | `src/oauth/generic-account-failover.ts:157` |
| Rotation only reacts to a 429 it already suffered; a known-exhausted account is still tried first | same |
| CLI copy calls Kiro a "single login slot", contradicting the shipped multiauth add-account flow | `src/cli/account.ts:28`, `:215` |

That last row matters more than it reads: the feature exists and the product tells the
user it does not.

## Non-goals for this unit

- No AGPL code, text, or structure copied from kiro-lb.
- No changes to the Codex or Anthropic pools; both are excluded from generic failover by
  design and own their own affinity/probe semantics.
- No `src/lab/` involvement — the core boundary test forbids it.
- No release promotion to `main`.
