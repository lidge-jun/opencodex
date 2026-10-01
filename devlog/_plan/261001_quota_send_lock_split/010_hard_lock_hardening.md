# 010 — wp1: window-aware hard-lock thresholds and outside-usage warning

Branch `codex/main-hard-lock-window-thresholds` from `origin/dev`. Maintainer code.

## Behaviour

1. The 5-hour (short) window locks at a lower percentage than the weekly/monthly
   (long) windows. Defaults: short **90**, long **98** (unchanged). Both configurable.
2. When the main account's usage rises while opencodex has not used the main
   account, the dashboard and `ocx status` show a warning: usage is being consumed
   outside opencodex, so the lock may not prevent exhaustion.

## Config (NEW key)

`src/types/config.ts` next to `codexMainAccountHardLock`:

```ts
/** Per-window lock thresholds in percent (#6196). short: 5h window, default 90; long: weekly/monthly, default 98. */
codexMainAccountHardLockThresholds?: { short?: number; long?: number };
```

`src/config/schema/config-schema.ts`: object of two optional integers in
`[MAIN_ACCOUNT_HARD_LOCK_MIN_PERCENT, 100]`, `.catch(undefined)` per field so a
malformed disk value degrades to defaults (same pattern as the boolean at :188).

`PUT /api/settings` (`src/server/management/config-routes.ts`): accept the object,
reject non-integer/out-of-range values and `short > long` with 400 before any write,
include it in the rollback snapshot; GET returns the effective thresholds in the
existing hard-lock projection.

## Constants (MODIFY `src/codex/quota-types.ts`)

```ts
export const MAIN_ACCOUNT_HARD_LOCK_PERCENT = 98;               // long default, unchanged export
export const MAIN_ACCOUNT_HARD_LOCK_SHORT_PERCENT = 90;          // NEW short default
export const MAIN_ACCOUNT_HARD_LOCK_MIN_PERCENT = 80;            // NEW lowest configurable value
```

## Lock (MODIFY `src/codex/main-account-hard-lock.ts`)

- NEW `resolveMainAccountHardLockThresholds(config): { short: number; long: number }`
  — defaults above, clamps invalid in-memory values back to defaults, forces
  `short <= long`.
- `WindowReading` gains `kind: "short" | "long"`; `governingWindows()` tags the 5h
  reading short, weekly and monthly-only long.
- `getMainAccountHardLockStatus()` compares each window with its own threshold and
  returns `thresholds` plus `window: "short" | "long"` of the first blocking reading.
- `PolicyConfig` adds `codexMainAccountHardLockThresholds`.

## Evidence retention (MODIFY `src/codex/quota.ts`)

The three policy-evidence retention guards (`assignCarriedShort` ~:263,
`preserveKnownWeekly` ~:374, `preserveKnownShort` ~:407) compare against 98. With a
configurable threshold a reading between the threshold and 98 could be dropped by an
elapsed reset or partial update and silently unlock. Change the comparison to
`MAIN_ACCOUNT_HARD_LOCK_MIN_PERCENT` so any reading that can block under some
allowed configuration is retained until a fresh lower reading arrives. Retaining a
non-blocking reading only keeps a stale percentage visible; it never blocks.

## Error copy (MODIFY `src/codex/auth-context.ts` ~:517)

`CodexMainAccountHardLockError` message stops naming 98: "Codex main account is
blocked by the main-account quota policy (5h ≥ X%, weekly ≥ Y%)." The constructor
takes the thresholds from the status. Update tests that assert the old string.

## Outside-usage detector (NEW `src/codex/main-account-external-usage.ts`)

Process-local, no persistence, no timers. It keeps its own baseline of fresh readings
and never reads the merged policy snapshot, which can contain carried windows.

