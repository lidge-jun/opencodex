# 020 — Account-aware auth layer (resolver, login, guardian)

## MODIFY src/oauth/index.ts
- Single-flight map key: `provider` → `provider\u0000accountId`.
  `getValidAccessToken(provider)` resolves ACTIVE account then delegates to new
  `getValidAccessTokenForAccount(provider, accountId)`:
  - reads `getAccountCredential`; expired → single-flight refresh;
  - refresh success → `saveAccountCredential(provider, accountId, merged)` —
    persists BEFORE returning access (rotation-safe: new refresh token hits disk
    first; matches auth2api manager.ts:603-660 finding);
  - refresh failure classified: response body containing `invalid_grant`,
    `refresh_token_reused`, `expired` (case-insensitive) → mark
    `markAccountNeedsReauth(provider, accountId, true)` and throw
    `OAuthLoginRequiredError`; other errors rethrow as transient.
  - kiro local-CLI import fallback stays, scoped to the active account.
- `runLogin`: after `def.login()` returns cred, `saveCredential` (store already
  appends-or-replaces by identity + activates). No signature change. forceLogin
  opt (chatgpt has it; others use provider account pickers server-side) — pass
  `{ forceLogin: true }` support where def.login honors it so adding a second
  account does not silently reuse the browser session's first account. For
  providers whose login imports local CLI tokens (xai/anthropic fallback), adding
  a second account requires the real OAuth flow: expose `opts.forceLogin` to skip
  local import (importLocal: "off" when forceLogin).
- `getLoginStatus(provider)`: unchanged shape + add `accounts: [{ id, email?
  (masked), active, needsReauth? }]` and `activeAccountId`.
- `oauthLoginSummary`: unchanged (active account).
- NEW `getOAuthCredentialProjectId(provider)` stays active-account (server.ts uses
  it right after getValidAccessToken — consistent).

## MODIFY src/oauth/token-guardian.ts
- Sweep A iterates ALL accounts per provider: `listAccounts(provider)`, key
  `oauth:<provider>:<accountId>`, skip `needsReauth` accounts, call new
  `getValidAccessTokenForAccount`. Terminal classification marks needsReauth so
  the sweep stops hammering dead refresh tokens (permanent backoff).
- Keeps existing tick/backoff/concurrency logic.

## Keep-alive semantics (the "로그인 안풀리는" ask)
- Non-active accounts are ONLY kept alive by the guardian when the provider's
  effective refreshPolicy is "proactive" (config.tokenGuardian.enabled +
  per-provider policy). Anthropic default stays "disabled" (ToS risk, documented
  in OAUTH_PROVIDERS) — its second account survives only if its refresh token is
  long-lived; document this in the D summary honestly.
- No new background traffic by default (policy defaults unchanged).
