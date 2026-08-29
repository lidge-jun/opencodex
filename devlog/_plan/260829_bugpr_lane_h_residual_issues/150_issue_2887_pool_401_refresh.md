# 150 — issue #2887: an ordinary stored Codex pool account is quarantined on its first Responses 401

## What the reporter saw

A stored Codex pool credential with a time-valid access token and a usable refresh
token receives one pre-stream `401` from Responses and is immediately marked
`needsReauth` with its affinity cleared. The refresh endpoint is never called.

## The path, from source

Ordinary stored credentials and native `__main__` are deliberately different auth
context variants:

- ordinary stored: `kind: "pool"`, carrying the stored record's credential
  `generation` — `src/codex/auth-context.ts:645-659`
- native main: `kind: "main-pool"`, with no stored-record generation —
  `src/codex/auth-context.ts:607-642`

There are exactly three kinds — `main`, `pool`, `main-pool` — and every configured
non-main stored account is `pool`, including exact selectors and accounts serving
Daybreak models. There is no separate reserve or WHAM variant, so `pool` is the whole
blast radius.

A time-valid ordinary token never refreshes: `getValidCodexToken()` returns as soon
as `expiresAt > now + 60s` (`src/codex/account-store.ts:402-410`). That is correct on
the happy path and is the reason the `401` arrives holding a token the store still
considers good.

The recovery that should follow is gated on the wrong discriminant. The pre-stream
`401` refresh-and-replay loop admits only `main-pool`
(`src/server/responses/core.ts:3815-3823`), and its helper independently rejects any
other context (`:1747-1760`). The generic OAuth replay cannot pick it up either — that
branch is limited to xAI, GitHub Copilot, and Kiro (`:3020-3024`). `/v1/responses/compact`
carries the identical gate (`src/server/responses/compact.ts:679-686`).

So the `401` falls through to terminal handling, is classified `credential`
(`src/codex/routing.ts:349-367`), and that branch marks reauth and removes every
affinity entry for the account (`:2146-2157`).

`/v1/chat/completions` bridges into `handleResponses`
(`src/server/chat-completions.ts:242`), so fixing core covers it too.

One correction to the report's wording: `needsReauth` is a process-local `Set`
(`src/codex/account-runtime-state.ts:3-10`), not a persisted credential-store field.
The account recovers on restart. That makes the defect less severe than "stored account
corrupted" and no less real — inside a running proxy the account is out of rotation and
its affinity is gone.

## What gets built

The machinery exists; ordinary pool has more of it than main does. Refresh-grant keyed
in-process flights (`src/codex/account-store.ts:288-297`, `:413-439`), a cross-process
file lock with locked re-read (`:448-475`), and generation-CAS persistence (`:521-530`).
The missing piece is an entrypoint that bypasses the freshness shortcut for exactly one
rejected generation.

### 1. A fenced forced-refresh entrypoint — `src/codex/account-store.ts`

Takes `accountId`, the rejected credential generation, the rejected access token, and the
caller's abort signal.

The fence is not a single check at the entrance. Flights are keyed by **refresh-grant
fingerprint**, not by account or generation (`:413`), so a forced caller can join a flight
started by an ordinary refresh, or by another account sharing the grant. The generation
must be re-checked in three places: at entry, in the joined-flight branch before the CAS
write (`:419-439`), and again after the file-lock re-read (`:448-455`). If the stored
generation is no longer the rejected one, someone already replaced the credential — return
what is stored and perform no refresh and no bump.

`findFreshCredentialForGrant()` (`:375-387`) needs one extra condition. It can return
another alias's still-fresh copy of the **same** access token that just got rejected, which
would bump the generation and replay with the identical bearer — a guaranteed second `401`
dressed up as recovery. The rejected token is therefore an explicit input, and a candidate
equal to it does not satisfy a forced refresh.

### 2. Dispatch on both endpoints — `core.ts`, `compact.ts`

Widen the existing `401` branch to `pool` and route it to the new entrypoint. One
request-local replay guard; a second `401` falls through to terminal handling. The replay
reuses the same account — alternate-account selection stays out of the first replay or
fixed-account and pin semantics change.

Core has a hole compact does not: when the main refresh fails it returns the `401`
response immediately without recording an outcome (`core.ts:3830`), whereas compact records
it (`compact.ts:694`). With no second upstream `401` there is nothing to quarantine on, so
an account whose grant is genuinely dead stays selectable and every request repeats the
same doomed refresh. Core must record a **terminal** refresh failure.

