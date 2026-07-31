# Phase 2: PR #39 runtime/service hardening merge

## Goal

Merge PR #39 onto `dev`, review high-risk runtime/service/auth changes, and patch concrete regressions before final verification.

## Planned Verification

- `bun install --frozen-lockfile`
- `bun run typecheck`
- `bun test tests`
- `bun run build:gui`
- `bun run privacy:scan`

## High-Risk Areas

- Service lifecycle and service token file handling
- API auth/CORS/Host validation
- GUI API token prompt wrapper
- Provider management validation and secret redaction
- Package publish files and Node launcher
- Codex Auth account-pool duplicate and privacy behavior
