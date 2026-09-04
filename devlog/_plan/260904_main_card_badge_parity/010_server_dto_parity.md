# 010 — Phase 1: main-account DTO reads the merged quota store

Work phase: `wp1`. Depends on: nothing. Consumed by: `020`.

## Goal

The main account's DTO quota must be the same merged store object a pool
account's DTO quota is, so every field the store carries forward (today
`resetCredits`, tomorrow anything else) reaches the dashboard.

## Scope boundary

IN: `src/codex/auth-api.ts` main DTO construction; a focused test in
`tests/codex-auth-api.test.ts`.
OUT: `src/codex/quota.ts` merge semantics (already correct), the pool path,
any WHAM fetch/refresh policy, credential handling.

## File change map

### `src/codex/auth-api.ts` — `listCodexAuthAccountsSnapshot`, main DTO (~line 1642)

Before:

```ts
quota: mainInfo.quota ? {
  ...quotaForPlan({
    ...mainInfo.quota,
    updatedAt: getAccountQuota(MAIN_CODEX_ACCOUNT_ID)?.updatedAt ?? Date.now(),
  }, mainInfo.plan),
} : null,
```

After:

```ts
quota: mainInfo.quota ? {
  ...quotaForPlan(mergeMainQuotaWithStore(mainInfo.quota), mainInfo.plan),
} : null,
```

with a small local helper next to the DTO builders:

```ts
/**
 * The main account is the only account whose DTO quota came from the raw parse
 * result rather than the merged store, so a resetCredits the store had carried
 * forward vanished from the response whenever the current /wham/usage payload
 * omitted `rate_limit_reset_credits`. Pool DTOs never had that hole because
 * commitPoolQuotaResponse re-reads getAccountQuota() after committing.
 *
 * Only resetCredits is filled from the store, deliberately. The window fields
 * have *clearing* semantics -- a monthly-only snapshot must drop a stale weekly
 * value (#382) -- so a blanket spread of the stored object would resurrect a
 * window the parse intended to clear whenever the store write was refused by
 * generation gating. resetCredits is the one field setAccountQuotaFromParsed
 * itself carries forward (quota.ts:339-340), so mirroring exactly that rule
 * here keeps the DTO consistent with the store instead of inventing a second,
 * looser merge policy.
 */
function mainQuotaWithStoredResetCredits(
  parsed: Omit<StoredAccountQuota, "updatedAt">,
): StoredAccountQuota {
  const stored = getAccountQuota(MAIN_CODEX_ACCOUNT_ID);
  return {
    ...parsed,
    ...(parsed.resetCredits === undefined && stored?.resetCredits !== undefined
      ? { resetCredits: stored.resetCredits }
      : {}),
    updatedAt: stored?.updatedAt ?? Date.now(),
  };
}
```

Call site becomes `quotaForPlan(mainQuotaWithStoredResetCredits(mainInfo.quota), mainInfo.plan)`.

Precedence rationale: a freshly parsed `resetCredits` always wins, including a
deliberate `0` (0 is defined, so it is present in `parsed` and the fill branch
does not run). The store supplies the value only when the parse omitted the key
entirely. Every other field is untouched, so no window-clearing behaviour
changes.

### Audit finding folded in (blocker 1)

The first draft of this document proposed `{ ...stored, ...parsed }`. That is
unsafe: `setAccountQuotaFromParsed` refuses to commit when
`mayCommitAccountQuota` fails generation gating (`quota.ts:280`), so the store
can legitimately hold a PRE-clear snapshot while `parsed` is monthly-only. The
blanket spread would then re-introduce the stale `weeklyPercent` that #382
exists to clear, and it would show up as a phantom weekly bar on the main card.
Narrowing the merge to `resetCredits` removes that failure mode entirely.

### Identity-change safety (corrected — audit blocker 3)

The first two drafts claimed a swapped identity "cannot leak" a previous
account's credits. **That claim was wrong**, and the second reviewer
(muse-spark-1.3-contributor) refuted it with the exact path:

- In-process swaps ARE safe: `reconcileMainCodexAccountRuntimeState`
  (`account-lifecycle.ts:60-70`) purges alias-keyed `__main__` quota when it
  observes the account id change, and `mainSnapshotLive === false` forces
  `EMPTY_MAIN_ACCOUNT_INFO`, whose null quota short-circuits the DTO guard.
- Across a RESTART it is not. `observedMainChatgptAccountId`
  (`account-lifecycle.ts:21`) is memory-only, and the first observation after a
  restart hits the `previousAccountId === undefined` early return with no purge
  (`:67`). If `~/.codex/auth.json` was swapped while the proxy was down, the
  disk-hydrated `__main__` quota entry still belongs to the PREVIOUS login, and
  a store-based fill would print its ticket count on the new account's card.
  Pool accounts never have this hole because their store key is the account id
  itself; `__main__` is an alias.

