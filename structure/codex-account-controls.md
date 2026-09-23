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
