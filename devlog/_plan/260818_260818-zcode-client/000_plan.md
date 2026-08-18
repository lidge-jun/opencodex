# 000_plan — ZCode client integration (rev 2, post-audit)

Issue: https://github.com/lidge-jun/opencodex/issues/2022
Branch: codex/zcode-client (from origin/dev)
Goalplan: .codexclaw/goalplans/add-zcode-client-support-to-opencodex-issue-firs

## Audit synthesis (grok-4.6 reviewer, round 1: FAIL — all findings ACCEPTED)

1. ACCEPTED: mcode/opencode are launchers; the real managed-block write surface is
   EXPORT_CLIENTS + INTEGRATION_CLIENTS + applyIntegration (src/integrations/writer.ts).
   No private read-modify-write. rev 1's homemade RMW is dropped.
2. ACCEPTED: no live admission token on disk. Loopback data-plane ignores the token
   (src/server/auth-cors.ts:256,436); emit LOOPBACK_API_KEY_PLACEHOLDER
   (src/clients/config-export.ts:128) as apiKey (ZCode requires a non-empty value;
   placeholder satisfies the UI). Never serialize opencodeApiKey().
3. ACCEPTED: "byte-for-byte" relaxed to structural preservation — JSON writer is
   parse-merge-serialize; user provider entries survive structurally unchanged.
4. ACCEPTED: 'ocx zcode show' must never dump file bytes (would print user Z.ai keys);
   integration-style state/path report only.

## Verified ground truth (pre-code live validation, 2026-08-18)

- ~/.zcode/v2/config.json provider map, entry shape observed + proven live:
  { name, kind: "anthropic", options: { apiKey, baseURL, apiKeyRequired }, enabled,
    source: "custom", models: { <ID>: { name?, limit: { context, output? }, modalities } } }
- ZCode 3.7.7 + live proxy: model picker shows the provider, chat routes through
  /v1/messages, tool-call round trip works, slash-form model ids accepted
  (curl "model":"xai/grok-4.6" -> end_turn).
- Restart required after config change (docs + observed).

## 010 — implementation (single phase)

Scope (in): src/clients/config-export.ts (zcode builder + registration in
EXPORT_CLIENTS), src/integrations/registry.ts (INTEGRATION_CLIENTS entry),
src/cli/ thin alias 'ocx zcode' -> integration enable/disable/status wiring
(pattern: existing client aliases), tests listed below, docs-site if trivial.
Scope (out): src/router.ts, src/server/lifecycle.ts, src/server/responses/core.ts,
src/lab/, GUI, release automation.

Design:
- zcode registered as an integration client: id "zcode", target
  ~/.zcode/v2/config.json, ownership = provider.opencodex key only,
  loopbackOnly: true, apiKey = LOOPBACK_API_KEY_PLACEHOLDER, apiKeyRequired: true.
- Models from the shared export-model surface (exportModelsFromProxyRows /
  loadExportModels), provider/model slash ids, limit.context from authoritative
  contextWindow; baseURL from exportContextOf/opencodeProxyBaseUrl.
- First run: ~/.zcode missing -> not_installed (never create the home dir);
  file missing but dir present -> create file with only our key.
- Writer guarantees inherited from applyIntegration: unparseable abort,
  compare-before-commit, symlink refusal, snapshot/restore history.

Tests (model on): tests/integrations-writer.test.ts, tests/integrations-invariants.test.ts
(EXPORT_CLIENT_IDS lockstep), tests/client-config-export-new-clients.test.ts
(update hard-coded loopback-only list at :65), tests/client-config-new-clients.test.ts
(runtime-assembled fixture secrets; assert serialized text has no real secret).

Acceptance: focused tests green; typecheck green; full suite + privacy:scan green
before PR; PR to dev with template + Closes #2022.

