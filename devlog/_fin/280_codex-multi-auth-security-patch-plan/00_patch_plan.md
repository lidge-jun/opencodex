# 280 - Codex Multi-Auth Security Patch Plan

Date: 2026-06-24

Status: patch plan.

## Summary

This plan supersedes the release-readiness language in `devlog/270_codex-multi-account-auth/160_post-implementation-verification-results.md` for any main-merge or externally reachable deployment decision.

The phase `270` implementation is still useful as a local experimental baseline, but the combined external reviews found account-boundary failures that must be fixed before main merge.

Readiness:

| Target | Decision | Conditions |
| --- | --- | --- |
| Dev-only local test | CONDITIONAL-GO | Loopback-only, disposable accounts, one process, WebSocket disabled, manual import disabled, and no inbound/main credential that can receive fallback traffic. |
| Main merge | NO-GO | Blocked by pool-to-main fallback, non-atomic account deletion, unauthenticated local API exposure, manual import identity trust, and unsafe config/account disclosure. |

## Evidence Inputs

| Source | Evidence status |
| --- | --- |
| First ChatGPT Pro review with redacted devlog zip | Useful for broad multi-auth risk discovery, but source evidence was partly caveated because GitHub cache did not expose latest `35e4ff6`. |
| Full-source ChatGPT Pro review package | Stronger source evidence: `git archive HEAD` package at `35e4ff6ab32643488062764f0653ccf71e4e6877` plus redacted devlog. |
| Local source check after first review | Confirmed HTTP and WebSocket pool-token failure can fall through to inbound/main auth. |
| Devlog `270` phases | Historical implementation and verification context; treated as documentation, not proof of correctness. |

Review package used for full-source pass:

```text
/tmp/opencodex-full-source-and-devlog-review.zip
commit: 35e4ff6ab32643488062764f0653ccf71e4e6877
```

## Retractions And Downgrades

These earlier review claims should not drive the patch plan as originally phrased:

| Prior claim | Updated assessment |
| --- | --- |
| No refresh concurrency lock exists. | Retract. `src/codex-account-store.ts` has an in-process single-flight lock. Remaining issue is alias-scoped, process-local locking and stale writes. |
| Rotated refresh tokens are not persisted. | Retract. Returned refresh tokens are saved. Remaining issue is concurrent rotation/replacement/deletion safety. |
| No thread affinity exists. | Retract. Thread affinity exists in `src/codex-routing.ts`; lifecycle validation, deletion purge, TTL/LRU, and bounds are missing. |
| Normal request logs expose exact account IDs or tokens. | Retract. Request logs use safe ordinal pool labels. Remaining issue is label stability and durable console/service logs. |
| WebSocket completely bypasses the handler. | Downgrade. WebSocket frames pass through `handleResponses()`, but the upgrade-time stored credential and per-frame routing create inconsistent auth contexts. |
| Duplicate detection is entirely absent. | Downgrade. OAuth login has meaningful checks; manual import remains untrustworthy and merge-blocking. |

## Confirmed Blockers

### P0. Pool Token Failure Fails Open To Inbound/Main Credential

Current behavior:

- `src/server.ts` HTTP path selects a pool account, tries `getValidCodexToken()`, then catches failures, marks reauth, sets `selectedCodexAccountId = null`, and continues.
- `src/adapters/openai-responses.ts` copies inbound `authorization` and `chatgpt-account-id` headers unless `_codexAccountOverride` exists.
- `src/server.ts` WebSocket path explicitly catches token failure with `/* fallback to main */`.
- `src/ws-bridge.ts` preserves inbound auth headers when no override exists.

Why this is bad:

- A request logically pinned to a pool account can physically execute as the inbound/main account.
- Quota, health, and logs can describe the selected account rather than the credential actually used.
- This breaks the core account boundary of the feature.

Patch direction:

- Introduce an immutable request-level `CodexAuthContext`.
- Once a pool account is selected, missing/failed pool credentials must fail closed or explicitly re-route to another eligible pool account before any upstream request is built.
- Never allow "drop override and continue" when a pool account was required.
- Apply identical rules to HTTP and WebSocket.

Acceptance tests:

- HTTP request with active pool account, inbound main auth, and failing pool token returns account-specific auth error; upstream fetch is not called with inbound main auth.
- WebSocket upgrade/frame with failing pool token fails closed; no main fallback.
- Quota/log/health attribution uses the actual `CodexAuthContext`, not a separate selected id.

### P0. Account Deletion Is Not Atomic

