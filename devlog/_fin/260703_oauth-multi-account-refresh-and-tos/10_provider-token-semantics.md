# Provider token semantics (Thread A)

Date: 2026-07-03
Owner: Boss (main session), PABCD Phase 0 build output.
Status: DONE (design pass). Grounded in code (file:line) + provider docs where public.

Purpose: establish, per provider, how the access token and refresh token behave, so the guardian
in `20_guardian-design.md` refreshes at the right cadence and the ToS matrix in `30_...` can reason
about detection surface. Every codebase claim is grounded to a file:line; every server-side claim
(refresh-token lifetime/rotation) is cited or explicitly marked unverified.

## Two storage layers (this is the crux)

| Layer | File | Keyed by | Refresh entry point | Concurrency safety |
|---|---|---|---|---|
| Single-account OAuth | `src/oauth/store.ts` (`~/.opencodex/auth.json`) | provider name | `getValidAccessToken()` `src/oauth/index.ts:115` | in-memory `tokenRefreshes` map dedup `src/oauth/index.ts:17` |
| Multi-account Codex pool | `src/codex-account-store.ts` (`codex-accounts.json`) | account id | `getValidCodexToken(id)` `src/codex-account-store.ts:278` | file lock + generation CAS + refresh-grant fingerprint `:224,:139,:50` |

The reported "tokens keep expiring" bug lives in the **multi-account** layer: an account that the
balancer does not route to for a long time never reaches `getValidCodexToken`, so its refresh token
is never exercised and ages out server-side. The single-account layer rarely goes fully idle (its
one credential is used on nearly every request for that provider), so it is far less exposed — but
generalizing still buys pre-expiry (latency) refresh and a home for any future provider pool.

## Per-provider table

Legend: "skew" = how long *before* nominal expiry opencodex treats the token as needing refresh.

| Provider | Access TTL source | Existing skew (code) | Refresh-token behavior | Refresh fn |
|---|---|---|---|---|
| chatgpt / Codex | `expires_in` (~1h) `src/oauth/chatgpt.ts:55` | generic 60s `src/oauth/index.ts:16`; Codex path `REFRESH_SKEW_MS=60s` `src/codex-account-store.ts:11` | **rotates**; reuse invalidates the whole family (`refresh_token_reused`) — see below | `refreshChatGPTToken` `src/oauth/chatgpt.ts:135`; pool: inline in `getValidCodexToken` `:349` |
| anthropic | `expires_in` | **−5 min** `src/oauth/anthropic.ts:65` | rotates (new refresh returned) | `refreshAnthropicToken` |
| google-antigravity | `expires_in` (~1h) | **−50 min (already proactive)** `src/oauth/google-antigravity.ts:35,150` | rotates | `refreshAntigravityToken` |
| xai (Grok) | `expires_in` | generic 60s | returns `refresh_token` each call `src/oauth/xai.ts:27,233` (rotation not asserted) | `refreshXaiToken` `src/oauth/xai.ts:219` |
| cursor | JWT `exp` decoded from access token `src/oauth/cursor.ts:116` | generic 60s | returns `refreshToken` each call `src/oauth/cursor.ts:161` | `refreshCursorToken` `src/oauth/cursor.ts:140` |
| kimi (Moonshot) | `expires_in` `src/oauth/kimi.ts:112` | `OAUTH_EXPIRY_SKEW_MS` | device-code grant + `refresh_token` grant `src/oauth/kimi.ts:153` | `refreshKimiToken` |
| kiro (AWS) | `expiresIn` / 3600 default `src/oauth/kiro.ts:121` | generic 60s | re-importable from local CLI sqlite `src/oauth/index.ts:130` | `refreshKiroToken` |

## ChatGPT/Codex refresh-token rotation (the failure mode, verified)

OpenAI's `auth.openai.com/oauth/token` **rotates** the refresh token: each refresh returns a new
`refresh_token`, and reusing an old one invalidates the token family. opencodex already handles the
rotation correctly on the write side — the pool store persists the returned `refresh_token`
(`src/codex-account-store.ts:375`) under a file lock + generation CAS, and de-dupes concurrent
refreshers of the same grant via `refreshGrantFingerprint` (`:50,:264`). What it does NOT do is
refresh an account that is never routed to. Idle → refresh token ages out → next use fails with a
permanent code.

The permanent failure codes (mirrors `codex-lb`'s `PERMANENT_FAILURE_CODES`): `refresh_token_expired`,
`refresh_token_reused`, `refresh_token_invalidated`, `invalid_grant`, `token_invalidated`,
`token_expired`. opencodex's `TokenRefreshError` (`src/codex-account-store.ts:174`) already
classifies `revoked`/`expired`/`unknown` from the error text (`:366`).

> 출처: [OpenAI Codex — Authentication](https://developers.openai.com/codex/auth)
> 출처: [OpenAI Codex — Maintain account auth in CI/CD](https://developers.openai.com/codex/auth/ci-cd-auth)
> 출처: [cc-switch #4474 — Codex OAuth refresh token rotation does not sync back, false session expired](https://github.com/farion1231/cc-switch/issues/4474)

## Recommended proactive cadence per provider (feeds 20_guardian-design.md)

- **Codex pool (chatgpt)**: the one that needs it. `codex-lb` uses a use-time top-up at
  `TOKEN_REFRESH_INTERVAL_DAYS = 8` plus a ~6h guardian tick refreshing accounts whose last refresh
  is > 12h old. opencodex has no per-account `lastRefresh` timestamp today (fields are
  `accessToken/refreshToken/expiresAt/chatgptAccountId`), so the practical trigger is: refresh any
  pool account whose access token is within a lead window of `expiresAt` — this naturally cycles the
  refresh token before it can age out. (Adding an explicit `lastRefresh` is a Phase 1 option.)
  > 출처: [Soju06/codex-lb — Auth Guardian scheduler](https://github.com/Soju06/codex-lb)
- **Others (anthropic/google/xai/cursor/kimi/kiro)**: single-seat, exercised regularly → proactive
  refresh mainly saves first-request latency, not survival. Cadence = refresh when within the
  provider's existing skew window; no aggressive background warming (and for Anthropic, none at all
  — see `30_...`).

## Unverified / uncertain

- Exact server-side **refresh-token lifetimes** for xai, kimi, kiro, google-antigravity are not
  publicly documented at a level citable with 2 sources — treated as unknown. The design does not
  depend on a specific number; it triggers off access-token expiry proximity.
- Whether xai/cursor rotation *invalidates* the prior refresh token (vs. accepting either) is not
  asserted by their docs; code simply persists whatever `refresh_token` comes back, which is safe
  under both models.