Fix: do not read the fill value from the store at all. Keep an in-process,
identity-tagged observation of the last parsed count
(`mainResetCreditsProvenance = { accountId, credits }`), recorded in
`fetchMainAccountInfoWhileOwned` next to the existing `freshResetCredits`, and
return it only when `getMainChatgptAccountId()` still matches. A restart simply
starts with no observation, so the badge waits for the first response that
carries the summary rather than showing a stale or foreign number.

```ts
let mainResetCreditsProvenance: { accountId: string; credits: number } | null = null;

function mainResetCreditsForCurrentIdentity(): number | undefined {
  if (!mainResetCreditsProvenance) return undefined;
  const currentAccountId = getMainChatgptAccountId();
  if (currentAccountId === null) return undefined;
  if (currentAccountId !== mainResetCreditsProvenance.accountId) {
    mainResetCreditsProvenance = null;
    return undefined;
  }
  return mainResetCreditsProvenance.credits;
}
```

`updatedAt` still comes from the store, unchanged from today's behaviour.

### Consume-route interaction (audit question Q2c)

`auth-api.ts:2135` deliberately refuses to report a preserved cached
`resetCredits` as the consume response's `remaining`. That governs a
*transactional* claim about a just-executed redeem and is a different guarantee
from best-effort display state, so the DTO carry does not violate it. The real
overlap, recorded rather than fixed: if the forced post-consume refresh omits
the summary, the main card keeps showing the pre-consume count until the next
response that carries it — exactly the staleness every pool card already has.

### Upstream omission semantics (residual, non-blocking)

If upstream ever omits `rate_limit_reset_credits` to MEAN zero, a carried
non-zero would persist until the next explicit reading. Nothing in this
repository settles that question, the risk is pre-existing in the store merge,
and it is shared with every pool card. Named here rather than guessed at.

### quotaForPlan interaction

`quotaForPlan` already forwards `resetCredits` for 30-day plans
(`auth-api.ts:272`) and `withSparkVisibility` only filters `customWindows`,
which this helper does not touch. No change needed in either.

Note on `quotaForPlan`: it already passes `resetCredits` through for 30-day
plans (`auth-api.ts:272`), so no change is needed there.

## Accept criteria

1. Given a main WHAM parse result without `resetCredits` and a store entry for
   `__main__` holding `resetCredits: 1`, the main DTO carries `resetCredits: 1`.
2. Given a parse result WITH `resetCredits: 0` and a store entry holding
   `resetCredits: 3`, the DTO carries `0` — fresh wins, including zero.
3. Given no store entry, the DTO is byte-identical to today's output.
4. `updatedAt` behaviour is unchanged (store value, else now).
5. Window fields are never taken from the store: a monthly-only parse with a
   stored weekly value still produces a DTO without `weeklyPercent`.
6. A carried count is dropped when the physical main account id changes.

### Activation scenario for the conditional path

The new helper's store branch only runs when `getAccountQuota("__main__")`
returns an entry. The test triggers it by calling
`setAccountQuotaFromParsed(MAIN_CODEX_ACCOUNT_ID, { resetCredits: 1 })` before
listing accounts, and proves it ran by asserting `resetCredits` is present in
the returned DTO where it is absent today.

## Verifier

`bun test tests/codex-auth-api.test.ts` — this file already exercises the main
DTO and the `__main__` quota store (it references
`getAccountQuota(MAIN_CODEX_ACCOUNT_ID)?.resetCredits` at lines 2631, 2668,
2706), so it observes the change target directly.

## Field chain (PLAN-FIELD-CHAIN-01)

`resetCredits: number | undefined` is not a new field; this phase changes which
object the DTO reads. Chain for completeness:

- creation: `parseUsageQuota` (`quota.ts:562`) from
  `rate_limit_reset_credits.available_count`; also
  `updateAccountQuota(..., resetCredits)` (`quota.ts:473`).
- store merge: `setAccountQuotaFromParsed` (`quota.ts:294, 339-340`).
- serialization: `poolAccountDto` (store-read) and the main DTO (this fix).
- deserialization: `hydrateAccountQuotasFromDisk` reads
  `codex-quota-cache.json`; N/A for the DTO, which is response-only.
- consumers: `CodexTicketBadge` (`gui/.../codex-account-pool-helpers.tsx:29`),
  `src/cli/account-auth.ts`, the reset-credit consume route
  (`auth-api.ts:2135`).

## Bypass record (PLAN-BYPASS-NAMED-01)

This phase adds no enforcement. Tier: n/a. Executing surface: n/a. Known bypass:
n/a. Residual risk: a future main DTO rewrite could reintroduce the raw-parse
read; the regression test in criterion 1 is the early warning. Final enforcement
layer: none.