```ts
export const EXTERNAL_USAGE_QUIET_MS = 30 * 60_000;
export const EXTERNAL_USAGE_TTL_MS = 6 * 60 * 60_000;
type FreshWindow = { kind: "short" | "long"; percent: number; resetAtMs: number };
export function noteMainAccountActivity(now = Date.now()): void;
/** Only windows with a validated percent AND a known reset in this observation. */
export function observeMainAccountUsage(identityKey: string, windows: FreshWindow[], now = Date.now()): void;
export function forgetMainAccountUsage(): void;
export function getMainAccountExternalUsageWarning(identityKey: string | undefined, now = Date.now()):
  { window: "short" | "long"; fromPercent: number; toPercent: number; observedAt: number } | undefined;
export function resetMainAccountExternalUsageForTests(): void;
```

Rule: the module holds `{ identityKey, perWindow: { percent, resetAtMs, observedAt } }`.
A new `identityKey` replaces the baseline and drops any warning. For a fresh window
with the same kind and the same normalized `resetAtMs` (both known; a missing reset
never proves the same episode), a rise of at least 1 point with no main-account
activity noted since `baseline.observedAt - EXTERNAL_USAGE_QUIET_MS` records a warning.
A changed reset rebaselines that window and clears its warning. Warnings expire after
`EXTERNAL_USAGE_TTL_MS` or once the recorded `resetAtMs` passes, whichever is first; the getter returns nothing for a different identity.
Over-counting activity only suppresses warnings. A single turn longer than the quiet
margin can still cause a false positive, so the copy says "possible usage outside
opencodex".

Hooks:

- `src/codex/auth-context.ts` `assertMainAccountPolicy()` (:703) runs on every
  main-credential attach (main-pool, substituted main, caller bearer matching observed
  main) and on some admission checks before refusal. Call `noteMainAccountActivity()`
  there before the `!config` early return; the extra calls only suppress warnings.
- `src/codex/quota.ts` `setAccountQuotaFromParsed()` (~:318): when `isMain`,
  `mainWriter` is present and `policyQuota` (this call's validated observation) is
  non-null and carries usage, build `FreshWindow`s from `policyQuota` only (short:
  `shortPercent` + `shortResetAt`; long: `weeklyPercent` + `weeklyResetAt`, or monthly
  when `monthlyIsPrimaryWindow`), normalize with `resetAtToMs`, and call
  `observeMainAccountUsage(mainWriter.identityKey, windows)`.
- `clearAccountQuota()` (main or all) calls `forgetMainAccountUsage()`.
- Readers pass `getObservedMainQuotaIdentityKey()` to the getter.

## Surfaces

- `src/codex/auth-api/account-list.ts` (~:374): the main-account hard-lock DTO gains
  `thresholds` and optional `externalUsage`.
- GUI `gui/src/components/MainAccountHardLockSetting.tsx` and
  `codex-account-pool-main-card.tsx`: copy uses the effective thresholds; amber notice
  when `externalUsage` is present. Locale keys in all ten catalogs; replace fixed-98
  strings (`en.ts:2312-2325`).
- `ocx status`: `src/oauth/health.ts` `fetchCodexHealthFromLiveProxy()` already reads
  `/api/codex-auth/accounts`; project the main hard-lock state, thresholds and
  external-usage warning, and print one line in `src/cli/status-oauth.ts` (human) and
  include it in JSON. Keep `src/cli/index.ts` (1979 lines) untouched.

## Tests (NEW sibling files; register in both layout files)

- `tests/codex-integration/main-account-hard-lock-thresholds.test.ts`: short 90 blocks
  at 90 with weekly 30; weekly 95 admits by default and blocks with long 95;
  configured short/long; invalid config falls back; retention of a 92% short reading
  across an elapsed reset.
- `tests/codex-integration/main-account-external-usage.test.ts`: rise without
  activity warns; activity inside the quiet margin suppresses; reset change clears;
  identity change clears; expiry.
- `tests/config/settings-main-account-hard-lock.test.ts` (MODIFY, 119 lines): PUT
  validation and rollback for thresholds.
- GUI test for the warning notice next to the existing hard-lock setting tests.

## Docs

`docs-site/src/content/docs/reference/cli/providers-accounts.md` (+ Korean),
`docs-site/src/content/docs/reference/configuration/server.md` key row,
`structure/providers/openai-accounts.md`, `structure/config.md`.

