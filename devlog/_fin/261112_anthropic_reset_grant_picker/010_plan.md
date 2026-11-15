# 010 — Claude reset grant picker

Owner request: "클로드 리셋은 골라서 쓸 수 있고 만료도 다른데 클릭되게 만들어줘".
Class: C3 (GUI component + hook helper + i18n across 11 locales; touches the spend path of a
user-consent action, so it gets an independent and a security review). Base: `origin/dev` a159cdde84.

## Current behavior (origin/dev)

- `gui/src/components/provider-workspace/AnthropicResetGrants.tsx` `AnthropicResetGrantModal` lists grants
  (`GrantItem`) but "Use 1 reset" always confirms `spendableGrant(snapshot)`
  (`gui/src/hooks/useAnthropicResetGrants.ts:135`): the first grant in upstream order that passes the gate.
- `controller.spend(accountId, {grantId, operationId})` already posts any grantId.
- Server `src/server/management/anthropic-reset-grant-routes.ts` `handleConsume`: a new operationId re-reads
  upstream and calls `anthropicResetGrantBlocker(status, grantId)` (`src/providers/anthropic-reset-grants.ts:195`)
  for the exact grantId → 409 `grant_not_usable` with reason ineligible|unknown_grant|paused|not_usable|exhausted|not_limited.
  A same-id retry of an open journal record skips the gate; the ledger then refuses a grant/account change
  (`operation_identity_mismatch`) and a second open op on the same (account, grant) (`unresolved_prior_operation`).
  So server validation is already per grant and independent of client choice; no server code change is planned.

## Default selection decision

Default = the gate-passing grant with the **earliest `endsAt`** (grants with no end date last; ties keep
upstream order). Reasons:
1. Every grant spends exactly one reset; a grant unused at `endsAt` is lost. Earliest-expiry first maximizes
   resets the user actually gets (same rule the Grok coupon dialog already applies, `byExpiry` in
   `useGrokResetCoupons.ts`).
2. Upstream order carries no documented meaning; the GUI never consumed `next_grant_id`.
3. The cost of a wrong default is low because the choice is now visible and changeable, and the confirm step
   names the windows the grant clears before anything is sent.
Rejected: "first in upstream order" (arbitrary, can burn a long-lived grant while a short one expires);
"prefer the grant that clears the most windows" (guesses intent; the user can pick it explicitly).

## Grok coupons

Out of scope for this PR. Grok coupons are interchangeable (same effect, differ only in validity end); the
dialog already spends earliest-expiry first and says so (`grokCoupon.fifoNote`). A picker adds choice without
value there. No change.

## Diff-level plan

1. `gui/src/hooks/useAnthropicResetGrants.ts`
   - add `export type AnthropicGrantBlocker = "paused" | "not_usable" | "exhausted" | "not_limited"` and
     `grantBlocker(snapshot, grant)` mirroring the server gate order (paused → usableNow → resetsLeft → limit).
   - `spendableGrant(snapshot)` returns the earliest-expiry grant with no blocker (snapshot-level
     eligible/journalAvailable unchanged). Badge semantics unchanged (exists ⇔ any spendable).
2. `gui/src/components/provider-workspace/AnthropicResetGrants.tsx`
   - grant list becomes `role="radiogroup"` (`aria-label` = new key); each grant `role="radio"`,
     `aria-checked`, `aria-disabled` when blocked, roving `tabIndex` (selected 0, others -1),
     click / Space / Enter selects, Arrow keys and Home/End move to and select the next enabled grant.
   - state `selectedId`; effective selection = `selectedId` if it still has no blocker in the current snapshot,
     else `spendableGrant(snapshot)`. Selection handler is a no-op while `unresolved`, `busy`, or `confirming`.
   - blocked grants keep their note; new note for exhausted (`resetsLeft === 0`).
   - confirm step shows grant label, expiry date/time, and cleared windows (names only), posts that grantId.
     Confirm button is disabled if the confirmed grant is no longer selectable in the current snapshot.
   - unknown-outcome / pending screen additionally shows which grant the held attempt uses (read-only);
     no radios render there, so the held grant cannot be swapped; retry still posts the same {grantId, operationId}.
   - journal unavailable: show the existing `anthropicGrant.journalBusy` note above the list.
