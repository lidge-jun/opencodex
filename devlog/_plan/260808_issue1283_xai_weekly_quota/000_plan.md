---
created: 2026-08-08
status: active
tags: [xai, grok, quota, issue-1283, dashboard]
---

# Issue #1283 — Grok dashboard weekly quota (OpenCodex)

## Loop spec

- Archetype: spec-satisfaction repair
- Trigger: https://github.com/lidge-jun/opencodex/issues/1283 reports dashboard shows 30-day/monthly Grok usage while Codex/Grok CLI gates on weekly limit.
- Goal: OpenCodex provider quota for OAuth `xai` prefers Grok weekly credits and only falls back to legacy monthly billing when weekly data is unavailable.
- Non-goals: ima2-gen/cli-jaw changes; multi-account xAI pool aggregation redesign; docs-site locale churn; release/version bump; secret-store redesign.
- Verifier: `bun test tests/provider-quota.test.ts`; `bun run typecheck` if types change; `git diff --check`.
- Stop: weekly-first path + monthly fallback covered by focused tests; branch pushed; PR targets `dev` with `Closes #1283`.
- Terminal outcomes: DONE on green tests + PR; NOOP only if tree already weekly-first; BLOCKED only if contract cannot be determined.

## Evidence already known

- OpenCodex `fetchXaiQuota` (`src/providers/quota.ts`) still calls `GET https://cli-chat-proxy.grok.com/v1/billing` and maps `monthlyLimit/used` → `monthlyPercent` (introduced 2026-07-05, unchanged).
- Prior cross-repo work (2026-07-16) moved **ima2-gen** (and intended cli-jaw) to `GET /v1/billing?format=credits` with envelope `{ config: { creditUsagePercent?, currentPeriod: { type: USAGE_PERIOD_TYPE_WEEKLY, end } } }`.
- OpenCodex already has:
  - `XAI_GROK_COMPATIBILITY` client headers in `src/providers/xai-transport.ts`
  - `credential.accountId` from JWT `sub` / Grok CLI `user_id` (`src/oauth/xai.ts`, `src/oauth/local-token-detect.ts`)
  - `getCredential("xai")` / `getValidAccessToken("xai")` for the active OAuth account

## Diff-level plan

### IN

1. MODIFY `src/providers/quota.ts`
   - Add constants:
     - `XAI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing"`
     - `XAI_CREDITS_URL = XAI_BILLING_URL + "?format=credits"`
   - Add pure parser `parseXaiCreditsResponse(value: unknown): { percent: number; resetAt?: number } | null`
     - Require `config.currentPeriod.type === "USAGE_PERIOD_TYPE_WEEKLY"` and parseable `end`
     - `creditUsagePercent` optional: omit → `0`; non-finite number → reject
     - Clamp via `normalizePercent`
   - Rewrite `fetchXaiQuota(provider)`:
     1. Resolve access token via `getValidAccessToken("xai")`; on failure return null.
     2. Read active credential via `getCredential("xai")` for optional `accountId`.
     3. If `accountId` is non-empty, attempt weekly credits request with headers:
        - `Accept: application/json`
        - `Authorization: Bearer <access>`
        - `x-xai-token-auth: xai-grok-cli`
        - `x-authenticateresponse: authenticate-response`
        - `x-userid: <accountId>`
        - `x-grok-client-version: XAI_GROK_CLIENT_VERSION`
        - Prefer importing constants from `./xai-transport` rather than duplicating version.
        - Isolate throw/non-2xx/malformed/non-weekly into null so monthly can run.
        - On success return `report(provider, "xai:grok-billing-credits", { weeklyPercent, weeklyResetAt?, updatedAt })`.
     4. Legacy monthly fallback: current bare `/v1/billing` parse of `monthlyLimit/used` → `monthlyPercent`/`monthlyResetAt`, source remains `xai:grok-billing`.
   - Do not log tokens, user ids, or raw body fields.

2. MODIFY `tests/provider-quota.test.ts`
   - Existing multi-provider fixture currently mocks only bare `/v1/billing` and expects `xai.monthlyPercent === 25`. Keep that path green: either leave accountId absent so weekly is skipped, or answer weekly with non-weekly/null and still serve monthly.
   - Add focused xAI cases:
     - weekly success: credential with `accountId`, credits URL returns weekly envelope → `weeklyPercent` + `weeklyResetAt` + source `xai:grok-billing-credits`; assert request URL ends with `format=credits` and required headers present without asserting secret values beyond bearer token already used.
     - omitted percent → weekly 0
     - weekly non-2xx / malformed / non-weekly period → monthly fallback still works
     - missing accountId → skip weekly, monthly only
   - Keep privacy assertions: report JSON must not include access secrets / raw_secret fields.

### OUT

- GUI component rewrite (weekly bar already renders when `weeklyPercent` is present)
- Changing Codex WHAM weekly/monthly plan logic
- Live network smoke requiring real Grok auth (optional only)

## Activation scenarios (C)

1. Weekly non-zero path fires when mock returns `USAGE_PERIOD_TYPE_WEEKLY` + percent.
2. Weekly zero-omission path fires when percent key omitted.
3. Fallback activation: rejected weekly response still yields monthly percent from second call.
4. Missing identity skips credits URL entirely.

## Verification commands

```bash
bun test tests/provider-quota.test.ts
bun run typecheck
git diff --check
```

## Publish

- Branch: `codex/260808-1283-xai-weekly-quota`
- Commit message: `fix(quota): prefer Grok weekly credits for xAI dashboard`
- Push and open PR to `dev` with template + `Closes #1283` (user authorized push).


## Audit synthesis — round 1 (main, 2026-08-08)

Independent reviewer dispatch timed out with empty output; main agent performed the adversarial read-only audit against local code and ima2-gen.

Accepted amendments before B:

1. **Header case / constants (High):** use `XAI_GROK_COMPATIBILITY.headers.tokenAuth` / `authenticateResponse` / `clientVersion` and `XAI_GROK_CLIENT_VERSION` from `src/providers/xai-transport.ts`. Do not invent mixed-case aliases. Keep `x-userid` literal as in ima2-gen weekly path (not present on chat transport).
2. **Identity resolution (High):** read `getCredential("xai")?.accountId` first; if missing, decode JWT `sub` from the active access token the same way `getTokenIdentity` does (base64url payload). Missing identity skips weekly and falls back monthly.
3. **Client version (Medium):** use OpenCodex pinned `XAI_GROK_CLIENT_VERSION` rather than reading `~/.grok/version.json`. OpenCodex chat transport already pins this; weekly quota should match product identity, not require a local Grok CLI install.
4. **Percent semantics (Medium):** use `normalizePercent` (clamp, no Math.round) for consistency with other provider quota parsers in this file; tests must not assume integer rounding of 12.3.
5. **Source labels (Low):** weekly success → `xai:grok-billing-credits`; monthly fallback → `xai:grok-billing`.
6. **Exception isolation (High):** weekly attempt must catch network/JSON/parse failures and continue to monthly; never throw out of `fetchXaiQuota`.
7. **Fixture preservation (High):** existing multi-provider fixture saves credentials without accountId and mocks only bare `/v1/billing`; keep weekly skip-on-missing-identity so `monthlyPercent: 25` stays green. Focused weekly tests use credentials with accountId.
8. **No dual-window merge in v1:** when weekly succeeds, return weekly only (the gating window). Do not also attach stale monthly from a second call in the success path.
9. **Privacy:** never put accountId/user id into report objects or logs.

VERDICT: GO-WITH-FIXES (blockers=4 High folded into plan above)
