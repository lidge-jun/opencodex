# 004 — Roadmap lock (wp1 D)

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Historical investigation or process record; not current execution authority.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

Locked 2026-09-05 after a five-round audit (003 amendments applied). This is
the work-phase map the goalplan carries: one work-phase per layer, id
`L<dec>`, in the execution order below (round-robin by layer index across
stacks so that each stack's bottom PR is open before any second layer).

| Order | WP id | Doc | Branch | Base |
|---:|---|---|---|---|
| 1 | L105 | 105 | codex/split-cursor-desktop-executor-contract | dev |
| 2 | L010 | 010 | codex/split-lib-redact | dev |
| 3 | L040 | 040 | codex/split-providers-openai-tiers | dev |
| 4 | L080 | 080 | codex/split-adapters-anthropic-image-normalize | dev |
| 5 | L110 | 110 | codex/split-adapters-cursor-tool-definitions | codex/split-cursor-desktop-executor-contract |
| 6 | L160 | 160 | codex/split-adapters-xai-tool-schema | dev |
| 7 | L190 | 190 | codex/split-vision-index | dev |
| 8 | L210 | 210 | codex/split-responses-parser | dev |
| 9 | L250 | 250 | codex/split-claude-inbound | dev |
| 10 | L270 | 270 | codex/split-server-system-env | dev |
| 11 | L300 | 300 | codex/split-codex-prompt-layers-a | dev |
| 12 | L320 | 320 | codex/split-combos-types | dev |
| 13 | L370 | 370 | codex/split-codex-log-guard-inspect | dev |
| 14 | L400 | 400 | codex/split-clients-config-export-a | dev |
| 15 | L450 | 450 | codex/split-cli-status | dev |
| 16 | L480 | 480 | codex/split-lab-events-validate | dev |
| 17 | L530 | 530 | codex/split-lab-conformance-executor | dev |
| 18 | L580 | 580 | codex/split-components-storage-workspace-StorageWorkspace | dev |
| 19 | L610 | 610 | codex/split-pages-integrations-overview-clients | dev |
| 20 | L630 | 630 | codex/split-pages-compatibility-matrix-api | dev |
| 21 | L670 | 670 | codex/split-pages-ClaudeDesktop | dev |
| 22 | L720 | 720 | codex/split-release-notes-a | dev |
| 23 | L020 | 020 | codex/split-lib-errors | dev |
| 24 | L050 | 050 | codex/split-providers-registry-a | dev |
| 25 | L090 | 090 | codex/split-adapters-anthropic-a | codex/split-adapters-anthropic-image-normalize |
| 26 | L120 | 120 | codex/split-adapters-cursor-catalog | codex/split-cursor-desktop-executor-contract |
| 27 | L170 | 170 | codex/split-adapters-command-code | dev |
| 28 | L200 | 200 | codex/split-images-artifacts | dev |
| 29 | L220 | 220 | codex/split-responses-namespace-tool-compat | dev |
| 30 | L260 | 260 | codex/split-server-claude-messages | codex/split-claude-inbound |
| 31 | L280 | 280 | codex/split-server-management-logs-usage-routes | codex/split-server-system-env |
| 32 | L310 | 310 | codex/split-codex-prompt-layers-b | codex/split-codex-prompt-layers-a |
| 33 | L330 | 330 | codex/split-codex-subagent-defaults | dev |
| 34 | L380 | 380 | codex/split-codex-log-guard-protection | codex/split-codex-log-guard-inspect |
| 35 | L410 | 410 | codex/split-clients-config-export-b | codex/split-clients-config-export-a |
| 36 | L460 | 460 | codex/split-cli-provider | dev |
| 37 | L490 | 490 | codex/split-lab-ledger-store | codex/split-lab-events-validate |
| 38 | L540 | 540 | codex/split-lab-automation-persistence | dev |
| 39 | L590 | 590 | codex/split-pages-Storage-a | codex/split-components-storage-workspace-StorageWorkspace |
| 40 | L620 | 620 | codex/split-pages-integrations-IntegrationsOverview-a | codex/split-pages-integrations-overview-clients |
| 41 | L640 | 640 | codex/split-pages-CompatibilityMatrix | codex/split-pages-compatibility-matrix-api |
| 42 | L680 | 680 | codex/split-components-MemoryObservabilityCard | dev |
| 43 | L730 | 730 | codex/split-release-notes-b | codex/split-release-notes-a |
| 44 | L030 | 030 | codex/split-lib-upstream-retry | dev |
| 45 | L060 | 060 | codex/split-providers-registry-b | codex/split-providers-registry-a |
| 46 | L100 | 100 | codex/split-adapters-anthropic-b | codex/split-adapters-anthropic-a |
| 47 | L130 | 130 | codex/split-adapters-cursor-images | codex/split-cursor-desktop-executor-contract |
| 48 | L180 | 180 | codex/split-adapters-ollama-native | dev |
| 49 | L230 | 230 | codex/split-server-responses-agent-task-recovery | dev |
| 50 | L290 | 290 | codex/split-server-management-lab-routes | dev |
| 51 | L340 | 340 | codex/split-codex-cli-install-provenance | dev |
| 52 | L390 | 390 | codex/split-codex-log-guard-maintenance | codex/split-codex-log-guard-inspect |
| 53 | L420 | 420 | codex/split-cli-opencode | codex/split-clients-config-export-b |
| 54 | L470 | 470 | codex/split-client-hub-client | dev |
| 55 | L500 | 500 | codex/split-lab-artifacts-sanitize | dev |
| 56 | L550 | 550 | codex/split-lab-public-community | dev |
| 57 | L600 | 600 | codex/split-pages-Storage-b | codex/split-pages-Storage-a |
| 58 | L625 | 625 | codex/split-pages-integrations-IntegrationsOverview-b | codex/split-pages-integrations-IntegrationsOverview-a |
| 59 | L650 | 650 | codex/split-combo-workspace-data | dev |
| 60 | L690 | 690 | codex/split-components-provider-workspace-ProviderSettings | dev |
| 61 | L740 | 740 | codex/split-test | dev |
| 62 | L070 | 070 | codex/split-providers-registry-c | codex/split-providers-registry-b |
| 63 | L140 | 140 | codex/split-adapters-cursor-request-builder | codex/split-adapters-cursor-images |
| 64 | L240 | 240 | codex/split-server-responses-collaboration | codex/split-responses-parser |
| 65 | L350 | 350 | codex/split-routing-trace | dev |
| 66 | L430 | 430 | codex/split-cli-minimax | codex/split-cli-opencode |
| 67 | L510 | 510 | codex/split-lab-fabric-observe | codex/split-lab-artifacts-sanitize |
| 68 | L560 | 560 | codex/split-lab-projection-verification | dev |
| 69 | L660 | 660 | codex/split-components-combo-workspace-detail-panel | codex/split-combo-workspace-data |
| 70 | L700 | 700 | codex/split-pages-dashboard-shared | dev |
| 71 | L750 | 750 | codex/split-disposable-host-codex-service-composed-acceptance | dev |
| 72 | L150 | 150 | codex/split-adapters-cursor-protobuf-events | codex/split-adapters-cursor-tool-definitions |
| 73 | L360 | 360 | codex/split-oauth-github-copilot | dev |
| 74 | L440 | 440 | codex/split-integrations-state | codex/split-clients-config-export-b |
| 75 | L520 | 520 | codex/split-lab-fabric-scratch | dev |
| 76 | L570 | 570 | codex/split-lab-projection-verdicts | codex/split-lab-projection-verification |
| 77 | L710 | 710 | codex/split-components-QuotaBars | dev |


## Historical execution sequence — do not execute

The original sequence was: each work-phase = one full PABCD cycle: P stale-checks its decade doc against
the tip of its base branch; A = gpt-6-astra read-only plan audit; B =
gpt-6-astra executor in a dedicated `git worktree`; C = 002 per-layer gate +
lidge full suite (pipefail receipt); D = commit, push, PR (base per 002),
record PR number + CI rollup in the decade doc, then re-enter P.