3. `gui/src/styles/anthropic-reset-grants.css` — selectable item styles: pointer, radio dot, checked
   border (reuse amber), disabled opacity, `:focus-visible` outline.
4. i18n, all 11 catalogs (`en de fr ko zh zh-TW ru ja tr vi pt`): `anthropicGrant.chooseLabel`, `.pickHint`,
   `.exhausted`, `.confirmExpires`, `.confirmClears`, `.clearsFiveHour`, `.clearsWeekly`, `.clearsOverage`.
5. Tests (written first, must fail on origin/dev):
   - extend `gui/tests/anthropic-reset-grants.test.tsx` (existing happy-dom harness with the real hook and
     mocked fetch; gui/tests is outside the root test-layout registry): default = earliest expiry; clicking
     another usable grant then confirming posts that grantId with a UUIDv4; paused / not usable / exhausted /
     requires-limit grants are `aria-disabled` with their note and clicks do not select them; ArrowDown/Space
     selection skips disabled; unknown outcome and a server-held pending op render no radios and retry posts
     the held grantId/operationId; confirm step shows label, expiry and cleared windows.
   - `tests/server/management-anthropic-reset-grants.test.ts`: two-grant block — spending the second grant
     sends that grant_id upstream; a paused second grant is refused `grant_not_usable`/`paused` with no claim.
     (This passes on dev; it locks the server contract the picker now relies on.)

## Verification

- `cd gui && bun test tests/anthropic-reset-grants.test.tsx`; `bun test tests/server/management-anthropic-reset-grants.test.ts`
- `cd gui && bun run lint:i18n`, `bun run build`, and the GUI suite `bun test tests` before review
- `bun run typecheck`, `bun run lint:gui`, `bun run test:changed`, `bun run privacy:scan`
- Browser screenshot of the picker and the confirm step (GUI dev server with a mocked grants response),
  uploaded to `pr-assets` and linked by commit SHA.

## Risks

- Selecting a grant that upstream refuses: server gate refuses before any claim; GUI refreshes on refusal.
- Swapping grant during an unknown outcome: blocked in UI (no radios) and in ledger (identity mismatch /
  unresolved prior).


## Audit (A) — system24/deepseek-v4.1-flash, NEAR-PASS

Model trail: combo/deepseek-flash-pool stalled (cancelled after 8 min without output);
hyds/deepseek-v4.1-flash-1m and hyds/deepseek-v4.1-flash failed with provider 403; system24/deepseek-v4.1-flash answered.

1. Roving tabindex must move DOM focus — accepted: refs per grant, `.focus()` on the newly selected radio;
   arrow targets come from the focused radio's index.
2. `unresolved_prior_operation` not resumed — rebutted: `post()` refreshes after every refusal, and the
   refreshed snapshot's `pendingOperation` (newest open op for the account) drives the same-id retry screen.
   Covered by a test.
3. Confirmed grant vanishes/blocks on refresh — accepted: the dialog leaves the confirm step and shows
   `anthropicGrant.notUsableNow`; the unposted operationId is discarded (never sent, so safe).
4. Malformed `endsAt` — accepted: `expiryRank` returns Infinity for null/NaN, stable sort keeps upstream order.
5. `startConfirm` source — accepted: uses the effective selection and re-checks it has no blocker.
6. Snapshot-level blockers — accepted: `!journalAvailable` makes every radio aria-disabled and shows
   `anthropicGrant.journalBusy`; `!eligible` keeps the existing ineligible screen (no list).
7. Ratchet/layout — touched files are not in `file-size-baseline.json` (locale files are exempt);
   `gui/tests` is outside the root registry; the server test file is already registered. `bun run build:gui` added.
