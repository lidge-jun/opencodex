# Work phase 1 — Publish refined lane PRs

Depends on wp0. Coordinator source changes: NONE. Each lane creates its own numbered implementation plan before production edits. This document defines concrete dispatch/publication changes; source diffs are fixed by the captured public PR head and refined by the owning lane after review.

## Coordinator artifacts (NEW)
- .tmp/next-release/lanes.json: repository, lane id, canonical thread/host, provisional handle separately, worktree/branch, base/head SHA, sources, PRs, status, evidence.
- .tmp/next-release/coverage.json: per source head, original behaviors, replacement PR/head, retained/dropped changes with reasons, contributor trailers, tests, review gaps, closure eligibility.
- 011_lane_results.md: public outcomes, PR links and verification limits; no raw security analysis or machine paths.

## Dispatch contract
Create six isolated worktree chats from verified dev. Branch prefix codex/next-release-261004-. User authorizes scoped push and PR creation; merge/release/installed runtime writes/source closure are withheld. Each lane runs its own PABCD, uses leaf subagents, preserves contributor trailers and templates, attaches every created PR, runs focused checks, and returns evidence. Do not message unrelated tasks. No automatic approval requests or native-stack registration. Shared registry/docs paths are integration conflicts to reconcile on fresh dev before future merge, not permission to edit peers.

## catalog
Sources: #6530, #6537.

Before → after: Preserve routed rows when config authority is absent; bind writer ownership, audit minimally and bound owner healing.

Acceptance: Missing/salvaged config cannot remove routed rows; explicit owner deletion/restore works; foreign owner cannot write; identical bytes unchanged; healing respects idle/gates/rate caps.

SoT: structure/codex-home.md.

Source file map (from pinned public PRs; NEW where absent on baseline, otherwise MODIFY):
- #6530 head `451bcd43e078d811b2bef0455000d48964bb06cd`
- #6537 head `8e50608319dcd5180e43fa2b9377ed4b3702127b`
- MODIFY `scripts/test-layout/layout.json`
- MODIFY `src/cli/dispatch.ts`
- MODIFY `src/cli/index.ts`
- NEW `src/codex/catalog-self-heal.ts`
- MODIFY `src/codex/catalog-write-serialization.ts`
- MODIFY `src/codex/catalog/build-entries.ts`
- MODIFY `src/codex/catalog/remote.ts`
- MODIFY `src/codex/catalog/restore.ts`
- MODIFY `src/codex/catalog/retained-sync.ts`
- NEW `src/codex/catalog/routed-removal.ts`
- NEW `src/codex/catalog/write-audit.ts`
- NEW `src/codex/codex-home-owner.ts`
- MODIFY `src/codex/convergence.ts`
- MODIFY `src/codex/inject/restore.ts`
- MODIFY `src/codex/internal/catalog-writer.ts`
- MODIFY `src/codex/journal.ts`
- MODIFY `src/codex/refresh.ts`
- MODIFY `src/codex/sync.ts`
- MODIFY `src/server/index.ts`
- MODIFY `structure/codex-home.md`
- MODIFY `tests/codex-integration/catalog-remote-pull.test.ts`
- NEW `tests/codex-integration/codex-catalog-routed-removal.test.ts`
- NEW `tests/codex-integration/codex-catalog-self-heal.test.ts`
- MODIFY `tests/codex-integration/codex-catalog-sync-hardening.test.ts`
- NEW `tests/codex-integration/codex-catalog-write-audit.test.ts`
- MODIFY `tests/codex-integration/codex-catalog-write-serialization.test.ts`
- MODIFY `tests/codex-integration/codex-catalog-writer.test.ts`
- MODIFY `tests/codex-integration/codex-convergence-account-selectors.test.ts`
- MODIFY `tests/codex-integration/codex-convergence-contract.test.ts`
- NEW `tests/codex-integration/codex-home-owner.test.ts`
- MODIFY `tests/codex-integration/codex-models-cache-invalidate.test.ts`
- MODIFY `tests/codex-integration/codex-retained-root-serialization.test.ts`
- MODIFY `tests/codex-integration/codex-sync-api.test.ts`
- MODIFY `tests/fixtures/test-layout-expected.json`

## claude
Sources: #6533, #6534, #6547.

Before → after: Separate native tool-reference correctness and account-pool protocol preservation from settings/default changes in a manual PR chain.

Acceptance: Declared nested references renamed without touching arbitrary input/cache markers; exact selected account identity, refusal failover before output only; opt-out persists and failed save is visible; real live coverage remains unproven unless exercised.

SoT: structure/data-planes/protocol-paths.md and structure/providers/anthropic-account-pool.md.

