# 002 — Layer map and stack topology

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Historical investigation or process record; not current execution authority.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

77 layers, 21 stacks (105 and 625 appended per 003). Base rule (003 STACK-INDEPENDENCE-01, applied per layer): a layer's base is the nearest lower layer of its stack that it imports from or that is a `#`-part of the same file; S04 layers additionally base on the 105 type-contract layer; otherwise the base is `dev`. 29 layers are chained, 48 are `dev`-based; the stack id groups execution order only. Within a stack, layers are dependency-ordered (a file
that imports another file in the same stack comes after it); `#a/#b/#c`
split one large file across consecutive layers so each layer stays ≤500
changed source lines. Branch = `codex/split-<slug>`; bottom base `dev`.

Execution order across stacks: round-robin by layer index (all L1s, then all
L2s, …) so that each stack's PR can be reviewed while the next layer is
prepared, and no stack blocks another.

| Doc | Stack | Layer | File | Lines | Branch | Base |
|---|---|---:|---|---:|---|---|
| 010 | S01 lib | 1 | src/lib/redact.ts | 526 | codex/split-lib-redact | dev |
| 020 | S01 lib | 2 | src/lib/errors.ts | 457 | codex/split-lib-errors | dev |
| 030 | S01 lib | 3 | src/lib/upstream-retry.ts | 429 | codex/split-lib-upstream-retry | dev |
| 040 | S02 providers | 1 | src/providers/openai-tiers.ts | 416 | codex/split-providers-openai-tiers | dev |
| 050 | S02 providers | 2 | src/providers/registry.ts (#a) | 3250 | codex/split-providers-registry-a | dev |
| 060 | S02 providers | 3 | src/providers/registry.ts (#b) | 3250 | codex/split-providers-registry-b | codex/split-providers-registry-a |
| 070 | S02 providers | 4 | src/providers/registry.ts (#c) | 3250 | codex/split-providers-registry-c | codex/split-providers-registry-b |
| 080 | S03 adapters-anthropic | 1 | src/adapters/anthropic-image-normalize.ts | 518 | codex/split-adapters-anthropic-image-normalize | dev |
| 090 | S03 adapters-anthropic | 2 | src/adapters/anthropic.ts (#a) | 1375 | codex/split-adapters-anthropic-a | codex/split-adapters-anthropic-image-normalize |
| 100 | S03 adapters-anthropic | 3 | src/adapters/anthropic.ts (#b) | 1375 | codex/split-adapters-anthropic-b | codex/split-adapters-anthropic-a |
| 105 | S04 adapters-cursor | 0 | src/adapters/cursor/native-exec-desktop.ts | 15 | codex/split-cursor-desktop-executor-contract | dev |
| 110 | S04 adapters-cursor | 1 | src/adapters/cursor/tool-definitions.ts | 777 | codex/split-adapters-cursor-tool-definitions | codex/split-cursor-desktop-executor-contract |
| 120 | S04 adapters-cursor | 2 | src/adapters/cursor/catalog.ts | 716 | codex/split-adapters-cursor-catalog | codex/split-cursor-desktop-executor-contract |
| 130 | S04 adapters-cursor | 3 | src/adapters/cursor/images.ts | 704 | codex/split-adapters-cursor-images | codex/split-cursor-desktop-executor-contract |
| 140 | S04 adapters-cursor | 4 | src/adapters/cursor/request-builder.ts | 518 | codex/split-adapters-cursor-request-builder | codex/split-adapters-cursor-images |
| 150 | S04 adapters-cursor | 5 | src/adapters/cursor/protobuf-events.ts | 1381 | codex/split-adapters-cursor-protobuf-events | codex/split-adapters-cursor-tool-definitions |
| 160 | S05 adapters-misc | 1 | src/adapters/xai-tool-schema.ts | 436 | codex/split-adapters-xai-tool-schema | dev |
| 170 | S05 adapters-misc | 2 | src/adapters/command-code.ts | 637 | codex/split-adapters-command-code | dev |
| 180 | S05 adapters-misc | 3 | src/adapters/ollama-native.ts | 1131 | codex/split-adapters-ollama-native | dev |
| 190 | S06 media | 1 | src/vision/index.ts | 667 | codex/split-vision-index | dev |
| 200 | S06 media | 2 | src/images/artifacts.ts | 552 | codex/split-images-artifacts | dev |
| 210 | S07 responses | 1 | src/responses/parser.ts | 883 | codex/split-responses-parser | dev |
| 220 | S07 responses | 2 | src/responses/namespace-tool-compat.ts | 435 | codex/split-responses-namespace-tool-compat | dev |
| 230 | S07 responses | 3 | src/server/responses/agent-task-recovery.ts | 498 | codex/split-server-responses-agent-task-recovery | dev |
| 240 | S07 responses | 4 | src/server/responses/collaboration.ts | 622 | codex/split-server-responses-collaboration | codex/split-responses-parser |
| 250 | S08 server-claude | 1 | src/claude/inbound.ts | 578 | codex/split-claude-inbound | dev |
| 260 | S08 server-claude | 2 | src/server/claude-messages.ts | 1092 | codex/split-server-claude-messages | codex/split-claude-inbound |
| 270 | S09 server-management | 1 | src/server/system-env.ts | 537 | codex/split-server-system-env | dev |
| 280 | S09 server-management | 2 | src/server/management/logs-usage-routes.ts | 569 | codex/split-server-management-logs-usage-routes | codex/split-server-system-env |
| 290 | S09 server-management | 3 | src/server/management/lab-routes.ts | 562 | codex/split-server-management-lab-routes | dev |
| 300 | S10 codex-prompt | 1 | src/codex/prompt-layers.ts (#a) | 1652 | codex/split-codex-prompt-layers-a | dev |
| 310 | S10 codex-prompt | 2 | src/codex/prompt-layers.ts (#b) | 1652 | codex/split-codex-prompt-layers-b | codex/split-codex-prompt-layers-a |
| 320 | S11 codex-misc | 1 | src/combos/types.ts | 423 | codex/split-combos-types | dev |
| 330 | S11 codex-misc | 2 | src/codex/subagent-defaults.ts | 550 | codex/split-codex-subagent-defaults | dev |
| 340 | S11 codex-misc | 3 | src/codex/cli-install-provenance.ts | 795 | codex/split-codex-cli-install-provenance | dev |
| 350 | S11 codex-misc | 4 | src/routing/trace.ts | 776 | codex/split-routing-trace | dev |
| 360 | S11 codex-misc | 5 | src/oauth/github-copilot.ts | 428 | codex/split-oauth-github-copilot | dev |
| 370 | S12 log-guard | 1 | src/codex/log-guard/inspect.ts | 524 | codex/split-codex-log-guard-inspect | dev |
| 380 | S12 log-guard | 2 | src/codex/log-guard/protection.ts | 489 | codex/split-codex-log-guard-protection | codex/split-codex-log-guard-inspect |
| 390 | S12 log-guard | 3 | src/codex/log-guard/maintenance.ts | 403 | codex/split-codex-log-guard-maintenance | codex/split-codex-log-guard-inspect |
| 400 | S13 clients-cli | 1 | src/clients/config-export.ts (#a) | 1990 | codex/split-clients-config-export-a | dev (prerequisite #3610 landed; 003/400) |
| 410 | S13 clients-cli | 2 | src/clients/config-export.ts (#b) | 1990 | codex/split-clients-config-export-b | codex/split-clients-config-export-a |
| 420 | S13 clients-cli | 3 | src/cli/opencode.ts | 682 | codex/split-cli-opencode | codex/split-clients-config-export-b |
| 430 | S13 clients-cli | 4 | src/cli/minimax.ts | 497 | codex/split-cli-minimax | codex/split-cli-opencode |
| 440 | S13 clients-cli | 5 | src/integrations/state.ts | 495 | codex/split-integrations-state | codex/split-clients-config-export-b |
| 450 | S14 cli-hub | 1 | src/cli/status.ts | 547 | codex/split-cli-status | dev |
| 460 | S14 cli-hub | 2 | src/cli/provider.ts | 485 | codex/split-cli-provider | dev |
| 470 | S14 cli-hub | 3 | src/client/hub-client.ts | 481 | codex/split-client-hub-client | dev |
| 480 | S15 lab-events | 1 | src/lab/events/validate.ts | 781 | codex/split-lab-events-validate | dev |
| 490 | S15 lab-events | 2 | src/lab/ledger/store.ts | 531 | codex/split-lab-ledger-store | codex/split-lab-events-validate |
| 500 | S15 lab-events | 3 | src/lab/artifacts/sanitize.ts | 585 | codex/split-lab-artifacts-sanitize | dev |
| 510 | S15 lab-events | 4 | src/lab/fabric/observe.ts | 489 | codex/split-lab-fabric-observe | codex/split-lab-artifacts-sanitize |
| 520 | S15 lab-events | 5 | src/lab/fabric/scratch.ts | 439 | codex/split-lab-fabric-scratch | dev |
| 530 | S16 lab-rest | 1 | src/lab/conformance/executor.ts | 741 | codex/split-lab-conformance-executor | dev |
| 540 | S16 lab-rest | 2 | src/lab/automation/persistence.ts | 512 | codex/split-lab-automation-persistence | dev |
| 550 | S16 lab-rest | 3 | src/lab/public/community.ts | 479 | codex/split-lab-public-community | dev |
| 560 | S16 lab-rest | 4 | src/lab/projection/verification.ts | 412 | codex/split-lab-projection-verification | dev |
| 570 | S16 lab-rest | 5 | src/lab/projection/verdicts.ts | 474 | codex/split-lab-projection-verdicts | codex/split-lab-projection-verification |
| 580 | S17 gui-storage | 1 | gui/src/components/storage-workspace/StorageWorkspace.tsx | 668 | codex/split-components-storage-workspace-StorageWorkspace | dev |
| 590 | S17 gui-storage | 2 | gui/src/pages/Storage.tsx (#a) | 1469 | codex/split-pages-Storage-a | codex/split-components-storage-workspace-StorageWorkspace |
| 600 | S17 gui-storage | 3 | gui/src/pages/Storage.tsx (#b) | 1469 | codex/split-pages-Storage-b | codex/split-pages-Storage-a |
| 610 | S18 gui-integrations | 1 | gui/src/pages/integrations/overview-clients.ts | 555 | codex/split-pages-integrations-overview-clients | dev |
| 620 | S18 gui-integrations | 2 | gui/src/pages/integrations/IntegrationsOverview.tsx (#a) | 748 | codex/split-pages-integrations-IntegrationsOverview-a | codex/split-pages-integrations-overview-clients |
| 625 | S18 gui-integrations | 3 | gui/src/pages/integrations/IntegrationsOverview.tsx (#b) | 619 | codex/split-pages-integrations-IntegrationsOverview-b | codex/split-pages-integrations-IntegrationsOverview-a |
| 630 | S19 gui-compat-combo | 1 | gui/src/pages/compatibility-matrix-api.ts | 432 | codex/split-pages-compatibility-matrix-api | dev |
| 640 | S19 gui-compat-combo | 2 | gui/src/pages/CompatibilityMatrix.tsx | 628 | codex/split-pages-CompatibilityMatrix | codex/split-pages-compatibility-matrix-api |
| 650 | S19 gui-compat-combo | 3 | gui/src/combo-workspace-data.ts | 650 | codex/split-combo-workspace-data | dev |
| 660 | S19 gui-compat-combo | 4 | gui/src/components/combo-workspace-detail-panel.tsx | 401 | codex/split-components-combo-workspace-detail-panel | codex/split-combo-workspace-data |
| 670 | S20 gui-misc | 1 | gui/src/pages/ClaudeDesktop.tsx | 689 | codex/split-pages-ClaudeDesktop | dev |
| 680 | S20 gui-misc | 2 | gui/src/components/MemoryObservabilityCard.tsx | 527 | codex/split-components-MemoryObservabilityCard | dev |
| 690 | S20 gui-misc | 3 | gui/src/components/provider-workspace/ProviderSettings.tsx | 514 | codex/split-components-provider-workspace-ProviderSettings | dev |
| 700 | S20 gui-misc | 4 | gui/src/pages/dashboard-shared.ts | 488 | codex/split-pages-dashboard-shared | dev |
| 710 | S20 gui-misc | 5 | gui/src/components/QuotaBars.tsx | 452 | codex/split-components-QuotaBars | dev |
| 720 | S21 scripts | 1 | scripts/release-notes.ts (#a) | 1233 | codex/split-release-notes-a | dev |
| 730 | S21 scripts | 2 | scripts/release-notes.ts (#b) | 1233 | codex/split-release-notes-b | codex/split-release-notes-a |
| 740 | S21 scripts | 3 | scripts/test.ts | 572 | codex/split-test | dev |
| 750 | S21 scripts | 4 | scripts/disposable-host/codex-service-composed-acceptance.ts | 402 | codex/split-disposable-host-codex-service-composed-acceptance | dev |

## Stack theses

| Stack | Thesis |
|---|---|
| S01 lib | shared leaf utilities (redact/errors/upstream-retry) split before their consumers move |
| S02 providers | openai-tiers leaf, then registry.ts in three layers (contracts → entries → lookups) — 260818 WP3 |
| S03 adapters-anthropic | image-normalize leaf, then anthropic.ts in two layers |
| S04 adapters-cursor | desktop-executor-contract (105, type-cycle prerequisite per 003 TYPE-CYCLE-01) → tool-definitions → catalog → images → request-builder → protobuf-events (import order); depth 6, documented exception |
| S05 adapters-misc | xai-tool-schema, command-code, ollama-native |
| S06 media | vision/index (no text oracle; three recursive source-walk guards must include the new leaves — 003 S06-ORACLE-01), images/artifacts |
| S07 responses | parser → namespace-tool-compat → agent-task-recovery → collaboration |
| S08 server-claude | claude/inbound → server/claude-messages |
| S09 server-management | system-env → logs-usage-routes → lab-routes |
| S10 codex-prompt | prompt-layers in two layers |
| S11 codex-misc | combos/types (fanin 946, barrel-only), subagent-defaults, cli-install-provenance, routing/trace, oauth/github-copilot |
| S12 log-guard | inspect → protection → maintenance |
| S13 clients-cli | config-export (two layers) → opencode → minimax → integrations/state |
| S14 cli-hub | status, provider, hub-client |
| S15 lab-events | events/validate → ledger/store → artifacts/sanitize → fabric/observe → fabric/scratch |
| S16 lab-rest | conformance/executor, automation/persistence, public/community, projection/verification → verdicts |
| S17 gui-storage | StorageWorkspace → Storage page (two layers) |
| S18 gui-integrations | overview-clients → IntegrationsOverview #a → #b (rebased on origin/dev first; #b appended per 003) |
| S19 gui-compat-combo | compatibility-matrix-api → CompatibilityMatrix; combo-workspace-data → detail-panel |
| S20 gui-misc | ClaudeDesktop, MemoryObservabilityCard, ProviderSettings, dashboard-shared, QuotaBars |
| S21 scripts | release-notes (two layers), scripts/test.ts (40 text oracles), composed-acceptance |

## Historical per-layer gate — do not execute

```sh
# in the layer worktree, at the layer tip
bun run typecheck                                     # exit 0
bun test tests/<domain>[/<file>]                      # focused, 0 fail
bun run privacy:scan                                  # exit 0
bun test tests/lab/core-lab-boundary.test.ts          # when src/server|src/router|src/lib touched
wc -l <new leaves> <residual>                         # each <=400 or #b layer named
rg -n "from \"[^\"]*/<basename>\"" src gui/src scripts tests | wc -l  # importer count unchanged; typecheck proves resolution
# full suite (never locally)
ssh lidge 'set -o pipefail; cd ~/ocx-ci/opencodex && git fetch -q origin <branch> && git checkout -q FETCH_HEAD && git rev-parse HEAD && bun install --frozen-lockfile >/dev/null && bun run test > /tmp/suite-<branch-slug>.log 2>&1; rc=$?; tail -15 /tmp/suite-<branch-slug>.log; echo SUITE_EXIT=$rc; exit $rc'
# the receipt records the printed HEAD sha (must equal the layer tip) and SUITE_EXIT=0
```