### 3. Terminal versus retryable refresh failure

The first draft of this plan asserted `:244-275` already classifies transient refresh
errors. That is wrong: those lines define generation-conflict, lock-timeout, busy, and
stale errors only. A raw network failure or timeout is untyped, and a token-endpoint 5xx
becomes `TokenRefreshError("unknown")` (`:496-506`). Treating "unknown" as terminal
rebuilds this exact bug behind a new door — an upstream blip would quarantine a healthy
account.

Only `revoked` and `expired` are terminal. Everything else — `unknown`, network
failure, abort, `CodexCredentialRefreshBusyError`, `CodexCredentialRefreshStaleError`,
`CodexCredentialRefreshLockTimeoutError`, `CodexCredentialGenerationConflictError` — is
transient: surface an error to the client, quarantine nothing.

### 4. Fence the quarantine — `src/codex/routing.ts`

Add a credential-generation field to `CodexUpstreamOutcomeMeta` and require
`isCodexAccountGenerationLive()` before the `credential` branch quarantines or clears
affinity. This must be a **new** field: the existing `writerGeneration` (`:232`) is the
config-store generation, an unrelated counter.

The field is optional and absent means historical behavior, so the sidecar recorders that
also report raw pool status (`src/providers/openai-sidecar.ts:133`, `src/server/search.ts:165`,
`src/server/images.ts:514`, `src/server/live.ts:657`) keep working exactly as today. Their
lack of a fence is pre-existing and is recorded as residual below, not silently adopted.

### 5. Hand the affinity generation forward — `src/codex/routing.ts`

The first draft claimed affinity survives. It provably does not. An affinity entry stores
the generation it was bound under (`:963-981`) and `isThreadAffinityGenerationLive()`
demands exact equality (`:921-923`). A successful forced refresh CAS-writes generation
`G+1`, so the entry the replay just "preserved" is dead on the very next request, which
deletes it at `:1849-1851`. Not quarantining is not the same as keeping affinity.

The fix is an explicit same-lineage handoff, and the codebase already has the exact test
for "same lineage": a refresh-owned bump preserves `replacedAt` (`account-store.ts:213`)
while an external replacement stamps a fresh one (`:142`).
`settleCodexQuotaRecoveryProbe()` uses precisely that distinction to accept a `+1`
transition (`routing.ts:564-576`). The affinity handoff advances an entry from `G` to
`G+1` under the same conditions: the account matches, the transition is exactly `+1`, and
`replacedAt` is unchanged.

## Verification

Endpoint coverage goes beside the existing main-pool cases in
`tests/responses-native-main-refresh.test.ts:135-161`, whose fixture has no ordinary pool
accounts at all (`:17-31`) — which is why this shipped.

The assertion is the wrong behavior, not a value comparison. A first ordinary-pool `401`
today produces one upstream send, zero token-endpoint calls, a `401` at the client,
`needsReauth` set, and affinity removed.

Named mutations, each of which must turn a specific test red:

1. Restore `authCtx.kind === "main-pool"` on either endpoint → that endpoint's ordinary-pool
   case fails with the signature above.
2. Drop the rejected-token condition from the same-grant reuse path → the replay sends the
   identical bearer and the test sees two `401`s instead of a `200`.
3. Classify `TokenRefreshError("unknown")` as terminal → the transient-failure case
   quarantines a healthy account.
4. Delete the affinity handoff → the **next** request after a successful replay finds a dead
   entry and re-selects, which is why the test must issue a second request rather than
   asserting on the entry at replay time.
5. Remove the generation fence from the `credential` branch → a stale `401` carrying a
   superseded generation quarantines the replacement.

Store-level concurrency goes near `tests/codex-account-store.test.ts:343-424`: a forced
caller joining an **ordinary** flight for the same grant (not merely two forced callers),
a same-grant alias holding the rejected token, and two concurrent forced refreshes
collapsing to one token call and one generation increment.

## Residual, carried knowingly

The sidecar recorders in `openai-sidecar.ts`, `search.ts`, `images.ts`, and `live.ts`
record pool `401`s without a credential-generation fence. That is pre-existing behavior and
unchanged by this work, but a forced refresh makes generation bumps more frequent, so the
window in which a stale sidecar `401` can quarantine a freshly refreshed credential gets
wider. Threading the fence through four more call sites is a separate mechanical change and
does not belong in the same work-phase as the behavioral fix.