Current behavior:

- Account deletion removes credential/config entry and maybe active id.
- It does not purge thread affinity, quota, upstream health, reauth state, refresh locks, or WebSocket bindings.
- A refresh that started before deletion can later save a credential again.
- Affinity lookups return mapped accounts without revalidating existence, generation, credential presence, or reauth state.

Why this is bad:

- Deleted accounts can remain usable through stale mappings or WebSocket state.
- A delete-versus-refresh race can recreate credentials.
- Long-running daemons can accumulate unbounded caller-controlled thread ids.

Patch direction:

- Add account generation/tombstone metadata.
- Delete as one lifecycle transaction:
  - mark generation deleted,
  - remove credential,
  - clear config entry and active id,
  - purge quota/health/reauth/affinity,
  - invalidate or close sockets bound to that account.
- Refresh completion must compare generation and discard results after delete/replacement.
- Affinity lookup must revalidate mapped account existence and generation.

Acceptance tests:

- Delete account purges quota, health, reauth state, and affinity.
- Deleted account cannot be selected for old thread ids.
- Refresh completing after deletion does not recreate credential.
- WebSocket bound to deleted account is invalidated or fails closed.

### P0. Management And Data-Plane APIs Lack Real Authentication

Current behavior:

- `hostname: "0.0.0.0"` is supported.
- Server binds directly to configured host.
- Missing `Origin` is treated as local/trusted.
- Management GET routes and data-plane routes do not require a local API credential.
- A non-browser client can omit `Origin`.
- If a pool account is active, a network client can consume server-side stored account credentials.

Why this is bad:

- Externally reachable proxy can expose account/config management and stored-account data-plane access.
- Origin checks are CSRF defense, not authentication.

Patch direction:

- Generate or require a local management secret.
- Authenticate every management API and data-plane route that can use stored credentials.
- Refuse non-loopback binding unless authentication is configured.
- Keep Origin/Host checks as defense in depth only.

Acceptance tests:

- Non-loopback bind without auth fails at startup or config validation.
- `/api/config`, `/api/codex-auth/*`, `/v1/responses`, and WebSocket reject unauthenticated requests when auth is required.
- Missing `Origin` does not bypass auth.

### P0. Manual Import Trusts Client-Controlled Identity

Current behavior:

- Manual import accepts client-supplied `id`, `email`, `accessToken`, `refreshToken`, and `chatgptAccountId`.
- JWT payload decoding only base64url-decodes JSON; it does not verify signature, issuer, audience, expiry, or token type.
- Collision detection permits same upstream account id when user-supplied emails differ.
- The manual UI sends a user-entered local id as the email value.
- Existing local id can be overwritten at credential-store level before metadata update is declined.

Why this is bad:

- Caller-controlled identity can poison duplicate detection and alias mapping.
- Same rotating refresh grant can be imported under multiple aliases.
- Local alias metadata can become paired with another credential.

Patch direction:

- Disable manual import by default until identity validation is authoritative.
- Separate local alias, display email, verified principal id, and workspace/account id.
- Treat decoded JWT claims as hints only.
- Validate identity through an upstream-authenticated response before storage.
- Reject existing alias before writing credential unless explicit replacement operation provides expected generation.
- Add refresh-token fingerprint duplicate protection without storing raw token hashes in user-visible output.

Acceptance tests:

- Manual import disabled by default.
- Existing alias cannot be overwritten by manual import.
- Same refresh credential cannot be imported under two aliases.
- Same workspace with distinct verified user/principal ids can be accepted.
- Same verified user/principal id cannot be duplicated with a different user-supplied email.

### P0/P1. Config And Account APIs Expose Secrets Or PII

Current behavior:

- `GET /api/config` returns a deep copy of config and only partly masks `apiKey`.
- Provider `headers` can contain arbitrary secrets and are not safely serialized.
- `GET /api/codex-auth/accounts` returns full email and plan data.
- GUI renders full emails.

Why this is bad:

- External bind or shared local host can leak provider headers, account emails, and key prefixes.
- Full email display conflicts with deployable UI/privacy expectations.

Patch direction:

- Replace config response with explicit safe DTO.
- Never return provider headers or API key prefixes.
- Return booleans such as `hasApiKey`, not key fragments.
- Mask emails by default; allow local reveal only behind authenticated management action.

Acceptance tests:

- `/api/config` never serializes provider headers or key prefixes.
- `/api/codex-auth/accounts` can return masked email by default.
- UI uses masked display in deployable/authenticated mode.

