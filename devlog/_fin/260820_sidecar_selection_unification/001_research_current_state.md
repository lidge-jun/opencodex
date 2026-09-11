# 001 — Research: current sidecar selection state (#2188)

Verified against dev @ f2ebd3067 (2026-08-20).

## Auth pieces (scattered today)
- Codex/ChatGPT: `listOpenAiForwardSidecarCandidates` (src/providers/openai-sidecar.ts:56) — canonical forward provider, pinned baseUrl; `isCodexAuthContextUsable` (src/codex/auth-context.ts:613) — per-context account usability.
- Anthropic: `findAnthropicSidecarProvider` (src/web-search/index.ts:87) and `findAnthropicVisionProvider` (src/vision/index.ts:219) — DUPLICATED predicate: enabled + adapter==="anthropic" + authMode==="oauth" + active account needsReauth!==true.

## Backend resolution asymmetry (issue-confirmed)
- Web-search `resolveSidecarBackend` (src/web-search/index.ts:104-108): explicit anthropic else openai. types/config.ts:787-796 comment claims "unset prefers anthropic" — WRONG vs code.
- Vision `resolveVisionBackend` (src/vision/index.ts:231-236): unset prefers anthropic when credential exists. Opposite default.

## Picker sets
- `visibleNativeSlugs` (src/codex/catalog/metadata.ts:331): nativeOpenAiSlugs − disabled − alias-shadowed.
- `listManagementModelRows` (src/server/management/model-rows.ts:50): native rows (incl. disabled, flagged) + account-bound + routed catalog rows.
- `visionCandidateRows` (src/server/management/vision-sidecar-options.ts:45): rows.filter(disabled !== true) — close to picker policy but no auth-slot concept.

## Vision candidate expansion defect
- `visionEligibleModelOptions` (src/vision/eligibility.ts:201): iterates ALL passed candidates + baselines. Candidates from visionCandidateRows = full catalog (all providers' rows), not picker-limited native set; anthropic side gated only by provider name match.

## Write gates
- Vision: PUT /api/sidecar-settings (config-routes.ts:584) rejects via `visionDescriberIsProvablyBlind`. Claude-code override shares module.
- Web-search: config-routes.ts:604-606 persists webSearch.model verbatim. NO GATE.

## GUI
- gui/src/pages/dashboard-overview-sections.tsx + use-dashboard-data.ts render webSearch/vision sidecar settings; GET /api/sidecar-settings returns visionModels options but NO webSearchModels options list.

## CLI
- No ocx sidecar command exists (src/cli/ has no sidecar.ts; only GUI/PUT paths).

## Tests nearby
tests/vision-eligibility.test.ts, tests/sidecar-settings-vision-filter.test.ts, tests/web-search.test.ts, tests/sidecar-settings-vision-controls.test.ts, tests/claude-sidecar-override.test.ts.

## Executors that exist today (probe-relevant)
- openai: src/web-search/executor.ts (ChatGPT forward /responses hosted web_search).
- anthropic: src/web-search/anthropic-executor.ts (web_search_20250305 via OAuth Messages).
- NO gemini/grok/zen/exa executor → per #2188 filter rule 2, only openai+anthropic can be active web-search backends in this unit.


## CORRECTION (post-audit)
- isCodexAuthContextUsable is src/codex/auth-context.ts:612 (not 613).
- CLI: `ocx agent sidecar <status|web|vision>` ALREADY EXISTS (src/cli/agent.ts:23) writing PUT /api/sidecar-settings. The gap is only: no --list surface, and the PUT it calls has no web-search membership gate. "No ocx sidecar command exists" above is WRONG.
- Additional ungated write path: PUT /api/claude-code writes webSearchSidecar.model verbatim (src/server/management/agent-settings-routes.ts:1064); `ocx claude config set --web-model` rides it.
- GUI contract: dashboard-shared.ts:273 — an OMITTED visionModels key falls back to the full openai+anthropic union; [] means none. Any new webSearchModels key must always be present.
- GET /api/sidecar-settings grandfathers the persisted vision model into options (config-routes.ts:115).

