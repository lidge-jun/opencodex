# Provider Access Control Plane

Phase 20.59 introduces a Provider Access Control Plane into Pao-hubPro (OpenCodeX). It is inspired by Charles-0509/Grok-Register **architecture only** (run_id, workflow, validation, health, normalized record, gateway import, monitoring, revoke/rotate/quarantine). It does **not** implement account-registration behavior.

## 1. Product Boundary

The Credential Runtime:

- Imports operator-supplied API keys, OAuth bundles, and local secrets.
- Encrypts them at rest (AES-256-GCM) and stores only a `secret://credential/<id>` reference on the public record.
- Validates and health-checks through fixture / in-process adapters. No live third-party network calls in this phase.
- Activates healthy credentials into a routing-eligible pool.
- Issues short-lived leases after policy + RBAC. Agents acquire leases; they do not read `.env`.
- Monitors health, quota, expiry, and per-credential circuit breakers.
- Supports rotate / refresh / quarantine / revoke with approval for sensitive actions.
- Offers an OAuth session gateway (PKCE + state hash). Callback CSRF mismatch is denied. Token exchange is fixture-only.

It does **not**:

- Register Grok/xAI or any other provider accounts.
- Solve CAPTCHA, bypass Turnstile/Cloudflare, spoof fingerprints, or rotate proxies to defeat registration controls.
- Stuff credentials, import stolen tokens, scrape private cookies, hijack sessions, generate bulk accounts, or resell accounts.
- Return raw secrets through ordinary list/detail/GUI endpoints.
- Log full secrets or write them into audit metadata.
- Replace existing `provider.apiKey` / keychain / live OAuth. 9Router integration is additive.

## 2. Invariants

| ID | Statement | Enforcement |
| --- | --- | --- |
| `INV-CRD-01` | Raw provider secrets are never stored in plaintext columns. | `src/credentials/vault.ts`, `src/credentials/service.ts` |
| `INV-CRD-02` | List/detail APIs and the GUI never return the raw credential. Display is masked. | `toPublicView`, `assertNoSecret`, GUI `Credentials.tsx` |
| `INV-CRD-03` | Feature flag `CREDENTIAL_RUNTIME_ENABLED` defaults off. Mutating API/CLI refuse when unset. | `src/credentials/enabled.ts` |
| `INV-CRD-04` | Health/quota/OAuth adapters are fixture/in-process. No live provider sockets in this phase. | `src/credentials/adapters.ts` |
| `INV-CRD-05` | This plane does not register provider accounts or bypass provider protections. | module headers; OAuth authorize URL is `local.invalid` |
| `INV-CRD-06` | Sensitive actions default-deny to `approval_required`. Ordinary vault reveal is not implemented. | `src/credentials/policy.ts`, `executeApproval` |
| `INV-CRD-07` | Quarantined, revoked, expired, disabled, circuit-open, and quota-exhausted credentials are not routing-eligible. | `src/credentials/lifecycle.ts`, `listCandidates` |
| `INV-CRD-08` | Retry only 408/409/425/429/5xx/timeout/reset. Never 400/401/403/`invalid_grant`/`invalid_token`/`revoked_token`. | `src/credentials/retry.ts` |
| `INV-CRD-09` | OAuth callback rejects state mismatch (CSRF). PKCE verifier lives in the vault. | `startOauth` / `completeOauth` |
| `INV-CRD-10` | Frozen GUI NAV is unchanged. Credentials is hash-routable only (`#credentials`, `#credentials/list`, …). | `gui/src/App.tsx`, `gui/src/app-routing.ts` |
| `INV-CRD-11` | Legacy secret fallback is off unless `ALLOW_LEGACY_SECRET_FALLBACK=true`. | `allowLegacySecretFallback` |

## 3. Architecture

```text
IMPORT (operator-supplied secret)
  → ENCRYPT (AES-256-GCM envelope) → STORE secret_ref
  → VALIDATE (fixture adapter)
  → HEALTH CHECK → ACTIVATE (routing_eligible)
  → POLICY + RBAC → short-lived LEASE
  → MONITOR (health / expiry / circuit)
  → REFRESH / ROTATE
  → QUARANTINE / REVOKE / EXPIRE
```

Status machine: `new → validating → valid → active`, plus `degraded`, `rotating`, `quarantined`, `expired`, `revoked`, `disabled`.

Health is independent of status: `unknown, healthy, warning, degraded, unhealthy, rate_limited, quota_exhausted, auth_failed, provider_down`.

Composite routing score = health_score × quota_factor × budget_factor × reliability_factor × policy_factor.

## 4. Local State Ownership

Under `$OPENCODEX_HOME` (`~/.opencodex`):

- `credentials.sqlite`: providers, encrypted envelopes, records, health samples, OAuth sessions, leases, policies, approvals, audit, circuit breakers, idempotency, runs.

Optional `PAO_CREDENTIAL_DB_PATH` isolates the database (tests, singleton). Master key from `CREDENTIAL_MASTER_KEY` (tests may inject `MemoryVault`).

The GUI page is hash-routable and is **not** a frozen sidebar NAV row. CLI `ocx credentials` (alias `creds`) talks to the service/database directly (local-transport), not over HTTP.

Key files:
- Server management API routes: `src/server/management/credential-routes.ts`
- CLI command: `src/cli/credentials.ts` (`ocx credentials`, alias `creds`)
- GUI page: `gui/src/pages/Credentials.tsx` (`#credentials`)

Management API prefix: `/api/credentials`.

## 5. Safe demo

Seeded providers (`openai`, `xai`, `anthropic`, `openrouter`, `deepseek`, `google`, `openai-compatible`, `local`) never open a network socket. Adapter classification is substring-based (`authfail` quarantines, `quota` is ineligible, empty secret fails). OAuth authorize URLs point at `local.invalid`. Fixture tokens are assembled from fragments so they are not live credentials.

