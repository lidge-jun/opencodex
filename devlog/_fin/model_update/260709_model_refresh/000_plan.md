# 000 — Model catalog refresh 260709 (roadmap)

## Loop-spec header (C3, spec-satisfaction)
- **Trigger:** user request 2026-07-09 — parallel gpt-5.5 research on current model updates (cursor, grok, grok-4.5 priority), dynamic loading where possible, recurring devlog record.
- **Goal:** registry/catalog reflects the verified current lineup; live discovery preferred where a models endpoint exists; dated research record established.
- **Non-goals:** no new providers; no GUI redesign; no hand edits to src/generated/*; no unverified model ids shipped as primary entries.
- **Verifier:** bun x tsc --noEmit; bun test (targeted: providers/catalog/cursor suites, then full).
- **Stop:** phase gates green + docs synced. Escalation per LOOP-REPAIR-01.
- **HOTL bounds:** writes in this repo only; subagents read-only gpt-5.5 (<=3); network = public docs/web search + generator script's own fetch; no authenticated remote calls.
- **Consolidation note:** goal's WP1(research+record) executed inside Phase 1's P (PABCD P = explore first); unit has 2 implementation phases => 2 PABCD cycles. All criteria preserved.

## Phase map (dependency-ordered)
1. **Phase 1 (010):** static catalog update from evidence — xai (grok-4.5 등), cursor static fallback, anthropic seed, openai-apikey liveModels flag, umans prune; jawcode metadata via generator script only.
2. **Phase 2 (020):** dynamic loading — verify/harden xai live /v1/models discovery via OAuth token, live-with-fallback tests (mocked fetch), cursor live path verification; record which providers remain static-only and why.

Research evidence: 001 (xai), 002 (cursor + registry drift). Convention: 003.
