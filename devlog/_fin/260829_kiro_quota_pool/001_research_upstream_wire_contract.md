# 001 — The Kiro usage-limits wire contract

Source of truth for this document: the observed Kiro CLI 2.19.x contract, cross-checked
against two independent third-party implementations. This operation is **undocumented** by
AWS; treat every field as best-effort and never fail a request because it changed.

## The operation

```http
POST /?origin=AI_EDITOR&isEmailRequired=true&profileArn=<optional>
Host: management.<region>.kiro.dev
Authorization: Bearer <access token>
Content-Type: application/x-amz-json-1.0
Accept: application/json
x-amz-target: AmazonCodeWhispererService.GetUsageLimits
```

```json
{ "origin": "AI_EDITOR", "isEmailRequired": true, "profileArn": "<optional>" }
```

Two details that look like mistakes and are not:

- **The modeled arguments appear in both the query string and the JSON body.** That is the
  observed CLI behaviour. Reproduce it rather than "simplifying" it; an AWS JSON-RPC
  front door that also reads query parameters will accept both, and we have no way to test
  which one it actually honours.
- **The host is `management.`, not `runtime.`** Generation goes to
  `runtime.{region}.kiro.dev`; usage goes to a different subdomain. Our provider
  `baseUrl` is the runtime host, so the quota fetcher must derive the management host
  rather than reuse `baseUrl`.

### Region resolution

The profile ARN is authoritative when present: `arn:aws:codewhisperer:<region>:<acct>:profile/<id>`
— take field 3. Otherwise fall back to the account's stored `apiRegion`, then `ssoRegion`,
then `us-east-1`. We already have all three on the credential
(`src/oauth/kiro-credentials.ts:285`) and a resolver in `src/oauth/kiro.ts:445`.

## Response shape

```json
{
  "subscriptionInfo": { "subscriptionTitle": "KIRO PRO", "type": "Q_DEVELOPER_..." },
  "overageConfiguration": { "overageStatus": "ENABLED|DISABLED" },
  "usageBreakdownList": [
    {
      "resourceType": "AGENTIC_REQUEST|CREDIT|...",
      "currentUsageWithPrecision": 147.82,
      "currentUsage": 147,
      "usageLimitWithPrecision": 1000.0,
      "usageLimit": 1000,
      "currentOveragesWithPrecision": 0.0,
      "overageRate": 0.04,
      "unit": "CREDITS|INVOCATIONS",
      "freeTrialInfo": { "freeTrialStatus": "ACTIVE", "usageLimitWithPrecision": 500.0 }
    }
  ],
  "userInfo": { "email": "...", "userId": "..." },
  "nextDateReset": 1785542400.0,
  "daysUntilReset": 3
}
```

### Field handling rules

1. **Prefer `*WithPrecision`.** Kiro meters to 0.01 credit; the integer fields round
   695.17 down to 695. Fall back to the integer only when precision is absent.
2. **Select the breakdown by `resourceType`, never by index.** Take `AGENTIC_REQUEST`
   first, then `CREDIT`; if neither exists, report unknown rather than guessing. Taking
   `[0]` means an upstream reorder silently reweights routing against an unrelated pool.
3. **`currentUsage > usageLimit` is not necessarily exhaustion** when
   `overageStatus` is `ENABLED` — enterprise accounts keep serving past the included
   limit. Percent must clamp for display, but exhaustion must consult overage status.
4. **`userInfo.email` is a personal identifier.** We request `isEmailRequired` because
   the response shape is the observed contract, but the email must never be logged and
   never persisted into quota state. Our account rows already carry a masked identity.
5. **`freeTrialInfo` is a separate pool.** kiro-lb ignores it, which understates the
   usable balance for trial users. We record it as its own window.

## Cadence

Kiro's own pricing page says usage data refreshes "at least every 5 minutes", so polling
faster buys nothing. The existing provider cache TTL is 5 minutes
(`src/providers/quota.ts:37`) and the per-account TTL governs account rows; both are
already at or above the useful floor. No new timer is needed — the existing pull-on-demand
plus TTL is the right shape, and it means an idle proxy makes zero usage calls.

## Auth-mode caveats

- **Enterprise / IdC accounts** carry a real profile ARN → send it.
- **AWS Builder ID** has no account-owned profile. We already resolve a *request-scoped*
  service profile (`src/adapters/kiro-constants.ts:16`, applied at
  `src/oauth/kiro.ts:508`) which must never be persisted as identity. For usage, send
  the request-scoped value the same way the generation path does.
- **`ksk_` API keys** are not OAuth accounts, have no refresh identity, and there is no
  evidence `GetUsageLimits` accepts the `tokentype: API_KEY` contract. Out of scope:
  report unknown.
