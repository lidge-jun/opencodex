# Phase 90 (P0-3) - OAuth refresh singleflight + Kiro SQLite reload

## Security boundary

Trust boundary: local credential store (`OPENCODEX_HOME/auth.json`) + imported
Kiro CLI SQLite token cache -> outbound Kiro runtime Authorization header.

Protecting: OAuth access/refresh tokens and correct persisted credential state.
Main failure mode: concurrent near-expiry requests refresh with the same old
refresh token, race writes to auth.json, or miss a fresher Kiro CLI token.

## Scope

Implement the hardening that is correct inside current opencodex ownership:

- general per-provider singleflight around `getValidAccessToken` refresh work
- Kiro-only SQLite reload before refreshing: if installed Kiro CLI has a fresh
  token, persist/use that instead of hitting the desktop refresh endpoint
- Kiro-only SQLite reload after refresh failure: if external Kiro CLI refreshed
  during/after our failed attempt, recover by importing it

Out of scope:

- AWS SSO OIDC/device-registration refresh path
- multi-account failover
- changing auth-source precedence for login

## File changes

### MODIFY src/oauth/index.ts

1. Import `readKiroCliSqlite` in addition to login/refresh.
2. Add module-level `const tokenRefreshes = new Map<string, Promise<string>>();`
3. Factor refresh path into `refreshAndPersistAccessToken(provider, def, cred)`:
   - for `provider === "kiro"`, call `readKiroCliSqlite()`
   - if imported token is valid beyond `REFRESH_SKEW_MS`, saveCredential(provider, imported) and return imported.access
   - otherwise call `def.refresh(cred.refresh)`, saveCredential, return access
   - if refresh throws and provider is Kiro, re-read SQLite and use it if now valid; otherwise rethrow
4. Update `getValidAccessToken`:
   - still returns immediately when existing credential is valid
   - if refresh needed and a provider refresh promise exists, return it
   - otherwise create promise, store in map, delete in finally

### Tests

NEW tests/oauth-refresh.test.ts:

- concurrent expired Kiro calls share one refresh request and both return same access
- fresh Kiro SQLite token is imported before refresh endpoint is called
- failed refresh recovers if SQLite now has a valid token
- non-expired stored credential still returns without refresh

Use isolated `OPENCODEX_HOME` and `HOME` temp dirs. Seed auth.json via
`saveCredential`, seed Kiro SQLite with the same schema used in kiro-oauth tests,
and mock `globalThis.fetch`.

## Verification

- bun x tsc --noEmit
- bun test tests/oauth-refresh.test.ts tests/kiro-oauth.test.ts

## Acceptance

- No tokens are logged.
- Singleflight map always clears after success/failure.
- Existing valid credentials remain fast-path and do not touch SQLite/fetch.
- Kiro reload path never weakens credential precedence at login time; it only
  prevents stale refresh races once an opencodex Kiro credential already exists.

## Commit

fix(oauth): singleflight refresh and reload Kiro CLI tokens
