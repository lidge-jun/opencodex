# 141.20 — Phase 2: kiro OAuth (import-first), plan

> Branch `feat/kiro-on-dev`. NEW `src/oauth/kiro.ts` + register in `OAUTH_PROVIDERS`.
> Port source: jawcode `packages/ai/src/providers/kiro.ts` (readKiroCliSqlite, refreshKiroDesktopToken,
> resolveKiroAuth) + `utils/oauth/kiro.ts`. Contract: codex `015/45_ki_codewhisperer_wire_stream_oauth.md` §3.

## opencodex contract (verified from src/oauth)
- `OAuthProviderDef = { login(ctrl, opts), refresh(refreshToken, signal), providerConfig, defaultModel }`.
- `OAuthCredentials = { refresh, access, expires(epoch ms), email?, accountId? }`.
- import-first precedent: `xai/anthropic` use `{importLocal:"fallback"}`; `kimi` uses a direct import login.
  kiro is **import-only** (no browser/PKCE) → `login` reads kiro-cli SQLite; manual-paste as fallback.

## Design
### NEW `src/oauth/kiro.ts`
- `loginKiro(ctrl): Promise<OAuthCredentials>`
  - read kiro-cli SQLite via `bun:sqlite` (readonly):
    mac `~/Library/Application Support/kiro-cli/data.sqlite3`, linux `~/.kiro/sso/cache.db`;
    table `auth_kv`, keys `kirocli:social:token`/`kirocli:odic:token`/`codewhisperer:odic:token`;
    value JSON `{access_token, refresh_token, expires_at, profile_arn?, region?}`.
  - map → `{ access, refresh, expires: Date(expires_at).getTime() }`.
  - if no SQLite token: `ctrl.onManualCodeInput()` manual-paste fallback (accept raw access token; or
    `KIRO_ACCESS_TOKEN` env). `ctrl.onProgress` for status.
- `refreshKiroToken(refresh, signal): Promise<OAuthCredentials>`
  - `POST https://prod.{region}.auth.desktop.kiro.dev/refreshToken` body `{refreshToken}` →
    `{accessToken, refreshToken?, expiresIn}`; `expires = Date.now()+expiresIn*1000` (60s skew handled by caller).
  - region: from stored cred / `KIRO_REGION` / default `us-east-1`.
- register in `OAUTH_PROVIDERS.kiro = { login: loginKiro, refresh: refreshKiroToken, providerConfig: oauthConfig("kiro"), defaultModel: oauthDefaultModel("kiro") }`.
  - **needs**: `kiro` entry in the provider registry so `deriveOAuthProviderConfig("kiro")`/`deriveOAuthDefaultModel("kiro")`
    resolve. providerConfig: `{ adapter:"kiro", baseUrl:"https://runtime.{region}.kiro.dev", authMode:"oauth" }`
    (registry add is Phase 4 wiring — for Phase 2, mirror chatgpt's inline providerConfig to avoid ordering dep,
    OR land the registry entry here. **audit: which is cleaner for opencodex?**)

### profileArn / region (NOT in OAuthCredentials)
- `OAuthCredentials` has no profileArn/region. Like jawcode, the **adapter** (Phase 3) resolves profileArn at
  request time from SQLite (`profile_arn`) or `KIRO_PROFILE_ARN`, and region from cred/env/default. Phase 2
  stores only access/refresh/expires. **audit: confirm this split is acceptable vs needing a cred extension.**

## Sub-steps (Phase 2 PABCD)
- A: Backend employee audits THIS plan vs opencodex `src/oauth/{index,types,store,login-cli}.ts` + kimi/xai
  precedent + jawcode source. Resolve the two audit questions (inline vs registry providerConfig; profileArn split).
- B: implement `src/oauth/kiro.ts` + register; tests (`tests/kiro-oauth.test.ts`): SQLite import (temp db),
  manual-paste fallback, refresh mapping, expires skew.
- C: `bun test` + `bun x tsc --noEmit`; Backend verify DONE.

## Risks
- SQLite path differs per OS → mac+linux paths + manual-paste fallback (test both).
- profileArn absence → adapter must error clearly (Phase 3).
- ToS: import-first reuses installed kiro-cli creds — transparency note at ship.

## Audit resolution (Backend, PASS + B1–B4) — 260628

- **CORRECTION (B2):** kimi is a **device-auth grant**, NOT a local-token import. The real import
  precedent to mirror is `src/oauth/local-token-detect.ts` (`detectGrokCliToken`/`detectClaudeCodeToken`).
- **Q1 → add registry entry now (not inline).** `OAUTH_PROVIDERS.kiro.providerConfig = oauthConfig("kiro")`
  is evaluated **eagerly at module load**; `oauthConfig` throws if the registry lacks `kiro` → importing
  `oauth/index.ts` would crash the CLI. So Phase 2 MUST also land the registry entry in `src/providers/registry.ts`:
  `{ id:"kiro", adapter:"kiro", baseUrl:"https://runtime.us-east-1.kiro.dev", authKind:"oauth", oauthId:"kiro", defaultModel:"kiro-auto" }`.
  baseUrl seed is static (no `{region}` template) → Phase 3 adapter rewrites per region. Registry entry also
  feeds init wizard/preset/oauth-id discovery (`derive.ts`).
- **Q2 → adapter-time resolution confirmed.** `getValidAccessToken()` returns only `cred.access`; the rest of
  the credential is never surfaced via the standard path. So profileArn (SQLite `profile_arn` / `KIRO_PROFILE_ARN`)
  and region (`KIRO_REGION`/default) are resolved in the **Phase 3 adapter** at request time. Phase 2 stores only
  `{refresh, access, expires}`. Do NOT extend `OAuthCredentials`.
- **B3 (GUI):** GUI `startLoginFlow` builds `ctrl` without `onManualCodeInput` (only CLI wires it). So with no
  SQLite token AND no `KIRO_ACCESS_TOKEN`, `loginKiro` must throw a clear "no kiro-cli token found" error — never hang.
- **B4 (manual paste):** call `ctrl.onManualCodeInput?.()` **directly** inside `kiro.ts` and treat the return as a
  **raw access token** (kiro does not use OAuthCallbackFlow / the callback-server code parser).

→ Phase 2 build scope (revised): `src/oauth/kiro.ts` (SQLite import via bun:sqlite + env + guarded manual-paste +
desktop refresh) **+** `src/providers/registry.ts` kiro entry **+** `OAUTH_PROVIDERS.kiro` registration **+**
`tests/kiro-oauth.test.ts`.
