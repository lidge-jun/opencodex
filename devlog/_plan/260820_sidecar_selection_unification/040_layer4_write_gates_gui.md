# 040 — Layer 4: management API write gates + GUI lists (wp5)

Branch: codex/sidecar-write-gates (base: codex/sidecar-websearch-slots).

## New file: src/server/management/web-search-sidecar-options.ts (extraction happens HERE, not L5)
- webSearchModelOptionsFor(config): candidate option list from webSearchSidecarCandidates.
- webSearchModelIsRejected(config, requested): membership gate — reject when requested is neither a candidate nor an auth-slot model; empty string always allowed (clears).
- Shared by BOTH routes below (mirrors vision-sidecar-options.ts pattern).

## Server
- config-routes.ts GET /api/sidecar-settings: add webSearchModels — ALWAYS present, [] when empty (dashboard-shared.ts:273 omission fallback). Display-grandfather the persisted model into options (parity with vision GET :115) while rejecting NEW illegal writes.
- PUT /api/sidecar-settings webSearch.model: 400 with error naming the filter when webSearchModelIsRejected.
- PUT /api/claude-code (agent-settings-routes.ts:1064): SAME gate, REQUIRED — covers ocx claude config set --web-model.
- Out of scope (explicit): ocx config set webSearchSidecar.model raw JSON writes (operator escape hatch, same as vision).
- Vision PUT unchanged (provably-blind gate stays).

## GUI
- use-dashboard-data.ts / dashboard-overview-sections.tsx: web-search model select consumes webSearchModels; [] renders empty-state, not full union.
- gui screenshot REQUIRED in PR body (enforce-target).

## Tests
- new tests/sidecar-settings-web-search-gate.test.ts: PUT rejected for non-candidate; accepted for candidate + auth-slot; empty clears; claude-code route rejects the same id (今日 persists "claude-search" — update that fixture); GET always carries webSearchModels key.
- bun run lint:gui.

## Verify: bun x tsc --noEmit && bun test tests/sidecar-settings-web-search-gate.test.ts tests/sidecar-settings-vision-controls.test.ts tests/claude-sidecar-override.test.ts && bun run lint:gui

