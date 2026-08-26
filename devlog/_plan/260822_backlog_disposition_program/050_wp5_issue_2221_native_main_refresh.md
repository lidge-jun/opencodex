# WP5 — Reimplement #2221: native main pool auth.json token refresh (disposes #2222)

> Source: read-only research lane `res-2221` (model `openrouter/stealth-ox-alpha`), dispatched at work-phase 0 against `dev@ced9a85c5`.
> Every file:line pointer below was independently spot-checked by the main agent before the roadmap was locked; verification notes are appended at the end of this document.

All evidence gathered from HEAD `ced9a85c5` plus the full PR #2222 diff and issue triage. Report below.

---

# Implementation Doc — Issue #2221 (native `__main__` auth.json token refresh)

## 1. ROOT CAUSE

Verified chain at `ced9a85c5`:

1. [src/codex/main-account.ts:34](/Users/jun/Developer/new/700_projects/opencodex/src/codex/main-account.ts:34) — `getMainAccountToken()` is read-only:
   ```ts
   /** Read-only main account token from ~/.codex/auth.json, or null when not logged in. */
   export function getMainAccountToken(): ... {
     const tokens = readCodexTokens();
     if (!tokens?.access_token) return null;
   ```
   It never reads `refresh_token` (`readCodexTokensResult()` at [src/codex/auth-collision.ts:44-58](/Users/jun/Developer/new/700_projects/opencodex/src/codex/auth-collision.ts:44) only parses `access_token/account_id/id_token`) and never calls the token endpoint.

2. [src/codex/auth-context.ts:515-517](/Users/jun/Developer/new/700_projects/opencodex/src/codex/auth-context.ts:515) — when routing selects `__main__` into rotation:
   ```ts
   if (accountId === MAIN_CODEX_ACCOUNT_ID) {
     // Main account in rotation: inject the read-only auth.json token and fail closed if it vanished.
     const token = (options.getMainAccountToken ?? getMainAccountToken)();
   ```
   The expired bearer is injected into `kind: "main-pool"` (line 534) and sent upstream → 401.

3. Contrast: the stored-pool path at [src/codex/auth-context.ts:548](/Users/jun/Developer/new/700_projects/opencodex/src/codex/auth-context.ts:548) calls `getValidCodexToken(accountId)`, which refreshes under the shared grant file-lock in [src/codex/account-store.ts:446-530](/Users/jun/Developer/new/700_projects/opencodex/src/codex/account-store.ts:446) (lock acquisition, same-grant adoption, POST to `CHATGPT_TOKEN_URL`, generation-CAS save).

4. Usability gate enforces the gap: [src/codex/account-usability.ts:36-37](/Users/jun/Developer/new/700_projects/opencodex/src/codex/account-usability.ts:36) —
   ```ts
   // Main account: credential is the read-only ~/.codex/auth.json token (Option A).
   return (options.isMainAccountTokenLive ?? isMainAccountTokenLive)();
   ```
   `isMainAccountTokenLive` ([main-account.ts:45-51](/Users/jun/Developer/new/700_projects/opencodex/src/codex/main-account.ts:45)) returns false once JWT `exp < now`, so an expired-but-refreshable main account becomes unroutable while pool accounts keep working.

5. No reactive path either: neither `/v1/responses` ([src/server/responses/core.ts:3173-3177](/Users/jun/Developer/new/700_projects/opencodex/src/server/responses/core.ts:3173) has only the xai/copilot/kiro OAuth replay) nor `/v1/responses/compact` ([src/server/responses/compact.ts:385](/Users/jun/Developer/new/700_projects/opencodex/src/server/responses/compact.ts:385) calls sync `materializeCodexUpstreamAuth`, defined sync at [auth-context.ts:619](/Users/jun/Developer/new/700_projects/opencodex/src/codex/auth-context.ts:619)) has any native-main 401 refresh/replay branch. The triage comment's pointers are all accurate against this head.

## 2. VERDICT ON PR #2222

