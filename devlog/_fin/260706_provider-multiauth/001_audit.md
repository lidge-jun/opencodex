# 001 — A-phase audit verdict (folded fixes)

Reviewer subagent verdict: **PASS-WITH-FIXES**. Findings folded into the plan:

## High (plan amendments)
1. **forceLogin plumbing**: OAUTH_PROVIDERS wrappers drop `opts` (index.ts:49-95).
   Fix in 020: each wrapper becomes `(ctrl, opts) => ...`:
   - xai/anthropic: `importLocal: opts?.forceLogin ? "off" : "fallback"`.
   - chatgpt: pass opts through (already supported).
   - kimi/kiro/antigravity/cursor: ignore opts for now (kimi/kiro device/import
     flows can't select identity; antigravity gets `select_account` prompt when
     forceLogin — google-antigravity.ts:179; cursor's 2nd param is a NUMBER
     (pollBaseDelayMs) — do not blindly pass opts).
2. **Account id stability**: id is generated ONCE at append time and stored;
   upsert identity-matches ONLY on `accountId ?? email`. Credentials without
   identity (kimi, kiro, cursor) REPLACE the active slot (single-account
   behavior preserved). Effective multiauth providers: xai, anthropic,
   google-antigravity. Accept criterion 2 scoped to those.
3. **chatgpt exception**: chatgpt stays single-slot in auth.json
   (`saveCredential("chatgpt", ...)` always replaces the whole set) because
   codex-auth-api.ts:545-556 uses it as a scratch slot for pool logins;
   the Codex pool has its own ledger (codex-accounts.json). GUI accounts UI
   skips chatgpt/forward providers.

## Medium (folded)
4. token-guardian.test.ts:78 expects `oauth:kimi` — update test to new key
   `oauth:kimi:<id>`; add token-guardian.test.ts to the verifier list.
5. Downgrade safety: before FIRST persist in new shape, write a one-time
   `auth.json.pre-multiauth` backup (0600) so a downgraded loader's silent
   drop cannot destroy refresh tokens irrecoverably.
6. Store writes serialized through an in-process mutex (promise queue) to stop
   guardian-vs-switch lost updates. Cross-process risk accepted (single proxy).
7. Kiro local-CLI import fallback runs ONLY when `accountId === activeAccountId`.

## Low (folded)
8. Cursor has no email → GUI label falls back to short account id; i18n key
   `prov.accountNoLabel`. Kiro second-account add documented as unsupported.
