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

## wp4 P (executable)
Semantics: codexMainAccountHardLock absent or true = on; explicit false = off (persisted). Threshold 98 (MAIN_ACCOUNT_HARD_LOCK_PERCENT). Same convention as fastRows in config-routes.ts.
Writer A (core, write scope: src/**, tests/**, structure/**, scripts/test-layout/layout.json):
- src/codex/quota-types.ts: MAIN_ACCOUNT_HARD_LOCK_PERCENT = 98 (#5694).
- src/codex/main-account-hard-lock.ts: export isMainAccountHardLockEnabled(config) = config.codexMainAccountHardLock !== false; getMainAccountHardLockStatus uses it.
- Replace every === true gate: auth-context.ts 960/973/1017/1545/1623, native-profile-startup.ts 191/228/239/389/708, config-routes.ts projections 351/706.
- config-routes.ts PUT: true deletes key, false stores false (mirror fastRows); rollback path unchanged.
- config-schema.ts: .catch(undefined) so malformed values mean default-on.
- types/config.ts doc comment; auth-context.ts:512 message uses the constant.
- Tests: update existing hard-lock tests; add tests/codex-integration/main-account-hard-lock-default.test.ts (absent=on, false=off, malformed=on, 97.9 ready, 98 blocked, settings GET/PUT round trip) registered in layout.json explicit + test-layout-expected.json. codex-auth-api.test.ts cap 6549 (6514 now): no net growth beyond cap.
- structure/providers/openai-tiers.md:291-315 rewrite (on by default, 98%, opt-out persists false, Reserve trade-off).
Writer B (gui/src/i18n/*.ts only): 99 -> 98 in mainHardLock* strings in all locales; desc adds "On by default."
Writer C (docs-site/** only): providers-accounts.md en + ko (and other locales mentioning it) -> 98%, on by default, opt-out; check configuration/providers.md:71 and guides/providers.md:377.
Previous opt-outs deleted the key, so they cannot be distinguished; PR notes it.
Focused: main-account-hard-lock-*.test.ts, settings-main-account-hard-lock, main-quota-*, reserve-*, reserve-claude-policy, codex-quota-auto-refresh-main-admission, codex-auth-api, codex-account-threshold-api; bun run lint:gui; GUI i18n tests.

