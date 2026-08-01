# 50 - Phase 5: drvfs error-misclassification hardening

Priority: P2. Addresses root cause #4 in `00_plan.md`. This is the lowest
ranked cause and the `/mnt/c` lock unreliability is UNCONFIRMED by Microsoft
docs (only permission/metadata differences are PROVEN). Treat this phase as
defense-in-depth gated behind real local diagnostics, NOT as the fix that makes
auto-switch work. Phases 10/20 are the actual unblockers.

## The risk (confirmed in code)

`shouldMarkAccountNeedsReauthForCodexAuthFailure` treats exactly two error
classes as transient and everything else as "credential is dead":

- src/codex-auth-context.ts:69 returns `true` (mark needs-reauth) unless the
  cause is `CodexCredentialGenerationConflictError` or
  `CodexCredentialRefreshLockTimeoutError`.
- src/codex-auth-context.ts:99 catches any throw from `getValidCodexToken`, and
  src/codex-auth-context.ts:100 calls `markAccountNeedsReauth(accountId)` on it.

`markAccountNeedsReauth` just adds the id to an in-memory `Set`
(src/codex-account-runtime-state.ts:1, src/codex-account-runtime-state.ts:3).
That set is read by `isCodexAccountUsable` (src/codex-account-usability.ts:13
returns `false` when the id is in the set), and `getEligiblePoolAccounts`
filters on both `isAccountNeedsReauth` and `isCodexAccountUsable`
(src/codex-routing.ts:209, src/codex-routing.ts:211). There is no disk
persistence and no timed expiry, so the only exits are `clearAccountNeedsReauth`
or a process restart.

Now follow a raw filesystem failure through the refresh path:

- The refresh lock is acquired with `openSync(path, "wx", 0o600)`
  (src/codex-account-store.ts:234). The only error code it tolerates is
  `EEXIST` (src/codex-account-store.ts:238); any other code (`EPERM`, `EBUSY`,
  `EACCES`, `ENOTSUP`, `EROFS`) is rethrown raw.
- Stale-lock cleanup `unlinkSync(path)` only tolerates `ENOENT`
  (src/codex-account-store.ts:243); other codes rethrow raw, as does the
  `finally` unlink (src/codex-account-store.ts:257).
- After a successful network refresh the new credential is written via
  `saveCodexAccountCredentialIfGeneration` -> `atomicWriteFile`
  (src/codex-account-store.ts:379, src/codex-account-store.ts:98), which does
  `writeFileSync(tmp)` then `renameSync(tmp, path)` (src/config.ts:14,
  src/config.ts:16). A cross-filesystem or drvfs `renameSync` failure
  (`EXDEV`, `EPERM`, `EBUSY`) throws raw.
- The OAuth store persists the same way: `persist` -> `atomicWriteFile`
  (src/oauth/store.ts:33), reachable on the read-only/main token write path.

None of these raw `fs` errors are `CodexCredentialGenerationConflictError` or
`CodexCredentialRefreshLockTimeoutError`, so each one falls through
src/codex-auth-context.ts:70 to `true` and evicts the account. A transient
drvfs hiccup on `/mnt/c` thus reads as a revoked credential and silently drops a
pool account from rotation until restart.

`getConfigDir()` resolves to `OPENCODEX_HOME` or `~/.opencodex`
(src/config.ts:148, via `resolveConfigDir` src/config.ts:21). If a WSL user
points `OPENCODEX_HOME` under `/mnt/c`, every lock and atomic write above runs
on drvfs.

## Design

Two independent changes; (a) is the real fix, (b) is a diagnostic guard.

### (a) Classify raw IO/fs errors as transient

Goal: a raw `fs` error during refresh must NOT mark needs-reauth. Let the
request fail this once and retry on the next route; the credential is fine.

Recommended approach: wrap fs failures in a typed transient error at the throw
sites, then widen the classifier to recognize it. This keeps the "transient"
decision in one place and avoids string-sniffing error codes in the auth layer.

- NEW error class in src/codex-account-store.ts near the existing error classes
  (src/codex-account-store.ts:183, src/codex-account-store.ts:190):
  `CodexCredentialIoError extends Error` carrying the original `code` and
  `cause`.
- In `withCodexRefreshFileLock` (src/codex-account-store.ts:224): when
  `openSync`/`unlinkSync`/`writeFileSync` throws a non-`EEXIST` / non-`ENOENT`
  fs error, rethrow as `new CodexCredentialIoError(code, { cause })` instead of
  the raw error (src/codex-account-store.ts:238, src/codex-account-store.ts:243,
  src/codex-account-store.ts:257). Identify fs errors via the existing `errCode`
  helper (src/codex-account-store.ts:210) returning a string code.
