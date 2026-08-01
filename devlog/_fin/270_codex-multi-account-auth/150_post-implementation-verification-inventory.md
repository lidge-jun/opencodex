# 150 - Post-Implementation Verification Inventory

> Superseded security note (2026-06-25): This document predates the 280 security patch plan and Phase 10-60 hardening. Treat release-readiness, full-email UI, ordinal request-log labels, unauthenticated management API, fail-open fallback, and earlier account-boundary claims here as historical only. Current merge/deploy evidence is tracked under `devlog/280_codex-multi-auth-security-patch-plan/` and `devlog/_plan/260624_codex-multi-auth-security-implementation/`.

Date: 2026-06-24

Purpose: document the code-level fixes made during the Codex Auth hardening pass before entering a formal PABCD verification cycle.

Scope: Codex Auth dashboard, ChatGPT OAuth pool login, runtime config synchronization, pool quota display, request-log pool labels, quota refresh scaling, and Team/Business account collision handling.

## Status

Implementation state: code changes are applied and committed.

Verification state: targeted tests, full test suite, typecheck, GUI build, local API checks, proxy restart, and browser layout probes have already passed. A formal PABCD verification pass can now reuse this document as the source-of-truth inventory.

Sensitive data policy: account emails, token values, refresh tokens, and raw account IDs must not appear in logs, tests, docs, screenshots, or release examples. Any operational comparison should use masked values or short hashes only.

## Commit Inventory

| Commit | Area | Summary |
| --- | --- | --- |
| `56938f3` | Request logs | Label actual pool overrides as `chatgpt-1`, `chatgpt-2`, etc. |
| `3342b20` | Runtime config | Mutate live runtime config for active account, auto-switch, and delete operations. |
| `aa4e7b8` | OAuth lifecycle | Add cancellable ChatGPT OAuth login flow and cancel API. |
| `0683378` | OAuth UX | Change explicit login URL action from open to copy. |
| `de2f31e` | Quota refresh | Limit pool quota refresh concurrency so large pools do not fan out unbounded requests. |
| `6c2d7df` | OAuth runtime config | Fix OAuth completion using stale file config instead of live runtime config. |
| `f891486` | Quota UI/API | Add reset timestamps to quota API and align compact quota rows. |
| `5f95635` | Team account collision | Allow different Team/Business members that share `chatgpt_account_id` but have different emails. |
| `7edba42` | Module boundary | Split collision helpers into `src/codex-auth-collision.ts` to keep files under size limit. |

## File Inventory

### Backend and Runtime

| File | Role | Verification concern |
| --- | --- | --- |
| `src/server.ts` | Request routing, selected pool label, quota capture | Logs must show pool ordinal only, not emails or token identifiers. |
| `src/codex-auth-api.ts` | Codex Auth management API, quota fetch, login status | All config mutations must affect the running server and persisted config. |
| `src/codex-auth-collision.ts` | Main/pool identity collision detection | Team workspace members sharing account ID must be allowed only when email differs. |
| `src/codex-account-store.ts` | Pool credential storage and refresh | Tokens remain file-only and never appear in management API responses. |
| `src/oauth/index.ts` | OAuth flow lifecycle | Closing/canceling the modal must cancel the in-flight login flow. |

### GUI

| File | Role | Verification concern |
| --- | --- | --- |
| `gui/src/pages/CodexAuth.tsx` | Account cards, quota rows, active selection, refresh | New accounts must appear after login; quota rows must stay aligned. |
| `gui/src/components/AddCodexAccountModal.tsx` | ChatGPT login modal | User-facing action copies the login link; modal close cancels the login process. |
| `gui/src/styles.css` | Dashboard layout and quota alignment | Dark/light mode readability; quota columns must not drift by date width. |
| `gui/src/i18n/en.ts` / `ko.ts` / `zh.ts` | UI strings | Refresh, copy-link, cancellation, and quota labels must remain localized. |

### Tests

