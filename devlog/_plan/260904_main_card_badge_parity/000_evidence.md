# 000 — Evidence: main account card is missing two badges

Unit: `260904_main_card_badge_parity`
Opened: 2026-09-04
Branch base: `dev` @ `8b60e4c44`

## Reported symptom

On the Codex Auth dashboard the MAIN account card shows neither the plan badge
(`pro`) nor the reset-credit ticket badge, while every pool card shows both.

## Live evidence (read-only, port 10100)

`GET /api/codex-auth/accounts` at 2026-09-04, main entry:

```json
{"id":"__main__","email":"k***1@gmail.com","plan":"pro","isMain":true,
 "quota":{"weeklyPercent":28,"weeklyResetAt":1788749167,"updatedAt":1788490155601}}
```

A pool entry from the same response:

```json
{"id":"chatgpt-1786626108327","plan":"pro",
 "quota":{"updatedAt":1788490159314,"weeklyPercent":26,"weeklyResetAt":1788748127,"resetCredits":2}}
```

On-disk cache `~/.opencodex/codex-quota-cache.json`, `__main__` entry:

```json
{"updatedAt":1788490155601,"weeklyPercent":28,"weeklyResetAt":1788749167,
 "customWindows":[{"label":"GPT-5.3-Codex-Spark Weekly","percent":0,"resetAt":1789094955}],
 "resetCredits":1}
```

So the store HAS `resetCredits: 1` for the main account, and the response DTO
drops it. That is the whole of defect 2.

## Two independent defects

**D1 — plan badge absent from the main card markup.** The server sends
`plan: "pro"`. `gui/src/components/codex-account-pool-cards.tsx:91` renders
`{a.plan && <span className="badge badge-green">{a.plan}</span>}` inside
`card-badges`. The equivalent block in
`gui/src/components/codex-account-pool-main-card.tsx:87-99` has no such line.
Purely a missing element; no data problem.

**D2 — resetCredits never reaches the main DTO.**
`CodexTicketBadge` (`codex-account-pool-helpers.tsx:28-51`) returns `null`
when `account.quota` is non-null but `quota.resetCredits === undefined`. The
main card passes `{...main, id:"__main__"}`, so it inherits whatever the DTO
carries — and the DTO carries no `resetCredits`.

## Why the two DTO paths diverge

Pool path, `src/codex/auth-api.ts`:

- `commitPoolQuotaResponse` writes the parsed snapshot with
  `setAccountQuotaFromParsed(accountId, quota, writerGeneration)` (line 1195)
  and then returns `quota: getAccountQuota(accountId)` (line 1197) — it reads
  the value **back out of the merged store**.
- `poolAccountDto` (line 277) serializes that store-read object, so it carries
  every field the store merged, including a `resetCredits` that arrived on an
  earlier partial snapshot.

Main path, same file:

- `fetchMainAccountInfoWhileOwned` (line 807+) parses the same WHAM payload,
  mirrors it into the store with `setAccountQuotaFromParsed(MAIN_CODEX_ACCOUNT_ID, ...)`
  (line 860) — and then caches and returns `result.quota`, the **pre-merge parse
  result**, not the store value.
- `listCodexAuthAccountsSnapshot` (line 1632-1647) builds the main DTO from
  `mainInfo.quota`, spreading it and patching in only `updatedAt` from
  `getAccountQuota(MAIN_CODEX_ACCOUNT_ID)`:

```ts
quota: mainInfo.quota ? {
  ...quotaForPlan({
    ...mainInfo.quota,
    updatedAt: getAccountQuota(MAIN_CODEX_ACCOUNT_ID)?.updatedAt ?? Date.now(),
  }, mainInfo.plan),
} : null,
```

That reaches into the store for exactly one field. Every other merged field —
`resetCredits` above all — is lost whenever the current `/wham/usage` response
omits `rate_limit_reset_credits.available_count`.

## Why the current response omits it

`parseUsageQuota` (`src/codex/quota.ts:561`) only sets `resetCredits` when the
payload carries `rate_limit_reset_credits.available_count`. `/wham/usage`
includes that summary inconsistently, and the dedicated
`/wham/rate-limit-reset-credits` endpoint is separately rate limited — a live
probe for `__main__` returned `{"error":"Upstream error 429"}`. The store is
specifically designed to survive that: `setAccountQuotaFromParsed`
(`quota.ts:339-340`) carries `existing.resetCredits` forward when the new
snapshot omits it. The pool DTO benefits from that carry-forward because it
re-reads the store. The main DTO does not, because it does not.

This also matches upstream Codex, where `RateLimitsWithResetCredits`
(`codex-rs/backend-client/src/types.rs:45-48`) models the reset-credit summary
as `Option` alongside rate limits rather than as a field guaranteed on every
usage read.

## Conclusion

D2 is a server-layer bug, not a GUI bug: the main account is the only account
whose DTO bypasses the merged quota store. Fixing it in the GUI (for example by
reading `/api/codex-auth/quota` separately) would paper over an asymmetry that
also affects any other consumer of the main DTO.
