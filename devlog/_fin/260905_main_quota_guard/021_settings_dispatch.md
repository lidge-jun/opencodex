# Settings implementation stale check and ownership

Consumes runtime headfe2e10e15 (PR3552). Linux full suite and behavioral criteria passed; remaining macOS checks stay in final delivery. No local test suites. Design Read/dials in020 unchanged: existing monochrome developer console, D8/V2/M1, no concept imagery.

## UI worker scope

NEW MainAccountHardLockSetting.tsx, MODIFY codex-set-multiauth.tsx, useCodexAccountPool.ts DTO, codex-account-pool-main-card.tsx, scoped styles-codex-set.css; NEW gui/tests/main-account-hard-lock-setting.test.tsx. No locale/doc/backend edits by the worker.

The actual tab URL is #codex-set, not #codex-set/multiauth. The parent creates exactly one useCodexAccountPool(apiBase) controller and injects it into CodexAccountPool, whose fallback becomes inert. New setting receives onSaved:()=>Promise<boolean> calling controller.load(false). Invoke after acknowledged PUT for both enable/disable, not dialog open/cancel. A failed status reload does not relabel the successful PUT as failed; show a separate retryable saved-but-status-unconfirmed notice.

Persisted field codexMainAccountHardLock:boolean, status mainAccountHardLock:{enabled:boolean,state:off|unknown|ready|blocked,resetAt?:milliseconds}. Main-card DTO has this optional status. Never derive status from rounded bars; ready means monitoring, not a promise that every other account restriction is absent.

No optimistic protection claim before acknowledgment. GET generations are invalidated on writes; cancel/Escape makes no request. Native dialog traps/restores focus; pending submission rejects duplicates and cannot be dismissed into an ambiguous success. Load error offers retry. Save failure describes inability to confirm, keeps recoverable state, and reloads authoritative state when appropriate.

Show main status when advanced settings are collapsed, and suppress the use-main button when policy blocks. Offer a link to the actual Codex settings route when the card appears elsewhere. Do not create a new event bus, duplicate account store, or force an upstream quota refresh on every settings save.

## Translation contract (main owns all locales)

Use only these new keys under codexAuth: mainHardLockTitle, mainHardLockDesc, mainHardLockConfirmTitle, mainHardLockConfirmBody, mainHardLockConfirm, mainHardLockEnabled, mainHardLockDisabled, mainHardLockLoadFailed, mainHardLockSaveFailed, mainHardLockRefreshFailed, mainHardLockBlocked, mainHardLockUnknown, mainHardLockMonitoring, mainHardLockManage. Reuse common.retry/common.close/codexAuth.cancel for common controls. Main can add a key only after synchronizing the worker and all locales.

Copy must state5h first, weekly otherwise, monthly-only fallback; fresh0 unlocks automatically while enabled. While blocked, Reserve is unavailable too; staying below ordinary exhaustion may prevent Reserve activation. In-flight/direct/unmatched-keyring use is outside the guarantee. No claim that the Reserve picker feature has shipped in this UI layer.

## Main scope and verification

All locale keys, public English/Korean usage docs, isolated fixture preview and browser QA, records and PR body. Browser at390/768/1280px, Korean/English, enable/cancel/Escape/saving/savefail/loadfail/disable and current-block status. Native browser tool first; no Playwright install. Build/i18n/lint are allowed; no local suites. CI executes component regressions. Screenshots must contain fixtures only and be embedded in the upper PR.
