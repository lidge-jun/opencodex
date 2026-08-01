# Codex auth warmup + freshness refresh follow-up — PLAN

Date: 2026-07-05
Status: IMPLEMENTED
Work class: C4-lite (auth/session validation, refresh-token lifecycle, multi-account pool safety)
Branch context: `codex/gpt-56-sol-terra-luna-rollout`

## Request

After the previous token-refresh patch, most Codex pool accounts still became unusable except one.
The working hypothesis from the live incident is:

> After OAuth login/import, opencodex records the token but does not actually send a small Codex
> `/responses` request. Accounts that are logged in and then left idle never get their Codex backend
> session validated/warmed, while the one account that receives real traffic survives.

This plan is a follow-up to `devlog/_fin/260703_oauth-multi-account-refresh-and-tos/00_plan.md`.
That patch added a Token Guardian, but its actual Codex pool sweep is still access-token-expiry
based, not Codex `last_refresh` / real backend-use based.

## Current evidence

### opencodex behavior

- Login completion checks `https://chatgpt.com/backend-api/wham/usage`, not Codex `/responses`:
  `src/codex-auth-api.ts:557`.
- Login then immediately persists the pool account credential:
  `src/codex-auth-api.ts:578`.
- Pool quota refresh also checks `/wham/usage`, so it can report quota without proving the
  `/backend-api/codex/responses` path works: `src/codex-auth-api.ts:238`.
- `getValidCodexToken()` returns the existing token whenever `expiresAt` is still outside the
  local skew window: `src/codex-account-store.ts:285`.
- Token Guardian skips Codex pool accounts whose `expiresAt` is beyond its horizon:
  `src/oauth/token-guardian.ts:143`.
- The ChatGPT forward adapter's actual Codex request path is `${baseUrl}/responses`; for ChatGPT
  that means `https://chatgpt.com/backend-api/codex/responses`:
  `src/adapters/openai-responses.ts:89`.

### External/reference behavior

- OpenAI Codex CI/CD auth docs describe Codex-managed auth as refreshing based on `last_refresh`
  age, writing the refreshed auth cache back, and using a real Codex run such as a one-word OK
  reply to keep auth fresh:
  <https://developers.openai.com/codex/auth/ci-cd-auth>.
- `Soju06/codex-lb` has a quota warmup path that defaults to `gpt-5.4-mini` and sends an actual
  streamed `/codex/responses` probe. Local inspection points:
  `/tmp/codex-lb-inspect/app/modules/quota_planner/warmup.py:79` and
  `/tmp/codex-lb-inspect/app/modules/quota_planner/warmup.py:395`.

## Root-cause statement

The previous patch protected the local refresh code path from simple access-token expiry, but it
did not guarantee that each stored Codex pool account has recently exercised the Codex backend.
Because the store has no durable `lastRefresh` / `lastValidated` style timestamp, an account with
a far-future `expiresAt` is considered valid indefinitely by opencodex even if upstream Codex has
silently invalidated or not initialized the session.

This makes `/wham/usage` a false positive: it proves the bearer token can query account metadata,
but it does not prove a Codex Responses request can be created.

## Patch goals

1. After login/import, send a tiny `gpt-5.4-mini` Codex `/responses` request and require a valid
   response before the account is considered connected.
2. Record durable freshness metadata for pool accounts so guardian decisions can be based on
   Codex-session validation age, not only access-token expiration.
3. Keep all traffic explicit, low-volume, and user-configurable because synthetic traffic has
   account-safety/ToS implications.
4. Reuse existing refresh locking and generation-CAS machinery; do not invent a second refresh
   coordinator.

## Non-goals

- No blanket proactive traffic for all providers.
- No Anthropic/OAuth behavior change.
- No rate-limit bypass automation.
- No silent loop that keeps many idle accounts hot by default.
- No changes to the Sol/Terra/Luna rollout metadata branch content except this planning doc unless
  implementation is explicitly requested on this branch.

## Proposed implementation phases

### Phase 1 — Codex Responses warmup helper

Add a small helper, probably `src/codex-warmup.ts` or a tightly scoped function in
`src/codex-auth-api.ts`.

Behavior:

- POST to `https://chatgpt.com/backend-api/codex/responses`.
- Headers:
  - `Authorization: Bearer <accessToken>`
  - `ChatGPT-Account-Id: <chatgptAccountId>`
  - `Content-Type: application/json`