## Required Hardening

### P1. HTTP/WebSocket Auth Context Consistency

Problem:

- HTTP chooses account inside each request.
- WebSocket chooses at upgrade, stores forwarding headers, then each frame re-enters `handleResponses()` and can make another auth decision.
- Without a thread id, active account changes can move later frames.
- If frame-level lookup fails, stored handshake credentials can be reused.

Patch direction:

- Bind each socket to an account generation, not a raw bearer header.
- Each turn may refresh the same account token but cannot silently change account.
- Account rebind requires a new connection or explicit protocol action.
- Remove raw bearer storage from generic WebSocket state.

### P1. Outcome Classification

Problem:

- Every non-2xx increments the same account failure counter.
- Caller/model errors can trigger account failover.
- Connect failures return local 502 before account health is recorded.
- HTTP 2xx resets health at headers time, even if SSE later fails or is incomplete.
- 401 marks reauth but current active account may keep receiving work until generic threshold.
- `lastFailureAt` is not used to expire stale streaks.

Patch direction:

- Implement outcome taxonomy:
  - credential 401/403: immediate account quarantine,
  - quota/rate 429: account cooldown using reset/Retry-After,
  - connect/timeouts/5xx: transient health,
  - caller/model 4xx: no account penalty,
  - terminal SSE/WS `response.failed` or `response.incomplete`: post-stream outcome record.
- Use time-bounded failure windows.
- Separate account health from provider/model health.

### P1. Refresh Safety

Problem:

- Current lock is in-process and keyed by local alias.
- Duplicate manual aliases can refresh the same grant concurrently.
- Multiple processes sharing `OPENCODEX_HOME` have independent locks.
- Refresh completion unconditionally saves over current credential.

Patch direction:

- Coordinate refresh by validated grant/subject fingerprint.
- Add inter-process lock or transactional storage.
- Version every credential record.
- Refresh completion uses compare-and-swap against starting generation.
- Discard refresh results after delete/replacement.

### P1. Quota Freshness And Unknown State

Problem:

- `computeCodexUsageScore(null)` returns `0`.
- Unknown quota looks like unused quota.
- Routing ignores `updatedAt`.
- Failed quota refresh returns old quota without stale/error state.
- Header parsing accepts non-finite/out-of-range values.
- Deletion does not clear quota map.

Patch direction:

- Model quota as fresh/stale/unknown/error.
- Unknown must not be ranked as zero usage.
- Validate and clamp finite percentages.
- Expire quota by observation/reset time.
- Remove quota during account deletion.
- Trigger bounded refresh before quota-driven switch where feasible.

### P1. Affinity Lifecycle

Problem:

- Thread affinity is unbounded and server-lifetime.
- Mapped account is not revalidated.
- Account deletion does not purge mappings.

Patch direction:

- Add TTL/LRU and maximum entry count.
- Purge by account id/generation on deletion or reauth quarantine.
- Revalidate mapped account existence/generation on lookup.
- Do not silently move an expired existing thread to another account; return clear account-affinity-expired or require explicit policy.

## Privacy And Maintainability

### P2. Logging And Labels

Preserve:

- Normal request logs should keep using non-PII labels.

Improve:

- Replace order-based `chatgpt-1` labels with stable non-PII random pool labels.
- Sanitize local aliases and upstream error descriptions before durable service logs.
- Remove or redact `OCX_DEBUG_FRAMES` payload previews.
- Scrub absolute home paths from devlog before sharing.
- Add CI checks for token-looking strings, emails, home paths, and bearer values in docs/devlog artifacts.

### P2. Documentation Updates

Required doc updates after P0/P1 patches:

- Add supersession banner to historical `270` docs whose assumptions changed:
  - weekly-only or older quota semantics,
  - account-id-only collision,
  - older login flow details,
  - affinity deletion on token failure,
  - release-ready language in `160`.
- Add final verification manifest with:
  - commit SHA,
  - OS,
  - Bun version,
  - commands,
  - test counts,
  - live cases run,
  - intentionally deferred cases.

## Implementation Order

### Patch 1 - Fail-Closed Auth Context

Files:

- `src/server.ts`
- `src/adapters/openai-responses.ts`
- `src/ws-bridge.ts`
- `src/codex-routing.ts`
- `src/vision/index.ts`
- `src/vision/describe.ts`
- `src/web-search/index.ts`
- `src/web-search/executor.ts`
- `src/web-search/loop.ts`
- `tests/passthrough-override.test.ts`
- `tests/ws-endpoint.test.ts`
- vision/web-search sidecar auth-context tests
- new/updated auth-context tests