- Wrap the credential-persist failure path so a throw from `atomicWriteFile`
  during refresh (src/codex-account-store.ts:379) surfaces as
  `CodexCredentialIoError`, not a raw `EXDEV`/`EPERM`.
- Widen `shouldMarkAccountNeedsReauthForCodexAuthFailure`
  (src/codex-auth-context.ts:69) to also return `false` for
  `CodexCredentialIoError`.

Alternative (smaller, considered, not recommended): skip the new error type and
have the classifier sniff `cause && typeof cause.code === "string"` for a known
set of transient fs codes. Rejected because it leaks fs-error knowledge into the
auth layer and would also swallow genuinely fatal IO problems with no single
owner for the policy.

Either way: do NOT broaden so far that a `TokenRefreshError` with
`reason: "revoked"`/`"expired"` (src/codex-account-store.ts:369) stops marking
reauth. Revoked/expired must still evict; only raw IO is reclassified.

### (b) Startup warning when the state dir is on drvfs (decision D3)

At startup, resolve `getConfigDir()` and, on Linux, check whether the real path
begins with `/mnt/` (drvfs mount root). If so, emit one diagnostic line.

Recommendation for D3: warn-only, no refusal. The `/mnt/c` lock unreliability is
UNCONFIRMED, so a hard refusal would block legitimate setups on an unproven
risk. Provide the escape hatch the other direction: keep the warning unless
`OPENCODEX_ALLOW_DRVFS=1` is set, which silences it for users who have
intentionally chosen that layout. This matches the plan's "gate behind local
diagnostics" guidance and the `OPENCODEX_*` env convention already used by
`OPENCODEX_HOME`.

Warning copy (single line, ASCII): state dir is on a Windows drive mount
(`/mnt/...`); file locks and atomic renames may behave unexpectedly; prefer a
native Linux path such as `~/.opencodex`; set `OPENCODEX_ALLOW_DRVFS=1` to
silence.

## Diff-level plan

MODIFY src/codex-account-store.ts
- Add and export `CodexCredentialIoError`.
- Rethrow non-tolerated fs errors in `withCodexRefreshFileLock` as
  `CodexCredentialIoError` (lock acquire, stale unlink, finally unlink).
- Wrap the persist throw in the refresh body as `CodexCredentialIoError`.

MODIFY src/codex-auth-context.ts
- Import `CodexCredentialIoError` and add it to the transient set in
  `shouldMarkAccountNeedsReauthForCodexAuthFailure` (src/codex-auth-context.ts:69).

NEW startup guard (place with existing boot diagnostics; likely src/config.ts or
the server bootstrap that already calls `hardenConfigDir`)
- Best-effort drvfs detection + warn, gated by `OPENCODEX_ALLOW_DRVFS`.

NEW tests/codex-drvfs-hardening.test.ts (or extend an existing codex-account
test file if one already owns this surface).

## Test plan

- Refresh fs throw stays in pool: stub the lock acquire so `openSync` throws an
  `EPERM`-coded error, drive `resolveCodexAuthContext` for a pool account, and
  assert `isAccountNeedsReauth(accountId)` is `false` and the account still
  appears in `getEligiblePoolAccounts`. The request still throws
  `CodexAuthContextError`, but the account is NOT evicted.
- Persist fs throw stays in pool: make `atomicWriteFile`/`renameSync` throw
  `EXDEV` during `saveCodexAccountCredentialIfGeneration` after a mocked
  successful token fetch; assert no needs-reauth marking.
- Revoked still evicts (regression guard): a `TokenRefreshError("revoked", ...)`
  must still set needs-reauth, proving the widening did not over-reach.
- Lock-timeout still transient: `CodexCredentialRefreshLockTimeoutError`
  continues to return `false` from the classifier (existing behavior).
- drvfs warn: with config dir mocked under `/mnt/c`, startup emits the warning;
  with `OPENCODEX_ALLOW_DRVFS=1`, it does not. A non-`/mnt` path: no warning.

## Risks

- Over-widening could hide a genuinely fatal local fs problem (disk full,
  permissions) behind silent per-request failures with no reauth signal.
  Mitigate by reclassifying only fs-coded errors, still logging them, and
  keeping `revoked`/`expired` on the eviction path.
- A persistently broken state dir now retries forever instead of evicting once.
  Acceptable: the account is genuinely usable once the fs heals, and the
  per-request failure plus the drvfs warning are the surfaced signal.

## Non-goals

- Do not move the lock implementation off `openSync(wx)` or invent an
  advisory-lock scheme; the O_EXCL unreliability is unproven.
- Do not persist the needs-reauth set or add TTL expiry; separate design.
- Do not change networking, quota priming, or thread affinity (phases 20/30/40).
- Do not auto-relocate or refuse a `/mnt/c` state dir; warn-only per D3.

## Build record

(to be filled when the phase lands: files changed, verification commands,
commit.)
