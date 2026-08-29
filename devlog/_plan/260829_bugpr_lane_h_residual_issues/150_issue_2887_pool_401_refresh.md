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