Acceptance:

- Pool token failure cannot use inbound/main credential.
- HTTP and WebSocket behave consistently.
- Vision and web-search sidecars cannot use inbound/main credential after pool selection.
- Logs/quota/health reference actual auth context.

### Patch 2 - Account Lifecycle Transaction

Files:

- `src/types.ts`
- `src/codex-account-runtime-state.ts`
- `src/codex-auth-api.ts`
- `src/codex-account-store.ts`
- `src/codex-routing.ts`
- `src/codex-quota.ts`
- WebSocket binding code in `src/server.ts`

Acceptance:

- Delete purges all account-bound state.
- Refresh after delete/replacement cannot resurrect stale credential.
- Refresh CAS uses generation/version semantics and a grant-scoped cross-process-safe lock or equivalent transaction.
- Affinity lookup validates account generation.

### Patch 3 - Local API Authentication And Safe DTOs

Files:

- `src/server.ts`
- `src/config.ts`
- `src/types.ts`
- `src/codex-auth-api.ts`
- GUI fetch/auth wiring

Acceptance:

- Non-loopback bind requires auth.
- Management/data-plane reject unauthenticated access where stored credentials may be used.
- Config/account APIs do not leak secrets or unrestricted PII.

### Patch 4 - Manual Import Rework

Files:

- `src/codex-auth-api.ts`
- `src/codex-auth-collision.ts`
- `src/oauth/chatgpt.ts`
- `gui/src/components/AddCodexAccountModal.tsx`
- collision/import tests

Acceptance:

- Manual import disabled or gated until validated identity exists.
- Existing aliases cannot be overwritten.
- Duplicate refresh grants are blocked.
- Team workspace plus distinct user principal is allowed.

### Patch 5 - Routing Outcome And Quota State

Files:

- `src/codex-routing.ts`
- `src/codex-quota.ts`
- `src/server.ts`
- response/SSE/WS bridge tests

Acceptance:

- Caller 4xx does not mark account unhealthy.
- 401 immediately quarantines account.
- 429 records cooldown/quota state.
- Network/timeouts/5xx contribute to transient health.
- SSE/WS terminal failures are recorded after stream completion.
- Unknown quota does not rank as zero.

### Patch 6 - Privacy, Labels, And Docs

Files:

- `src/codex-routing.ts`
- `src/server.ts`
- `src/service.ts`
- `src/debug.ts`
- `gui/src/pages/CodexAuth.tsx`
- devlog docs

Acceptance:

- Stable non-PII labels.
- Durable logs do not include raw aliases, token fragments, or payload previews.
- Devlog has supersession markers and final verification manifest.

## Verification Matrix

Minimum gates for every patch:

```bash
git diff --check
bun run typecheck
cd gui && bun run build
bun test tests
```

Additional focused tests:

| Area | Required checks |
| --- | --- |
| Fail-closed auth | HTTP and WebSocket pool token failure with inbound main auth never reaches upstream as main. |
| Delete lifecycle | Delete purges affinity/quota/health/reauth; refresh completion after deletion is discarded. |
| Sidecar auth | Vision and web-search sidecars use the selected pool auth context or fail closed; no inbound/main fallback. |
| API auth | Route-by-route `/api/*`, `/v1/responses`, and WebSocket missing/bad/correct secret tests; missing Origin cannot bypass auth. |
| Manual import | Duplicate alias/refresh/user identity cases covered; same verified principal/workspace with different alias rejected before credential write. |
| Outcome classifier | 400/404-or-422/401/403/429/5xx/fetch reject/connect timeout/SSE failed/incomplete/malformed each produce correct account health result. |
| Quota | fresh/stale/unknown/error/NaN/Infinity/out-of-range headers covered. |
| Privacy | config/account DTO redaction snapshots, mandatory Codex Auth masking render test, and request-log assertions. |

## Stop Criteria

The feature can move from `main merge: NO-GO` to `CONDITIONAL-GO` only when:

- P0 patches are implemented and covered by regression tests.
- The full test suite, typecheck, GUI build, and targeted browser/API probes pass.
- No path can silently convert a selected pool account into main/inbound credentials.
- Non-loopback mode requires authentication before stored credentials can be used.
- Manual import is either disabled or validated against authoritative identity.

The feature can move to `GO` only after P1 routing/refresh/quota lifecycle hardening is complete and documented with fresh evidence.
