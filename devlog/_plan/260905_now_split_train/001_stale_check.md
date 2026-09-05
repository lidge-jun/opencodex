# 001 — Stale check of the 68 NOW rows against origin/dev

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Historical investigation or process record; not current execution authority. Counts, source ranges and origin/dev observations below belong to the historical checkpoint, not the current inventory.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

Command: `git fetch origin dev; git diff --numstat 980a9fbed origin/dev -- <path>`
for each row, plus `git merge-base --is-ancestor 980a9fbed origin/dev` (true;
origin/dev = 583d6a91b, 6 commits ahead).

Result: **67 unchanged, 1 changed.** (origin/dev moved to 1362b1a38 during
drafting; the IntegrationsOverview delta arrives in that commit, #3540 carry.)

| Path | Upstream delta | Disposition |
|---|---|---|
| gui/src/pages/integrations/IntegrationsOverview.tsx | +9 lines (isMissingJournalEntry guard in the delete handler, #3540 carry) | KEEP — the layer rebases onto origin/dev before moving; line ranges in its decade doc are taken from origin/dev, not 980a9fbed |

All other rows: line counts and ranges in the lane docs remain exact at
origin/dev.

## Oracle inventory (per row)

`textoracle` = number of test files that read the file as text or resolve its
path (`rg -l 'readFileSync|Bun\.file|source\(' tests | xargs rg -l <basename>`);
`fanin` = importer count across src/gui/scripts/tests. Both from
origin/dev.

| Path | lines | fanin | textoracle |
|---|---:|---:|---:|
| src/server/claude-messages.ts | 1092 | — | — |
| src/responses/parser.ts | 883 | — | — |
| src/server/responses/collaboration.ts | 622 | — | — |
| src/claude/inbound.ts | 578 | — | — |
| src/server/management/logs-usage-routes.ts | 569 | — | — |
| src/server/management/lab-routes.ts | 562 | — | — |
| src/server/system-env.ts | 537 | — | — |
| src/server/responses/agent-task-recovery.ts | 498 | — | — |
| src/responses/namespace-tool-compat.ts | 435 | — | — |
| src/providers/registry.ts | 3250 | — | — |
| src/codex/prompt-layers.ts | 1652 | — | — |
| src/codex/cli-install-provenance.ts | 795 | — | — |
| src/routing/trace.ts | 776 | — | — |
| src/codex/subagent-defaults.ts | 550 | — | — |
| src/codex/log-guard/inspect.ts | 524 | — | — |
| src/codex/log-guard/protection.ts | 489 | — | — |
| src/oauth/github-copilot.ts | 428 | — | — |
| src/combos/types.ts | 423 | — | — |
| src/providers/openai-tiers.ts | 416 | — | — |
| src/codex/log-guard/maintenance.ts | 403 | — | — |
| src/adapters/cursor/protobuf-events.ts | 1381 | — | — |
| src/adapters/anthropic.ts | 1375 | — | — |
| src/adapters/ollama-native.ts | 1131 | — | — |
| src/adapters/cursor/tool-definitions.ts | 777 | — | — |
| src/adapters/cursor/catalog.ts | 716 | — | — |
| src/adapters/cursor/images.ts | 704 | — | — |
| src/vision/index.ts | 667 | — | — |
| src/adapters/command-code.ts | 637 | — | — |
| src/images/artifacts.ts | 552 | — | — |
| src/adapters/cursor/request-builder.ts | 518 | — | — |
| src/adapters/anthropic-image-normalize.ts | 518 | — | — |
| src/adapters/xai-tool-schema.ts | 436 | — | — |
| gui/src/pages/Storage.tsx | 1469 | — | — |
| gui/src/pages/integrations/IntegrationsOverview.tsx | 748 | — | — |
| gui/src/pages/ClaudeDesktop.tsx | 689 | — | — |
| gui/src/components/storage-workspace/StorageWorkspace.tsx | 668 | — | — |
| gui/src/combo-workspace-data.ts | 650 | — | — |
| gui/src/pages/CompatibilityMatrix.tsx | 628 | — | — |
| gui/src/pages/integrations/overview-clients.ts | 555 | — | — |
| gui/src/components/MemoryObservabilityCard.tsx | 527 | — | — |
| gui/src/components/provider-workspace/ProviderSettings.tsx | 514 | — | — |
| gui/src/pages/dashboard-shared.ts | 488 | — | — |
| gui/src/components/QuotaBars.tsx | 452 | — | — |
| gui/src/pages/compatibility-matrix-api.ts | 432 | — | — |
| gui/src/components/combo-workspace-detail-panel.tsx | 401 | — | — |
| src/clients/config-export.ts | 1990 | — | — |
| scripts/release-notes.ts | 1233 | — | — |
| src/lab/events/validate.ts | 781 | — | — |
| src/lab/conformance/executor.ts | 741 | — | — |
| src/cli/opencode.ts | 682 | — | — |
| src/lab/artifacts/sanitize.ts | 585 | — | — |
| scripts/test.ts | 572 | — | — |
| src/cli/status.ts | 547 | — | — |
| src/lab/ledger/store.ts | 531 | — | — |
| src/lib/redact.ts | 526 | — | — |
| src/lab/automation/persistence.ts | 512 | — | — |
| src/cli/minimax.ts | 497 | — | — |
| src/integrations/state.ts | 495 | — | — |
| src/lab/fabric/observe.ts | 489 | — | — |
| src/cli/provider.ts | 485 | — | — |
| src/client/hub-client.ts | 481 | — | — |
| src/lab/public/community.ts | 479 | — | — |
| src/lab/projection/verdicts.ts | 474 | — | — |
| src/lib/errors.ts | 457 | — | — |
| src/lab/fabric/scratch.ts | 439 | — | — |
| src/lib/upstream-retry.ts | 429 | — | — |
| src/lab/projection/verification.ts | 412 | — | — |
| scripts/disposable-host/codex-service-composed-acceptance.ts | 402 | — | — |

(fanin/textoracle values are recorded per layer in each decade doc from the
same command; the notable ones for slicing were: `src/combos/types.ts`
fanin 946, `src/providers/registry.ts` 167, `src/adapters/cursor/catalog.ts`
129, `src/lab/ledger/store.ts` 111; text oracles: `src/vision/index.ts` 47,
`scripts/test.ts` 40, `src/integrations/state.ts` 4, `src/codex/prompt-layers.ts`
3, `src/lab/ledger/store.ts` 3, `src/server/system-env.ts` 2, and 1 each for
claude-messages, registry, log-guard/inspect, cursor/images, overview-clients,
release-notes, lab/conformance/executor, cli/opencode, cli/provider,
lib/upstream-retry.)

## Intra-set import edges (prerequisite for stacking)

47 edges among the 68 files (script: read every `from "./..."` specifier and
resolve against the set). They define the within-stack order in 002.
Cross-stack edges exist in both directions (e.g. registry ← cursor/catalog,
logs-usage-routes ← registry); they never block a layer because every layer
preserves the original path's barrel re-export, so a consumer in another
stack keeps compiling whether or not the producer's split has merged.
