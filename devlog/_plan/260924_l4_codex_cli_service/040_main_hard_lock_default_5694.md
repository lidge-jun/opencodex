# 040 — #5694 98% main-account hard lock by default

Existing mechanism: codexMainAccountHardLock (src/types/config.ts, schema .catch(false)), MAIN_ACCOUNT_HARD_LOCK_PERCENT=99 in src/codex/quota-types.ts, getMainAccountHardLockStatus in src/codex/main-account-hard-lock.ts, consumers gate on === true in src/codex/auth-context.ts, src/codex/native-profile-startup.ts, src/server/management/config-routes.ts, gui/src/components/MainAccountHardLockSetting.tsx.
Change:
- MAIN_ACCOUNT_HARD_LOCK_PERCENT = 98.
- New resolver isMainAccountHardLockEnabled(config) = config.codexMainAccountHardLock !== false; replace every === true gate.
- Schema: invalid value -> undefined (default on), explicit false persists opt-out; management PUT false stores false (not delete), true deletes key or stores true — decide by reading config-routes semantics.
- GUI: toggle shows on when unset; copy 99% -> 98% in all locales; confirmation dialog still shown when enabling.
- Docs: providers-accounts.md (en, ko, others), configuration/providers.md, guides/providers.md, ru; structure/providers/openai-tiers.md.
- Tests: default-on status, explicit false off, 98 threshold (97.9 ready, 98 blocked), config-route round trip.
Trade-off for PR: default lock can keep main-account Luna Reserve from activating (Reserve needs exhausted normal window); opt-out by setting false.

## Audit folds (wp0 A)
- src/codex/main-account-hard-lock.ts:26 gates on !== true: switch to resolver.
- config-schema.ts:152 .catch(false) -> .catch(undefined) so malformed values fall back to the default (on).
- config-routes.ts:598 deletes the key on PUT false: must store false; PUT true deletes the key (default on). Projections at :351 and :706 become resolver-based, else GUI invariant at MainAccountHardLockSetting.tsx:14 fails.
- quota.ts:262 and :388 also use MAIN_ACCOUNT_HARD_LOCK_PERCENT (blocking-evidence retention); they follow the constant.
- auth-context.ts:512 hardcoded "99%" message -> derive from constant.
