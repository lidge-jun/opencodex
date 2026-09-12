# Architect review dispositions (round 1)

Reviewer: read-only architect subagent, 2026-09-12. Verdict text is reproduced in
`evidence/architect-round1.md`. Main owns the plan; each decision below is main's
disposition, not the reviewer's.

| ID | Finding | Disposition |
| --- | --- | --- |
| D1 | Eager one-GET-per-account is the most expensive of three read strategies; lazy-on-open matches the Codex detail fetch | **Rebutted with an amendment.** The request is explicitly "코덱스처럼 리셋쿠폰 아이콘도 생기고" — a badge with no number until clicked does not satisfy it, and xAI quota carries no `resetCredits` equivalent to make the count free. Eager stays, bounded: at most three reads in flight, and the read set is only the accounts of the provider whose panel is open. Folding the count into the xAI quota probe is recorded as the follow-up. |
| D2 | One scalar generation ref serves as both roster epoch and per-request cancel token, so a single-account refresh or redeem silently discards sibling reads and strands their badges | **Folded.** The roster epoch stays a scalar bumped only by the effect and its cleanup; each in-flight read now carries a per-account token, so one row's retry cannot cancel another row's read. |
| D3a | A retried redemption against a still-`open` journal record executes again, so one confirmation can spend two coupons | **Acknowledged as a backend residual.** The `open` → `execute` path is the server's deliberate resumption branch (`src/grok/reset-coupon-ledger.ts:87`) and this unit does not touch `src/`. The client keeps redemption single-flight and the residual is recorded for a follow-up issue against the route. |
| D3b | A settled *failure* replays as HTTP 200 with `replayed: true`, and the client reads only that flag, so a failed redemption is announced as a successful one | **Folded — this was the worst defect.** The client now reads `code` out of the 200 body and treats only `redeemed` as success; any other replayed code routes through the failure table. |
| D3c | 409 identity mismatch never clears the held operation id, so "try again" reproduces the same 409 forever | **Folded.** The id is cleared on 409 and on any failure that makes it unusable. |
| D3d | 503 capacity arrives as code `capacity`, which has no mapping and falls back to copy claiming nothing was consumed | **Folded.** `capacity` gets its own retryable message, and the generic failure copy no longer asserts that no coupon was consumed, because `redeem_failed` can follow an upstream call that already went out. |
| D4a | The fetch filter tests `account.needsReauth` while the render guard uses `showReauth`, so a health-flagged row is fetched and never rendered | **Folded.** Both use one predicate built from `accountNeedsReauth`-equivalent health state. |
| D4b | `grokCouponsEnabled` does not reference `surface`, so API-key xAI is excluded only by accident | **Folded.** The gate now requires the OAuth surface locally. |
| D5a | Seven locale catalogs are missing all 29 keys; `tests/i18n-locales.test.ts` and `tests/locale-parity.test.ts` fail | **Folded** — already in the file-change map; confirmed failing at plan time (`de key count: 2653` vs `2682`). |
| D5b | Failure outcome uses `role="status"` where the panel's convention for failures is `role="alert"`; confirmation step does not move focus | **Folded.** Failures announce assertively and the confirmation step takes focus. |
| D6a | `byExpiry` sorts client-side while the server's no-token default picks upstream order, so `fifoNote` promises the client's rule | **Rebutted as written.** The dialog always sends an explicit `tokenId`, so the server's default ordering never applies to this surface; the promise the copy makes is the one the request enforces. |
| D6b | The GET's 400/401/502 collapse into one opaque error | **Folded in part.** The entry keeps the response status so the dialog can separate "sign in again" from an upstream billing failure; finer codes stay out of scope. |
| D6c | docs-site owes an update | **Folded** — already in the file-change map. |

## Amendment to the plan

D1's bound and D2's per-account token change `gui/src/hooks/useGrokResetCoupons.ts`;
D3b/D3c/D3d and D5b change `gui/src/components/provider-workspace/GrokResetCoupons.tsx`;
D4a/D4b change the wiring in `ProviderAuthPanel.tsx`. No new files, and the scope
boundary is unchanged: `src/` stays out.

Two new locale keys follow from the dispositions: `grokCoupon.capacity` and
`grokCoupon.authExpired`, bringing the key set to 31.

