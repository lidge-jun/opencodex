# 410 — S13 L2/5: finish client path and format partitions

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`. Bounded delegated **docs-only C3** task; parent owns orchestration, loop and goal state.
- Goal: finish client path and format partitions, preserving the original public import path and behavior.
- Non-goals: behavior fixes, exported renames, signature changes, new validation, changed credentials/admission policy, changed config paths, new framework, caller migration, merges or releases. Preserve function bodies verbatim, including >50-line functions; function redesign is not this pure-move train.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below; every layer must pass independently at its actual tip. Full suite on `ssh lidge` only, never locally.
- Stop: exact-tip acceptance evidence recorded; do not merge. This drafting task stops after document checks and runs no tests, code entrypoints, or Git mutations.
- Escalation: parent must resolve the 002 size-budget contradiction before execution. This layer moves **1041 original lines** including attached comments/whitespace: plain added+deleted churn is at least **2082 lines** before glue. Even a move-count-once interpretation fails: #a moves 707 lines and #b 1,041. At least 1,590 original lines must leave a 1,990-line file to reach 400, so two 500-line layers cannot meet that target. Request an explicit pure-move churn exception or a parent-approved topology expansion; do not silently waive the gate or edit 002. Stale source, a leaf >400, any new cycle, or any behavioral difference also stops implementation.

Basis: task docs HEAD `4cc219549`; code `origin/dev=1362b1a3841b4de20177e5d65865a513dd7936c4`. Read 000, 001, S13 rows/Per-layer gate of 002, and the relevant records in `devlog/_plan/260905_modular_debt_ledger/016_lane_cli_storage_usage_update_lab_scripts.md`. Source was read with `git show origin/dev:<path>`; `git diff origin/dev -- src/clients/config-export.ts src/cli/opencode.ts src/cli/minimax.ts src/integrations/state.ts` was empty. Older tips in 000/001 are historical, not this plan's code basis.

Structural decision (cxc-dev §1/§5, architecture ARCH-MAP-01/ARCH-DECISION-01): 1990 lines mix distinct concerns. Reject deleting/configuring the feature (does not preserve behavior), and generic helpers/index barrels (do not establish ownership). Reuse every existing algorithm and lower-level dependency; only relocate declarations. Inspected conventions: `src/config/paths.ts`, `src/config/process-state.ts`, `src/cli/launcher-context.ts`, `src/cli/account-extended.ts`, `src/integrations/ownership-policy.ts`. Use the domain subfolder `src/clients/config-export/` without an index barrel. The original remains an existing compatibility boundary, not an internal import shortcut.

Structural map: 33 direct source/test/fixture consumer files. Production dependents: `src/integrations/state.ts`, `src/integrations/ownership.ts`, `src/integrations/merge.ts`, `src/integrations/registry.ts`, `src/integrations/owned-refresh.ts`, `src/integrations/config-io.ts`, `src/integrations/ownership-policy.ts`, `src/integrations/writer.ts`, `src/server/management/model-routes.ts`, `src/server/management/model-rows.ts`, `src/cli/export-command.ts`, `src/cli/minimax.ts`, `src/cli/opencode.ts`. Current direction is dependents → original → existing imported owners; intended direction is dependents → original → concern leaves → existing owners. Leaf imports are fully enumerated below; no leaf → original edge. Blast radius: client/CLI integration feature, with public consumers unchanged. `structure/09_client-integrations.md:11` identifies builders and classification as single authorities; no parallel implementation is introduced.

## Symbol inventory

Exact syntax spans at `origin/dev:src/clients/config-export.ts` (leading comments excluded). Reproduce: `sg run --lang ts --kind 'function_declaration,interface_declaration,type_alias_declaration,lexical_declaration,variable_declaration,class_declaration' --json=compact src/clients/config-export.ts`, filtering declarations enclosed by another declaration. Consumers = distinct direct importer/re-exporter files per symbol, resolved by literal module path then counted with `rg -l -w '<symbol>' <resolved importer files>`. Dynamic dispatch destructuring counts too. Private declarations have 0 external consumers, not 0 local calls. Imported bindings are covered by the leaf imports; export-only declarations are noted below. L2 repeats the complete basis inventory and marks L1-owned rows already moved.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `ManagedFragment` | interface | 43–46 | yes | 2 | `src/clients/config-export/contracts.ts` (L1; already moved) |
| `ManagedContribution` | interface | 49–52 | yes | 5 | `src/clients/config-export/contracts.ts` (L1; already moved) |
| `BuildContribution` | type | 54–54 | yes | 0 | `src/clients/config-export/contracts.ts` (L1; already moved) |
| `OpencodeLaunchEnv` | interface | 56–58 | yes | 1 | `src/clients/config-export/contracts.ts` (L1; already moved) |
| `OpencodeCatalogModel` | interface | 61–76 | yes | 1 | `src/clients/config-export/contracts.ts` (L1; already moved) |
| `OpencodeModelEntry` | interface | 78–81 | yes | 1 | `src/clients/config-export/opencode.ts` (L2) |
| `OpencodeModelVariant` | interface | 90–93 | yes | 0 | `src/clients/config-export/opencode.ts` (L2) |
| `OpencodeV2ModelEntry` | interface | 95–97 | yes | 0 | `src/clients/config-export/opencode.ts` (L2) |
| `OpencodeProviderConnection` | interface | 100–104 | yes | 0 | `src/clients/config-export/opencode.ts` (L2) |
| `OpencodeProviderBlock` | interface | 107–112 | yes | 1 | `src/clients/config-export/opencode.ts` (L2) |
| `OpencodeV2ProviderBlock` | interface | 115–120 | yes | 1 | `src/clients/config-export/opencode.ts` (L2) |
| `OpencodeProviderBlocks` | interface | 127–130 | yes | 1 | `src/clients/config-export/opencode.ts` (L2) |
| `OpencodeGeneratedConfig` | interface | 132–138 | yes | 4 | `src/clients/config-export/opencode.ts` (L2) |
| `OPENCODE_PROVIDER_ID` | const | 141–141 | yes | 11 | `src/clients/config-export/constants.ts` (L1; already moved) |
| `OPENCODE_CONFIG_SCHEMA` | const | 143–143 | yes | 2 | `src/clients/config-export/constants.ts` (L1; already moved) |
| `OPENCODE_PROVIDER_NPM` | const | 149–149 | no | 0 | `src/clients/config-export/opencode.ts` (L2) |
| `OPENCODE_V2_PROVIDER_PACKAGE` | const | 161–161 | no | 0 | `src/clients/config-export/opencode.ts` (L2) |
| `OPENCODE_PROVIDER_NAME` | const | 164–164 | no | 0 | `src/clients/config-export/opencode.ts` (L2) |
| `OPENCODE_API_KEY_ENV` | const | 171–171 | yes | 3 | `src/clients/config-export/constants.ts` (L1; already moved) |
| `OPENCODE_API_KEY_ENV_REF` | const | 174–174 | yes | 2 | `src/clients/config-export/constants.ts` (L1; already moved) |
| `HERMES_API_KEY_ENV` | const | 180–180 | yes | 0 | `src/clients/config-export/constants.ts` (L1; already moved) |
| `HERMES_API_KEY_ENV_REF` | const | 181–181 | yes | 2 | `src/clients/config-export/constants.ts` (L1; already moved) |
| `OPENCLAW_API_KEY_ENV` | const | 184–184 | yes | 0 | `src/clients/config-export/constants.ts` (L1; already moved) |
| `OPENCLAW_API_KEY_ENV_REF` | const | 185–185 | yes | 2 | `src/clients/config-export/constants.ts` (L1; already moved) |
| `LOOPBACK_API_KEY_PLACEHOLDER` | const | 193–193 | yes | 9 | `src/clients/config-export/constants.ts` (L1; already moved) |
| `GAJAE_API_KEY_ENV` | const | 200–200 | yes | 2 | `src/clients/config-export/constants.ts` (L1; already moved) |
| `PI_API_DIALECT` | const | 203–203 | no | 0 | `src/clients/config-export/constants.ts` (L1; already moved) |
| `SCHEMA_REQUIRED_OUTPUT_BUDGET` | const | 217–217 | yes | 2 | `src/clients/config-export/constants.ts` (L1; already moved) |
| `OPENCODE_PROVIDER_BLOCK_DEFAULT_CONFIG` | const | 220–225 | yes | 1 | `src/clients/config-export/constants.ts` (L1; already moved) |
| `opencodeGlobalConfigPath` | function | 231–237 | yes | 3 | `src/clients/config-export/paths.ts` (L2) |
| `OMP_PROFILE_NAME_RE` | const | 239–239 | no | 0 | `src/clients/config-export/paths.ts` (L2) |
| `OMP_WINDOWS_RESERVED_PROFILE_RE` | const | 240–240 | no | 0 | `src/clients/config-export/paths.ts` (L2) |
| `ompProfileName` | function | 242–258 | no | 0 | `src/clients/config-export/paths.ts` (L2) |
| `piAgentDir` | function | 270–274 | yes | 2 | `src/clients/config-export/paths.ts` (L2) |
| `piConfigPath` | function | 277–279 | yes | 2 | `src/clients/config-export/paths.ts` (L2) |
| `ompAgentDir` | function | 282–293 | yes | 1 | `src/clients/config-export/paths.ts` (L2) |
| `ompModelsConfigPath` | function | 296–301 | yes | 4 | `src/clients/config-export/paths.ts` (L2) |
| `opencodeProxyBaseUrl` | function | 304–316 | yes | 4 | `src/clients/config-export/opencode.ts` (L2) |
| `hermesHomeDir` | function | 322–330 | yes | 1 | `src/clients/config-export/paths.ts` (L2) |
| `hermesConfigPath` | function | 332–334 | yes | 2 | `src/clients/config-export/paths.ts` (L2) |
| `ClientPathError` | class | 350–350 | yes | 12 | `src/clients/config-export/paths.ts` (L2) |
| `absoluteClientPath` | function | 352–363 | no | 0 | `src/clients/config-export/paths.ts` (L2) |
| `openclawEffectiveHome` | function | 372–375 | no | 0 | `src/clients/config-export/openclaw-paths.ts` (L2) |
| `openclawHomeDir` | function | 393–413 | yes | 2 | `src/clients/config-export/openclaw-paths.ts` (L2) |
| `openclawConfigPath` | function | 427–457 | yes | 2 | `src/clients/config-export/openclaw-paths.ts` (L2) |
| `kimiHomeDir` | function | 459–462 | yes | 1 | `src/clients/config-export/paths.ts` (L2) |
| `kimiConfigPath` | function | 464–466 | yes | 2 | `src/clients/config-export/paths.ts` (L2) |
| `gajaeHomeDir` | function | 468–470 | yes | 1 | `src/clients/config-export/paths.ts` (L2) |
| `gajaeConfigPath` | function | 472–474 | yes | 2 | `src/clients/config-export/paths.ts` (L2) |
| `dshHomeDir` | function | 477–492 | yes | 2 | `src/clients/config-export/paths.ts` (L2) |
| `dshConfigPath` | function | 494–496 | yes | 2 | `src/clients/config-export/paths.ts` (L2) |
| `mcodeHomeDir` | function | 503–509 | yes | 2 | `src/clients/config-export/paths.ts` (L2) |
| `mcodeConfigPath` | function | 511–513 | yes | 3 | `src/clients/config-export/paths.ts` (L2) |
| `zcodeHomeDir` | function | 521–525 | yes | 2 | `src/clients/config-export/paths.ts` (L2) |
| `zcodeConfigPath` | function | 527–529 | yes | 2 | `src/clients/config-export/paths.ts` (L2) |
| `primeAgentDir` | function | 540–544 | yes | 2 | `src/clients/config-export/paths.ts` (L2) |
| `primeConfigPath` | function | 547–549 | yes | 2 | `src/clients/config-export/paths.ts` (L2) |
| `asideHomeDir` | function | 558–560 | yes | 1 | `src/clients/config-export/aside-paths.ts` (L2) |
| `asideCurrentAccountId` | function | 584–612 | no | 0 | `src/clients/config-export/aside-paths.ts` (L2) |
| `asideAccountDir` | function | 619–622 | yes | 2 | `src/clients/config-export/aside-paths.ts` (L2) |
| `asideConfigPath` | function | 625–627 | yes | 2 | `src/clients/config-export/aside-paths.ts` (L2) |
| `ExportModel` | interface | 634–647 | yes | 18 | `src/clients/config-export/contracts.ts` (L1; already moved) |
| `ExportContext` | interface | 649–658 | yes | 8 | `src/clients/config-export/contracts.ts` (L1; already moved) |
| `ExportClientId` | type | 660–672 | yes | 3 | `src/clients/config-export/contracts.ts` (L1; already moved) |
| `ExportClientSpec` | interface | 674–713 | yes | 0 | `src/clients/config-export/contracts.ts` (L1; already moved) |
| `authoritativeContextWindow` | function | 719–725 | no | 0 | `src/clients/config-export/model-metadata.ts` (L1; already moved) |
| `outputBudgetFor` | function | 728–730 | no | 0 | `src/clients/config-export/model-metadata.ts` (L1; already moved) |
| `CLIENT_INPUT_MODALITIES` | const | 761–764 | no | 0 | `src/clients/config-export/model-metadata.ts` (L1; already moved) |
| `inputModalitiesForClient` | function | 767–779 | no | 0 | `src/clients/config-export/model-metadata.ts` (L1; already moved) |
| `dshInputModalities` | function | 782–791 | no | 0 | `src/clients/config-export/dsh.ts` (L1; already moved) |
| `exportModelLabel` | function | 798–805 | no | 0 | `src/clients/config-export/model-metadata.ts` (L1; already moved) |
| `opencodeProviderConnection` | function | 808–818 | no | 0 | `src/clients/config-export/opencode.ts` (L2) |
| `opencodeEffortVariants` | function | 833–840 | no | 0 | `src/clients/config-export/opencode.ts` (L2) |
| `opencodeProviderBlocks` | function | 855–894 | yes | 1 | `src/clients/config-export/opencode.ts` (L2) |
| `opencodeProviderBlock` | function | 897–903 | no | 0 | `src/clients/config-export/opencode.ts` (L2) |
| `opencodeV2ProviderBlock` | function | 906–912 | yes | 1 | `src/clients/config-export/opencode.ts` (L2) |
| `buildOpencodeProviderBlockFromCatalog` | function | 919–926 | yes | 1 | `src/clients/config-export/opencode.ts` (L2) |
| `normalizeExportModels` | function | 934–943 | yes | 2 | `src/clients/config-export/model-metadata.ts` (L1; already moved) |
| `buildOpencodeClientConfig` | function | 953–962 | no | 0 | `src/clients/config-export/opencode.ts` (L2) |
| `PiModelEntry` | interface | 964–979 | yes | 0 | `src/clients/config-export/contracts.ts` (L1; already moved) |
| `PiProviderBlock` | interface | 981–986 | yes | 0 | `src/clients/config-export/pi.ts` (L2) |
| `PiGeneratedConfig` | interface | 988–990 | yes | 6 | `src/clients/config-export/pi.ts` (L2) |
| `OmpModelEntry` | interface | 997–1006 | yes | 0 | `src/clients/config-export/omp.ts` (L1; already moved) |
| `OmpProviderBlock` | interface | 1008–1013 | yes | 0 | `src/clients/config-export/omp.ts` (L1; already moved) |
| `OmpGeneratedConfig` | interface | 1015–1017 | yes | 0 | `src/clients/config-export/omp.ts` (L1; already moved) |
| `OMP_EFFORT_VOCABULARY` | const | 1023–1023 | no | 0 | `src/clients/config-export/omp.ts` (L1; already moved) |
| `ompEfforts` | function | 1025–1034 | no | 0 | `src/clients/config-export/omp.ts` (L1; already moved) |
| `HermesProviderBlock` | interface | 1041–1049 | yes | 0 | `src/clients/config-export/hermes-openclaw.ts` (L2) |
| `HermesModelEntry` | interface | 1052–1054 | yes | 0 | `src/clients/config-export/hermes-openclaw.ts` (L2) |
| `HermesGeneratedConfig` | interface | 1056–1058 | yes | 4 | `src/clients/config-export/hermes-openclaw.ts` (L2) |
| `OpenclawModelEntry` | interface | 1060–1064 | yes | 0 | `src/clients/config-export/hermes-openclaw.ts` (L2) |
| `OpenclawProviderBlock` | interface | 1066–1072 | yes | 0 | `src/clients/config-export/hermes-openclaw.ts` (L2) |
| `OpenclawGeneratedConfig` | interface | 1075–1080 | yes | 2 | `src/clients/config-export/hermes-openclaw.ts` (L2) |
| `KimiProviderBlock` | interface | 1082–1086 | yes | 0 | `src/clients/config-export/kimi-gajae.ts` (L2) |
| `KimiModelBlock` | interface | 1095–1100 | yes | 0 | `src/clients/config-export/kimi-gajae.ts` (L2) |
| `KimiGeneratedConfig` | interface | 1102–1105 | yes | 2 | `src/clients/config-export/kimi-gajae.ts` (L2) |
| `GajaeModelEntry` | interface | 1107–1113 | yes | 0 | `src/clients/config-export/kimi-gajae.ts` (L2) |
| `GajaeProviderBlock` | interface | 1116–1121 | yes | 0 | `src/clients/config-export/kimi-gajae.ts` (L2) |
| `GajaeGeneratedConfig` | interface | 1123–1125 | yes | 3 | `src/clients/config-export/kimi-gajae.ts` (L2) |
| `DshReasoningEffort` | type | 1127–1127 | yes | 0 | `src/clients/config-export/dsh.ts` (L1; already moved) |
| `DshWireReasoningEffort` | type | 1128–1128 | yes | 0 | `src/clients/config-export/dsh.ts` (L1; already moved) |
| `DshModelEntry` | interface | 1130–1136 | yes | 0 | `src/clients/config-export/dsh.ts` (L1; already moved) |
| `DshProviderBlock` | interface | 1138–1144 | yes | 0 | `src/clients/config-export/dsh.ts` (L1; already moved) |
| `DshGeneratedConfig` | interface | 1146–1150 | yes | 2 | `src/clients/config-export/dsh.ts` (L1; already moved) |
| `McodeProviderBlock` | interface | 1152–1163 | yes | 0 | `src/clients/config-export/mcode.ts` (L1; already moved) |
| `McodeModelEntry` | interface | 1165–1170 | yes | 0 | `src/clients/config-export/mcode.ts` (L1; already moved) |
| `McodeGeneratedConfig` | interface | 1172–1174 | yes | 2 | `src/clients/config-export/mcode.ts` (L1; already moved) |
| `ZcodeModelEntry` | interface | 1183–1187 | yes | 0 | `src/clients/config-export/zcode.ts` (L1; already moved) |
| `ZcodeProviderBlock` | interface | 1189–1200 | yes | 0 | `src/clients/config-export/zcode.ts` (L1; already moved) |
| `ZcodeGeneratedConfig` | interface | 1202–1204 | yes | 1 | `src/clients/config-export/zcode.ts` (L1; already moved) |
| `buildPiClientConfig` | function | 1229–1276 | no | 0 | `src/clients/config-export/pi.ts` (L2) |
| `buildOmpClientConfig` | function | 1283–1321 | no | 0 | `src/clients/config-export/omp.ts` (L1; already moved) |
| `proxyAdmissionHeaders` | function | 1324–1326 | no | 0 | `src/clients/config-export/model-metadata.ts` (L1; already moved) |
| `buildHermesClientConfig` | function | 1328–1349 | no | 0 | `src/clients/config-export/hermes-openclaw.ts` (L2) |
| `buildOpenclawClientConfig` | function | 1351–1375 | no | 0 | `src/clients/config-export/hermes-openclaw.ts` (L2) |
| `kimiModelAlias` | function | 1378–1380 | yes | 1 | `src/clients/config-export/kimi-gajae.ts` (L2) |
| `buildKimiClientConfig` | function | 1382–1407 | no | 0 | `src/clients/config-export/kimi-gajae.ts` (L2) |
| `buildGajaeClientConfig` | function | 1409–1438 | no | 0 | `src/clients/config-export/kimi-gajae.ts` (L2) |
| `DSH_EFFORT_ORDER` | const | 1440–1440 | no | 0 | `src/clients/config-export/dsh.ts` (L1; already moved) |
| `dshReasoningEfforts` | function | 1442–1462 | no | 0 | `src/clients/config-export/dsh.ts` (L1; already moved) |
| `isKnownSafeDshCombo` | function | 1464–1483 | no | 0 | `src/clients/config-export/dsh.ts` (L1; already moved) |
| `buildDshClientConfig` | function | 1485–1516 | no | 0 | `src/clients/config-export/dsh.ts` (L1; already moved) |
| `buildMcodeClientConfig` | function | 1527–1559 | no | 0 | `src/clients/config-export/mcode.ts` (L1; already moved) |
| `buildZcodeClientConfig` | function | 1570–1606 | no | 0 | `src/clients/config-export/zcode.ts` (L1; already moved) |
| `summarizeOpencode` | function | 1614–1617 | no | 0 | `src/clients/config-export/opencode.ts` (L2) |
| `summarizePi` | function | 1619–1622 | no | 0 | `src/clients/config-export/pi.ts` (L2) |
| `summarizeOmp` | function | 1624–1627 | no | 0 | `src/clients/config-export/omp.ts` (L1; already moved) |
| `summarizeHermes` | function | 1629–1633 | no | 0 | `src/clients/config-export/hermes-openclaw.ts` (L2) |
| `summarizeOpenclaw` | function | 1635–1638 | no | 0 | `src/clients/config-export/hermes-openclaw.ts` (L2) |
| `summarizeKimi` | function | 1640–1645 | no | 0 | `src/clients/config-export/kimi-gajae.ts` (L2) |
| `summarizeGajae` | function | 1647–1650 | no | 0 | `src/clients/config-export/kimi-gajae.ts` (L2) |
| `summarizeDsh` | function | 1652–1655 | no | 0 | `src/clients/config-export/dsh.ts` (L1; already moved) |
| `summarizeMcode` | function | 1657–1660 | no | 0 | `src/clients/config-export/mcode.ts` (L1; already moved) |
| `summarizeZcode` | function | 1662–1665 | no | 0 | `src/clients/config-export/zcode.ts` (L1; already moved) |
| `singleFragment` | function | 1668–1670 | no | 0 | `src/clients/config-export/model-metadata.ts` (L1; already moved) |
| `buildOpencodeContribution` | function | 1672–1684 | no | 0 | `src/clients/config-export/opencode.ts` (L2) |
| `buildPiContribution` | function | 1686–1689 | no | 0 | `src/clients/config-export/pi.ts` (L2) |
| `buildOmpContribution` | function | 1691–1694 | no | 0 | `src/clients/config-export/omp.ts` (L1; already moved) |
| `buildHermesContribution` | function | 1696–1699 | no | 0 | `src/clients/config-export/hermes-openclaw.ts` (L2) |
| `buildOpenclawContribution` | function | 1701–1704 | no | 0 | `src/clients/config-export/hermes-openclaw.ts` (L2) |
| `buildKimiContribution` | function | 1711–1720 | no | 0 | `src/clients/config-export/kimi-gajae.ts` (L2) |
| `buildGajaeContribution` | function | 1722–1725 | no | 0 | `src/clients/config-export/kimi-gajae.ts` (L2) |
| `buildDshContribution` | function | 1727–1730 | no | 0 | `src/clients/config-export/dsh.ts` (L1; already moved) |
| `buildMcodeContribution` | function | 1732–1735 | no | 0 | `src/clients/config-export/mcode.ts` (L1; already moved) |
| `buildZcodeContribution` | function | 1737–1740 | no | 0 | `src/clients/config-export/zcode.ts` (L1; already moved) |
| `buildPrimeContribution` | function | 1755–1758 | no | 0 | `src/clients/config-export/pi.ts` (L2) |
| `buildAsideContribution` | function | 1778–1781 | no | 0 | `src/clients/config-export/pi.ts` (L2) |
| `EXPORT_CLIENTS` | const | 1783–1954 | yes | 15 | `src/clients/config-export.ts` (residual) |
| `EXPORT_CLIENT_IDS` | const | 1956–1956 | yes | 7 | `src/clients/config-export.ts` (residual) |
| `isExportClientId` | function | 1958–1960 | yes | 3 | `src/clients/config-export.ts` (residual) |
| `buildClientConfig` | function | 1963–1965 | yes | 9 | `src/clients/config-export.ts` (residual) |
| `buildClientConfigText` | function | 1973–1985 | yes | 8 | `src/clients/config-export.ts` (residual) |
| `buildClientContribution` | function | 1988–1990 | yes | 5 | `src/clients/config-export.ts` (residual) |

Export-only declaration: `ConfigFormat` at `src/clients/config-export.ts:32` remains forwarded from `../integrations/serialize`, not redefined.

## Leaf partition

Part a moves the lowest-fanout format leaves first: `omp` (sum of external symbol consumers 0), `zcode` (1), `dsh` (2), `mcode` (2). Part b takes the higher-fanout families and paths. The three shared foundations move with part a because even its lowest-fanout clients need them: leaving types/constants/model rules in the original would create facade back-imports. No external caller changes paths. PiModelEntry (0 consumers) moves with shared contracts because OmpModelEntry extends it. The larger Pi document type/builders remain for part b.

Line-budget convention: each declaration carries immediately preceding comments/whitespace, from previous declaration end+1 (first declaration starts after the import/export header). Counts include those blocks, the exact one-line imports shown, one header line and one separator. These are conservative projected implementation counts, not measurements of files already written. Do not discard comments to meet limits. Adding an export keyword does not add a line. All new files are ≤400.

### `src/clients/config-export/paths.ts` — expected 221 lines

Symbols: `opencodeGlobalConfigPath`, `OMP_PROFILE_NAME_RE`, `OMP_WINDOWS_RESERVED_PROFILE_RE`, `ompProfileName`, `piAgentDir`, `piConfigPath`, `ompAgentDir`, `ompModelsConfigPath`, `hermesHomeDir`, `hermesConfigPath`, `ClientPathError`, `absoluteClientPath`, `kimiHomeDir`, `kimiConfigPath`, `gajaeHomeDir`, `gajaeConfigPath`, `dshHomeDir`, `dshConfigPath`, `mcodeHomeDir`, `mcodeConfigPath`, `zcodeHomeDir`, `zcodeConfigPath`, `primeAgentDir`, `primeConfigPath`.

Own imports:

```ts
import type { OpencodeLaunchEnv } from "./contracts";
import { homedir } from "node:os";
import { join, isAbsolute, resolve } from "node:path";
import { existsSync } from "node:fs";
```

Leaf exports: `opencodeGlobalConfigPath`, `piAgentDir`, `piConfigPath`, `ompAgentDir`, `ompModelsConfigPath`, `hermesHomeDir`, `hermesConfigPath`, `ClientPathError`, `absoluteClientPath`, `kimiHomeDir`, `kimiConfigPath`, `gajaeHomeDir`, `gajaeConfigPath`, `dshHomeDir`, `dshConfigPath`, `mcodeHomeDir`, `mcodeConfigPath`, `zcodeHomeDir`, `zcodeConfigPath`, `primeAgentDir`, `primeConfigPath`. Other listed declarations remain private. Only previously public symbols are forwarded from the original path; newly exposed internal symbols serve production registry/sibling calls, not tests.

### `src/clients/config-export/openclaw-paths.ts` — expected 101 lines

Symbols: `openclawEffectiveHome`, `openclawHomeDir`, `openclawConfigPath`.

Own imports:

```ts
import type { OpencodeLaunchEnv } from "./contracts";
import { absoluteClientPath } from "./paths";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
```

Leaf exports: `openclawHomeDir`, `openclawConfigPath`. Other listed declarations remain private. Only previously public symbols are forwarded from the original path; newly exposed internal symbols serve production registry/sibling calls, not tests.

### `src/clients/config-export/aside-paths.ts` — expected 85 lines

Symbols: `asideHomeDir`, `asideCurrentAccountId`, `asideAccountDir`, `asideConfigPath`.

Own imports:

```ts
import type { OpencodeLaunchEnv } from "./contracts";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { ClientPathError } from "./paths";
```

Leaf exports: `asideHomeDir`, `asideAccountDir`, `asideConfigPath`. Other listed declarations remain private. Only previously public symbols are forwarded from the original path; newly exposed internal symbols serve production registry/sibling calls, not tests.

### `src/clients/config-export/opencode.ts` — expected 272 lines

Symbols: `OpencodeModelEntry`, `OpencodeModelVariant`, `OpencodeV2ModelEntry`, `OpencodeProviderConnection`, `OpencodeProviderBlock`, `OpencodeV2ProviderBlock`, `OpencodeProviderBlocks`, `OpencodeGeneratedConfig`, `OPENCODE_PROVIDER_NPM`, `OPENCODE_V2_PROVIDER_PACKAGE`, `OPENCODE_PROVIDER_NAME`, `opencodeProxyBaseUrl`, `opencodeProviderConnection`, `opencodeEffortVariants`, `opencodeProviderBlocks`, `opencodeProviderBlock`, `opencodeV2ProviderBlock`, `buildOpencodeProviderBlockFromCatalog`, `buildOpencodeClientConfig`, `summarizeOpencode`, `buildOpencodeContribution`.

Own imports:

```ts
import type { OcxConfig } from "../../types";
import { standaloneCodexRoutingTarget, shouldInjectApiAuthHeader } from "../../codex/inject";
import { probeHostname } from "../../server/proxy-liveness";
import { OPENCODE_API_KEY_ENV_REF, OPENCODE_PROVIDER_BLOCK_DEFAULT_CONFIG, OPENCODE_CONFIG_SCHEMA, OPENCODE_PROVIDER_ID } from "./constants";
import type { OpencodeCatalogModel, ExportContext, ManagedContribution } from "./contracts";
import { canonicalizeReasoningEfforts } from "../../reasoning-effort";
import { exportModelLabel, authoritativeContextWindow, outputBudgetFor, normalizeExportModels } from "./model-metadata";
```

Leaf exports: `OpencodeModelEntry`, `OpencodeModelVariant`, `OpencodeV2ModelEntry`, `OpencodeProviderConnection`, `OpencodeProviderBlock`, `OpencodeV2ProviderBlock`, `OpencodeProviderBlocks`, `OpencodeGeneratedConfig`, `opencodeProxyBaseUrl`, `opencodeProviderBlocks`, `opencodeV2ProviderBlock`, `buildOpencodeProviderBlockFromCatalog`, `buildOpencodeClientConfig`, `summarizeOpencode`, `buildOpencodeContribution`. Other listed declarations remain private. Only previously public symbols are forwarded from the original path; newly exposed internal symbols serve production registry/sibling calls, not tests.

### `src/clients/config-export/pi.ts` — expected 139 lines

Symbols: `PiProviderBlock`, `PiGeneratedConfig`, `buildPiClientConfig`, `summarizePi`, `buildPiContribution`, `buildPrimeContribution`, `buildAsideContribution`.

Own imports:

```ts
import type { PiModelEntry, ExportContext, ManagedContribution } from "./contracts";
import { normalizeExportModels, inputModalitiesForClient, exportModelLabel, authoritativeContextWindow, outputBudgetFor, singleFragment } from "./model-metadata";
import { OPENCODE_PROVIDER_ID, PI_API_DIALECT, LOOPBACK_API_KEY_PLACEHOLDER } from "./constants";
```

Leaf exports: `PiProviderBlock`, `PiGeneratedConfig`, `buildPiClientConfig`, `summarizePi`, `buildPiContribution`, `buildPrimeContribution`, `buildAsideContribution`. Other listed declarations remain private. Only previously public symbols are forwarded from the original path; newly exposed internal symbols serve production registry/sibling calls, not tests.

### `src/clients/config-export/hermes-openclaw.ts` — expected 121 lines

Symbols: `HermesProviderBlock`, `HermesModelEntry`, `HermesGeneratedConfig`, `OpenclawModelEntry`, `OpenclawProviderBlock`, `OpenclawGeneratedConfig`, `buildHermesClientConfig`, `buildOpenclawClientConfig`, `summarizeHermes`, `summarizeOpenclaw`, `buildHermesContribution`, `buildOpenclawContribution`.

Own imports:

```ts
import type { ExportContext, ManagedContribution } from "./contracts";
import { normalizeExportModels, proxyAdmissionHeaders, authoritativeContextWindow, exportModelLabel, singleFragment } from "./model-metadata";
import { HERMES_API_KEY_ENV_REF, OPENCODE_PROVIDER_ID, OPENCLAW_API_KEY_ENV_REF } from "./constants";
```

Leaf exports: `HermesProviderBlock`, `HermesModelEntry`, `HermesGeneratedConfig`, `OpenclawModelEntry`, `OpenclawProviderBlock`, `OpenclawGeneratedConfig`, `buildHermesClientConfig`, `buildOpenclawClientConfig`, `summarizeHermes`, `summarizeOpenclaw`, `buildHermesContribution`, `buildOpenclawContribution`. Other listed declarations remain private. Only previously public symbols are forwarded from the original path; newly exposed internal symbols serve production registry/sibling calls, not tests.

### `src/clients/config-export/kimi-gajae.ts` — expected 146 lines

Symbols: `KimiProviderBlock`, `KimiModelBlock`, `KimiGeneratedConfig`, `GajaeModelEntry`, `GajaeProviderBlock`, `GajaeGeneratedConfig`, `kimiModelAlias`, `buildKimiClientConfig`, `buildGajaeClientConfig`, `summarizeKimi`, `summarizeGajae`, `buildKimiContribution`, `buildGajaeContribution`.

Own imports:

```ts
import { OPENCODE_PROVIDER_ID, LOOPBACK_API_KEY_PLACEHOLDER, GAJAE_API_KEY_ENV } from "./constants";
import type { ExportContext, ManagedContribution, ManagedFragment } from "./contracts";
import { normalizeExportModels, authoritativeContextWindow, inputModalitiesForClient, exportModelLabel, outputBudgetFor, singleFragment } from "./model-metadata";
```

Leaf exports: `KimiProviderBlock`, `KimiModelBlock`, `KimiGeneratedConfig`, `GajaeModelEntry`, `GajaeProviderBlock`, `GajaeGeneratedConfig`, `kimiModelAlias`, `buildKimiClientConfig`, `buildGajaeClientConfig`, `summarizeKimi`, `summarizeGajae`, `buildKimiContribution`, `buildGajaeContribution`. Other listed declarations remain private. Only previously public symbols are forwarded from the original path; newly exposed internal symbols serve production registry/sibling calls, not tests.

Residual `src/clients/config-export.ts`: expected **273 lines**. Part a leaves 1,299; part b removes 1,041 additional original lines and replaces staged glue with final glue. No #c remains.

Retained declarations after this layer: `EXPORT_CLIENTS`, `EXPORT_CLIENT_IDS`, `isExportClientId`, `buildClientConfig`, `buildClientConfigText`, `buildClientContribution`.

Arithmetic: 1990 original − 1748 cumulative moved original lines + 31 facade glue = 273. Across a/b: 707 + 1,041 = 1,748 moved body/trivia lines; 242 retained original lines; 1,748 + 242 = 1,990. Final glue is 31 lines, giving 273; L1's 16 glue lines are replaced by L2's 31, not both counted.

## Re-export block

Exact forwards in the original path follow. Other public declarations remain exported in place. No wildcard, alias, wrapper, signature change or duplicate definition.

```ts
export type { ConfigFormat } from "../integrations/serialize";
export type { ManagedFragment, ManagedContribution, BuildContribution, OpencodeLaunchEnv, OpencodeCatalogModel, ExportModel, ExportContext, ExportClientId, ExportClientSpec, PiModelEntry } from "./config-export/contracts";
export { OPENCODE_PROVIDER_ID, OPENCODE_CONFIG_SCHEMA, OPENCODE_API_KEY_ENV, OPENCODE_API_KEY_ENV_REF, HERMES_API_KEY_ENV, HERMES_API_KEY_ENV_REF, OPENCLAW_API_KEY_ENV, OPENCLAW_API_KEY_ENV_REF, LOOPBACK_API_KEY_PLACEHOLDER, GAJAE_API_KEY_ENV, SCHEMA_REQUIRED_OUTPUT_BUDGET, OPENCODE_PROVIDER_BLOCK_DEFAULT_CONFIG } from "./config-export/constants";
export { normalizeExportModels } from "./config-export/model-metadata";
export type { OmpModelEntry, OmpProviderBlock, OmpGeneratedConfig } from "./config-export/omp";
export type { ZcodeModelEntry, ZcodeProviderBlock, ZcodeGeneratedConfig } from "./config-export/zcode";
export type { DshReasoningEffort, DshWireReasoningEffort, DshModelEntry, DshProviderBlock, DshGeneratedConfig } from "./config-export/dsh";
export type { McodeProviderBlock, McodeModelEntry, McodeGeneratedConfig } from "./config-export/mcode";
export { opencodeGlobalConfigPath, piAgentDir, piConfigPath, ompAgentDir, ompModelsConfigPath, hermesHomeDir, hermesConfigPath, ClientPathError, kimiHomeDir, kimiConfigPath, gajaeHomeDir, gajaeConfigPath, dshHomeDir, dshConfigPath, mcodeHomeDir, mcodeConfigPath, zcodeHomeDir, zcodeConfigPath, primeAgentDir, primeConfigPath } from "./config-export/paths";
export { openclawHomeDir, openclawConfigPath } from "./config-export/openclaw-paths";
export { asideHomeDir, asideAccountDir, asideConfigPath } from "./config-export/aside-paths";
export { opencodeProxyBaseUrl, opencodeProviderBlocks, opencodeV2ProviderBlock, buildOpencodeProviderBlockFromCatalog } from "./config-export/opencode";
export type { OpencodeModelEntry, OpencodeModelVariant, OpencodeV2ModelEntry, OpencodeProviderConnection, OpencodeProviderBlock, OpencodeV2ProviderBlock, OpencodeProviderBlocks, OpencodeGeneratedConfig } from "./config-export/opencode";
export type { PiProviderBlock, PiGeneratedConfig } from "./config-export/pi";
export type { HermesProviderBlock, HermesModelEntry, HermesGeneratedConfig, OpenclawModelEntry, OpenclawProviderBlock, OpenclawGeneratedConfig } from "./config-export/hermes-openclaw";
export { kimiModelAlias } from "./config-export/kimi-gajae";
export type { KimiProviderBlock, KimiModelBlock, KimiGeneratedConfig, GajaeModelEntry, GajaeProviderBlock, GajaeGeneratedConfig } from "./config-export/kimi-gajae";
```

Explicit residual local imports (re-export binds nothing locally):

```ts
import type { ExportClientId, ExportClientSpec, ExportContext, ManagedContribution } from "./config-export/contracts";
import { opencodeGlobalConfigPath, piConfigPath, ompModelsConfigPath, hermesConfigPath, kimiConfigPath, gajaeConfigPath, dshConfigPath, mcodeConfigPath, zcodeConfigPath, primeConfigPath } from "./config-export/paths";
import { OPENCODE_API_KEY_ENV, HERMES_API_KEY_ENV, OPENCLAW_API_KEY_ENV, GAJAE_API_KEY_ENV } from "./config-export/constants";
import { buildOpencodeClientConfig, summarizeOpencode, buildOpencodeContribution } from "./config-export/opencode";
import { buildPiClientConfig, summarizePi, buildPiContribution, buildPrimeContribution, buildAsideContribution } from "./config-export/pi";
import { buildOmpClientConfig, summarizeOmp, buildOmpContribution } from "./config-export/omp";
import { buildHermesClientConfig, summarizeHermes, buildHermesContribution, buildOpenclawClientConfig, summarizeOpenclaw, buildOpenclawContribution } from "./config-export/hermes-openclaw";
import { openclawConfigPath } from "./config-export/openclaw-paths";
import { buildKimiClientConfig, summarizeKimi, buildKimiContribution, buildGajaeClientConfig, summarizeGajae, buildGajaeContribution } from "./config-export/kimi-gajae";
import { buildDshClientConfig, summarizeDsh, buildDshContribution } from "./config-export/dsh";
import { buildMcodeClientConfig, summarizeMcode, buildMcodeContribution } from "./config-export/mcode";
import { buildZcodeClientConfig, summarizeZcode, buildZcodeContribution } from "./config-export/zcode";
import { asideConfigPath } from "./config-export/aside-paths";
```

Retain original external imports still used by the residual; prune only proven-unused bindings. New leaves import one another directly. This is the cumulative block, including L1 forwards; replace the staged block instead of appending duplicate forwards.

## Module-level state and cycles

L1 already owns `CLIENT_INPUT_MODALITIES` (`src/clients/config-export.ts:761–764`) in `config-export/model-metadata.ts` and `OMP_EFFORT_VOCABULARY` (`:1023`) in `config-export/omp.ts`; do not recreate them. No top-level let/Map/WeakMap/timer/lock exists. `EXPORT_CLIENTS` (`:1783–1954`) and `EXPORT_CLIENT_IDS` (`:1956`) remain in the original registry, preserving identity/key order/one-time evaluation. `ClientPathError` (`:350`) moves once to `config-export/paths.ts` so every existing instanceof check sees the same constructor. Non-global `OMP_PROFILE_NAME_RE`/`OMP_WINDOWS_RESERVED_PROFILE_RE` (`:239–240`) stay with ompProfileName.

Lane 016's AST import BFS found no return path through the original. The partition avoids new return imports, including type-only ones. Risk: original → client leaf → original. Shared contracts/constants/model rules therefore move down in L1. `contracts.ts → ../../integrations/serialize` preserves ConfigFormat's actual owner; do not substitute config-io (which imports the original facade). OpenClaw/Aside paths import paths.ts for the single constructor/absolute-path rule; paths.ts imports no path sibling. Only the residual registry composes all client builders. Private builders/summarizers become explicit leaf exports for that production registry; no duplicated closures.

Coupling classification: existing config-schema coupling stays with format owners; sequential/functional coupling is explicit through parameters. No new common mutable state or temporal startup constraint. Existing auth/ownership checks are moved verbatim. Before execution rerun lane 016 method G against the actual layer base (relative static imports, re-exports, type-only edges and literal dynamic imports); any new return path is escalation, not permission for a lazy-import workaround.

## Tests

Discovery: `rg -l 'src/clients/config-export' tests --glob '*.ts'`, followed by import/source-read inspection. Every direct test/fixture importer is listed below, with disposition **unchanged** (old public path):

- `tests/ci-workflows/dsh-path-contract.test.ts` — unchanged.
- `tests/ci-workflows/dsh-writer-lock.test.ts` — unchanged.
- `tests/cli/cli-help.test.ts` — unchanged.
- `tests/clients/client-export-modality-enum.test.ts` — unchanged.
- `tests/clients/integrations-state.test.ts` — unchanged.
- `tests/clients/integrations-writer.test.ts` — unchanged.
- `tests/clients/omp-path-contract.test.ts` — unchanged.
- `tests/clients/pi-path-contract.test.ts` — unchanged.
- `tests/clients/prime-client.test.ts` — unchanged.
- `tests/clients/sync-client-integrations.test.ts` — unchanged.
- `tests/config/client-config-export-new-clients.test.ts` — unchanged.
- `tests/config/client-config-export.test.ts` — unchanged.
- `tests/config/client-config-new-clients.test.ts` — unchanged.
- `tests/gui/integrations-invariants.test.ts` — unchanged.
- `tests/providers/aside-client.test.ts` — unchanged.
- `tests/providers/minimax-clients.test.ts` — unchanged.
- `tests/providers/zcode-client.test.ts` — unchanged.
- `tests/server/management-client-config-route.test.ts` — unchanged.
- `tests/server/management-integration-journal-delete.test.ts` — unchanged.
- `tests/server/management-integration-routes.test.ts` — unchanged.

No source-text reader of src/clients/config-export.ts was found. `tests/config/client-config-export.test.ts:58` and `tests/server/management-client-config-route.test.ts:416` mention it in comments, not source reads. No retarget-to-leaf or add-leaf-to-scan-list action. Preserve baked serialized fixtures unchanged.

C-phase red proof: temporarily treat incompatible audio-only input as text in the moved metadata function and observe `tests/clients/client-export-modality-enum.test.ts:96` fail; restore. Run all existing Pi/OMP/DSH path-contract tests unchanged against the final facade; no replacement expected paths.

These are future implementation checks, not tests run by this docs author. No new test file is required. Facade/leaf identity assertions may be added in an existing focused test; if a new test file is required, parent must explicitly expand scope to include both test-layout registry files (`scripts/test-layout/layout.json`, `tests/fixtures/test-layout-expected.json`). Never commit red-proof mutations.

## Verification

Future implementation gate only, in the dedicated layer worktree at its actual tip. Domains: ci-workflows, cli, clients, config, gui, providers, server. Explicit source-reader and subprocess coverage is not replaced by test:changed.

```sh
bun run typecheck
bun test tests/ci-workflows/dsh-path-contract.test.ts tests/ci-workflows/dsh-writer-lock.test.ts tests/cli/cli-help.test.ts tests/clients/client-export-modality-enum.test.ts tests/clients/integrations-state.test.ts tests/clients/integrations-writer.test.ts tests/clients/omp-path-contract.test.ts tests/clients/pi-path-contract.test.ts tests/clients/prime-client.test.ts tests/clients/sync-client-integrations.test.ts tests/config/client-config-export-new-clients.test.ts tests/config/client-config-export.test.ts tests/config/client-config-new-clients.test.ts tests/gui/integrations-invariants.test.ts tests/providers/aside-client.test.ts tests/providers/minimax-clients.test.ts tests/providers/zcode-client.test.ts tests/server/management-client-config-route.test.ts tests/server/management-integration-journal-delete.test.ts tests/server/management-integration-routes.test.ts tests/cli/cli-export-command.test.ts
bun run privacy:scan
wc -l src/clients/config-export/paths.ts src/clients/config-export/openclaw-paths.ts src/clients/config-export/aside-paths.ts src/clients/config-export/opencode.ts src/clients/config-export/pi.ts src/clients/config-export/hermes-openclaw.ts src/clients/config-export/kimi-gajae.ts src/clients/config-export.ts
# Compare resolved old-path consumer identities/counts with the list in this plan
rg -n 'clients/config-export' src gui/src scripts tests
# Full suite on lidge only; parent serializes access to this shared remote checkout
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-clients-config-export-b && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test'
```

The remote command intentionally keeps bun run test last, preserving its exit code instead of masking failure behind tail. Parent records remote HEAD and full output. Every command exits 0; focused/full tests report 0 failures. Delivery requires a green exact-head GitHub CI rollup, not an empty required-check list.

Per 002, `bun test tests/lab/core-lab-boundary.test.ts` is conditional on source edits under `src/server|src/router|src/lib`: **not applicable** to this approved layer touch set. Do not edit its PROTECTED roots. If implementation expands into those directories, parent must approve scope and run that guard explicitly. Preserve the 33 original direct consumer files; new facade-to-leaf imports are not caller churn. The grep is a discovery list, not by itself a proof of consumer identity: resolve relative and dynamic paths as in the inventory method. Repeat lane 016 method G on the final imports to prove zero new cycles; typecheck alone is not a cycle detector.

Drafting verification is document-only: required heading order, complete symbol ranges/ownership, projected line arithmetic, export coverage, referenced test paths, unique leaf paths and assigned-file scope. No test, typecheck, privacy scan or remote command above was executed in this drafting task.

## Accept criteria

1. Parent resolves the 500-line budget definition/exception or revises topology before implementation; no claim that literal added+deleted churn passes.
2. Every inventory declaration has exactly one implementation owner. Preserve all original export names/signatures and value/type importability; do not extract L1 declarations a second time.
3. Every new leaf is ≤400 lines. Residual target is 273, ≤400. Measure actual files and explain drift before proceeding.
4. Preserve function bodies, branch order, literals, serialized bytes/key order, class/object identity and state initialization. Only moves, explicit imports and named forwards change source structure.
5. Old-path consumers and assertions remain intact. Record the exact red/restored-green evidence named under Tests; no guard deletion, skipping, weakened assertions or empty-facade source scans.
6. Singleton state/allowlists each have one owner; no leaf imports the original even for types; resolved static/re-export/type/dynamic-literal graph has no new cycles.
7. Typecheck, focused checks, privacy, remote full suite and exact-head CI pass at this layer tip independently of later layers. No full local suite and no merge.
8. Diff stays within the original/new leaves and genuinely required existing focused tests. New tests, SoT edits, new topology or unrelated code require parent scope approval.

## PR

Title: `refactor(clients): finish client path and format partitions (split S13 L2/5)`

Branch: `codex/split-clients-config-export-b`. Base: `codex/split-clients-config-export-a`. Closes: none.

Use all sections of `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist), including the size-gate disposition and DEV-STACK-03 map below. This draft creates no PR; placeholder PR numbers are intentional.

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 1 | #TBD-S13-L1 | 400 | `codex/split-clients-config-export-a` | `dev` | extract low-fanout client formats and dependency foundations |
| 2 | #TBD-S13-L2 | 410 — this layer | `codex/split-clients-config-export-b` | `codex/split-clients-config-export-a` | finish client path and format partitions |
| 3 | #TBD-S13-L3 | 420 | `codex/split-cli-opencode` | `codex/split-clients-config-export-b` | separate OpenCode config and catalog from launch |
| 4 | #TBD-S13-L4 | 430 | `codex/split-cli-minimax` | `codex/split-cli-opencode` | isolate MMX protocol and termination owners |
| 5 | #TBD-S13-L5 | 440 | `codex/split-integrations-state` | `codex/split-clients-config-export-b` | separate classification from state reads |

Depends on #TBD-S13-L1. Review this layer's diff only. Cascade this layer only from its real parent `codex/split-clients-config-export-a`, then re-verify its tip/base ref while preserving checkout ownership. Bottom-up merging remains a separate user-authorized action and is out of scope.