Source file map (from pinned public PRs; NEW where absent on baseline, otherwise MODIFY):
- #6533 head `8e5c78912222b1616709d664c23de254dd71b7c9`
- #6534 head `829b203b3e65530a4cdaaa121f2da15484c2c9b7`
- #6547 head `5f3cf4ed0b4a63604133863442002fb9ac824b16`
- MODIFY `docs-site/src/content/docs/guides/claude-code.md`
- MODIFY `docs-site/src/content/docs/reference/configuration/providers.md`
- MODIFY `docs-site/src/content/docs/reference/configuration/server.md`
- MODIFY `gui/src/components/provider-workspace/AnthropicAccountPoolSettings.tsx`
- MODIFY `gui/src/i18n/de.ts`
- MODIFY `gui/src/i18n/en.ts`
- MODIFY `gui/src/i18n/fr.ts`
- MODIFY `gui/src/i18n/ja.ts`
- MODIFY `gui/src/i18n/ko.ts`
- MODIFY `gui/src/i18n/pt.ts`
- MODIFY `gui/src/i18n/ru.ts`
- MODIFY `gui/src/i18n/tr.ts`
- MODIFY `gui/src/i18n/vi.ts`
- MODIFY `gui/src/i18n/zh-TW.ts`
- MODIFY `gui/src/i18n/zh.ts`
- MODIFY `gui/src/pool-settings.ts`
- MODIFY `gui/src/styles.css`
- MODIFY `gui/tests/account-pool-strategy.test.tsx`
- MODIFY `gui/tests/anthropic-pool-conditions.test.tsx`
- MODIFY `gui/tests/anthropic-pool-quota-window.test.tsx`
- MODIFY `src/adapters/anthropic/beta-allowlist.ts`
- MODIFY `src/adapters/anthropic/client-identity.ts`
- NEW `src/adapters/anthropic/native-client-preamble.ts`
- MODIFY `src/adapters/anthropic/passthrough.ts`
- MODIFY `src/config/diagnostics.ts`
- MODIFY `src/config/schema/config-schema.ts`
- MODIFY `src/oauth/anthropic-routing.ts`
- MODIFY `src/oauth/pool-settings-capability.ts`
- MODIFY `src/protocols/plan-snapshot.ts`
- MODIFY `src/protocols/settings.ts`
- MODIFY `src/server/claude-messages.ts`
- MODIFY `src/server/management/oauth-account-routes.ts`
- MODIFY `src/server/messages-native-eligibility.ts`
- MODIFY `src/server/messages-native-oauth.ts`
- MODIFY `src/server/messages-native.ts`
- MODIFY `src/types/config.ts`
- MODIFY `structure/data-planes/protocol-paths.md`
- MODIFY `structure/providers/anthropic-account-pool.md`
- MODIFY `tests/adapters/anthropic/anthropic-account-pool.test.ts`
- MODIFY `tests/adapters/anthropic/anthropic-beta-allowlist.test.ts`
- MODIFY `tests/adapters/anthropic/anthropic-client-identity.test.ts`
- MODIFY `tests/adapters/anthropic/anthropic-messages-passthrough-oauth.test.ts`
- MODIFY `tests/claude-integration/messages-native-oauth.test.ts`
- MODIFY `tests/config/config-load-degrade.test.ts`
- MODIFY `tests/config/protocol-settings.test.ts`
- MODIFY `tests/responses/messages-native-eligibility.test.ts`
- MODIFY `tests/responses/messages-native-oauth-eligibility.test.ts`
- MODIFY `tests/server/account-pool-management-api.test.ts`

## cache
Sources: #6521, #6488.

Before → after: Two independent PRs in one lane: caller session identity and Devin named-conversation trajectory. No artificial dependency.

Acceptance: Explicit session headers win; unsafe IDs ignored; body/abort preserved; no invented cross-user identity; Devin key separates account/host/conversation and overlapping turns never share trajectory.

SoT: structure/runtime.md and structure/providers-and-adapters.md.

Source file map (from pinned public PRs; NEW where absent on baseline, otherwise MODIFY):
- #6521 head `011ab507fcf03ae86933098de1994b25ecfd0495`
- #6488 head `a0b199fc6b96367fb174f6488a7a45eb58eccd54`
- MODIFY `scripts/test-layout/layout.json`
- MODIFY `src/adapters/devin.ts`
- MODIFY `src/adapters/devin/cloud-direct/chat.ts`
- NEW `src/server/caller-session-identity.ts`
- MODIFY `src/server/index/serve-options.ts`
- MODIFY `tests/fixtures/test-layout-expected.json`
- MODIFY `tests/providers/devin-prompt-cache.test.ts`
- MODIFY `tests/providers/xai/grok-session-identity.test.ts`
- NEW `tests/server/caller-session-identity.test.ts`
- MODIFY `tests/server/loopback-listener-admission.test.ts`