Mid-stream SSE `401`s (`core.ts:1304`, `:4155`) are in scope for the fence but never for
replay: once the stream is committed, a transparent retry would duplicate output the client
has already seen.


## Post-implementation review: six defects, all in the fix

An independent source review of the landed commit returned FAIL and reproduced each
finding with its own probe. Five were in code written for this fix; two of those
existed in `getValidCodexToken` before it and the forced path made them reachable.

**A joined flight could copy a sibling account's credential.** Flights are keyed by
refresh grant and shared by every account holding it. If the owner's own credential is
externally replaced while it waits for the file lock, the grant-mismatch branch returns
that replacement — and a joiner, checking only its own current grant, would CAS-write
another account's access *and* refresh tokens onto itself. Flight results now carry
`resolvedGrantFingerprint`, tagged with the grant the flight was **opened** for rather
than the rotated one it produced. Tagging the rotated grant instead broke the existing
`same refresh grant joins a live flight` test, which is what caught the distinction.

**The lineage check was tautological.** Both callers read `replacedAt` after the refresh
and passed it to a function that re-read the same record, so the comparison could not
fail — an external replacement passed it and inherited the rejected credential's
affinity, the exact case the handoff claimed to refuse. Lineage is now proven by the
call that performed the CAS: the store reports `selfRefreshed`, and the handoff only
runs when that is true. The `replacedAt` parameter is gone.

**A same-bearer refresh neither recovered nor quarantined.** Upstream can rotate only
the refresh grant and return the same access token. The store commits `G+1` regardless,
so quarantining against `G` was silently suppressed by the new fence — the account was
neither replayed nor retired, and the next request repeated the refresh. The refresh
result now reports the generation the credential actually sits at, and both endpoints
fence on that value.

**An ordinary joiner could bump the generation twice.** With the refresh grant retained,
an ordinary same-account caller joins the forced caller's flight and CAS-writes the
identical credential, moving `G+1` to `G+2` and killing the handoff the owner just
performed. A joiner whose stored credential already equals the flight result now adopts
the stored state instead of rewriting it.

**The fence covered only two synthetic call sites.** Mid-stream SSE terminals, a
replay's own second 401, and compact's ordinary recorder were all unfenced, so a stale
401 could still retire a replacement — which contradicted what the commit message
claimed. All three now pass `credentialGeneration` for a `pool` context.

**Bare `invalid_grant` was classified transient.** The parser only looked for
`revoked`, `invalidated`, or `expired` in the description; upstream sends
`invalid_grant` with no description at all, so a genuinely dead grant read as
`unknown` and every request retried it forever.

### One guard without an isolated regression

The `resolvedGrantFingerprint` provenance check has no test that fails when only it is
removed: the adopt-stored branch intercepts the same scenario first, and both must be
removed together before the cross-account overwrite reappears. It is kept as
defence-in-depth rather than dropped, because the two guards answer different questions
— one asks whether the credential is the one already stored, the other whether it
belongs to this grant at all — and a future change to either branch would remove the
overlap. This is recorded rather than presented as proven.


## Second review round: both residuals closed

**`invalid_grant` matched too loosely.** The first fix searched the combined
code-plus-description text, so a transient `server_error` whose description merely
mentioned the phrase was classified `revoked` and retired a healthy account — the
same failure mode this whole change exists to remove, reintroduced through the fix
for it. The match is now on the exact OAuth `error` code, with descriptive text
classified separately.

**The cross-account test did not reach the branch it claimed to test.** It replaced
the owner's credential from inside `fetch`, which runs after the lock body has
already compared grants, so the alias-reuse and CAS paths handled the scenario and
the test passed with the provenance check removed. It now holds the shared grant's
file lock directly, replaces the owner's credential while its flight is parked in the
lock wait, then releases — so the lock body observes a different grant and returns
that replacement, which is the branch under test. The assertions are positive as well
as negative: the owner's replacement must survive intact.

With that, the provenance guard has the isolated regression it previously lacked.
Removing `resolvedGrantFingerprint === refreshGrantFingerprint` on its own now fails
with the joiner holding `owner-secret` — a real cross-account credential leak, not an
inferred one.

