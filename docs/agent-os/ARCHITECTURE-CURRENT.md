# PaohupByPaoZa — Current Architecture Map (Phase 00)

> Generated: 2026-08-29. Describes what exists today, not the Agent OS blueprint.

## Process model

One Bun process starts the proxy (src/cli/index.ts start), binds a local HTTP
port (default 10100), and serves:

- POST /v1/responses — provider translation for Codex clients
- POST /v1/chat/completions — OpenAI-compatible clients
- GET /healthz — health check
- GET /api/* — management API (src/server/management/)
- GET / — GUI dashboard (gui/dist build)

A Windows tray (src/tray/) and start.cmd/start.ps1 wrap the same entrypoint.

## Request flow (core path)

Codex/Claude client → HTTP server → admission/auth boundary → routing
(src/router.ts + src/routing/) → adapter (src/adapters/, per provider wire
format) → provider transport (src/providers/, quota/keys/tiers/failover) →
upstream → response translation back to the client dialect.

The Compatibility Lab (src/lab/) is opt-in: a user with one provider and no
routing profile never reaches it. The boundary is enforced by import-graph tests,
and activation registers into core-owned slots (passive-route-linker,
provider-slot, optional-shutdown-hooks) rather than importing Lab from core.

## Dependency direction (as observed)

cli → server → router → routing + adapters → providers → lib/types
server/management → config + storage (JSON ledgers under ~/.opencodex)
gui → management API over /api/* (no direct backend imports)

Forbidden direction (enforced by test): router.ts, server/lifecycle.ts, and
server/responses/core.ts must not import or transitively reach src/lab/.

## Persistence

- config.json + per-feature JSON/JSONL ledgers in ~/.opencodex (usage,
  usage-debug, logs). No SQL database, no ORM, no migration framework.
- src/storage/ runs policy/cleanup/restore jobs over that local data.

## i18n / GUI

React app with locale catalogs (en, th, de, fr, ja, ko, ru, tr, zh, zh-TW) in
gui/src/i18n/; this fork's default locale is Thai ("th"), detecting from storage,
then navigator language, then falling back to "th". The local oxlint rule
forbids hardcoded UI strings outside catalogs.

## Security posture today

- OAuth token handling with fail-closed admission tests (agent-task-recovery,
  auth boundary suites).
- Secrets via @napi-rs/keyring; privacy:scan guards against credential/PII leaks
  in the repo.
- Approval/consent rules for agent-owned actions live in AGENTS_INSTALL.md and
  are enforced in CLI/server code with dedicated tests.
