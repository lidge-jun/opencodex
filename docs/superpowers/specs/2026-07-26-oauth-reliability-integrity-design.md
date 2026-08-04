# OAuth Reliability and Client Integrity — Design

**Date:** 2026-07-26  
**Branch:** `feat/oauth-reliability-integrity`  
**Status:** Approved (Approach 1 + affinity policy A)

## Goal

Improve OAuth refresh reliability, token persistence safety, actionable diagnostics, and legitimate client-metadata integrity — without client impersonation, fingerprint spoofing, or rate-limit circumvention.

## Product decisions

1. **Approach 1 — Strengthen + surface:** generalize existing xAI/Anthropic lock+CAS patterns; add a thin health projection; wire status/doctor/dashboard.
2. **Affinity policy A:** keep current Codex pool behaviour:
   - 401/403 → reauth quarantine + clear affinities
   - 429 → cooldown + clear affinities + may rotate `activeCodexAccountId`
   - Do **not** pin threads through 429 in this work
3. Affinity remains process-local (`threadAccountMap`); no new disk persistence.
4. Do not remove existing non-Codex adapter client headers (xAI/MiMo) in this work; Codex forward path must not fabricate official Codex identity.

## Non-goals

- Ban protection / anti-detection marketing or behaviour
- Fabricating `originator: codex_cli_rs`, official Codex versions, or device fingerprints
- Account rotation to bypass provider limits
- Automatic destructive doctor repairs
- New npm dependencies

## Current architecture (baseline)

```text
request
  → client metadata (FORWARD_HEADERS / adapter headers)
  → routeModel / resolveCodexAuthContext
  → credential load (auth.json / codex-accounts.json)
  → refresh if needed (tokenRefreshes ± file lock/CAS)
  → provider request
  → classify outcome → reauth / cooldown / failover
  → atomic persist
  → status / doctor / dashboard (thin OAuth surface today)
```

Existing strengths: in-process single-flight; atomic writes; xAI/Anthropic/Codex cross-process refresh locks + generation CAS; Codex cooldown/Retry-After/probe leases; Codex header passthrough with pool account injection.

Gaps: generic OAuth providers lack cross-process refresh lock + CAS; no shared health projection; weak status/doctor/dashboard OAuth detail; no `maskAccountId`; sparse structured OAuth logs.

## Design units

### 1. Privacy helper — `maskAccountId`

Extend `src/lib/privacy.ts` with account-id redaction (`account-…42` style). Use in CLI, doctor, logs, and dashboard secondary labels where full IDs are currently shown.

### 2. Structured OAuth logger

Small helper (e.g. `src/oauth/log.ts`) that emits one-line transition events with redacted account ids. Never logs tokens, auth headers, codes, or full account identifiers.

### 3. Generalized locked refresh

Extract/generalize the xAI/Anthropic pattern into a shared path for remaining OAuth providers in `refreshAndPersistAccessToken`:

1. Acquire `createOAuthRefreshIntentLock(provider, accountId)`
2. Reload credential from store
3. If another writer already refreshed (generation changed + still valid) → return stored access
4. Call `def.refresh`
5. Persist via `mergeAccountCredential` with `expectedGeneration` (CAS)
6. On terminal failure → `markAccountNeedsReauthIfGeneration`
7. Release lock in `finally`
8. Keep in-process `tokenRefreshes` map as first-layer single-flight

Preserve provider-specific branches (xAI Grok CLI adoption, Anthropic durable intent, Kiro local-cli import).

### 4. Health projection

New module (e.g. `src/oauth/health.ts`) projecting existing state into:

```ts
type OAuthAccountHealth =
  | { status: "healthy" }
  | { status: "cooldown"; until: string; reason: "rate_limit" | "quota" }
  | { status: "reauth_required"; reason: "unauthorized" | "forbidden" | "refresh_failed" }
  | { status: "warning"; reason: "refresh_conflict" | "metadata_mismatch" | "stale_credentials" };
```

Sources: `needsReauth`, Codex `upstreamHealth` cooldowns, refresh-intent / CAS conflict markers, incomplete credentials. Single projection consumed by status, doctor, management API, dashboard — no parallel stores.

### 5. Diagnostics surfaces

- **`ocx status`:** concise OAuth health block (provider, redacted account, status, reason/action or retry-after).
- **`ocx doctor`:** checks for writable credential store, single-flight/lock readiness, reauth, cooldown, incomplete credentials, refresh conflicts; each WARN includes recovery action.
- **Dashboard:** health badge on provider/account views with explanation + actions (reauthenticate, copy `ocx doctor`, retry after cooldown). Copy must say reliability/diagnostics — never “anti-ban”.

### 6. Client metadata integrity (Codex path)

Keep `FORWARD_HEADERS` passthrough. Ensure pool mode overwrites only auth + `chatgpt-account-id` to match selected credential. Add regression tests that genuine metadata is preserved and official-client values are not fabricated when absent. Treat untrusted remote identity headers as untrusted unless already authenticated by architecture.

### 7. Documentation

Update docs-site guides/reference: refresh coordination, cooldowns, affinity (process-local + policy A), preserved vs non-fabricated metadata, status/doctor usage, reauth, explicit statement that this cannot guarantee protection from provider enforcement.

## Testing strategy

TDD: failing test → implement → pass → commit per task.

Cover: concurrent refresh → one IdP call; shared result; failed refresh clears single-flight; retry after failure; rotated refresh persisted; older result cannot overwrite newer; reload after lock; 401 path where applicable (one refresh + one retry); repeated auth failure → reauth; 403/429 policy A assertions; metadata pass-through + non-fabrication; status/doctor/dashboard; redaction; no secrets in logs.

## Success criteria

- Generic OAuth refresh uses file lock + generation CAS
- Health projection shared across CLI/API/UI
- Diagnostics actionable and redacted
- Codex metadata integrity tests green
- `bun run typecheck`, targeted OAuth tests, and full `bun run test` pass
- No impersonation / fingerprint spoofing / limit-bypass behaviour added
