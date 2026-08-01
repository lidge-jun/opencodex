# 60 - Phase 6: Privacy, Docs, And Verification

Status: implementation-ready plan.

## Objective

Finish the security hardening with stable privacy-safe labels, durable-log redaction, superseded-doc markers, and release-grade verification evidence.

## Planned Changes

### MODIFY `src/types.ts`, `src/codex-auth-api.ts`, `src/codex-routing.ts`

Replace order-based labels (`chatgpt-1`) with stable non-PII pool labels:

- add `poolLabel` or `logLabel` to `CodexAccount`;
- generate it at account creation in both OAuth and manual/gated import flows;
- random and non-secret;
- never derived from email, workspace id, user id, token, or local alias.

Compatibility:

- UI may still show user-friendly masked email;
- request logs use stable label only;
- routing consumes the stored label but does not own label generation.

### MODIFY `src/server.ts`, `src/service.ts`, `src/debug.ts`

Redact:

- local aliases in durable error logs;
- upstream auth error descriptions if they include token/account material;
- debug frame payload previews.

### MODIFY `gui/src/pages/CodexAuth.tsx`

Render masked email by default in deployable/authenticated mode. Full reveal requires authenticated local action if retained.

### Documentation

Add supersession banners to `270` docs whose assumptions are obsolete after P0/P1:

- `devlog/270_codex-multi-account-auth/20_phase2-passthrough-override.md` for fail-open passthrough behavior;
- `devlog/270_codex-multi-account-auth/30_phase3-management-api.md` for unauthenticated management API assumptions;
- `devlog/270_codex-multi-account-auth/50_phase5-tests-and-hardening.md` for old hardening/test scope;
- `devlog/270_codex-multi-account-auth/70_phase7-quota-capture-autoswitch.md` for older quota semantics;
- `devlog/270_codex-multi-account-auth/80_phase8-e2e-hardening.md` for pre-P0 security assumptions;
- `devlog/270_codex-multi-account-auth/130_oauth-token-collision-fix.md` for account-id-only collision assumptions;
- `devlog/270_codex-multi-account-auth/160_post-implementation-verification-results.md` and `devlog/270_codex-multi-account-auth/120_phase12-production-verification.md` for release-ready language;
- `devlog/160_dashboard-redesign-and-media-models/00_overview.md` only if it contains release/readiness statements affected by the security gate.

Add final verification manifest with:

- commit SHA;
- Bun version;
- OS;
- commands;
- test counts;
- live cases run;
- deferred cases.

## Tests

Add/update:

- request-log label tests;
- config/account DTO redaction tests;
- debug/log redaction tests where practical;
- mandatory GUI render/DOM tests for Codex Auth masking.

GUI masking test must render:

- account list;
- switch-confirm modal;
- active-selection/toast path.

Use fixture data containing an email-like raw value and assert the raw value is absent while the masked display is present.

## Verification

```bash
git diff --check
bun run typecheck
cd gui && bun run build
cd gui && bun run test:codex-auth-privacy
bun test tests
```

Runtime/browser after code implementation:

- `/healthz`
- redacted `/api/codex-auth/accounts`
- HTTP pool fail-closed probe;
- WebSocket pool fail-closed probe when websockets enabled;
- Codex Auth page no PII exposure in deployable mode.
