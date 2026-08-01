# 290-01 Codex-rs Rate-Limit Reset Credits — API Research

## Source Commits

| Commit | PR | Author | Date | Scope |
|--------|-----|--------|------|-------|
| `bef99f861` | #28143 | jay@openai.com | 2026-06-15 | Backend + protocol foundation |
| `f8f5a6e78` | #28154 | jay@openai.com | 2026-06-16 | TUI `/usage` redemption flow |
| `5c0fbf349` | #28793 | ? | 2026-06-?? | Fix usage-limit reset copy + state |

## Backend API Endpoints

### GET `/wham/usage` (existing, extended)

Already called by opencodex at `codex-auth-api.ts:106,137,349`.

New response field:
```json
{
  "rate_limit_reset_credits": {
    "available_count": 2
  }
}
```

Field is nullable — absent for workspace accounts or backends that don't
support the feature yet.

### POST `/wham/rate-limit-reset-credits/consume` (new)

**Request:**
```json
{
  "redeem_request_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

`redeem_request_id` = caller-generated UUID. Reuse the same key when retrying
the same logical reset attempt (idempotency).

**Response:**
```json
{
  "code": "reset"
}
```

### Consume Outcome Codes

| Code | Meaning | Action |
|------|---------|--------|
| `reset` | Credit consumed, windows reset | Refetch `/wham/usage` for new state |
| `nothing_to_reset` | No window is eligible for reset | Inform user |
| `no_credit` | Account has 0 available credits | Inform user |
| `already_redeemed` | Same UUID was already used | Safe to ignore (idempotent) |

### Authentication

Both endpoints require:
```
Authorization: Bearer <accessToken>
ChatGPT-Account-Id: <chatgptAccountId>
```

Same credentials already stored per-account in opencodex's
`codex-accounts.json` and refreshed via `getValidCodexToken()`.

### Timeout

Codex-rs uses 10 seconds:
```rust
const RATE_LIMIT_RESET_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
```

## Protocol Types (Rust → TypeScript mapping)

### RateLimitResetCreditsSummary
```rust
pub struct RateLimitResetCreditsSummary {
    pub available_count: i64,
}
```
→ `{ availableCount: number }` (camelCase on wire)

### ConsumeAccountRateLimitResetCreditParams
```rust
pub struct ConsumeAccountRateLimitResetCreditParams {
    pub idempotency_key: String,
}
```
→ `{ idempotencyKey: string }`

### ConsumeAccountRateLimitResetCreditOutcome
```rust
pub enum ConsumeAccountRateLimitResetCreditOutcome {
    Reset,
    NothingToReset,
    NoCredit,
    AlreadyRedeemed,
}
```
→ `"reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed"` (camelCase)

**Note**: The backend (wham) API uses `snake_case` (`redeem_request_id`,
`nothing_to_reset`). The app-server protocol uses `camelCase`
(`idempotencyKey`, `nothingToReset`). opencodex calls wham directly,
so we use **snake_case** for the backend call.

## TUI State Machine (codex-rs reference)

File: `codex-rs/tui/src/chatwidget/usage.rs` (382 lines)

```
/usage command
  ↓
Menu: [Token activity] [Earned rate-limit resets]
  ↓ (select resets)
Loading... (fetch rateLimits)
  ↓
[No credits] → show empty state, dismiss
  ↓ (has credits)
Confirmation: "Use 1 of N credits to reset?"
  ↓ (confirm)
POST consume with UUID
  ↓
[reset]            → success message + refetch
[nothing_to_reset] → "No window needs resetting"
[no_credit]        → "No credits" (race condition)
[already_redeemed] → treat as success
[error]            → retry option (reuse same UUID)
```

### Workspace Exclusion

codex-rs hides the reset menu entry for workspace accounts.
opencodex should check `plan_type` — if it contains "team" or "enterprise"
or if the account is flagged as workspace, skip the redeem button.

### Availability Hint

codex-rs shows a hint when:
1. A backend-classified rate-limit error occurs
2. The account has `available_count > 0`
3. Not a workspace account

opencodex equivalent: when a 429 response is received and the account
has `resetCredits > 0`, show a notification in the dashboard.

## Community State

| Resource | Status |
|----------|--------|
| hascodexratelimitreset.today | Tracking site only, no API |
| Third-party implementations | **None found** — opencodex would be first |
| Codex CLI v0.135+ | Has `/usage` → reset flow |
| Codex App v26.609+ | Has reset banking in usage menu |

## opencodex Existing Infrastructure

| Component | File | Ready? |
|-----------|------|--------|
| `GET /wham/usage` call per account | `codex-auth-api.ts:106,137,349` | ✅ Already calling |
| Auth token per pool account | `codex-account-store.ts` | ✅ `getValidCodexToken()` |
| Quota storage per account | `codex-quota.ts` | ✅ `StoredAccountQuota` map |
| Dashboard quota display | `gui/src/pages/CodexAuth.tsx` | ✅ QuotaRow component |
| Account routing | `codex-routing.ts` | ✅ Pool-aware selection |
| `WhamUsageResponse` type | `codex-quota.ts:11-19` | ❌ Missing `rate_limit_reset_credits` |
| Consume API proxy | — | ❌ Not implemented |
| CLI usage command | `cli.ts` | ❌ No `ocx usage` subcommand |