**Approach: architecturally correct. Reuse: not directly — clean reimplementation on current `dev` is better.**

What the PR gets right (matches the issue contract):

- Pre-request refresh via new `getValidMainAccountToken()` / `forceRefreshMainAccountToken()` in `src/codex/main-account.ts`.
- Shares the pool's existing grant file-lock (`withCodexRefreshFileLock`) keyed by refresh-grant fingerprint — no second lock system.
- Exactly-one 401 replay for Responses (both pre-stream and continuation loops in `core.ts`, `codexMain401ReplayAttempted`) and pre-I/O refresh for compact via async materialization.
- Fail-closed persistence through `atomicWriteFile`, preserving unrelated `auth.json` fields.
- Cross-domain convergence: native-first refresh publishes to same-grant pool rows (`publishFreshCredentialForGrant`), stored-first refresh adopts into `auth.json`.

Why it must be redone rather than rebased:

1. **Stale against dev.** Its `account-store.ts` hunks add the `expires_in` finite/negative guards that are *already merged* on current dev ([account-store.ts:508-520](/Users/jun/Developer/new/700_projects/opencodex/src/codex/account-store.ts:508)); GitHub reports `mergeable: CONFLICTING`. Large portions of the diff no longer apply.
2. **Semantic change smuggled in:** `saveCodexAccountCredentialIfGeneration` is rewritten so `refreshGrantFingerprint` never rotates when the refresh token rotates (“logical grant” model). This changes pool-wide invariant behavior and invalidates an existing test expectation (`tests/codex-account-store.test.ts:232` currently asserts the opposite). That deserves its own reviewed decision, not a rider on a bugfix.
3. **Lock machinery rewrite** (reclaim lock, PID liveness, abandon set, quarantine) is ~200 lines of new concurrency code attached to a bugfix; the owner review already flagged stale reclaim-lock handling. This is separable.
4. Maintainer findings stand: missing compact replay at that head was fixed later in the PR, but unsafe test-home isolation (env-var mutation of `CODEX_HOME` without process isolation) remains, plus unrelated `LEARNED_LESSONS.md`.
5. Auth surface ⇒ exact-head maintainer security review regardless; a fresh minimal diff reviews far faster than a 2k-line conflicting one.

## 3. FILE CHANGE MAP (recommended clean implementation)

Reuse PR #2222's *shapes*, re-derived against current dev:

| File | Action | Symbols |
|---|---|---|
| `src/oauth/chatgpt.ts` | MODIFY | Export `CHATGPT_CLIENT_ID`, `CHATGPT_TOKEN_URL`; add exported `ChatGPTTokenResponse` + `refreshChatGPTTokenRaw(rt, {signal})` returning `{access, refresh, expires, accountId, idToken}`; refactor existing `refreshChatGPTToken` to wrap it |
| `src/codex/auth-collision.ts` | MODIFY | Add optional `refresh_token?: string` to `CodexTokens` and parse it in `readCodexTokensResult()` |
| `src/codex/main-account.ts` | MODIFY (core) | Add `mainAccessTokenFresh()`, `isMainAccountCredentialUsable()`, `getValidMainAccountToken({dependencies})`, `forceRefreshMainAccountToken(rejectedAccessToken?, {signal, dependencies})`, `NativeMainRefreshDependencies` |
| `src/codex/account-store.ts` | MODIFY (minimal) | Export `CODEX_REFRESH_SKEW_MS` alias of `REFRESH_SKEW_MS`; export `withCodexRefreshFileLock(lockKey, signal, fn)` (keep the *current* signature — do NOT port the reclaim-lock rewrite); export `findFreshCredentialForGrant` and a narrow `publishFreshCredentialForGrant` |
| `src/codex/account-usability.ts` | MODIFY | Line 37: `(options.isMainAccountTokenLive ?? isMainAccountCredentialUsable)()` + comment update |
| `src/codex/auth-context.ts` | MODIFY | Main branch (~line 515): await `getValidMainAccountToken` behind test seams (`getValidMainAccountToken`, `nativeMainRefreshDependencies` options); release probe leases in the catch like the pool branch below; add `materializeCodexUpstreamAuthAsync()` mirroring `materializeCodexUpstreamAuth` (line 619) but awaiting the refreshed main credential for `kind:"main"` substitution |
| `src/server/responses/core.ts` | MODIFY | Thread `nativeMainRefreshDependencies` through `HandleResponsesOptions`; use async materialization in `resolveResponsesCodexAuth` (~line 1494 area); add `codexMain401ReplayAttempted` + one-replay branches in both recovery loops (next to `oauth401ReplayAttempted` at lines 3096/4501), guarded by `status===401 && authCtx.kind==="main-pool" && usesCodexForwardPoolAuth(...)`; add `nativeMainRefreshFailureResponse()` (401 revoked/expired, 503 transient) |
| `src/server/responses/compact.ts` | MODIFY | Use `materializeCodexUpstreamAuthAsync` at line 385; map refresh errors before other catch arms; pass deps to `handleResponses` for the internal call |

