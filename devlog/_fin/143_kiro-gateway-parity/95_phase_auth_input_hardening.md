# Phase 95 (P0 residual) - Kiro auth input hardening without multi-account

## Trigger

The external code review says Phase 90 closed refresh singleflight and
SQLite reload, but not the broader single-account Kiro auth surface:

- JSON credential file import.
- AWS SSO OIDC refresh through `clientId`/`clientSecret`.
- Device registration keys in kiro-cli SQLite.
- API-region/runtime-region split (`KIRO_API_REGION`) without conflating it
  with SSO/auth refresh region (`KIRO_REGION`).
- Broader SQLite path coverage and clearer diagnostics.

User scope decision: account failover / multi-account routing is not needed.
Do not implement account pool, circuit breaker, sticky account selection, or
per-request account failover in this phase.

## Current state

- `src/oauth/index.ts` already has per-provider singleflight refresh.
- `src/oauth/index.ts` already reloads fresh Kiro CLI SQLite tokens before
  calling the refresh endpoint and after refresh failure.
- `src/oauth/kiro.ts` still reads only two hardcoded SQLite paths, ignores
  device-registration keys, has no JSON credential file import, and uses
  `KIRO_REGION` for both auth refresh and runtime API.
- `src/adapters/kiro.ts` calls `resolveKiroRegion()` for the runtime URL.

## Diff plan

### ADD `src/oauth/kiro-credentials.ts`

Add a small parser module so `src/oauth/kiro.ts` stays below the 500-line
limit:

- Export `ImportedKiroCredential`, `KiroAuthType`, and helpers:
  - `readImportedKiroCredential(opts?)`
  - `readKiroCliSqliteCredential()`
  - `inferRegionFromProfileArn(arn)`
- Source precedence:
  1. `KIRO_CREDS_FILE` or `KIRO_CREDENTIALS_FILE` JSON.
  2. `KIRO_CLI_DB_FILE` SQLite override.
  3. Known SQLite paths:
     - `~/Library/Application Support/kiro-cli/data.sqlite3`
     - `~/.local/share/kiro-cli/data.sqlite3`
     - `~/.local/share/amazon-q/data.sqlite3`
     - `~/.kiro/sso/cache.db`
  4. Existing env-token fallback stays in `loginKiro()`.
- JSON fields:
  - `accessToken` / `access_token`
  - `refreshToken` / `refresh_token`
  - `expiresAt` / `expires_at`
  - `profileArn` / `profile_arn`
  - `region`
  - `apiRegion` / `api_region`
  - `clientId` / `client_id`
  - `clientSecret` / `client_secret`
  - `clientIdHash`, loading `~/.aws/sso/cache/{clientIdHash}.json`.
- SQLite fields:
  - Existing token keys: `kirocli:social:token`,
    `kirocli:odic:token`, `codewhisperer:odic:token`.
  - Device-registration keys: `kirocli:odic:device-registration`,
    `codewhisperer:odic:device-registration`.
  - `state` table profile row: `api.codewhisperer.profile`.
- Apply `PRAGMA busy_timeout = 5000` on opened SQLite handles.
- Preserve read-only behavior: this phase only reads external Kiro stores.
- Diagnostics must be secret-free. Return only source labels/status codes such
  as `missing`, `invalid_json`, `token_found`, `registration_found`, and
  `schema_mismatch`; never include token values, refresh tokens, client secrets,
  profile ARNs, raw JSON payloads, or absolute user paths in diagnostic objects,
  progress strings, thrown messages, or tests.

### MODIFY `src/oauth/kiro.ts`

- Replace inline SQLite scanning with the new helper.
- Keep the public `readKiroCliSqlite()` export shape for existing tests.
- Preserve and adapt the public `inspectKiroCliSqlite()` export introduced by
  security commit `68b079f`; it must continue returning
  `{ token, diagnostics }` with token values only in `token`, never in
  diagnostics.
- `loginKiro()` source order becomes imported credential JSON/SQLite ->
  `KIRO_ACCESS_TOKEN` -> manual paste.
- Add `resolveKiroApiRegion()`:
  - `KIRO_API_REGION`
  - imported `apiRegion`
  - imported `profileArn` ARN region
  - imported SSO `region`
  - `KIRO_REGION`
  - `us-east-1`
- Keep `resolveKiroRegion()` as auth/SSO refresh region:
  - imported SSO `region`
  - `KIRO_REGION`
  - `us-east-1`
- Keep `resolveKiroProfileArn()` env-first, then imported credential.
- `refreshKiroToken()` chooses:
  - AWS SSO OIDC endpoint when imported current credential has
    `clientId` + `clientSecret`.
  - Kiro Desktop refresh endpoint otherwise.
- OIDC request:
  - URL `https://oidc.{region}.amazonaws.com/token`.
  - JSON body with camelCase:
    `{ grantType: "refresh_token", clientId, clientSecret, refreshToken }`.
  - Header `Content-Type: application/json`.
  - Rationale: AWS IAM Identity Center OIDC `CreateToken` is an AWS JSON API,
    not a generic form-urlencoded OAuth endpoint. The official AWS docs list
    `Content-type: application/json` and camelCase request fields, and
    `kiro-gateway`'s current implementation sends this same JSON/camelCase
    payload.
  - On a `400` with a new imported SQLite refresh token, retry once with the
    reloaded token.

### MODIFY `src/adapters/kiro.ts`

- Use `resolveKiroApiRegion()` for `https://runtime.{region}.kiro.dev/`.
- Continue using `resolveKiroProfileArn()` for payload/header profile ARN.

### MODIFY `tests/kiro-oauth.test.ts`

Add regression coverage for:

