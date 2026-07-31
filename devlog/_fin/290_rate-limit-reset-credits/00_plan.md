# 290 Rate-Limit Reset Credits — Implementation Plan

## Objective

Add Codex rate-limit reset credit viewing and redemption to opencodex.
Users can see how many banked reset credits each pool account has,
and redeem them from the CLI (`ocx usage`) or Dashboard GUI (CodexAuth tab).

Pool-aware: every account in `codex-accounts.json` is independently queryable
and redeemable, using each account's own OAuth credentials.

## Background

Codex app v26.609+ / CLI v0.135+ added self-service rate-limit reset credits
(PR #28143, #28154). Users earn credits (monthly baseline + referral program)
and redeem them to instantly reset their hourly/weekly usage windows.

**Source of truth**: commits `bef99f861` and `f8f5a6e78` in `openai/codex`.

### API Contract (from codex-rs)

**Read credits** — already called by opencodex:

```
GET https://chatgpt.com/backend-api/wham/usage
Headers: Authorization: Bearer <accessToken>
         ChatGPT-Account-Id: <chatgptAccountId>

Response (new field):
{
  ...existing rate_limit fields...,
  "rate_limit_reset_credits": {        // nullable — absent for old backends
    "available_count": 2               // integer
  }
}
```

**Consume a credit**:

```
POST https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume
Headers: Authorization: Bearer <accessToken>
         ChatGPT-Account-Id: <chatgptAccountId>
Content-Type: application/json
Body: { "redeem_request_id": "<UUID v4>" }

Response:
{
  "code": "reset"              // success
       | "nothing_to_reset"    // no window eligible
       | "no_credit"           // 0 credits
       | "already_redeemed"    // same UUID already used
}
```

**Timeout**: 10 seconds (codex-rs constant).

## Classification

C2 (Ordinary Product Slice): single feature — read endpoint already called,
add one new POST proxy + extend existing types + GUI component.
No public API contract change (internal dashboard/CLI only).

## Phase Map

| Phase | Scope | Deliverable |
|-------|-------|-------------|
| **Phase 1** | Backend types + API proxy | `WhamUsageResponse` extension, consume proxy route, `codex-auth-api.ts` endpoint |
| **Phase 2** | CLI `ocx usage` enhancement | Show reset credits in `ocx usage`, add `ocx reset-limit` subcommand |
| **Phase 3** | Dashboard GUI | CodexAuth.tsx reset credit display + redeem button per account |
| **Phase 4** | Tests | Unit tests for parsing, proxy, CLI output |

---

## Phase 1 — Backend Types + API Proxy

### 1.1 MODIFY `src/codex-quota.ts`

Extend `WhamUsageResponse` to include reset credits:

```typescript
// BEFORE (line 11-19)
export type WhamUsageResponse = {
  email?: string | null;
  plan_type?: string | null;
  rate_limit?: {
    primary_window?: { used_percent?: number; reset_at?: number };
    secondary_window?: { used_percent?: number; reset_at?: number };
    tertiary_window?: { used_percent?: number; reset_at?: number };
  };
};

// AFTER
export type WhamUsageResponse = {
  email?: string | null;
  plan_type?: string | null;
  rate_limit?: {
    primary_window?: { used_percent?: number; reset_at?: number };
    secondary_window?: { used_percent?: number; reset_at?: number };
    tertiary_window?: { used_percent?: number; reset_at?: number };
  };
  rate_limit_reset_credits?: {
    available_count: number;
  } | null;
};
```

Extend `StoredAccountQuota` to store reset credit count:

```typescript
// BEFORE (line 1-9)
export type StoredAccountQuota = {
  weeklyPercent?: number;
  fiveHourPercent?: number;
  monthlyPercent?: number;
  weeklyResetAt?: number;
  fiveHourResetAt?: number;
  monthlyResetAt?: number;
  updatedAt: number;
};

// AFTER — add one field
export type StoredAccountQuota = {
  weeklyPercent?: number;
  fiveHourPercent?: number;
  monthlyPercent?: number;
  weeklyResetAt?: number;
  fiveHourResetAt?: number;
  monthlyResetAt?: number;
  resetCredits?: number;           // NEW: banked reset credits (0 = none, undefined = not fetched)
  updatedAt: number;
};
```

Update `parseUsageQuota()` to capture the new field.
Parse `resetCredits` BEFORE the early `hasKnownQuotaValue` return,
so credits-only responses (no `rate_limit` windows) are not dropped:

```typescript
// Parse resetCredits early — before rate_limit check
export function parseUsageQuota(data: WhamUsageResponse): Omit<StoredAccountQuota, "updatedAt"> | null {
  const resetCredits = typeof data.rate_limit_reset_credits?.available_count === "number"
    ? data.rate_limit_reset_credits.available_count
    : undefined;

  if (!data.rate_limit) {
    // Credits-only response: return quota with just resetCredits
    return resetCredits !== undefined ? { resetCredits } : null;
  }

  const quota: Omit<StoredAccountQuota, "updatedAt"> = {};
  // ... existing window parsing ...
  if (resetCredits !== undefined) quota.resetCredits = resetCredits;
  return hasKnownQuotaValue(quota) || resetCredits !== undefined ? quota : null;
}
```

Update `updateAccountQuota()` signature to accept `resetCredits`,
and preserve existing `resetCredits` when the param is omitted
(important: `server.ts:358-367` calls this with header-only data):

```typescript
// Add optional parameter + preserve existing value when omitted
export function updateAccountQuota(
  accountId: string,
  weekly: unknown,
  fiveHour: unknown,
  weeklyResetAt?: unknown,
  fiveHourResetAt?: unknown,
  monthly?: unknown,
  monthlyResetAt?: unknown,
  resetCredits?: number,          // NEW
): void {
  // ... existing merge code ...
  // PRESERVE existing resetCredits when not provided (header-only updates)
  ...(existing?.resetCredits !== undefined ? { resetCredits: existing.resetCredits } : {}),
  // ... end of existing merge ...
  if (resetCredits !== undefined) quota.resetCredits = resetCredits;
  accountQuota.set(accountId, quota);
}
```

### 1.2 MODIFY `src/codex-auth-api.ts`

Update `fetchPoolAccountQuota()` to pass `resetCredits` through:

```typescript
// In fetchPoolAccountQuota() (line ~143-153)
    const quota = parseUsageQuota(data);
    if (!quota) return { quota: existing ?? null, needsReauth: false };
    updateAccountQuota(
      accountId,
      quota.weeklyPercent,
      quota.fiveHourPercent,
      quota.weeklyResetAt,
      quota.fiveHourResetAt,
      quota.monthlyPercent,
      quota.monthlyResetAt,
      quota.resetCredits,          // NEW
    );
```

Update `fetchMainAccountInfo()` to include `resetCredits` in its return:

```typescript
// In fetchMainAccountInfo() — extend result object
    const result = {
      email: data.email ?? null,
      plan: data.plan_type ?? null,
      quota: parseUsageQuota(data),
      resetCredits: data.rate_limit_reset_credits?.available_count ?? null,  // NEW
      ts: Date.now(),
    };
```

Update all callers of `updateAccountQuota` in `codex-auth-api.ts` (both
`fetchPoolAccountQuota` and the OAuth login path at ~line 369-377) to pass
the 8th `resetCredits` argument.

Add new consume endpoint handler inside `handleCodexAuthAPI()`:

```typescript
// NEW route: POST /api/codex-auth/reset-credits/consume
if (url.pathname === "/api/codex-auth/reset-credits/consume" && req.method === "POST") {
  const body = await req.json() as { accountId: string };
  if (!body.accountId) return jsonResponse({ error: "accountId required" }, 400);

  // Resolve credentials: __main__ uses readCodexTokens(), pool uses getValidCodexToken()
  let accessToken: string;
  let chatgptAccountId: string;
  const isMain = body.accountId === "__main__";

  try {
    if (isMain) {
      const tokens = readCodexTokens();
      if (!tokens) return jsonResponse({ error: "Main Codex account not logged in" }, 401);
      accessToken = tokens.access_token;
      chatgptAccountId = tokens.account_id;
    } else {
      const cred = await getValidCodexToken(body.accountId);
      accessToken = cred.accessToken;
      chatgptAccountId = cred.chatgptAccountId;
    }

    const idempotencyKey = crypto.randomUUID();
    const resp = await fetch(
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "ChatGPT-Account-Id": chatgptAccountId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ redeem_request_id: idempotencyKey }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return jsonResponse({ error: `Upstream error ${resp.status}`, detail: text }, resp.status);
    }
    const result = await resp.json();
    // Refresh quota after successful consume — use correct refresh path
    if (result.code === "reset") {
      if (isMain) {
        await fetchMainAccountInfo(true);
      } else {
        await fetchPoolAccountQuota(body.accountId, true);
      }
    }
    return jsonResponse(result);
  } catch (e) {
    return jsonResponse({ error: String(e) }, 500);
  }
}
```

### 1.3 Routing note

`server.ts:1100-1102` already forwards all `/api/codex-auth/*` to
`handleCodexAuthAPI()`. No routing change needed. `router.ts` is
provider model routing — NOT edited.

---

## Phase 2 — CLI Enhancement

### 2.1 MODIFY `src/cli.ts`

Add `ocx usage` subcommand (or enhance existing status output):

```
$ ocx usage

  Codex Account Usage
  ─────────────────────────────────────────
  Main (user@example.com, Pro)
    5h:     ████████░░  80%   resets 14:35
    Weekly: ██░░░░░░░░  20%   resets Mon
    30d:    █░░░░░░░░░  10%   resets Jul 15
    Reset credits: 2 available

  Pool: work (work@corp.com, Plus)
    5h:     ██████████  100%  RATE LIMITED
    Weekly: ██████░░░░  60%   resets Mon
    30d:    ███░░░░░░░  30%   resets Jul 15
    Reset credits: 1 available
```

Add `ocx reset-limit <accountId>` subcommand:

```
$ ocx reset-limit work

  Redeeming 1 reset credit for "work" (work@corp.com)...
  ✓ Rate limit windows reset successfully.
  Remaining credits: 0

$ ocx reset-limit work
  ✗ No reset credits available for "work".
```

Implementation: HTTP call to `POST http://localhost:<port>/api/codex-auth/reset-credits/consume`.

**Prerequisite**: opencodex server must be running (`ocx start`).
Both `ocx usage` and `ocx reset-limit` resolve the port from config
(`config.port`, default 10100) and fail fast with a clear message if
the server is not reachable:

```
$ ocx reset-limit work
  ✗ opencodex server is not running. Start it with: ocx start
```

This is the first CLI feature that depends on a live server. The pattern
sets a precedent for future CLI-to-server commands.

---

## Phase 3 — Dashboard GUI

### 3.1 MODIFY `gui/src/pages/CodexAuth.tsx`

Extend `AccountQuota` interface (lines 7-15) with `resetCredits`:

```tsx
// ADD to existing AccountQuota interface
resetCredits?: number;
```

Add reset credits display inside `QuotaBars` component (used by both
main and pool account cards), after the existing QuotaRow entries:

```tsx
// Inside QuotaBars, after the three QuotaRow entries
{quota.resetCredits != null && quota.resetCredits > 0 && (
  <div className="reset-credits-row">
    <span className="reset-credits-label">{t("codexAuth.resetCredits")}</span>
    <span className="reset-credits-count">{quota.resetCredits}</span>
    <button
      className="reset-credits-btn"
      onClick={() => handleRedeemResetCredit(accountId)}
      disabled={redeemingAccount === accountId}
    >
      {redeemingAccount === accountId ? t("codexAuth.redeeming") : t("codexAuth.redeemReset")}
    </button>
  </div>
)}
```

This renders in both the main account card (~line 113) and pool account
cards (~line 194), since both use `QuotaBars`.

Workspace exclusion: hide the redeem button when `plan` contains
"team" or "enterprise" (matching codex-rs behavior):

```tsx
const isWorkspace = (plan?: string) =>
  plan && /team|enterprise/i.test(plan);

// In QuotaBars, guard the button:
{!isWorkspace(account.plan) && quota.resetCredits > 0 && ( ... )}
```

Add redeem handler:

```tsx
const [redeemingAccount, setRedeemingAccount] = useState<string | null>(null);

async function handleRedeemResetCredit(accountId: string) {
  if (!confirm(t("codexAuth.confirmRedeem"))) return;
  setRedeemingAccount(accountId);
  try {
    const resp = await fetch("/api/codex-auth/reset-credits/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId }),
    });
    const result = await resp.json();
    if (result.code === "reset") {
      load();  // Refresh accounts to update quota display
    } else {
      alert(t(`codexAuth.resetOutcome.${result.code}`));
    }
  } catch {
    alert(t("codexAuth.resetError"));
  } finally {
    setRedeemingAccount(null);
  }
}
```

### 3.2 MODIFY `gui/src/i18n/en.ts`

```typescript
"codexAuth.resetCredits": "Reset credits",
"codexAuth.redeemReset": "Use reset",
"codexAuth.redeeming": "Resetting...",
"codexAuth.confirmRedeem": "Use 1 reset credit to clear your current rate limits?",
"codexAuth.resetOutcome.reset": "Rate limits reset successfully!",
"codexAuth.resetOutcome.nothing_to_reset": "No rate-limit window needs resetting right now.",
"codexAuth.resetOutcome.no_credit": "No reset credits available.",
"codexAuth.resetOutcome.already_redeemed": "This reset was already applied.",
"codexAuth.resetError": "Failed to redeem reset credit. Please try again.",
```

### 3.3 MODIFY `gui/src/styles.css`

```css
.reset-credits-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  font-size: 12px;
}
.reset-credits-count {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.reset-credits-btn {
  margin-left: auto;
  padding: 3px 10px;
  font-size: 11px;
  border-radius: 4px;
  background: var(--accent);
  color: var(--accent-ink);
  border: none;
  cursor: pointer;
}
.reset-credits-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

---

## Phase 4 — Tests

### 4.1 NEW `tests/rate-limit-reset-credits.test.ts`

Test cases:
1. `parseUsageQuota` correctly extracts `resetCredits` from `WhamUsageResponse`
2. `parseUsageQuota` returns `undefined` when field is absent (backward compat)
3. `updateAccountQuota` stores and retrieves `resetCredits`
4. Consume endpoint returns correct outcomes (mock fetch)
5. Consume refreshes quota after successful reset

---

## File Change Summary

| Action | File | Change |
|--------|------|--------|
| MODIFY | `src/codex-quota.ts` | Add `resetCredits` to types + parsing |
| MODIFY | `src/codex-auth-api.ts` | Pass `resetCredits` through + add consume endpoint |
| MODIFY | `src/cli.ts` | `ocx usage` + `ocx reset-limit` subcommands |
| MODIFY | `gui/src/pages/CodexAuth.tsx` | Reset credits display + redeem button |
| MODIFY | `gui/src/i18n/en.ts` | Translation keys |
| MODIFY | `gui/src/styles.css` | Reset credits styling |
| NEW    | `tests/rate-limit-reset-credits.test.ts` | Unit tests |

## Audit Fixes Applied (from Backend employee audit)

| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| 1 | CRITICAL | Main account (`__main__`) consume path undefined | Added `readCodexTokens()` branch in consume handler |
| 2 | CRITICAL | Post-consume refresh wrong for main | Added `fetchMainAccountInfo(true)` for main path |
| 3 | MAJOR | `updateAccountQuota` merge drops `resetCredits` | Added preservation of `existing.resetCredits` |
| 4 | MAJOR | `parseUsageQuota` drops credits-only responses | Parse `resetCredits` before `rate_limit` null check |
| 5 | MAJOR | GUI misaligned with QuotaBars/AccountQuota | Fixed to extend `AccountQuota` interface, place inside `QuotaBars` |
| 6 | MODERATE | Workspace exclusion not planned | Added `isWorkspace()` guard on redeem button |
| 7 | MODERATE | CLI server dependency undocumented | Documented port resolution + fail-fast pattern |
| 8 | MINOR | Phase 1.3 routing ambiguity | Clarified: only `server.ts` matters, `router.ts` not edited |
| 9 | MINOR | CSS token mismatch | Fixed `var(--bg)` → `var(--accent-ink)` |
| 10 | MINOR | OAuth login path not listed | Added note to update all `updateAccountQuota` callers |

## Risks & Notes

1. **No actual credit consumed during development** — test with mocked responses only.
   Live testing requires a real Codex account with credits (do manually post-merge).
2. **Backend field availability** — `rate_limit_reset_credits` may be absent for older
   backends or non-Pro accounts. All parsing is nullable/optional.
3. **Idempotency** — UUID generated server-side per request. Retries use the same
   key only within the same HTTP request (no persistence needed).
4. **Workspace accounts** — excluded from redeem button via `plan_type` regex guard.
5. **CLI requires running server** — `ocx usage` and `ocx reset-limit` need `ocx start`.
   Fail fast with clear message if server unreachable.