Core new function (literal target shape, adapted from PR #2222 minus the lock rewrite):

```ts
// src/codex/main-account.ts (new exports)
export async function forceRefreshMainAccountToken(
  rejectedAccessToken?: string,
  options: { signal?: AbortSignal; dependencies?: NativeMainRefreshDependencies } = {},
): Promise<{ accessToken: string; chatgptAccountId: string } | null> {
  const initial = mainTokenFromAuthJson();          // parses tokens incl. refresh_token
  if (!initial?.refreshToken) return null;
  const fp = initial.refreshGrantFingerprint ?? refreshGrantFingerprintForToken(initial.refreshToken);
  const signal = AbortSignal.any([options.signal ?? AbortSignal.never(), AbortSignal.timeout(30_000)]);
  try {
    return await withCodexRefreshFileLock(fp, signal, async () => {
      const locked = mainTokenFromAuthJson();
      if (!locked?.refreshToken) return null;
      if (rejectedAccessToken && locked.accessToken !== rejectedAccessToken
          && mainAccessTokenFresh(locked.accessToken)) {
        return { accessToken: locked.accessToken, chatgptAccountId: locked.chatgptAccountId };
      }
      const stored = findFreshCredentialForGrant(fp, MAIN_CODEX_ACCOUNT_ID);
      if (stored && (!rejectedAccessToken || stored.accessToken !== rejectedAccessToken)) {
        persistMainAuthJsonWith(stored);            // atomicWriteFile, preserve other fields
        return { accessToken: stored.accessToken, chatgptAccountId: stored.chatgptAccountId };
      }
      const t = await (options.dependencies?.refreshToken ?? refreshChatGPTTokenRaw)(locked.refreshToken, { signal });
      const cred = { accessToken: t.access, refreshToken: t.refresh || locked.refreshToken,
                     expiresAt: t.expires, chatgptAccountId: t.accountId ?? locked.chatgptAccountId };
      persistMainAuthJsonWith(cred);
      publishFreshCredentialForGrant({ refreshGrantFingerprint: fp, credential: cred,
                                       excludeId: MAIN_CODEX_ACCOUNT_ID });
      clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
      return { accessToken: cred.accessToken, chatgptAccountId: cred.chatgptAccountId };
    });
  } catch (error) {
    const reason = tokenRefreshReason(error);       // "expired"|"revoked"|"unknown"
    if (reason !== "unknown") markAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    throw error instanceof TokenRefreshError ? error : new TokenRefreshError(reason, "Codex main token refresh failed; reauthenticate the main account.");
  }
}

export async function getValidMainAccountToken(
  options: { dependencies?: NativeMainRefreshDependencies } = {},
) {
  const t = mainTokenFromAuthJson();
  if (!t) return null;
  if (mainAccessTokenFresh(t.accessToken)) {
    return { accessToken: t.accessToken, chatgptAccountId: t.chatgptAccountId };
  }
  return forceRefreshMainAccountToken(t.accessToken, options);
}
```

Deliberately dropped from PR #2222: the reclaim-lock/PID-liveness/quarantine rewrite of `withCodexRefreshFileLock` (keep current dev implementation), the `refreshGrantFingerprint` non-rotation change in `saveCodexAccountCredentialIfGeneration`, and `LEARNED_LESSONS.md`. Note: dropping the fingerprint-stability change means native→pool publication uses the *current* fingerprint-at-refresh-time semantics; verify `refreshGrantFingerprintForToken(rotated)` still matches pool records written by the same refresh flow (it does today because pool saves store the fingerprint of the credential they saved — confirm with the cross-domain test in §5).

## 4. TEST PLAN

New files, adapted from PR #2222 but with proper isolation (spawn-per-test or explicit config-dir seam instead of mutating global `CODEX_HOME`; check how existing tests isolate home — e.g. search `tests/codex-auth-context.test.ts` for the established seam and follow it):

- `tests/codex-main-account-refresh.test.ts`
  - `"keeps an expired credential selectable when its refresh grant is valid"` → `isMainAccountCredentialUsable() === true` with expired access + valid refresh (fails before fix: false).
  - `"persists rotated fields atomically preserving unrelated auth fields"`.
  - `"marks terminal revoked grants for reauthentication"`.
  - `"serializes native refresh behind the shared grant lock"` (hold lock externally, assert zero fetch calls and timeout rejection).
  - `"publishes native-first refreshes to stored accounts sharing the grant"` and `"adopts stored-first refreshes into native auth without another refresh"` — these two are the external-writer/CAS-convergence contract tests.
- `tests/responses-native-main-refresh.test.ts` — `"replays one native-main 401 with the refreshed bearer"`: local `Bun.serve` returns 401 then 200; assert `observedBearers === [stale, fresh]` (fails before fix: single stale bearer, 401 response).
- `tests/responses-compact-native-main-refresh.test.ts` — `"substitutes a refreshed native credential before compact upstream I/O"`: assert exactly one observed bearer equal to the fresh token (fails before fix: stale bearer).

## 5. VERIFIER COMMAND

```
bun test tests/codex-main-account-refresh.test.ts tests/responses-native-main-refresh.test.ts tests/responses-compact-native-main-refresh.test.ts tests/codex-account-store.test.ts tests/codex-auth-context.test.ts
```

Yes — all five suites import the changed modules directly (`main-account.ts`, `account-store.ts`, `auth-context.ts`, `core.ts`, `compact.ts`). Before review-ready status also run `bun run typecheck` and `bun run test` (auth/account surface ⇒ full suite per AGENTS.md).

## 6. ACTIVATION SCENARIO

A test writes `$CODEX_HOME/auth.json` containing an access JWT whose `exp` is in the past plus a valid `refresh_token`, with zero pool accounts, and routes through `handleResponses`/`handleResponsesCompact` with an injected `nativeMainRefreshDependencies.refreshToken` stub. Observable proof the new conditional ran: (a) the upstream stub receives `Bearer <fresh>` where `<fresh>` is only produced by the stubbed refresh endpoint, (b) `auth.json` on disk now contains the rotated `access_token`/`refresh_token`, (c) exactly one 401 is observed by the stub followed by success (Responses path), and (d) `isAccountNeedsReauth("__main__")` stays false on success and flips true when the stub throws `TokenRefreshError("revoked", …)`.

## 7. RISK / BLOCKERS

- **Writing `~/.codex/auth.json` races the Codex CLI.** Mitigation: refresh read + write inside the shared grant file-lock, atomic write, preserve unknown fields. A true multi-writer CAS (mtime/content compare before rename) beyond lock scope was demanded by the owner review; the lock covers same-machine ocx processes but not Codex CLI writers that ignore our lock. Flag this residual risk in the PR description.
- **Fingerprint semantics:** publishing native refreshes into pool rows requires stable same-grant identification across refresh-token rotation. PR #2222 solved this by freezing fingerprints; if we drop that change, the cross-domain tests above are the guard — if they fail, the fingerprint-freeze decision must be made explicitly (separate small PR) before this lands.
- **Do not port the reclaim-lock rewrite** in this change; current dev lock is adequate and battle-tested.
- Test-home isolation must use the repo's established seam, not raw `process.env.CODEX_HOME` mutation (hygiene finding against #2222 stands).
- None of this is implementable without touching auth-surface files ⇒ exact-head maintainer security review is mandatory before merge (per MAINTAINERS.md policy referenced in AGENTS.md).


---

# AMENDMENT (A-phase round 1, blockers B4+B5)

**B4 — external-writer CAS is acceptance, not a PR note.** The body proposes flagging the
Codex-CLI-writer race "in the PR description". That is not acceptable for a credential
file another product writes concurrently: our grant lock coordinates ocx processes only,
and an atomic rename still clobbers a newer token written between our read and our
publish. Promoted into WP5 acceptance criteria:

1. Capture file identity (`dev`, `ino`, `mtime`, `size`) **and** a content hash of
   `auth.json` at read time.
2. Immediately before publication, re-stat and re-hash. On any change: re-read, and
   either adopt the newer credential (if it is fresh) or refuse — never blind-overwrite.
3. Regression: mutate `auth.json` between refresh and publish, and assert the newer
   writer's token survives and is the one subsequently used.

**B5 — verifier existence gates.** Each mandatory new suite runs as its own invocation:

```bash
test -f tests/codex-main-account-refresh.test.ts || exit 1
bun test tests/codex-main-account-refresh.test.ts
test -f tests/responses-native-main-refresh.test.ts || exit 1
bun test tests/responses-native-main-refresh.test.ts
test -f tests/responses-compact-native-main-refresh.test.ts || exit 1
bun test tests/responses-compact-native-main-refresh.test.ts
bun test tests/codex-account-store.test.ts
bun test tests/codex-auth-context.test.ts
```

Evidence that the combined form was false-green at plan time:

```
$ bun test tests/codex-main-account-refresh.test.ts tests/codex-account-store.test.ts
 26 pass / 0 fail    RC=0        # first file does not exist
```

**Security review gate.** This work-phase touches credential handling, so it is subject to
exact-head maintainer security review per AGENTS.md and MAINTAINERS.md. It does not merge
on this unit's verification alone.


---

# AMENDMENT 2 (WP5 A-gate, security audit) — AUTHORITATIVE over everything above

An independent security audit of this plan returned **GO-WITH-FIXES with 4 High
blockers**, every one re-verified by the main agent against `dev@e1d197565`. Two of
them are **plan decisions that must be made before any code is written**, which is why
this work-phase does not proceed to implementation on the strength of the earlier
amendment alone.

## B1 (High) — the body's code sample still blind-writes `auth.json`

Amendment 1 promoted external-writer CAS into acceptance criteria, but it left the
sample in the body intact:

```ts
const t = await refreshChatGPTTokenRaw(locked.refreshToken, { signal });
persistMainAuthJsonWith(cred);              // <- no re-check
publishFreshCredentialForGrant({ ... });    // <- pool published from the same result
```

An implementer copies the sample, not the acceptance list. The sample must be rewritten
in place to: capture identity (`dev`/`ino`/`mtime`/`size`) **and** a content hash at
read; re-stat and re-hash **immediately before the rename**, not merely after the HTTP
round trip; on mismatch **discard the freshly-fetched grant** and either adopt the disk
token if it is fresh or refuse; and persist `auth.json` **before** any pool publish.

PR #2222 published to the pool first, which the owner already rejected.

**Residual, to be named in the PR rather than hidden:** after a true pre-rename
re-check there is still a microsecond window where the Codex CLI can rename between our
check and our rename. There is no userspace CAS against a writer that ignores our lock.
That residual is acceptable; the multi-second IdP-round-trip window is not.

## B2 (High) — dropping the fingerprint freeze breaks pool-first adoption

This is a real fork in the plan, not a test-gated maybe. Verified on `dev`:

```ts
// src/codex/account-store.ts:206
const refreshGrantFingerprint = current.credential.refreshToken === cred.refreshToken
  ? current.refreshGrantFingerprint ?? refreshGrantFingerprintForToken(cred.refreshToken)
  : refreshGrantFingerprintForToken(cred.refreshToken);   // rotates
```

pinned by `tests/codex-account-store.test.ts:257`.

- **Native-first still works.** Look up pool rows by the old fingerprint, write, and let
  the save path stamp `hash(newRT)`.
- **Pool-first does not.** After the pool rotates `RT1`→`RT2`, its row is
  `hash(RT2)` while `auth.json` still holds `RT1`; native
  `findFreshCredentialForGrant(hash(RT1))` misses and then POSTs a possibly-invalidated
  `RT1`.

#2222 solved this by freezing the fingerprint across rotation — a pool-wide invariant
change that contradicts a currently-passing test, which is exactly why this plan dropped
it. **Three honest options, and one must be chosen before building:** (a) land the
freeze as its own reviewed PR first, (b) define a non-fingerprint same-grant lookup and
state what happens on a ChatGPT-account-id collision, or (c) drop pool-first adoption
from WP5's scope. "Decide if the tests fail" is not an A-gate.

## B3 (High) — compact needs its own 401 replay

The plan gives compact a pre-I/O refresh only. `src/server/responses/compact.ts`
alternates on 429/402 and has no 401 replay, so a grant rotated by the CLI between our
refresh and the request fails compact while Responses recovers. The issue contract asks
for exactly one replay on **both**.

## B4 (High) — a refresh-only `auth.json` is still unusable

`readCodexTokensResult` treats a missing `access_token` as invalid
(`src/codex/auth-collision.ts:47`), and `getMainAccountToken` returns null on it. A file
holding a valid `refresh_token` with an empty or absent `access_token` is exactly the
state this feature should recover from. Usability must be "a non-empty refresh token OR
a live access JWT", and the refresh entrypoint must not require a prior access token.

## Two Mediums, both accepted

**Do not put `refresh_token` on the shared `CodexTokens` type.** `readCodexTokens` is
called from `auth-api.ts` and `doctor.ts`; widening the shared DTO spreads the secret to
callers that are not refresh surfaces. This is the same shape as the #2351 defect where a
secret rode along on a subtree nobody redacted. Parse the refresh token privately inside
`main-account.ts`. Equally: **do not write `refresh_grant_fingerprint` into
`auth.json`** — that is an ocx-private field in a file the Codex CLI owns. Preserve
unknown fields; add none.

**The test-isolation guidance in Amendment 1 was over-corrected.** The repo's seam
genuinely is `CODEX_HOME` mutation, via `tests/helpers/isolated-codex-home.ts`; #2222's
defect was mutating it *without* isolation, not the mutation itself. Mandate
`installIsolatedCodexHome` **plus** `OPENCODEX_HOME`, not spawn-per-test.

This one matters more than it looks: `src/lib/test-home-guard.ts:61` protects only
`~/.opencodex`. **`~/.codex` is unguarded**, and WP5 would be the first code in this
repository that writes `auth.json` at all. A persist test that skips isolation
overwrites the developer's real Codex credentials.

## Disposition of this work-phase

WP5 is **NOT implemented in this cycle**. B2 requires a maintainer decision about a
pool-wide invariant (freeze the fingerprint, or restructure same-grant lookup, or narrow
the scope), and that decision changes the shape of the diff rather than one of its
lines. Building first and asking afterwards would produce exactly the kind of PR this
program has been rejecting in other people's work.

The rest of the plan is sound and now carries the corrections above, so the next cycle
can implement directly once the fork is settled.