8. A pending op on any grant blocks spending another grant — intended: one unresolved claim per account at a time,
   and the retry screen names the held grant.


## Security review (C) — combo/deepseek-flash-pool, head afd5acdb04, REQUEST_CHANGES

1. Stale snapshot could offer a picker while an attempt is open, and the ledger refused only a same-grant
   prior, so a different-grant claim could start — accepted, fixed on both sides: the ledger now allows at
   most one unresolved operation per account and org (any grant) inside the ten-minute retry window (an older
   open record no longer blocks, matching the same-id retry limit), and the dialog re-reads the account when it
   opens. Fail-first tests: ledger (`tests/adapters/anthropic/anthropic-reset-grants.test.ts`), route
   (`tests/server/management-anthropic-reset-grants.test.ts`), dialog (`gui/tests/anthropic-reset-grants.test.tsx`).
2. One frame with a live picker between `setHeld(null)` and the refresh — rebutted: `setHeld`, `setOutcome` and
   the refresh's synchronous `setEntry(loading)` run in the same task after the awaited spend and are batched
   into one render; the unresolved-prior dialog test covers the path.
3. `credit-next` now marks the selection — nit, kept (styling only).
4. `CLEARS_KEYS` lookup on an unknown window — nit, unreachable: the hook parser filters `clears` to the three windows.

CodeRabbit (5 minor) — accepted: per-grant limit wording in `anthropicGrant.desc` (11 locales) and docs (8 locales);
unparsable dates hidden; empty `clears` shows `anthropicGrant.confirmClearsUnknown`.


## Final review — system24/deepseek-v4.1-flash, head 7f90636f41, APPROVE with should-fix

1. No tab stop when nothing is selectable — accepted: the first grant is the group's tab stop when none is selected.
2. Re-read on open blanked the list and badge — accepted: `refresh(accountId, { keepSnapshot: true })` keeps a ready entry
   during the read and the dialog disables "Use 1 reset" until it lands. A failed re-read still turns the entry into
   an error (fail closed on a spend path) — that sub-point is rebutted.
3. Hint with no real choice — accepted: shown only with two or more selectable grants.
4. Missing test for a pick surviving a re-read — accepted (test added; it passes on the previous head too, as a guard).
5. German du/Sie — accepted. 6. Turkish docs wording — accepted.

Security review round 2 (combo/deepseek-flash-pool, head 6f93946d70): APPROVE; its nits (account wording in
`anthropicGrant.unresolvedPrior`, structure scope per pool journal, newest open record named by the ledger) were folded in 7f90636f41.
Model trail for reviews: hyds/deepseek-v4.1-flash-1m and hyds/deepseek-v4.1-flash returned 403 again; combo stalled on two final-review briefs.


## Final review — system24/deepseek-v4.1-flash, head bf87ad512f, APPROVE

1. pickHint false after a pick (should-fix) — accepted: shown only while the default grant is selected; test extended (fails on bf87ad512f).
2. Silent fallback when a picked grant becomes unusable (nit) — rebutted: the confirm step names the grant before any spend.
3. GET pending filter lacks orgDigest (nit) — rebutted for this PR: adding it needs a profile read on every GET; an org change mid-window fails closed (`operation_identity_mismatch` releases the hold, nothing is spent).
4. Missing `.catch` on the open re-read (nit) — accepted.
5. Tests for newest prior / StrictMode (nit) — rebutted: two open records only exist in pre-change journals; the guarded render update is exercised by the stale-confirm test.


## Outcome (D)

Delivered in https://github.com/lidge-jun/opencodex/pull/8595 (squash merge into `dev`).
What did not change: Grok coupons keep their earliest-expiry-first dialog with no picker; the GET's pending
operation still does not filter by organization (an org change mid-window fails closed without a spend).
What would refute the default: evidence that upstream `next_grant_id` encodes a preference the user should follow
(for example a grant that clears the window the account is actually limited on); then prefer it among selectable grants.
