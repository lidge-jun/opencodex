# wp11 — #1082 per-account Gem/Cla quota for Google Antigravity (reimplementation; PR #2123 closed)

Issue #1082 (score 63). PR #2123 (chilung-cgu, +755/-40, 319 commits behind, hygiene/enforce-target
red) carried two reviewer blockers across three rounds: (1) cache/in-flight identity ignores the
configurable Antigravity destination so a baseUrl change replays stale rows and stale writers can
publish across generations; (2) every stored account bearer goes out through plain `fetch` to a
configurable host without the repository's pinned provider-outbound transport.

## Design (removes both blockers by construction)

- `supportsPerAccountQuota`: add `google-antigravity`.
- `fetchAccountQuota`: branch for `google-antigravity` → `fetchAntigravityUsageQuota(token, projectId)`,
  where token comes from `getTokenForAccountQuotaProbe` (same refresh hygiene as Anthropic) and
  projectId from that account's stored credential; missing projectId → throw → existing
  negative-cache/unavailable path (never 0%).
- Destination: per-account probes go to the registry destination for the account's credential
  (`https://daily-cloudcode-pa.googleapis.com`) only — not `config.baseUrl`. Per-account quota is
  a display of Google's own accounting for that credential; a custom base URL is a routing choice,
  not a second quota source. With a fixed destination the cache key `provider\0accountId` stays
  correct and generation reconciliation keeps working unchanged (blocker 1 gone). Documented.
- Transport: `providerOutboundPost("google-antigravity", { baseUrl: DAILY }, url, ...)` — the shared
  resolved/pinned transport with `redirect: "manual"` semantics; `providerRedirectError` → null
  quota (blocker 2 gone). The provider-level probe keeps its current behavior (out of scope).
- Parsing: extract the existing `fetchAvailableModels` → `customWindows` classification into
  `antigravityWindowsFromModels(body)` and reuse it in both paths so Gem/Cla semantics are identical.
- Route/UI: nothing to change — `/api/oauth/accounts?quota=1` already projects `quota.customWindows`
  through the account list, and the dashboard renders customWindows for Anthropic rows today.

## Acceptance
- Two stored Antigravity accounts → two rows, each probed with its own bearer and its own project id,
  to the fixed Google host; a private/redirecting destination is never given a token (transport test).
- Missing projectId → unavailable, no request, other account unaffected.
- Provider-level report unchanged (existing `tests/provider-quota.test.ts` green).
- `supportsPerAccountQuota("google-antigravity") === true`; unknown/failed never becomes 0%.
- tsc, privacy, focused: provider-account-quota, provider-quota, oauth-account-routes-related file.
- Close #2123 with credit for the account loop + token hygiene design and the reasons above.