| File | Coverage |
| --- | --- |
| `tests/session-affinity.test.ts` | Pool log labels, active account resolution, auto-switch behavior. |
| `tests/codex-auth-api.test.ts` | Runtime config mutation, quota refresh, login cancel/status, live duplicate check. |
| `tests/codex-auth-collision.test.ts` | Team/Business same-account-id collision edge case. |

## Implemented Behavior

### Request Log Pool Labels

Provider log rows now distinguish main passthrough from pool overrides:

```text
main ChatGPT passthrough  -> chatgpt
first pool account        -> chatgpt-1
second pool account       -> chatgpt-2
unknown pool id           -> chatgpt
```

Rationale: request logs should answer "which pool slot was used?" without exposing local account IDs or emails.

### Live Runtime Config Synchronization

All Codex Auth management mutations must update both:

1. persisted `~/.opencodex/config.json`
2. in-memory runtime `OcxConfig` used by the running proxy

Previously fixed paths:

```text
PUT    /api/codex-auth/active
PUT    /api/codex-auth/auto-switch
DELETE /api/codex-auth/accounts
POST   /api/codex-auth/login completion
```

Regression guarded by tests that pass a live runtime config object and assert the API observes it without a restart.

### OAuth Login Flow Cancellation

ChatGPT OAuth login now has an abortable flow:

```text
User starts login
  -> backend starts login flow
  -> modal enters waiting state
  -> user closes modal or presses cancel
  -> GUI calls POST /api/codex-auth/login/cancel
  -> backend aborts the OAuth flow
  -> flow state is expired
```

The explicit login URL button now copies the URL rather than opening it.

### Account Pool Immediate Visibility

Root cause fixed: OAuth login completion shadowed the live `config` parameter with a file-loaded local `config`, so the account was persisted but not added to the running server's live config.

Fix: the OAuth path uses `getRuntimeConfig(config)` and `saveRuntimeConfig(config, latestConfig)`.

Expected behavior:

```text
Add account via OAuth
  -> credential saved
  -> account appended to live runtime config
  -> GET /api/codex-auth/accounts returns new account immediately
  -> UI reload shows the account without server restart
```

### Large Pool Quota Refresh

Pool quota refresh now uses bounded concurrency:

```text
POOL_QUOTA_REFRESH_CONCURRENCY = 4
```

Expected behavior for 30+ accounts:

```text
GET /api/codex-auth/accounts?refresh=1
  -> returns all configured accounts
  -> does not drop entries
  -> does not start one unbounded request per account
```

### Quota Reset Timestamps

WHAM usage includes reset timestamps:

```text
rate_limit.primary_window.reset_at
rate_limit.secondary_window.reset_at
```

API now exposes:

```ts
fiveHourResetAt?: number
weeklyResetAt?: number
```

The GUI formats quota as fixed columns:

```text
5h    resets    Today    HH:mm    [bar]    31%
Week  resets    M/D      HH:mm    [bar]    45%
```

Column alignment was browser-verified:

```text
desktop: day/time/bar/% x positions are identical across all quota rows
mobile: no horizontal overflow
```

### Team/Business Member Collision Handling

Observed production behavior:

```text
existing pool member and newly logged-in Team member:
  same chatgpt_account_id
  different email
  different WHAM usage quota
```

Conclusion: for Team/Business workspaces, `chatgpt_account_id` can identify the shared workspace, not necessarily the individual employee quota bucket.

New collision rule:

```text
same chatgptAccountId + same email      -> duplicate, reject
same chatgptAccountId + different email -> different Team member, allow
unknown email on either side            -> conservative duplicate, reject
```

This preserves duplicate protection while allowing employee accounts from the same Team workspace.

## Verification Already Run

### Static and Unit Verification

Commands run successfully:

```bash
git diff --check
bun run typecheck
bun test tests
```

Latest full-suite result:

```text
238 pass
0 fail
693 expect() calls
33 test files
```

Targeted test results:

```text
tests/codex-auth-api.test.ts        30 pass / 0 fail
tests/codex-auth-collision.test.ts   2 pass / 0 fail
```

### GUI Build

