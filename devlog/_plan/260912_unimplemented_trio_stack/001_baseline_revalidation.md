# Baseline revalidation (wp1 B-phase)

Independent main-session spot check of the citations folded in by the wp1
audit (0268727f82), re-run against the working tree at B. Every folded
reference was opened and read; results below. All verified TRUE.

| Claim | Where verified | Result |
|-------|----------------|--------|
| `assertNativeMainOwner` throws without a held owner entry | src/codex/native-main-owner.ts:302-314 — throws NATIVE_MAIN_OWNER_UNAVAILABLE/BUSY (503) unless snapshot held | TRUE |
| Exclusive claim is owner-independent (FS/SQLite lock) | src/codex/native-main-claim.ts:167 — `withNativeMainExclusiveClaim(context, operation, options)`, claim/release around operation, no owner lookup | TRUE |
| `shouldSyncCodexOnStart` is composed at desired-state.ts:130 | src/codex/desired-state.ts:130 — exported function; comment names the hub rule | TRUE |
| Pool login writes `isMain: false` | src/codex/auth-api.ts:2934,2939 — both update and add paths set `isMain: false` | TRUE |
| Paginated guard throws the structured reason | src/codex/history-provider.ts:1172 — `CodexHistoryIntegrityError("history_paginated_requires_native_writer")` on `ordinal` key or `history_mode === "paginated"` | TRUE |
| State DB resolution | src/codex/paths.ts:106-109 — `resolveCodexStateDbPath` joins sqlite root + state_5.sqlite | TRUE |
| `startLoginFlow` location | src/oauth/index.ts:1899 — export begins | TRUE |
| GUI modal state | gui/src/components/CodexAccountPool.tsx:75 (`showAdd`), :94 (`reauthId`), :651-654 (modal mount) | TRUE |

Consequence for implementation cycles: 020's hub-fence resolution stands
as amended — the native-main reauth fence MUST NOT call
`assertNativeMainOwner`; the owner-independent exclusive claim plus
path/hash/inode and recovery/admission rechecks is the whole fence, and
claim/admission failure alone maps to `native_main_unavailable`.
