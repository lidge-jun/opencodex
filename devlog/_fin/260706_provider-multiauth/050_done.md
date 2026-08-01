# 050 — D summary (terminal outcome: DONE)

## Shipped
- `src/oauth/types.ts`: `ProviderAccount` / `ProviderAccountSet`.
- `src/oauth/store.ts`: multi-account auth.json (`provider -> { activeAccountId,
  accounts[] }`), legacy normalize on load, one-time `auth.json.pre-multiauth`
  downgrade backup, in-process write queue, chatgpt single-slot exception,
  identity-less (kimi/kiro/cursor) active-slot replace, new API: getAccountSet /
  listAccounts / getAccountCredential / saveAccountCredential / setActiveAccount /
  removeAccount / markAccountNeedsReauth.
- `src/oauth/index.ts`: `getValidAccessTokenForAccount` (single-flight per
  provider+account, rotated refresh token persisted to disk before use, identity
  fields preserved across refresh, terminal `invalid_grant`/`refresh_token_reused`/
  `revoked` -> needsReauth + OAuthLoginRequiredError), kiro local-CLI import only
  for the active account, forceLogin wrappers (xai/anthropic skip local import;
  antigravity adds `select_account`), `getLoginStatus` returns account summaries.
- `src/oauth/token-guardian.ts`: sweeps EVERY account per proactive provider
  (keys `oauth:<provider>:<accountId>`), permanent backoff on needsReauth.
- `src/server.ts`: `GET/DELETE /api/oauth/accounts`, `PUT /api/oauth/accounts/active`
  (quota cache invalidated), `POST /api/oauth/login { addAccount: true }`.
- `src/provider-quota.ts`: `clearProviderQuotaCache()`.
- GUI: `.provider-quota` divider removed (comment 1); thin `Accounts (N)` chevron
  row on oauth cards opening an account list — click switches active, trash
  removes, `+ Add account` starts a forced-fresh login (comment 2). i18n en/ko/zh.
- structure/00_overview.md + 05_gui-and-management-api.md updated (SOT-SYNC-01).

## Verification (fresh)
- `bun x tsc --noEmit` (root) + `tsc -b` (gui): clean.
- `bun test ./tests/`: 1487 pass / 0 fail (includes new oauth-store-multi 11,
  oauth-accounts-api 3; token-guardian key assertion updated).
- `bun run privacy:scan`: passed.
- Runtime smoke: isolated OPENCODEX_HOME proxy served masked 2-account list,
  PUT active switched, DELETE promoted; live dashboard (10100) screenshot shows
  divider gone + dropdown open with active badge; mobile 487px rowFits=true.
- Live catalog healed via `ocx sync` after temp-proxy catalog overwrite
  (test pollution, root-caused: temp CODEX_HOME missing on first run).

## Honest limits (LOOP-PESSIMIST-01)
- Effective multiauth = xai / anthropic / google-antigravity (identity present).
  kimi/kiro/cursor stay single-account by design (rotating refresh tokens, no
  stable identity in credential). Kiro second account unsupported (import-first).
- Keep-alive for background accounts requires tokenGuardian.enabled + proactive
  policy; anthropic default stays "disabled" (ToS risk) — its background account
  survives only as long as its refresh token does.
- 429 auto-rotation across accounts is NOT in this unit (next unit; design sketch
  in 000_plan research: cooldown + Retry-After + next-request switch).
- Cross-process store races accepted (single-proxy assumption).
