# Implementation map

## Lane A — native catalog and compatibility
MODIFY src/codex/catalog/{native-models,metadata,parsing,sync,effort}.ts:
- NATIVE_OPENAI_MODELS and DOCUMENTED_NATIVE_OPENAI_ADDITIONS lose gpt-5.3-codex-spark.
- RETIRED_NATIVE_OPENAI_MODELS gains the exact slug; remove 100k Spark context override and exclusive tier/lite exceptions.
- Verify full-shaped bare, cache, persisted account-selector-v1 Spark rows cannot reappear in assembly/restore; unrelated future native still admitted.
MODIFY src/adapters/openai-responses.ts and src/responses/hosted-tool-policy.ts to remove exclusive Spark request/tool/lite flags. Retain shared response normalization. Adjust misleading src/server/responses-self-named-namespace-scrub.ts comment only, not generic scrub logic.
Tests owned by A: catalog/metadata/effort/visibility/convergence/restore/selector tests; tests/claude-integration, tests/clients, tests/responses, tests/routing. Do not change quota/routing core tests owned by B. Keep adequate positive native controls after deleting Spark-specific behavior.

## Lane B — quota, routing, settings
MODIFY src/codex/{quota,routing,auth-context,auth-api}.ts, src/providers/quota.ts, src/server/management/config-routes.ts, src/config.ts, src/types/config.ts.
Before: CodexQuotaScope = shared|spark|reserve, Spark WHAM additional rate limits and response header windows parsed, preference showCodexSparkQuota gates UI projection.
After: shared|reserve scope only; no Spark collection/active affinity/probe family. Ignore Spark-specific response evidence; filter legacy Spark windows before presence/capacity/DTO use. Remove setting read/write/rollback/type/schema contract while accepting old config without dropping unrelated fields. Generic customWindows and Reserve detection remain.
Trace scope generation -> maps/cache persistence -> auth error labels -> main claim recovery -> provider quota DTO. Tests owned by B: codex-{quota*,routing,pool*,auth-api,auth-context,cooldown*}, main-quota-evidence-validation, reserve-quota-scope, codex-spark-visibility; tests/server; tests/providers/provider-quota. Replace obsolete Spark tests with retired-evidence negatives and Reserve isolation.
If deleting a test file adjust scripts/test-layout/layout.json and tests/fixtures/test-layout-expected.json; prefer repurposing existing files.

## Lane C — UI and documentation
MODIFY gui/src/components/CodexAccountPool.tsx, codex-account-pool-main-card.tsx: delete sparkVisible/sparkBusy/onToggleSpark and showCodexSparkQuota wiring; preserve other actions, feedback and busy state.
MODIFY gui/src/styles.css to remove only Spark styles and revise actual action layout comments; remove codexAuth.sparkQuota* keys across all locales. Update gui/tests, notably main-account-hard-lock-setting.
MODIFY current docs/, docs-site (all locales) and structure/ current ownership docs. Describe no Spark quota setting or native offering in this branch; retain historical decisions and benchmark records. Structure docs must describe shared/Reserve and retired-window suppression accurately. Main owns devlog unit only.
Capture real UI evidence using an already available environment or remote-built artifact, with synthetic fixture data. No local product build/tests/install and no mutation of the live service.

## Verification scenarios
1. Seed full-shaped retired native rows bare and account-qualified, run assembly/sync twice: absent both times; keep a future unknown native positive control.
2. Feed WHAM codex_bengalfox and Spark labels with shared/Reserve limits: Spark custom windows absent, ordinary limits unmodified.
3. Feed old persisted custom windows and retired response headers: no resurrection and no shared cooldown contamination.
4. Old showCodexSparkQuota config loads safely; API never advertises or accepts re-enabling it.
5. Shared and Reserve independent quota/cooldown/affinity tests still prove independence.
6. Native catalog tests retain reasoning/context/ordering positive coverage using live native models, not deleted assertions.
7. DOM/rendered account panel has no Spark switch/bars and surviving controls still work; authentic screenshot in PR.
8. Hosted CI is complete for the final PR head; no pending/failed jobs masked by shell pipelines or pass-count scripts.

## Source review refinements (before Build)
- Quota tombstone lives before ingestion/hydration and presence/observation, not only DTO display. quota.ts hydration currently accepts stored customWindows (626); partial updates preserve them (338). Sanitize both and direct-provider DTO paths.
- Retired Spark model-derived response headers and reset-derived 429 outcomes are ignored before shared quota health/recovery. Preserve true Retry-After account throttle and credential/transport failures.
- Keep generic WebSocket family normalization in src/server/responses/codex-ws-metadata.ts. It is not Spark-specific merely because fixtures mention codex_bengalfox.
- Generic custom-window reset observation in src/quota/window-mapping.ts survives; filter retired evidence before it sees the snapshot.
- Config schema passthrough makes an old setting inert. No destructive config migration or removal of historical observer/usage stores.
- Ownership correction: B exclusively owns tests/routing/, tests/responses/responses-compaction-routing.test.ts, ws-upstream.test.ts and responses-account-label.test.ts. A owns the remaining Responses tests. B also owns src/codex/subagent-model-fallback.ts and Responses core edits only if tracing requires them; report such expansion. This is explicit rather than overlapping broad directory ownership.
- Known retirement guard is local catalog/evidence policy (tier E1, runtime executing surface). Manually typed model ids may still pass generic routing; this work removes advertised native membership and model-specific support, not a universal request denylist. No stronger security enforcement is claimed.
- UI proof: download the exact-head dashboard-preview CI artifact (build-commit and build-gui-tree stamps) and render against synthetic fixture API responses. No local product build/test/install or live service modification.