- Body:
  - `model: "gpt-5.4-mini"`
  - `instructions: "Reply with OK."`
  - `input: "hi"`
  - `stream: true`
  - `store: false`
  - no `max_output_tokens`; existing ChatGPT Codex sidecars note that this backend rejects it
- Drain SSE until a terminal success event (`response.completed`).
- Fail closed on:
  - HTTP 401/403/429/5xx before streaming;
  - streamed `response.failed`, `response.incomplete`, or `error` events;
  - EOF before a success terminal;
  - malformed terminal JSON.

Important distinction: codex-lb uses warmup probes for quota planning. opencodex should use this
first as auth/session validation, not as hidden quota shaping.

### Phase 2 — Login/import gate

Patch successful OAuth login flow:

- Keep the existing `/wham/usage` fetch for email/plan/quota metadata.
- Before marking the flow successful, run the warmup helper using the just-issued token.
- If warmup succeeds, save the credential and clear reauth state.
- If warmup fails with auth/session status, do not mark the account connected; surface a clear
  login-state error.
- If warmup fails transiently, decide whether login should fail closed or save with
  `warmupStatus: "unknown"`; default recommendation is fail closed for auth/session errors and
  retryable error for transport failures.

Patch manual/import flow too, otherwise imported accounts can reproduce the same idle-token path.

Candidate files:

- `src/codex-auth-api.ts`
- `src/codex-account-store.ts`
- `tests/codex-auth-api.test.ts` or adjacent auth-flow tests

### Phase 3 — Durable freshness metadata

Extend `CodexAccountCredentialRecord` to include:

- `lastCodexWarmupAt?: number`
- `lastCodexWarmupStatus?: "ok" | "failed" | "unknown"`
- `lastCodexWarmupError?: string`

Alternative name if we want to match Codex docs more closely:

- `lastRefreshAt?: number` for token refresh
- `lastCodexValidatedAt?: number` for actual `/responses` validation

Recommendation: use `lastCodexValidatedAt`, because it is semantically different from OAuth
refresh. A successful `/responses` warmup may not rotate tokens.

Backwards compatibility:

- Existing records without these fields remain readable.
- Legacy `loadCodexAccountStore()` continues returning only credentials.
- Do not include tokens in logs or persisted error strings.
- `saveCodexAccountCredential()` and `saveCodexAccountCredentialIfGeneration()` must preserve
  validation metadata across ordinary saves/token refreshes. Otherwise a later refresh erases the
  freshness signal that guardian depends on.
- Add a dedicated metadata helper, e.g. `markCodexAccountValidated(id, now)`, so warmup can update
  validation fields without rewriting credential material.

### Phase 4 — Guardian age policy

Add an optional Codex pool freshness sweep:

- Keep `tokenGuardian.enabled` and `refreshPolicy` gates.
- Add config:
  - `tokenGuardian.codexWarmupEnabled?: boolean`
  - `tokenGuardian.codexWarmupMaxAgeSeconds?: number`
  - `tokenGuardian.codexWarmupModel?: string` default `gpt-5.4-mini`
- For each active pool account:
  - if access token is near expiry, reuse existing `getValidCodexToken()`;
  - if `lastCodexValidatedAt` is older than max age, call warmup helper;
  - use the existing concurrency/backoff controls.

Default recommendation:

- `codexWarmupEnabled` defaults OFF.
- Login-time warmup defaults ON because it is part of connection verification, not background
  synthetic usage.

### Phase 5 — Request-time recovery (deferred from this implementation pass)

Add or verify one retry path for Codex pool requests:

- If `/responses` returns 401/403 for a selected pool account, mark the account as needing reauth
  or refresh once via `getValidCodexToken()` if access expiry says it is stale.
- Do not loop across accounts indefinitely; respect existing routing and account-safety policy.
- Record the failure in request logs without token material.

This phase is separate because request-path retries can alter routing semantics. It touches
`src/codex-auth-context.ts`, `src/server.ts`, `src/codex-routing.ts`, and broader request-path
tests, so this implementation pass should not claim Phase 5 done.

Optional follow-up: update `lastCodexValidatedAt` on any successful real pool-backed Codex
`/responses` request, not only synthetic warmup. That would reduce unnecessary optional guardian
warmups for accounts that are already receiving traffic.

## Test plan

Unit tests:

