# Design B — openai_base_url injection (no re-tag)

- **Date:** 2026-07-06 · **Branch:** dev-B (from origin/dev @ 23cc4ed) · **Class:** C4
- **Loop archetype:** spec-satisfaction repair (verifier defines done: bun test suite + targeted E2E facts)
- **Trigger:** macmini-cf spike (2026-07-05) proved `openai_base_url` routes plain codex
  through the proxy with threads tagged `openai` — the re-tag failure class disappears.
- **Goal:** plain `codex` routes through ocx WITHOUT changing `model_provider`, so
  Codex thread history never needs remapping or restore.
- **Non-goals:** npm publish, proxy restart on this machine, GUI changes, changes to
  usage attribution/catalog routing (verified unaffected), removal of `recover-history`.
- **Verifier:** `bun test` full suite green; new tests for decompression + Design B inject.
- **Stop condition:** all three phases D-closed with fresh test evidence.
- **HOTL bounds:** write scope = this repo only (src/, tests/, devlog/, README).
  No pushes, no global installs, no killing the running proxy (port 10100), no edits
  to ~/.opencodex or ~/.codex live configs. Budget: this session's token budget;
  hitting it = BUDGET_EXHAUSTED with best-so-far.
- **Escalation:** if codex-rs facts contradict the spike (e.g. override ignored in a
  newer codex), stop and report NEEDS_HUMAN.

## Verified facts (carry-over)

1. `[model_providers.openai]` table override is REJECTED (`RESERVED_MODEL_PROVIDER_IDS`,
   config_toml.rs:61) — config load fails. Design B must NOT emit that table.
2. `openai_base_url` root key IS the official built-in-openai override
   (config_toml.rs:359 → built_in_model_providers → create_openai_provider). It wins
   over both api.openai.com and CHATGPT_CODEX_BASE_URL (to_api_provider, lib.rs:246).
3. Spike (ocx 2.6.25 + codex 0.142.5, isolated homes): requests hit proxy 200,
   threads stored `model_provider='openai'`, WS upgrade to ws://…/v1/responses works.
4. zstd risk: `enable_request_compression` (Stable, default ON) fires when auth is
   codex-backend AND provider `is_openai()` (client.rs:1213). WS path unaffected;
   HTTP fallback sends `content-encoding: zstd` body → ocx today returns 400
   "Invalid JSON body" (reproduced with curl). Must decode before Design B ships.
5. Analytics/usage sidecalls go direct to chatgpt.com — unaffected.

Research SoT: deep codex-rs facts live in `devlog/_fin/260702_codex-history-sync-hardening/`
(01_codex-rs-facts.md, 02_openai-override-design.md); this unit's 000 carries only the
delta facts verified for Design B.

## Work-phase map (dependency-ordered)

| Phase | Doc | Delivers | Depends on |
|-------|-----|----------|-----------|
| 1 | 010 | Request-body decompression (zstd/gzip/deflate) on /v1/responses + tests | — |
| 2 | 020 | codex-inject Design B: emit marker + `openai_base_url`, stop emitting provider table/root model_provider; strip/restore/profile updated; legacy-form cleanup kept | 1 (safety prerequisite) |
| 3 | 030 | History one-time migration on inject (opencodex→openai eject), message surface, docs/SoT sync, full-suite gate | 2 |

One work-phase = one full PABCD cycle. Phase 3's C runs the whole suite as the final gate.