Command run successfully:

```bash
cd gui && bun run build
```

Purpose:

```text
tsc -b
vite production bundle
```

### Local API Verification

After proxy restart, `/api/codex-auth/accounts?refresh=1` returned:

```text
status: 200
accountCount: 3
mainCount: 1
poolCount: 2
quota reset timestamps present for all returned accounts
```

### Browser Layout Verification

Codex Auth dashboard was opened through the local browser automation path at:

```text
http://localhost:10100
```

Verified:

```text
desktop:
  quota day/time/bar/percent columns share identical x positions across rows

mobile-sized viewport:
  no horizontal overflow
  quota rows remain one-line rows
```

### Runtime Restart

Proxy was restarted after backend and GUI changes:

```bash
bun run src/cli.ts stop
bun run src/cli.ts ensure
```

Result:

```text
Proxy running on port 10100
```

## Verification Gaps for Formal PABCD

The implementation is locally verified, but a formal PABCD verification pass should still cover:

1. OAuth add flow with a new Team member account after the collision-rule change.
2. UI behavior when the login modal is closed during an active OAuth flow.
3. Request log labels during real Codex requests from main, pool 1, and pool 2.
4. New session routing after selecting a pool account as next session.
5. Auto-switch behavior when current active account exceeds the configured threshold.
6. Large-pool behavior using synthetic 30-account config, including refresh button responsiveness.
7. No sensitive data leakage in UI, logs, tests, docs, and API responses.
8. Dark mode readability for destructive X, quota reset text, and badges.

## Proposed PABCD Verification Plan

### P - Plan

Use this document as the inventory and define verification around observable outcomes:

```text
P1: Auth API correctness
P2: OAuth add/cancel flow
P3: Account pool visibility and large-pool behavior
P4: Request routing and request-log labels
P5: Quota UI layout and refresh behavior
P6: Sensitive data audit
```

### A - Plan Audit

Audit that the verification targets map to real files and real observable endpoints:

```text
/api/codex-auth/accounts
/api/codex-auth/active
/api/codex-auth/auto-switch
/api/codex-auth/login
/api/codex-auth/login-status
/api/codex-auth/login/cancel
/api/logs
```

### B - Build / Execute Verification

No new feature build should be needed. The B phase should execute probes:

```text
unit/type/build tests
browser GUI probes
manual OAuth add attempt for Team member
request-log probe using real Codex request
redaction scan for personal fixture leakage
```

### C - Check

Re-run:

```bash
git diff --check
bun run typecheck
cd gui && bun run build
bun test tests
```

Then verify the running proxy is using the latest source:

```bash
bun run src/cli.ts stop
bun run src/cli.ts ensure
```

### D - Done

Record final evidence in a follow-up devlog entry:

```text
devlog/270_codex-multi-account-auth/160_post-implementation-verification-results.md
```

## Current Risk Register

| Risk | Status | Mitigation |
| --- | --- | --- |
| Team workspace account IDs are shared | Confirmed | Collision now uses account ID + email. |
| Unknown email on one side could block a real member | Accepted conservative behavior | Requires visible email extraction or WHAM email before save. |
| Quota reset timestamps depend on WHAM response shape | Confirmed live once | Tests cover reset fields in fixture. |
| Existing pool state is in-memory for quota cache | Known | Refresh button forces WHAM fetch; request responses update cache. |
| Dashboard is served from built `gui/dist` | Known | Run `cd gui && bun run build` before proxy restart. |
| Browser click can open switch modal during visual checks | Known | Use DOM coordinate probes and close modal before screenshots. |

## Acceptance Criteria Before Release

Release should not proceed unless all are true:

```text
1. Full test suite passes.
2. GUI build passes.
3. Running proxy returns all configured accounts without restart after OAuth add.
4. Team member account with same chatgpt_account_id but different email can be added.
5. Same email/account duplicate is rejected.
6. Request logs show pool ordinal labels.
7. Quota rows remain aligned in light and dark mode.
8. API and docs do not expose raw personal account identifiers or tokens.
```
