# Codex Account Controls

Account-card controls in `gui/src/components/codex-account-pool-cards.tsx` and
`gui/src/components/codex-account-pool-main-card.tsx` project the account metadata owned by
`src/codex/auth-api.ts`. Management authentication and endpoint ownership remain in
[GUI and management API](gui-and-management-api.md).

## Selection order

Selection order must not be folded into the alias route. `codexAccountPriorities` is routing
metadata that Pool selection consults. It lives in config rather than on `CodexAccount` so the
`__main__` Desktop login can carry one; the alias route's rejection of `__main__` would be wrong here.
The matching CLI in `src/cli/account.ts` is `ocx account priority <provider> <id|main> [<value>]`,
reading the current order when the value is omitted. Ordering invariants live in
[OpenAI account modes](providers/openai-tiers.md).

## Custom usage thresholds

Per-account usage thresholds follow the same sidecar shape: `codexAccountAutoSwitchThresholds` maps
added account ids or `__main__` to 0..100. Account cards expose a custom-threshold toggle without
showing an inherited percentage. Enabling it copies the current global threshold into a fixed
account override through `/api/codex-auth/auto-switch`; that override, including `0`, takes precedence
over later global changes. Disabling it sends `null`, removes the map entry, and restores inheritance
of the current global threshold and subsequent global changes. Quota bars and routing both use the
effective account value so the dashboard drain marker matches runtime.

`gui/src/components/AccountAutoSwitchControl.tsx` keeps account-stable identity across saves,
preserves focus while a write is pending, and reconciles the draft to the persisted override after
acceptance or rejection. Internal keyboard focus movement does not commit a dirty draft; leaving
the control group does. An unrelated global refresh does not overwrite a dirty custom draft.
Mounted coverage lives in `gui/tests/codex-account-pool-pinned-badge.test.tsx`.

## Credits after the usage limit

Upstream keeps serving an account that holds ChatGPT credits at 100% and draws the balance, and
selection only leaves an account on quota after a refusal, so such an account was never moved off
(#6334). Spending is opt-in: `creditCodexAccountIds` lists the accounts, `__main__` included,
allowed to keep serving from credits, and absence means none. Every other account is switched out
at 100% and returns after its reset, so a new account also starts with spending off.
`src/codex/account-credit-use.ts` owns the list and the full-window rule. An unlisted account is
held while a usage window reads 100%: the long window (weekly, or monthly on 30-day plans) only
while its reset is still ahead, the burst window through `isTerminalShortWindow`. A held account
receives no traffic and therefore no new observation, so the reading has to end on its own; a long
window without a reset is not trusted.
Fresh spendable-credit evidence follows the [WHAM credit contract](providers/openai-tiers.md#spendable-codex-credits); included-plan refusal is not a credit-spending veto.

The hold is checked wherever plan exclusion is checked in `src/codex/routing/selection.ts`: the
eligible list (its pool filter and its main branch), `isCodexAccountSelectable`, and
`codexAccountBlockReason`, which reports `credits_off`. `isCodexAccountRotationExcluded` carries
both policies into the two legacy keep-the-active-account fallbacks and the transient-only affinity
check in `src/codex/routing.ts`, so a pool whose accounts are all held selects none instead of
spending. The main login has paths that never reach selection, so `src/codex/auth-context.ts` also
checks it where the main-account hard lock is checked: `assertMainAccountPolicy` throws
`CodexMainAccountCreditsOffError` (a cooldown error, mapped like the hard lock), and
`requestOwnedMainPinState` stops preserving a caller's own main credential. Both read the main
policy quota the lock reads and no plan, because several of those callers may not open the physical
auth file. The two main-account policies stay separate: listing `__main__` does not lift the hard lock
(98% by default), which refuses first, and the main card's switch says so. Both refusals are
policy, not authentication: they keep their own message in `cooldownErrorMessage` and never mark the
login for reauthentication, including when the window fills during the awaited token refresh.

`PUT /api/codex-auth/accounts/credits` writes one account (`{ id, creditsAfterLimit }`, pool
accounts and `__main__`) or the whole list (`{ all }`: on lists `__main__` and every selectable
pool account, off clears it). It has no CLI verb yet (`deferred-verb`, owner "#6334 follow-up");
`ocx config set creditCodexAccountIds` covers scripted use. The dashboard control is
`gui/src/components/CodexCreditSpend.tsx`: one global switch in the Codex Auth header beside the
"Codex credits" display switch, derived from the rows (off when none may spend, mixed when some
may, on when all may, matching the quota auto-refresh control), and one switch per account inside
that card's "⋯" disclosure (the main card gets the same disclosure for it). Clicking the global
switch from off or mixed allows every account; from on it clears them all. `CreditsOnBadge`
marks an account allowed to spend, independent of the display switch, which still never changes
routing. Coverage: `tests/codex-integration/codex-credits-after-limit.test.ts`,
`tests/codex-integration/codex-credits-after-limit-main.test.ts` and
`gui/tests/codex-credit-spend.test.tsx`.