## restart
Sources: #6548.

Before → after: Refine update restart using existing process-bound ownership and lifecycle machinery; extract helper if ratchet requires.

Acceptance: CLI-newer path only; fail on unknown/mismatched replacement identity/version; no stop on uncertain/foreign targets; stop/start failure and concurrent process replacement covered.

SoT: structure/runtime.md.

Source file map (from pinned public PRs; NEW where absent on baseline, otherwise MODIFY):
- #6548 head `fe3cf0aa823afd4144ab240191939ec6145b1c45`
- MODIFY `src/cli/index.ts`
- MODIFY `src/cli/system-restart-client.ts`
- MODIFY `tests/cli/system-restart-client.test.ts`

## retry and picker (separate worktree lanes)
Sources: retry owns #6525; picker owns #6524.

Before → after: Two independent PRs: translated pre-header replay and bounded picker headers. Keep distinct review theses.

Acceptance: Replay opt-in obeys shared grant/send budget and no replay after output/stored/cancelled; real loopback reset. Picker 24 KiB headers relay exactly, above 64 KiB rejected with content-free diagnostics; no claim that issue #6511 is solved without live acceptance.

SoT: structure/transports/responses-failover.md and structure/clients/claude-desktop.md.

Source file map (from pinned public PRs; NEW where absent on baseline, otherwise MODIFY):
- #6525 head `49c5c7012f1f27d781079231dde92562ced68594`
- #6524 head `0c258acd496aef26735ab6a61d65cce611e8ff88`
- MODIFY `docs-site/src/content/docs/fr/reference/configuration/providers.md`
- MODIFY `docs-site/src/content/docs/guides/claude-code.md`
- MODIFY `docs-site/src/content/docs/ja/reference/configuration/providers.md`
- MODIFY `docs-site/src/content/docs/ko/reference/configuration/providers.md`
- MODIFY `docs-site/src/content/docs/reference/configuration/providers.md`
- MODIFY `docs-site/src/content/docs/ru/reference/configuration/providers.md`
- MODIFY `docs-site/src/content/docs/tr/reference/configuration/providers.md`
- MODIFY `docs-site/src/content/docs/zh-cn/reference/configuration/providers.md`
- MODIFY `docs-site/src/content/docs/zh-tw/reference/configuration/providers.md`
- MODIFY `scripts/test-layout/layout.json`
- MODIFY `src/claude/intercept/picker-listener.ts`
- MODIFY `src/server/responses/adapter-dispatch.ts`
- MODIFY `src/types/provider.ts`
- MODIFY `structure/clients/claude-desktop.md`
- MODIFY `structure/transports/responses-failover.md`
- MODIFY `tests/claude-integration/claude-picker-listener.test.ts`
- MODIFY `tests/fixtures/test-layout-expected.json`
- NEW `tests/responses/responses-translated-reset.test.ts`


## Architect decisions accepted/amended
- NR-A accepted: catalog A1 removal, A2 ownership/intent/idempotence, A3 audit, A4 healer remain separately reviewable. Lane may combine A2/A3 only if implementation coupling makes separation artificial and records why; no timer hidden in the admission PR.
- NR-B accepted with boundary amendment: Claude B1 tools, B2 client compatibility, B3 pooled dispatch, B4 settings/defaults. Lane may combine B2/B3 if standalone correctness requires it, while B4 remains separate. Explicit operator false settings must not silently flip to true; resolve source behavior with config precedence tests before adopting default. Migration/recovery semantics must preserve restore and legitimate existing home ownership, never seize an active foreign home.
- NR-C accepted: two independent PRs, sequential branch work in that lane only; no invented dependency.
- NR-D accepted: exact target ownership, confirmed stop and exact known replacement version; behavioral failure probes, sibling module.
- NR-E/F accepted: separate worktree chats for retry and picker, rather than the initial combined transport chat.
- NR-DEP accepted: common inspected base is 0818ea1812a028e1c14cd0b0511b44863407bc52; refresh dev before publication without changing release/version policy. Shared registry/docs hunks reconcile after lanes; no cross-checkout writes.
- NR-ACCEPT/NR-CLOSE accepted in full. Failed healer attempt must not suppress all future retry. B4 tests malformed config, provider scope, explicit opt-out, atomic persistence, failed save and count/preview/runtime consistency. Devin cancellation and bounded storage included.
- Resource exception: concurrent release/lane work makes local full/changed suites impractical; focused regression and static/structure/privacy/layout/ratchet checks plus relevant hosted checks. Never mark unrun suite green.
