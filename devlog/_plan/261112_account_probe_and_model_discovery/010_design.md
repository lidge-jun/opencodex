# Per-account probe and manual model discovery

Status: implemented on `feat/antigravity-account-probe`.

## Problem

1. `POST /api/providers/test` resolves only the active account's token, so an operator with a
   pool of Google Antigravity accounts cannot tell which individual accounts still work. Accounts
   that started returning `permission_denied` could only be checked with an out-of-tree script.
2. Model discovery runs implicitly (catalog convergence, `liveModels`). There is no per-provider
   "discover now" action, and recent arrivals only show as small NEW badges on the Models page.

## 1. Per-account probe

`POST /api/oauth/accounts/probe` — body `{ "provider": "google-antigravity", "accountId"?: string }`.
Omitting `accountId` probes every stored account (concurrency 4). Response:

```json
{ "provider": "google-antigravity", "probedAt": "<iso>",
  "results": [{ "accountId": "…", "maskedLabel": "a***b@example.com", "active": true, "paused": false,
                "status": "ok", "httpStatus": 200, "reason": null, "message": null,
                "expiresAt": 0, "latencyMs": 412, "quota": { "customWindows": [] } }] }
```

`status` is one of:

| status | meaning | rule |
| --- | --- | --- |
| `ok` | usable | HTTP 200 |
| `token_expired` | stored access token expired, not refreshed | `credential.expires <= now`; no request is sent |
| `suspended` | upstream says the account is suspended/disabled | 403 whose reason/message names suspension, disablement or ToS |
| `verification_required` | upstream asks the user to verify the account | 403 with `details[].reason == VALIDATION_REQUIRED` or "verify your account" wording |
| `rate_limited` | throttled / quota exhausted | 429 or `RESOURCE_EXHAUSTED` |
| `permission_denied` | other 403 | 403 |
| `error` | anything else (401, 5xx, transport, missing project) | `httpStatus` and `reason` carry the detail |

Read-only by construction:

- Uses the account's stored access token exactly as read through `getAccountSet()`; never calls
  `getValidAccessToken`, never refreshes, never writes the auth store, never changes pause,
  active, cooldown or health state. Paused accounts are probed too (that is the point), but stay
  paused.
- One request: `POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`
  with `{ "project": <projectId> }` and `User-Agent: antigravityCliUserAgent()`. Unlike the quota
  poller there is no 403 retry under the IDE UA and no `fetchAvailableModels` fallback: the
  first answer is the evidence, and the CLI fingerprint is the one that reports the Gemini group.
- Goes through the pinned provider-outbound transport used by the quota poller.
- The response carries no token. `message` is Google's error message passed through
  `sanitizeUpstreamErrorText` and truncated to 300 characters.

Only `google-antigravity` is supported for now; other providers get HTTP 400
`account probe is not supported for this provider`. The request/response shape is provider-neutral
so another provider can plug in a probe function later.

CLI: `ocx account probe <provider> [<account-id|alias>] [--json]` (capability registered in
`src/cli/capabilities-accounts.ts`).

GUI: Providers → Google Antigravity → Available accounts. Each account row gets a **Test** button;
the result renders under the row as a coloured badge plus `HTTP <code> · <reason> · <message>`.
The section head gets **Test all**.

## 2. Manual model discovery

`POST /api/model-discovery/refresh` — body `{ "provider": "<name>" }`.

1. 404 for an unknown provider; `{ ok: false, applicable: false, reason: "static_catalog" }` when the
   provider has `liveModels: false` (no live endpoint to ask).
2. Snapshot the provider's `recentArrivals` ids, `clearModelCache(provider)`, then run the normal
   catalog convergence (`convergeCodexCatalog`), which re-fetches the provider and records new
   arrivals through the existing new-model policy.
3. Respond with `{ ok, provider, discovery, liveModelCount, newArrivals, recentArrivals, catalogRefresh }`,
   where `newArrivals` are the arrivals recorded by this call and `discovery` is the provider's
   discovery status (`ok` / `failed` + reason / http status).

CLI: `ocx models discover <provider> [--json]`.

GUI: provider settings, directly under the "Discover models from provider" toggle: a
**Discover now** button and a "Recently added" list (newest first, with date and whether the model
was auto-disabled by the new-model policy).

## Not changed

- `POST /api/providers/test` and the active-account path.
- Token refresh, re-login, pause/resume semantics.
