# WP5 plan (diff-level) — config + GUI: two sidecar settings + Claude override

Phase P. Grounded in Averroes (WP5 read-only scoping). WP6 (docs, Goodall)
runs in parallel and is disjoint (docs-site/ only).

Goal: MAIN settings expose EXACTLY TWO sidecar settings — webSearchSidecar
{backend, model} and visionSidecar {backend, model}. The Claude tab exposes a
PER-CLIENT OVERRIDE of the same two (unset = inherit global). Strings in en/ko/
zh-cn (+ German for compile completeness). Strict management-API validation.

Write scope: src/types.ts (OcxClaudeCodeConfig override fields), src/server/
management-api.ts (/api/sidecar-settings + /api/claude-code sidecar override),
the Claude effective-config merge point (src/server/claude-messages.ts OR the
config passed to handleResponses — determine exact seam), gui/src/pages/
Dashboard.tsx, gui/src/pages/ClaudeCode.tsx, gui/src/i18n/{en,ko,zh,de}.ts, and
tests (management + precedence). Out of scope: docs (WP6), desktop-3p.

## Config (src/types.ts)
- OcxClaudeCodeConfig (~247): add
  `webSearchSidecar?: { backend?: "openai"|"anthropic"; model?: string }` and
  `visionSidecar?: { backend?: "openai"|"anthropic"; model?: string }`.
  Absent nested object (or null on PUT) => inherit global.

## Effective resolution (Claude override)
- For Claude-originated requests, the EFFECTIVE sidecar config is
  `{ ...config.webSearchSidecar, ...config.claudeCode?.webSearchSidecar }` (same
  for vision). Only the {backend, model} keys are overridable; other global keys
  (reasoning, timeoutMs, maxSearchesPerTurn, maxDescriptionsPerTurn) always come
  from the global config.
- Seam: WP3 already builds the internal replay in src/server/claude-messages.ts
  and calls handleResponses. Inject the merged effective config there (pass a
  shallow-cloned config whose webSearchSidecar/visionSidecar are the merged
  result) so planWebSearch/planVisionSidecar (which read config.<sidecar>) see the
  Claude override WITHOUT changing their signatures. Do NOT affect non-Claude
  (Codex) requests. Worker must confirm the exact clone point and that global
  keys survive.

## Management API (src/server/management-api.ts)
- GET/PUT /api/sidecar-settings: expose `{ webSearch:{backend,model},
  vision:{backend,model} }`. ADD webSearch.backend (read+write+validate enum).
  Keep writing reasoning to config internally (do not surface in the two-setting
  GUI contract) so existing reasoning config is preserved. Reuse the strict
  isPlainRecord validation already added in WP4; validate both backends as the
  enum and reject malformed.
- GET/PUT /api/claude-code: add the two nested sidecar overrides
  (webSearchSidecar/visionSidecar {backend,model}); a `null` (or empty) clears the
  override and inherits global (mirror the existing null-clears precedent for
  maxContextTokens ~761 and empty-model-deletes ~832). Partial PUT preserves
  omitted fields via the existing `next = {...config.claudeCode}` pattern (~747).
  Strict enum + shape validation.

## GUI
- gui/src/pages/Dashboard.tsx (~739 web-search, ~764 vision): restructure to TWO
  compound rows, each with a backend selector (Auto/OpenAI/Anthropic) + a model
  input. Remove the reasoning control from the MAIN UI (config still holds it).
  Update SidecarData + saveSidecar() to carry backend.
- gui/src/pages/ClaudeCode.tsx (setting-row card ~129): add two OVERRIDE rows for
  webSearchSidecar/visionSidecar, each backend + model, with an explicit "Use main
  setting" (inherit) unset option; update ClaudeCodeState + load/save (PUT
  /api/claude-code) with null to clear.
- i18n: add dash.* + claude.* label/hint/inherit keys in en.ts, ko.ts, zh.ts, AND
  de.ts (DICTS requires Record<TKey,string> — missing keys break the build).
  Korean must be natural (no translationese).

## Tests
- Extend tests/vision-anthropic.test.ts or a new tests/sidecar-management-api.test.ts:
  /api/sidecar-settings GET/PUT round-trip incl webSearch.backend, enum validation,
  malformed rejection (reuse WP4 F2 style).
- Extend tests/claude-management-api.test.ts: claudeCode sidecar override GET/PUT,
  null-clears, partial preservation, strict rejection.
- New precedence test (tests/claude-messages-endpoint.test.ts or a new file): a
  Claude request with claudeCode.webSearchSidecar.backend override resolves to that
  backend while global stays different; non-Claude request ignores the override.
- Keep green: claude-management-api, web-search*, vision*, and build GUI with
  `bun run build:gui`.

## Verify (C)
`bun run typecheck` + `bun test --isolate ./tests/` + `bun run build:gui` green;
sol adversarial review of the diff (config merge correctness — global keys survive,
non-Claude unaffected; management validation; GUI two-setting contract; i18n
completeness incl de). Commit WP5.

## Audit synthesis (Peirce/sol — VERDICT FAIL, folded)

Evidence: .codexclaw/evidence/260712-wp5-plan-audit.md. Seam CONFIRMED sound:
both planners read config.<sidecar> directly (web-search/index.ts:141,
vision/index.ts:163); the sole Claude replay passes config at
claude-messages.ts:380, so a per-request shallow clone is Claude-only and native
/v1/responses (server/index.ts) is unaffected; nested spread preserves global-only
keys.

- F1 MAJOR ACCEPT (Auto clear-contract): the MAIN backend selector's Auto state
  and the Claude-override unset MUST be clearable. Management-API contract:
  `backend: null` on PUT DELETES the stored backend key (=> Auto = resolve by
  credential); GET returns backend unset when absent. Same for the claudeCode
  override (null clears -> inherit global). Model: empty string deletes the model
  key (existing precedent management-api.ts:874). Tests MUST cover explicit ->
  null -> Auto round-trip for BOTH main sidecars AND both claude overrides.
- F2 MINOR ACCEPT (precedence test breadth): the precedence regression asserts,
  for BOTH web-search AND vision: (a) claudeCode backend override wins over global
  for Claude requests; (b) claudeCode model override wins; (c) unset override
  inherits global; (d) ALL global-only keys survive the merge — enabled, reasoning,
  timeoutMs, routedModelStallTimeoutMs, maxSearchesPerTurn, maxDescriptionsPerTurn;
  (e) a non-Claude (Codex) request ignores the override entirely.
- F3 MINOR ACCEPT (global-key inventory): explicitly include `enabled` and
  `routedModelStallTimeoutMs` in the preserved global keys and the test.
- F4 MINOR ACCEPT (strict nested validation): /api/claude-code PUT rejects an
  unknown backend value with 400 BEFORE mutating `next`; null clears; partial PUT
  preserves omitted fields (next = {...config.claudeCode}).
- F5/F6 MINOR (confirmed): management/GUI restructure aligns with current code;
  de.ts exists and MUST receive every new key (DICTS Record<TKey,string>) or the
  build breaks.

Net: backend is a tri-state on the wire — "openai" | "anthropic" | null(clear).
GUI Auto = the null/unset state.