- JSON credential import from `KIRO_CREDS_FILE`.
- Enterprise `clientIdHash` loading from `~/.aws/sso/cache/{hash}.json`.
- AWS SSO OIDC refresh URL/body selection.
- `KIRO_API_REGION` runtime override separate from `KIRO_REGION`.
- SQLite device-registration client credentials and `state` table profile ARN
  region detection.

### MODIFY `tests/oauth-refresh.test.ts`

- Keep existing singleflight/reload tests green.
- Extend temporary env cleanup for new Kiro env vars if needed.

## Verification

- `bun x tsc --noEmit`
- `bun test tests/kiro-oauth.test.ts tests/oauth-refresh.test.ts tests/kiro-adapter.test.ts`
- `wc -l src/oauth/kiro.ts src/oauth/kiro-credentials.ts src/adapters/kiro.ts`

## Commit

`fix(oauth): broaden single-account Kiro credential inputs`

## Explicit non-goals

- No opencodex Kiro account pool.
- No account circuit breaker.
- No sticky account routing.
- No write-back to Kiro CLI SQLite in this phase.

## Build record

Files changed:

- ADD `src/oauth/kiro-credentials.ts`: centralized Kiro credential import from
  JSON credential files, SQLite overrides, macOS/Linux/Amazon-Q SQLite paths,
  device registration rows, profile state rows, and AWS SSO cache references.
- MODIFY `src/oauth/kiro.ts`: replaced inline SQLite scanning with the helper,
  preserved public SQLite import APIs, added `resolveKiroApiRegion()`, kept
  `resolveKiroRegion()` for auth/SSO refresh, and selected AWS SSO OIDC refresh
  when imported credentials carry client registration data.
- MODIFY `src/adapters/kiro.ts`: runtime requests now use
  `resolveKiroApiRegion()` instead of conflating runtime API region with auth
  region.
- MODIFY `src/oauth/types.ts` and `src/oauth/store.ts`: added and persisted the
  safe `credential-file` credential source label through the existing OAuth
  store allowlist.
- MODIFY `tests/kiro-oauth.test.ts`: added JSON credential import,
  `clientIdHash` AWS SSO cache loading, AWS SSO OIDC body/URL selection,
  SQLite device-registration/profile-state import, no-secret diagnostics, and
  API-region resolver coverage.
- MODIFY `tests/kiro-adapter.test.ts`: added runtime URL coverage for
  `KIRO_API_REGION`.
- MODIFY `tests/oauth-status-privacy.test.ts`: confirmed `credential-file`
  survives the credential-store allowlist without allowing arbitrary metadata.

Verification:

- `bun test tests/kiro-oauth.test.ts tests/oauth-refresh.test.ts tests/kiro-adapter.test.ts tests/oauth-status-privacy.test.ts`
  -> 59 pass, 0 fail.
- `bun x tsc --noEmit` -> exit 0, no diagnostics.
- `wc -l src/oauth/kiro.ts src/oauth/kiro-credentials.ts src/adapters/kiro.ts`
  -> 161 / 242 / 496 lines, all under the 500-line project limit.

Security notes:

- Diagnostics remain label/status-only and intentionally exclude access tokens,
  refresh tokens, client secrets, profile ARNs, raw JSON payloads, and absolute
  user paths.
- The phase stays single-account. It broadens credential inputs and refresh
  compatibility but does not introduce failover, account pools, or write-back to
  external Kiro stores.

## Independent audit follow-up

Read-only audit (`Bacon`) initially returned FAIL after commit `4c97e0d`.

Blocking findings:

- Region strings from `KIRO_REGION`, `KIRO_API_REGION`, and imported
  credential metadata were interpolated into Kiro runtime/auth URLs without a
  central validator.
- `clientIdHash` was joined directly into the AWS SSO cache path, allowing
  traversal outside the intended cache directory.
- Kiro eventstream exception/error payloads and stream parser catch errors could
  surface raw upstream JSON, tokens, client secrets, profile ARNs, or local
  absolute paths.

Follow-up fixes:

- Commit `931847b fix(kiro): sanitize region and upstream error details`
  added:
  - central Kiro region normalization/rejection in
    `src/oauth/kiro-credentials.ts` and `src/oauth/kiro.ts`;
  - `clientIdHash` basename-safe allowlisting;
  - client-secret redaction in `src/redact.ts`;
  - host-injection, traversal, and error-leak regression tests.
- Commit `e95338e fix(kiro): include safe error formatter` added the tracked
  `src/adapters/kiro-errors.ts` helper so `src/adapters/kiro.ts` stays under
  the project 500-line limit.

Re-verification:

- `bun test tests/redact.test.ts tests/kiro-oauth.test.ts tests/kiro-adapter.test.ts tests/oauth-status-privacy.test.ts`
  -> 67 pass, 0 fail.
- `bun test tests/redact.test.ts tests/crash-guard.test.ts tests/usage-debug.test.ts tests/request-log.test.ts tests/server-auth.test.ts tests/error-fidelity.test.ts tests/usage-log.test.ts tests/usage-summary.test.ts tests/oauth-status-privacy.test.ts tests/kiro-oauth.test.ts tests/oauth-refresh.test.ts tests/config.test.ts tests/kiro-adapter.test.ts`
  -> 179 pass, 0 fail, 604 expect calls.
- `bun x tsc --noEmit` -> exit 0, no diagnostics.
- `wc -l src/oauth/kiro.ts src/oauth/kiro-credentials.ts src/adapters/kiro.ts src/adapters/kiro-errors.ts`
  -> 164 / 256 / 497 / 40 lines.

Re-audit:

- `Bacon` returned PASS. The audit confirmed validated region interpolation,
  `clientIdHash` traversal blocking, safe Kiro upstream error formatting,
  regression coverage, and file-size compliance.
