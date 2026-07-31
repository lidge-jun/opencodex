# Provider Multiauth (multi-account per OAuth provider)

## Loop-spec
- Archetype: spec-satisfaction (verifier = bun test + tsc + UI smoke).
- Trigger: user request — per-provider account dropdown on provider cards, multiple
  logged-in accounts per provider, active-account switching, keep-alive so logins do
  not drop mid-use. Codex/ChatGPT passthrough pool is EXCLUDED (already has its own
  system: codex-accounts.json + Codex Auth page).
- Goal: `auth.json` holds N accounts per provider; GUI provider card shows a thin
  dropdown listing accounts; clicking one activates it; requests use the ACTIVE
  account only (no auto-rotation in this unit — rotation is a later unit).
- Non-goals (this unit): 429 auto-rotation across accounts, per-account quota
  fetching, api-key pools, Codex pool changes, usage-log accountId attribution.
- Verifier: `bun test tests/oauth-store-multi.test.ts tests/oauth-status-privacy.test.ts` +
  `bun x tsc --noEmit` + GUI build + browser screenshot of dropdown.
- Stop: all criteria pass; terminal outcome DONE.
- Escalation: any provider login flow that cannot carry a second account safely
  (device-bound) is documented, not forced.

## Research evidence (subagent, opened sources)
- CLIProxyAPI `sdk/cliproxy/auth/types.go:46-91` — per-account Disabled/Quota/
  NextRefreshAfter state; selector round-robin skips cooldown.
- auth2api `src/accounts/manager.ts:339-407` — sticky selection + cooldown skip;
  refresh single-flight per account; NEW refresh token persisted to disk BEFORE
  memory swap (`603-660`).
- TeamClaude `src/account-manager.js:607-650` — per-account `_refreshPromise`
  coalescing.
- opencode `packages/opencode/src/auth/index.ts:14-21` — single-slot only (no pool);
  confirms our current shape is the common baseline, pools are the differentiator.
- Pitfalls adopted: never double-use one refresh token concurrently; treat
  `refresh_token_reused/invalid_grant` as terminal (needsReauth), not retryable;
  persist rotated refresh token atomically before use.

## Current-code anchors
- Store: `src/oauth/store.ts` — `AuthStore = Record<provider, OAuthCredentials>`;
  normalize/persist/get/save/remove (84 lines).
- Resolver: `src/oauth/index.ts:209` `getValidAccessToken(provider)` — in-memory
  single-flight `tokenRefreshes` Map keyed by provider; refresh persists via
  `saveCredential` (line ~175).
- Login: `runLogin()` `src/oauth/index.ts:311-320` — overwrites the provider slot.
- Server injection: `src/server.ts:336-344` — `apiKey = getValidAccessToken(name)`,
  antigravity projectId from `getOAuthCredentialProjectId`.
- Status API: `src/oauth/index.ts:332-346` `getLoginStatus`, `oauthLoginSummary`.
- Logout: `src/server.ts:2095-2100` + `src/cli.ts:463` `removeCredential(provider)`.
- Guardian: `src/oauth/token-guardian.ts:117-136` iterates `getCredential(provider)`.
- Quota: `src/provider-quota.ts` uses `getValidAccessToken`/`getCredential` (active
  account semantics stay correct automatically).
- GUI: `gui/src/pages/Providers.tsx` (oauth grid + prov cards), `QuotaBars`
  `gui/src/components/QuotaBars.tsx`, styles `gui/src/styles.css:370-395`.

## Data model (backward-compatible)
`~/.opencodex/auth.json` value per provider becomes:
```json
{
  "anthropic": {
    "activeAccountId": "a1b2",
    "accounts": [
      { "id": "a1b2", "credential": { "access": "...", "refresh": "...", "expires": 0, "email": "x@y.z" }, "needsReauth": false, "addedAt": 0 }
    ]
  }
}
```
- Legacy single-credential values normalize on load to
  `{ activeAccountId: <derived>, accounts: [{ id: <derived>, credential }] }`.
- Account id derivation: `credential.accountId ?? credential.email ?? "default"`,
  hashed short (8 hex) for stability + non-PII filename safety; collision → suffix.
- Persist ALWAYS in the new shape. Loader accepts both shapes forever (cheap).

## Phase map (dependency order)
- 010 store: multi-account store + migration + unit tests.
- 020 auth layer: account-aware resolver/login/logout + guardian sweep all accounts
  + single-flight per (provider,account) + rotated-refresh-token-first persistence.
- 030 API: /api/oauth/accounts (GET list, PUT active, DELETE account), login adds
  (does not replace) when identity differs; status returns account summary.
- 040 GUI: provider card divider removal + thin accounts dropdown row (chevron) on
  oauth cards; click switches active; login button inside dropdown for adding.

## Accept criteria
1. Fresh legacy auth.json loads and round-trips into new shape without losing login.
2. Two accounts can coexist for one provider; `getValidAccessToken` returns ACTIVE
   account's token; switching persists.
3. Logout removes only the targeted account; last-account logout clears provider.
4. Guardian refreshes every proactive account, not just active.
5. Existing tests green; new store tests green; tsc clean; GUI builds; dropdown
   renders + switches in browser.