- Login success sends `/wham/usage`, then sends `gpt-5.4-mini` warmup, then saves credential.
- Login warmup 401/403 does not save as connected and reports reauth/login error.
- Login warmup transient failure returns retryable error without leaking token data.
- Manual import path also warmups before final connected state.
- Store parser accepts records with and without `lastCodexValidatedAt`.
- Store writes preserve `lastCodexValidatedAt` across token refresh / generation-CAS saves.
- Guardian skips fresh `lastCodexValidatedAt` records even if many accounts exist.
- Guardian warmups stale records only when global switch + Codex warmup switch allow it.
- Guardian preserves existing access-token refresh behavior.
- Warmup SSE parser treats streamed `response.failed`, `response.incomplete`, `error`, malformed
  terminal JSON, and EOF-before-success as failures.
- Warmup failure messages do not persist access tokens, refresh tokens, account IDs, or raw upstream
  descriptions.

Integration/manual checks:

- Add one account, confirm request log shows one tiny `gpt-5.4-mini` Codex Responses warmup.
- Leave account idle, run guardian one-shot, confirm no warmup if freshness is inside max age.
- Force stale freshness metadata, run guardian one-shot, confirm exactly one warmup per eligible
  account under concurrency limit.
- Confirm existing provider auth flows are untouched.

Commands:

```bash
bun test tests/codex-auth-api.test.ts tests/codex-account-store.test.ts tests/token-guardian.test.ts
bun test tests/*.test.ts
npx tsc --noEmit
```

## Risk notes

- Synthetic Codex traffic is account-sensitive. Keep login-time verification small and obvious;
  keep background warmup opt-in.
- Refresh tokens can be single-use/rotating. All paths must continue through the existing
  generation-CAS and file-lock logic in `src/codex-account-store.ts`.
- `/wham/usage` and `/codex/responses` have different semantics. Never treat one as proof of the
  other.
- SSE parsing must drain/abort cleanly so login does not hang on a streaming response.
- Do not write token values to logs, devlog, tests, snapshots, request logs, or error messages.

## Acceptance criteria

- A newly connected Codex pool account is not shown as connected unless a real Codex Responses
  warmup succeeds or the UI explicitly labels it as warmup-unknown.
- Stored account records contain durable Codex validation freshness after successful warmup.
- Guardian can warm stale Codex pool accounts by validation age when explicitly enabled.
- No default background synthetic traffic is introduced.
- Existing Token Guardian tests still pass.
- The user can diagnose the difference between metadata auth (`/wham/usage`) and usable Codex
  session (`/codex/responses`) from logs/UI without reading source.

## Implementation record

Implemented on 2026-07-05.

Files changed:

- NEW `src/codex-warmup.ts`: minimal `gpt-5.4-mini` warmup request to
  `https://chatgpt.com/backend-api/codex/responses`; drains streamed SSE; succeeds only on
  `response.completed`; fails on HTTP rejection, `response.failed`, `response.incomplete`,
  `type:"error"`, malformed SSE JSON, or EOF before success.
- `src/codex-auth-api.ts`: manual import and OAuth pool login now run warmup before persisting the
  account as connected. On success they record validation metadata. On failure they return/report a
  redacted `codex_warmup_failed` reason and do not add the account.
- `src/codex-account-store.ts` / `src/types.ts`: account records now support
  `lastCodexValidatedAt`, `lastCodexValidationStatus`, and `lastCodexValidationError`; ordinary
  credential saves and generation-CAS refresh saves preserve this metadata.
- `src/oauth/token-guardian.ts`: optional background validation-age warmup via
  `tokenGuardian.codexWarmupEnabled`, `codexWarmupMaxAgeSeconds`, and `codexWarmupModel`. This is
  opt-in and remains gated by global `tokenGuardian.enabled` plus ChatGPT `refreshPolicy:
  "proactive"`.
- Tests added/updated for warmup success/failure parsing, manual-import warmup gate, metadata
  preservation, and optional guardian warmup.

Verification:

```bash
bun test tests/codex-warmup.test.ts tests/codex-auth-api.test.ts tests/codex-account-store.test.ts tests/token-guardian.test.ts
# 85 pass / 0 fail

npx tsc --noEmit
# exit 0

bun test tests/*.test.ts
# 1392 pass / 0 fail
```

C-gate independent review found no blocking issues after implementation. Residual known gap:
OAuth browser-login completion is still covered mostly by source-shape assertions plus inspection,
not a full behavioral async flow test; manual import has direct behavioral coverage.
