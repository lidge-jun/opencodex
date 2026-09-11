# Phase 1 — an operator pick beats the pool cursor (Codex)

Base: `origin/dev` `dd9a2906b`. Branch: `codex/pool-manual-selection` off `dev`.
Precondition: lane L3 owns `src/codex/routing.ts` and `src/codex/auth-api.ts`
(000_plan.md constraints). Do not open this layer until that ownership clears.

## Thesis

A manual selection from the dashboard or `ocx account use` wins the next dispatch,
and commits as the stored active account when that dispatch succeeds.

## Current behaviour (verified on dd9a2906b)

```
src/codex/routing.ts
  56   let runtimeActiveCodexAccountId: string | undefined;
  1625 export function getEffectiveActiveCodexAccountId(config: OcxConfig): string | undefined {
  1626   return runtimeActiveCodexAccountId ?? config.activeCodexAccountId;
  1644 function rememberActiveCodexAccount(_config: OcxConfig, accountId: string): void {
  1645   runtimeActiveCodexAccountId = accountId;
```

`rememberActiveCodexAccount` is called at `:1470` (round-robin commit), `:1481`
(fill-first commit), `:1678` (`promoteActiveCodexAccount`) and `:2286`
(preemption). None of the four consults the pin. The pin itself
(`config.activeCodexAccountPinned`, written only by `auth-api.ts:2441`) is read as
a priority-tier ceiling in `getEligiblePoolAccounts` `:1318-1322` and nowhere else
in the selection path.

The path to copy is Anthropic's:

```
src/oauth/anthropic-routing.ts
  94  let manualPreference: OAuthAccountSelection | null | undefined;
  575 if (manualPreference === undefined) { ...seed from set.activeAccountId + selectionRevision }
  588 if (manualPreference.accountId !== set.activeAccountId || revision mismatch) manualPreference = null;
  597 return { accountId: chosen, reason: "manual" };
  799 // consumed only after the admission commit
  808 export function resetAnthropicRoutingForManualSelection(accountId: string)
```

## Change surface

MODIFY `src/codex/routing.ts`

1. NEW module-local `manualPreference: { accountId: string } | null | undefined`
   beside `runtimeActiveCodexAccountId` (`:56`). `undefined` means not yet seeded
   from the persisted active account; `null` means consumed.
2. `resetCodexRoutingForManualSelection` (`:870`) additionally seeds
   `manualPreference` from `config.activeCodexAccountId`, mirroring
   `anthropic-routing.ts:810`. It keeps clearing thread affinity, clearing the
   runtime cursor and seeding round-robin, and keeps preserving cooldown.
3. `pickUnboundStrategyAccount` (`:1466-1481`) returns early while a preference is
   live, so round-robin and fill-first cannot call `rememberActiveCodexAccount`
   over the operator choice.
4. `getEffectiveActiveCodexAccountId` (`:1625`) returns the preference account
   while one is live, ahead of the runtime cursor.
5. `resolveCodexAccountForThreadDetailed` (`:2069`) checks the preference before
   `pickUnboundStrategyAccount` (`:2194`). If it names the persisted active
   account and that account is selectable and not exhausted, return it with a
   `manual` reason and do not call `rememberActiveCodexAccount`.
6. `previewCodexAccountForRequest` (`:1987`) peeks the preference without
   consuming it.
7. NEW consume-on-success, mirroring `anthropic-routing.ts:799-800`: after a
   successful token and admission, set `manualPreference = null` and confirm
   `config.activeCodexAccountId`. A failed lookup must not spend the preference.

MODIFY `src/codex/auth-api.ts` PUT `/api/codex-auth/active` (`:2412-2444`):
no contract change. It keeps `setCodexAccountPin` and
`resetCodexRoutingForManualSelection`; the pin stays the tier ceiling and the new
preference carries the one-shot. A null body still clears the pin (`:2440`).

Explicitly NOT changed: `applyQuotaAutoSwitch` (`:1784`). It only moves at
`autoSwitchThreshold`, and `releaseDrainedCodexAccountPin` (`:1757`) already
treats that drain as the end of a pin. An earlier draft named it as the cause and
the audit rejected that.

## Tests

Extend, do not add files. `codex-` is not in the `layout.json` domain regex, so a
new `codex-*.test.ts` would need entries in both `scripts/test-layout/layout.json`
`explicit` and `tests/fixtures/test-layout-expected.json`.

- `tests/codex-integration/codex-pool-rotation.test.ts` — the operator pick wins the
  next round-robin and fill-first dispatch (manual seed cases at `:524-541`); the
  existing pin-holds-RR case at `:791-803` stays green for the ceiling after the
  preference is consumed.
- `tests/codex-integration/codex-routing.test.ts` — a second unbound session follows
  the pool cursor again once the preference is spent; a failed admission leaves the
  preference unspent (pin cases at `:3139-3242`).
- `tests/codex-integration/codex-auth-api.test.ts` — PUT then next-dispatch identity
  (`:3956-3989`).

Semantic oracle: `tests/adapters/anthropic/anthropic-account-pool.test.ts` `:144`,
`:209`, `:234`.

## Out of scope

The generic OAuth kind gets no preference in this layer; that arrives with the
kernel in phase 2. No management or GUI change.
