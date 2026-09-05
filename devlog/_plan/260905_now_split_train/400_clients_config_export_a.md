# 400 — S13 L1/5: extract low-fanout client formats and dependency foundations

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Existing split implementation history; aggregate delivery pending. Original PR is not individually merged. Current/latest below means at that historical checkpoint; older blocked/pending snapshots do not override bbf8d3cd or authorize resumption.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`, C3 implementation with explicit security regression review for the relocated admission/credential helpers. Main owns orchestration and goal state.
- Goal: extract low-fanout client formats and dependency foundations, preserving the original public import path and behavior.
- Non-goals: behavior fixes, exported renames, signature changes, new validation, changed credentials/admission policy, changed config paths, new framework, caller migration, merges or releases. Preserve function bodies verbatim, including >50-line functions; function redesign is not this pure-move train.
- Verifier: this document's authoritative Verification section; every layer must pass independently at its actual tip. All tests run on `ssh lidge`, never locally.
- Stop: exact-tip acceptance evidence and CI recorded, then close the work phase; do not merge. The earlier docs-only drafting pass is historical.
- Size gate: the binding `003_parent_decisions.md` PURE-MOVE-SIZE-01 resolves the original 500-line churn conflict. Non-move changes must stay **≤150 lines**, with move-aware diff review and unique-owner evidence for every inventory symbol. Raw added+deleted churn is not claimed to meet 500. Stale source, a leaf >400, any new cycle, any behavioral difference, or non-move changes above the bound stop implementation.

Inventory basis (historical): task docs HEAD `4cc219549`; code `origin/dev=1362b1a3841b4de20177e5d65865a513dd7936c4`. The drafting pass read 000, 001, S13 rows/Per-layer gate of 002, and the relevant records in `devlog/_plan/260905_modular_debt_ledger/016_lane_cli_storage_usage_update_lab_scripts.md`. Source was read with `git show origin/dev:<path>`; `git diff origin/dev -- src/clients/config-export.ts src/cli/opencode.ts src/cli/minimax.ts src/integrations/state.ts` was empty. Current execution uses the dev base in the PR section; the inventoried source bytes were checked unchanged.

Structural decision (cxc-dev §1/§5, architecture ARCH-MAP-01/ARCH-DECISION-01): 1990 lines mix distinct concerns. Reject deleting/configuring the feature (does not preserve behavior), and generic helpers/index barrels (do not establish ownership). Reuse every existing algorithm and lower-level dependency; only relocate declarations. Inspected conventions: `src/config/paths.ts`, `src/config/process-state.ts`, `src/cli/launcher-context.ts`, `src/cli/account-extended.ts`, `src/integrations/ownership-policy.ts`. Use the domain subfolder `src/clients/config-export/` without an index barrel. The original remains an existing compatibility boundary, not an internal import shortcut.

Structural map: 33 direct source/test/fixture consumer files. Production dependents: `src/integrations/state.ts`, `src/integrations/ownership.ts`, `src/integrations/merge.ts`, `src/integrations/registry.ts`, `src/integrations/owned-refresh.ts`, `src/integrations/config-io.ts`, `src/integrations/ownership-policy.ts`, `src/integrations/writer.ts`, `src/server/management/model-routes.ts`, `src/server/management/model-rows.ts`, `src/cli/export-command.ts`, `src/cli/minimax.ts`, `src/cli/opencode.ts`. Current direction is dependents → original → existing imported owners; intended direction is dependents → original → concern leaves → existing owners. Leaf imports are fully enumerated below; no leaf → original edge. Blast radius: client/CLI integration feature, with public consumers unchanged. `structure/09_client-integrations.md:11` identifies builders and classification as single authorities; no parallel implementation is introduced.

## Symbol inventory

Exact syntax spans at `origin/dev:src/clients/config-export.ts` (leading comments excluded). Reproduce: `sg run --lang ts --kind 'function_declaration,interface_declaration,type_alias_declaration,lexical_declaration,variable_declaration,class_declaration' --json=compact src/clients/config-export.ts`, filtering declarations enclosed by another declaration. Consumers = distinct direct importer/re-exporter files per symbol, resolved by literal module path then counted with `rg -l -w '<symbol>' <resolved importer files>`. Dynamic dispatch destructuring counts too. Private declarations have 0 external consumers, not 0 local calls. Imported bindings are covered by the leaf imports; export-only declarations are noted below. L2 repeats the complete basis inventory and marks L1-owned rows already moved.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `ManagedFragment` | interface | 43–46 | yes | 2 | `src/clients/config-export/contracts.ts` (L1) |
| `ManagedContribution` | interface | 49–52 | yes | 5 | `src/clients/config-export/contracts.ts` (L1) |
| `BuildContribution` | type | 54–54 | yes | 0 | `src/clients/config-export/contracts.ts` (L1) |
| `OpencodeLaunchEnv` | interface | 56–58 | yes | 1 | `src/clients/config-export/contracts.ts` (L1) |
| `OpencodeCatalogModel` | interface | 61–76 | yes | 1 | `src/clients/config-export/contracts.ts` (L1) |
| `OpencodeModelEntry` | interface | 78–81 | yes | 1 | `src/clients/config-export/opencode.ts` (L2; deferred) |
| `OpencodeModelVariant` | interface | 90–93 | yes | 0 | `src/clients/config-export/opencode.ts` (L2; deferred) |
| `OpencodeV2ModelEntry` | interface | 95–97 | yes | 0 | `src/clients/config-export/opencode.ts` (L2; deferred) |
| `OpencodeProviderConnection` | interface | 100–104 | yes | 0 | `src/clients/config-export/opencode.ts` (L2; deferred) |
| `OpencodeProviderBlock` | interface | 107–112 | yes | 1 | `src/clients/config-export/opencode.ts` (L2; deferred) |
| `OpencodeV2ProviderBlock` | interface | 115–120 | yes | 1 | `src/clients/config-export/opencode.ts` (L2; deferred) |
| `OpencodeProviderBlocks` | interface | 127–130 | yes | 1 | `src/clients/config-export/opencode.ts` (L2; deferred) |
| `OpencodeGeneratedConfig` | interface | 132–138 | yes | 4 | `src/clients/config-export/opencode.ts` (L2; deferred) |
| `OPENCODE_PROVIDER_ID` | const | 141–141 | yes | 11 | `src/clients/config-export/constants.ts` (L1) |
| `OPENCODE_CONFIG_SCHEMA` | const | 143–143 | yes | 2 | `src/clients/config-export/constants.ts` (L1) |
| `OPENCODE_PROVIDER_NPM` | const | 149–149 | no | 0 | `src/clients/config-export/opencode.ts` (L2; deferred) |
| `OPENCODE_V2_PROVIDER_PACKAGE` | const | 161–161 | no | 0 | `src/clients/config-export/opencode.ts` (L2; deferred) |
| `OPENCODE_PROVIDER_NAME` | const | 164–164 | no | 0 | `src/clients/config-export/opencode.ts` (L2; deferred) |
| `OPENCODE_API_KEY_ENV` | const | 171–171 | yes | 3 | `src/clients/config-export/constants.ts` (L1) |
| `OPENCODE_API_KEY_ENV_REF` | const | 174–174 | yes | 2 | `src/clients/config-export/constants.ts` (L1) |
| `HERMES_API_KEY_ENV` | const | 180–180 | yes | 0 | `src/clients/config-export/constants.ts` (L1) |
| `HERMES_API_KEY_ENV_REF` | const | 181–181 | yes | 2 | `src/clients/config-export/constants.ts` (L1) |
| `OPENCLAW_API_KEY_ENV` | const | 184–184 | yes | 0 | `src/clients/config-export/constants.ts` (L1) |
| `OPENCLAW_API_KEY_ENV_REF` | const | 185–185 | yes | 2 | `src/clients/config-export/constants.ts` (L1) |
| `LOOPBACK_API_KEY_PLACEHOLDER` | const | 193–193 | yes | 9 | `src/clients/config-export/constants.ts` (L1) |
| `GAJAE_API_KEY_ENV` | const | 200–200 | yes | 2 | `src/clients/config-export/constants.ts` (L1) |
| `PI_API_DIALECT` | const | 203–203 | no | 0 | `src/clients/config-export/constants.ts` (L1) |
| `SCHEMA_REQUIRED_OUTPUT_BUDGET` | const | 217–217 | yes | 2 | `src/clients/config-export/constants.ts` (L1) |
| `OPENCODE_PROVIDER_BLOCK_DEFAULT_CONFIG` | const | 220–225 | yes | 1 | `src/clients/config-export/constants.ts` (L1) |
| `opencodeGlobalConfigPath` | function | 231–237 | yes | 3 | `src/clients/config-export/paths.ts` (L2; deferred) |
| `OMP_PROFILE_NAME_RE` | const | 239–239 | no | 0 | `src/clients/config-export/paths.ts` (L2; deferred) |
| `OMP_WINDOWS_RESERVED_PROFILE_RE` | const | 240–240 | no | 0 | `src/clients/config-export/paths.ts` (L2; deferred) |
| `ompProfileName` | function | 242–258 | no | 0 | `src/clients/config-export/paths.ts` (L2; deferred) |
| `piAgentDir` | function | 270–274 | yes | 2 | `src/clients/config-export/paths.ts` (L2; deferred) |
| `piConfigPath` | function | 277–279 | yes | 2 | `src/clients/config-export/paths.ts` (L2; deferred) |
| `ompAgentDir` | function | 282–293 | yes | 1 | `src/clients/config-export/paths.ts` (L2; deferred) |
| `ompModelsConfigPath` | function | 296–301 | yes | 4 | `src/clients/config-export/paths.ts` (L2; deferred) |
| `opencodeProxyBaseUrl` | function | 304–316 | yes | 4 | `src/clients/config-export/opencode.ts` (L2; deferred) |
| `hermesHomeDir` | function | 322–330 | yes | 1 | `src/clients/config-export/paths.ts` (L2; deferred) |
| `hermesConfigPath` | function | 332–334 | yes | 2 | `src/clients/config-export/paths.ts` (L2; deferred) |
| `ClientPathError` | class | 350–350 | yes | 12 | `src/clients/config-export/paths.ts` (L2; deferred) |
| `absoluteClientPath` | function | 352–363 | no | 0 | `src/clients/config-export/paths.ts` (L2; deferred) |
| `openclawEffectiveHome` | function | 372–375 | no | 0 | `src/clients/config-export/openclaw-paths.ts` (L2; deferred) |
| `openclawHomeDir` | function | 393–413 | yes | 2 | `src/clients/config-export/openclaw-paths.ts` (L2; deferred) |
| `openclawConfigPath` | function | 427–457 | yes | 2 | `src/clients/config-export/openclaw-paths.ts` (L2; deferred) |
| `kimiHomeDir` | function | 459–462 | yes | 1 | `src/clients/config-export/paths.ts` (L2; deferred) |
| `kimiConfigPath` | function | 464–466 | yes | 2 | `src/clients/config-export/paths.ts` (L2; deferred) |
| `gajaeHomeDir` | function | 468–470 | yes | 1 | `src/clients/config-export/paths.ts` (L2; deferred) |
| `gajaeConfigPath` | function | 472–474 | yes | 2 | `src/clients/config-export/paths.ts` (L2; deferred) |
| `dshHomeDir` | function | 477–492 | yes | 2 | `src/clients/config-export/paths.ts` (L2; deferred) |
| `dshConfigPath` | function | 494–496 | yes | 2 | `src/clients/config-export/paths.ts` (L2; deferred) |
| `mcodeHomeDir` | function | 503–509 | yes | 2 | `src/clients/config-export/paths.ts` (L2; deferred) |
| `mcodeConfigPath` | function | 511–513 | yes | 3 | `src/clients/config-export/paths.ts` (L2; deferred) |
| `zcodeHomeDir` | function | 521–525 | yes | 2 | `src/clients/config-export/paths.ts` (L2; deferred) |
| `zcodeConfigPath` | function | 527–529 | yes | 2 | `src/clients/config-export/paths.ts` (L2; deferred) |
| `primeAgentDir` | function | 540–544 | yes | 2 | `src/clients/config-export/paths.ts` (L2; deferred) |
| `primeConfigPath` | function | 547–549 | yes | 2 | `src/clients/config-export/paths.ts` (L2; deferred) |
| `asideHomeDir` | function | 558–560 | yes | 1 | `src/clients/config-export/aside-paths.ts` (L2; deferred) |
| `asideCurrentAccountId` | function | 584–612 | no | 0 | `src/clients/config-export/aside-paths.ts` (L2; deferred) |
| `asideAccountDir` | function | 619–622 | yes | 2 | `src/clients/config-export/aside-paths.ts` (L2; deferred) |
| `asideConfigPath` | function | 625–627 | yes | 2 | `src/clients/config-export/aside-paths.ts` (L2; deferred) |
| `ExportModel` | interface | 634–647 | yes | 18 | `src/clients/config-export/contracts.ts` (L1) |
| `ExportContext` | interface | 649–658 | yes | 8 | `src/clients/config-export/contracts.ts` (L1) |
| `ExportClientId` | type | 660–672 | yes | 3 | `src/clients/config-export/contracts.ts` (L1) |
| `ExportClientSpec` | interface | 674–713 | yes | 0 | `src/clients/config-export/contracts.ts` (L1) |
| `authoritativeContextWindow` | function | 719–725 | no | 0 | `src/clients/config-export/model-metadata.ts` (L1) |
| `outputBudgetFor` | function | 728–730 | no | 0 | `src/clients/config-export/model-metadata.ts` (L1) |
| `CLIENT_INPUT_MODALITIES` | const | 761–764 | no | 0 | `src/clients/config-export/model-metadata.ts` (L1) |
| `inputModalitiesForClient` | function | 767–779 | no | 0 | `src/clients/config-export/model-metadata.ts` (L1) |
| `dshInputModalities` | function | 782–791 | no | 0 | `src/clients/config-export/dsh.ts` (L1) |
| `exportModelLabel` | function | 798–805 | no | 0 | `src/clients/config-export/model-metadata.ts` (L1) |
| `opencodeProviderConnection` | function | 808–818 | no | 0 | `src/clients/config-export/opencode.ts` (L2; deferred) |
| `opencodeEffortVariants` | function | 833–840 | no | 0 | `src/clients/config-export/opencode.ts` (L2; deferred) |
| `opencodeProviderBlocks` | function | 855–894 | yes | 1 | `src/clients/config-export/opencode.ts` (L2; deferred) |
| `opencodeProviderBlock` | function | 897–903 | no | 0 | `src/clients/config-export/opencode.ts` (L2; deferred) |
| `opencodeV2ProviderBlock` | function | 906–912 | yes | 1 | `src/clients/config-export/opencode.ts` (L2; deferred) |
| `buildOpencodeProviderBlockFromCatalog` | function | 919–926 | yes | 1 | `src/clients/config-export/opencode.ts` (L2; deferred) |
| `normalizeExportModels` | function | 934–943 | yes | 2 | `src/clients/config-export/model-metadata.ts` (L1) |
| `buildOpencodeClientConfig` | function | 953–962 | no | 0 | `src/clients/config-export/opencode.ts` (L2; deferred) |
| `PiModelEntry` | interface | 964–979 | yes | 0 | `src/clients/config-export/contracts.ts` (L1) |
| `PiProviderBlock` | interface | 981–986 | yes | 0 | `src/clients/config-export/pi.ts` (L2; deferred) |
| `PiGeneratedConfig` | interface | 988–990 | yes | 6 | `src/clients/config-export/pi.ts` (L2; deferred) |
| `OmpModelEntry` | interface | 997–1006 | yes | 0 | `src/clients/config-export/omp.ts` (L1) |
| `OmpProviderBlock` | interface | 1008–1013 | yes | 0 | `src/clients/config-export/omp.ts` (L1) |
| `OmpGeneratedConfig` | interface | 1015–1017 | yes | 0 | `src/clients/config-export/omp.ts` (L1) |
| `OMP_EFFORT_VOCABULARY` | const | 1023–1023 | no | 0 | `src/clients/config-export/omp.ts` (L1) |
| `ompEfforts` | function | 1025–1034 | no | 0 | `src/clients/config-export/omp.ts` (L1) |
| `HermesProviderBlock` | interface | 1041–1049 | yes | 0 | `src/clients/config-export/hermes-openclaw.ts` (L2; deferred) |
| `HermesModelEntry` | interface | 1052–1054 | yes | 0 | `src/clients/config-export/hermes-openclaw.ts` (L2; deferred) |
| `HermesGeneratedConfig` | interface | 1056–1058 | yes | 4 | `src/clients/config-export/hermes-openclaw.ts` (L2; deferred) |
| `OpenclawModelEntry` | interface | 1060–1064 | yes | 0 | `src/clients/config-export/hermes-openclaw.ts` (L2; deferred) |
| `OpenclawProviderBlock` | interface | 1066–1072 | yes | 0 | `src/clients/config-export/hermes-openclaw.ts` (L2; deferred) |
| `OpenclawGeneratedConfig` | interface | 1075–1080 | yes | 2 | `src/clients/config-export/hermes-openclaw.ts` (L2; deferred) |
| `KimiProviderBlock` | interface | 1082–1086 | yes | 0 | `src/clients/config-export/kimi-gajae.ts` (L2; deferred) |
| `KimiModelBlock` | interface | 1095–1100 | yes | 0 | `src/clients/config-export/kimi-gajae.ts` (L2; deferred) |
| `KimiGeneratedConfig` | interface | 1102–1105 | yes | 2 | `src/clients/config-export/kimi-gajae.ts` (L2; deferred) |
| `GajaeModelEntry` | interface | 1107–1113 | yes | 0 | `src/clients/config-export/kimi-gajae.ts` (L2; deferred) |
| `GajaeProviderBlock` | interface | 1116–1121 | yes | 0 | `src/clients/config-export/kimi-gajae.ts` (L2; deferred) |
| `GajaeGeneratedConfig` | interface | 1123–1125 | yes | 3 | `src/clients/config-export/kimi-gajae.ts` (L2; deferred) |
| `DshReasoningEffort` | type | 1127–1127 | yes | 0 | `src/clients/config-export/dsh.ts` (L1) |
| `DshWireReasoningEffort` | type | 1128–1128 | yes | 0 | `src/clients/config-export/dsh.ts` (L1) |
| `DshModelEntry` | interface | 1130–1136 | yes | 0 | `src/clients/config-export/dsh.ts` (L1) |
| `DshProviderBlock` | interface | 1138–1144 | yes | 0 | `src/clients/config-export/dsh.ts` (L1) |
| `DshGeneratedConfig` | interface | 1146–1150 | yes | 2 | `src/clients/config-export/dsh.ts` (L1) |
| `McodeProviderBlock` | interface | 1152–1163 | yes | 0 | `src/clients/config-export/mcode.ts` (L1) |
| `McodeModelEntry` | interface | 1165–1170 | yes | 0 | `src/clients/config-export/mcode.ts` (L1) |
| `McodeGeneratedConfig` | interface | 1172–1174 | yes | 2 | `src/clients/config-export/mcode.ts` (L1) |
| `ZcodeModelEntry` | interface | 1183–1187 | yes | 0 | `src/clients/config-export/zcode.ts` (L1) |
| `ZcodeProviderBlock` | interface | 1189–1200 | yes | 0 | `src/clients/config-export/zcode.ts` (L1) |
| `ZcodeGeneratedConfig` | interface | 1202–1204 | yes | 1 | `src/clients/config-export/zcode.ts` (L1) |
| `buildPiClientConfig` | function | 1229–1276 | no | 0 | `src/clients/config-export/pi.ts` (L2; deferred) |
| `buildOmpClientConfig` | function | 1283–1321 | no | 0 | `src/clients/config-export/omp.ts` (L1) |
| `proxyAdmissionHeaders` | function | 1324–1326 | no | 0 | `src/clients/config-export/model-metadata.ts` (L1) |
| `buildHermesClientConfig` | function | 1328–1349 | no | 0 | `src/clients/config-export/hermes-openclaw.ts` (L2; deferred) |
| `buildOpenclawClientConfig` | function | 1351–1375 | no | 0 | `src/clients/config-export/hermes-openclaw.ts` (L2; deferred) |
| `kimiModelAlias` | function | 1378–1380 | yes | 1 | `src/clients/config-export/kimi-gajae.ts` (L2; deferred) |
| `buildKimiClientConfig` | function | 1382–1407 | no | 0 | `src/clients/config-export/kimi-gajae.ts` (L2; deferred) |
| `buildGajaeClientConfig` | function | 1409–1438 | no | 0 | `src/clients/config-export/kimi-gajae.ts` (L2; deferred) |
| `DSH_EFFORT_ORDER` | const | 1440–1440 | no | 0 | `src/clients/config-export/dsh.ts` (L1) |
| `dshReasoningEfforts` | function | 1442–1462 | no | 0 | `src/clients/config-export/dsh.ts` (L1) |
| `isKnownSafeDshCombo` | function | 1464–1483 | no | 0 | `src/clients/config-export/dsh.ts` (L1) |
| `buildDshClientConfig` | function | 1485–1516 | no | 0 | `src/clients/config-export/dsh.ts` (L1) |
| `buildMcodeClientConfig` | function | 1527–1559 | no | 0 | `src/clients/config-export/mcode.ts` (L1) |
| `buildZcodeClientConfig` | function | 1570–1606 | no | 0 | `src/clients/config-export/zcode.ts` (L1) |
| `summarizeOpencode` | function | 1614–1617 | no | 0 | `src/clients/config-export/opencode.ts` (L2; deferred) |
| `summarizePi` | function | 1619–1622 | no | 0 | `src/clients/config-export/pi.ts` (L2; deferred) |
| `summarizeOmp` | function | 1624–1627 | no | 0 | `src/clients/config-export/omp.ts` (L1) |
| `summarizeHermes` | function | 1629–1633 | no | 0 | `src/clients/config-export/hermes-openclaw.ts` (L2; deferred) |
| `summarizeOpenclaw` | function | 1635–1638 | no | 0 | `src/clients/config-export/hermes-openclaw.ts` (L2; deferred) |
| `summarizeKimi` | function | 1640–1645 | no | 0 | `src/clients/config-export/kimi-gajae.ts` (L2; deferred) |
| `summarizeGajae` | function | 1647–1650 | no | 0 | `src/clients/config-export/kimi-gajae.ts` (L2; deferred) |
| `summarizeDsh` | function | 1652–1655 | no | 0 | `src/clients/config-export/dsh.ts` (L1) |
| `summarizeMcode` | function | 1657–1660 | no | 0 | `src/clients/config-export/mcode.ts` (L1) |
| `summarizeZcode` | function | 1662–1665 | no | 0 | `src/clients/config-export/zcode.ts` (L1) |
| `singleFragment` | function | 1668–1670 | no | 0 | `src/clients/config-export/model-metadata.ts` (L1) |
| `buildOpencodeContribution` | function | 1672–1684 | no | 0 | `src/clients/config-export/opencode.ts` (L2; deferred) |
| `buildPiContribution` | function | 1686–1689 | no | 0 | `src/clients/config-export/pi.ts` (L2; deferred) |
| `buildOmpContribution` | function | 1691–1694 | no | 0 | `src/clients/config-export/omp.ts` (L1) |
| `buildHermesContribution` | function | 1696–1699 | no | 0 | `src/clients/config-export/hermes-openclaw.ts` (L2; deferred) |
| `buildOpenclawContribution` | function | 1701–1704 | no | 0 | `src/clients/config-export/hermes-openclaw.ts` (L2; deferred) |
| `buildKimiContribution` | function | 1711–1720 | no | 0 | `src/clients/config-export/kimi-gajae.ts` (L2; deferred) |
| `buildGajaeContribution` | function | 1722–1725 | no | 0 | `src/clients/config-export/kimi-gajae.ts` (L2; deferred) |
| `buildDshContribution` | function | 1727–1730 | no | 0 | `src/clients/config-export/dsh.ts` (L1) |
| `buildMcodeContribution` | function | 1732–1735 | no | 0 | `src/clients/config-export/mcode.ts` (L1) |
| `buildZcodeContribution` | function | 1737–1740 | no | 0 | `src/clients/config-export/zcode.ts` (L1) |
| `buildPrimeContribution` | function | 1755–1758 | no | 0 | `src/clients/config-export/pi.ts` (L2; deferred) |
| `buildAsideContribution` | function | 1778–1781 | no | 0 | `src/clients/config-export/pi.ts` (L2; deferred) |
| `EXPORT_CLIENTS` | const | 1783–1954 | yes | 15 | `src/clients/config-export.ts` (residual) |
| `EXPORT_CLIENT_IDS` | const | 1956–1956 | yes | 7 | `src/clients/config-export.ts` (residual) |
| `isExportClientId` | function | 1958–1960 | yes | 3 | `src/clients/config-export.ts` (residual) |
| `buildClientConfig` | function | 1963–1965 | yes | 9 | `src/clients/config-export.ts` (residual) |
| `buildClientConfigText` | function | 1973–1985 | yes | 8 | `src/clients/config-export.ts` (residual) |
| `buildClientContribution` | function | 1988–1990 | yes | 5 | `src/clients/config-export.ts` (residual) |

Export-only declaration: `ConfigFormat` at `src/clients/config-export.ts:32` remains forwarded from `../integrations/serialize`, not redefined.

## Leaf partition

Part a moves the lowest-fanout format leaves first: `omp` (sum of external symbol consumers 0), `zcode` (1), `dsh` (2), `mcode` (2). Part b takes the higher-fanout families and paths. The three shared foundations move with part a because even its lowest-fanout clients need them: leaving types/constants/model rules in the original would create facade back-imports. No external caller changes paths. PiModelEntry (0 consumers) moves with shared contracts because OmpModelEntry extends it. The larger Pi document type/builders remain for part b.

Line-budget convention: each declaration carries immediately preceding comments/whitespace, from previous declaration end+1. One explicit exception: the blank separator at original line 33, immediately after the import/export header, stays in the facade; the first moved block starts at line 34. This gives 707 moved original lines and the contracts projection below. Moving line 33 as well would instead give 708 moved lines and a 151-line contracts leaf. Counts include those blocks, the exact one-line imports shown, one header line and one separator. These are projected implementation counts, not measurements of files already written. Do not discard comments to meet limits. Adding an export keyword does not add a line. All new files are ≤400.

### `src/clients/config-export/contracts.ts` — expected 150 lines

Symbols: `ManagedFragment`, `ManagedContribution`, `BuildContribution`, `OpencodeLaunchEnv`, `OpencodeCatalogModel`, `ExportModel`, `ExportContext`, `ExportClientId`, `ExportClientSpec`, `PiModelEntry`.

Own imports:

```ts
import type { OcxConfig } from "../../types";
import type { ConfigFormat } from "../../integrations/serialize";
```

Leaf exports: `ManagedFragment`, `ManagedContribution`, `BuildContribution`, `OpencodeLaunchEnv`, `OpencodeCatalogModel`, `ExportModel`, `ExportContext`, `ExportClientId`, `ExportClientSpec`, `PiModelEntry`. Other listed declarations remain private. Only previously public symbols are forwarded from the original path; newly exposed internal symbols serve production registry/sibling calls, not tests.

### `src/clients/config-export/constants.ts` — expected 69 lines

Symbols: `OPENCODE_PROVIDER_ID`, `OPENCODE_CONFIG_SCHEMA`, `OPENCODE_API_KEY_ENV`, `OPENCODE_API_KEY_ENV_REF`, `HERMES_API_KEY_ENV`, `HERMES_API_KEY_ENV_REF`, `OPENCLAW_API_KEY_ENV`, `OPENCLAW_API_KEY_ENV_REF`, `LOOPBACK_API_KEY_PLACEHOLDER`, `GAJAE_API_KEY_ENV`, `PI_API_DIALECT`, `SCHEMA_REQUIRED_OUTPUT_BUDGET`, `OPENCODE_PROVIDER_BLOCK_DEFAULT_CONFIG`.

Own imports:

```ts
import type { OcxConfig } from "../../types";
```

Leaf exports: `OPENCODE_PROVIDER_ID`, `OPENCODE_CONFIG_SCHEMA`, `OPENCODE_API_KEY_ENV`, `OPENCODE_API_KEY_ENV_REF`, `HERMES_API_KEY_ENV`, `HERMES_API_KEY_ENV_REF`, `OPENCLAW_API_KEY_ENV`, `OPENCLAW_API_KEY_ENV_REF`, `LOOPBACK_API_KEY_PLACEHOLDER`, `GAJAE_API_KEY_ENV`, `PI_API_DIALECT`, `SCHEMA_REQUIRED_OUTPUT_BUDGET`, `OPENCODE_PROVIDER_BLOCK_DEFAULT_CONFIG`. Other listed declarations remain private. Only previously public symbols are forwarded from the original path; newly exposed internal symbols serve production registry/sibling calls, not tests.

### `src/clients/config-export/model-metadata.ts` — expected 113 lines

Symbols: `authoritativeContextWindow`, `outputBudgetFor`, `CLIENT_INPUT_MODALITIES`, `inputModalitiesForClient`, `exportModelLabel`, `normalizeExportModels`, `proxyAdmissionHeaders`, `singleFragment`.

Own imports:

```ts
import { SCHEMA_REQUIRED_OUTPUT_BUDGET } from "./constants";
import type { OpencodeCatalogModel, ExportModel, ExportClientId, ManagedContribution } from "./contracts";
import type { OcxConfig } from "../../types";
import { shouldInjectApiAuthHeader } from "../../codex/inject";
```

Leaf exports: `authoritativeContextWindow`, `outputBudgetFor`, `inputModalitiesForClient`, `exportModelLabel`, `normalizeExportModels`, `proxyAdmissionHeaders`, `singleFragment`. Other listed declarations remain private. Only previously public symbols are forwarded from the original path; newly exposed internal symbols serve production registry/sibling calls, not tests.

### `src/clients/config-export/omp.ts` — expected 104 lines

Symbols: `OmpModelEntry`, `OmpProviderBlock`, `OmpGeneratedConfig`, `OMP_EFFORT_VOCABULARY`, `ompEfforts`, `buildOmpClientConfig`, `summarizeOmp`, `buildOmpContribution`.

Own imports:

```ts
import type { PiModelEntry, ExportModel, ExportContext, ManagedContribution } from "./contracts";
import { PI_API_DIALECT, OPENCODE_PROVIDER_ID, LOOPBACK_API_KEY_PLACEHOLDER } from "./constants";
import { normalizeExportModels, inputModalitiesForClient, exportModelLabel, authoritativeContextWindow, outputBudgetFor, singleFragment } from "./model-metadata";
```

Leaf exports: `OmpModelEntry`, `OmpProviderBlock`, `OmpGeneratedConfig`, `buildOmpClientConfig`, `summarizeOmp`, `buildOmpContribution`. Other listed declarations remain private. Only previously public symbols are forwarded from the original path; newly exposed internal symbols serve production registry/sibling calls, not tests.

### `src/clients/config-export/zcode.ts` — expected 92 lines

Symbols: `ZcodeModelEntry`, `ZcodeProviderBlock`, `ZcodeGeneratedConfig`, `buildZcodeClientConfig`, `summarizeZcode`, `buildZcodeContribution`.

Own imports:

```ts
import type { ExportContext, ManagedContribution } from "./contracts";
import { normalizeExportModels, inputModalitiesForClient, exportModelLabel, authoritativeContextWindow, singleFragment } from "./model-metadata";
import { OPENCODE_PROVIDER_ID, LOOPBACK_API_KEY_PLACEHOLDER } from "./constants";
```

Leaf exports: `ZcodeModelEntry`, `ZcodeProviderBlock`, `ZcodeGeneratedConfig`, `buildZcodeClientConfig`, `summarizeZcode`, `buildZcodeContribution`. Other listed declarations remain private. Only previously public symbols are forwarded from the original path; newly exposed internal symbols serve production registry/sibling calls, not tests.

### `src/clients/config-export/dsh.ts` — expected 132 lines

Symbols: `dshInputModalities`, `DshReasoningEffort`, `DshWireReasoningEffort`, `DshModelEntry`, `DshProviderBlock`, `DshGeneratedConfig`, `DSH_EFFORT_ORDER`, `dshReasoningEfforts`, `isKnownSafeDshCombo`, `buildDshClientConfig`, `summarizeDsh`, `buildDshContribution`.

Own imports:

```ts
import type { ExportModel, ExportContext, ManagedContribution } from "./contracts";
import type { OcxConfig } from "../../types";
import { providerCodexAccountMode } from "../../providers/registry";
import { normalizeExportModels, authoritativeContextWindow, exportModelLabel, singleFragment } from "./model-metadata";
import { OPENCODE_PROVIDER_ID } from "./constants";
```

Leaf exports: `DshReasoningEffort`, `DshWireReasoningEffort`, `DshModelEntry`, `DshProviderBlock`, `DshGeneratedConfig`, `buildDshClientConfig`, `summarizeDsh`, `buildDshContribution`. Other listed declarations remain private. Only previously public symbols are forwarded from the original path; newly exposed internal symbols serve production registry/sibling calls, not tests.

### `src/clients/config-export/mcode.ts` — expected 83 lines

Symbols: `McodeProviderBlock`, `McodeModelEntry`, `McodeGeneratedConfig`, `buildMcodeClientConfig`, `summarizeMcode`, `buildMcodeContribution`.

Own imports:

```ts
import type { ExportContext, ManagedContribution } from "./contracts";
import { normalizeExportModels, authoritativeContextWindow, singleFragment } from "./model-metadata";
import { sanitizeCodexReasoningEfforts } from "../../reasoning-effort";
import { OPENCODE_PROVIDER_ID, LOOPBACK_API_KEY_PLACEHOLDER } from "./constants";
```

Leaf exports: `McodeProviderBlock`, `McodeModelEntry`, `McodeGeneratedConfig`, `buildMcodeClientConfig`, `summarizeMcode`, `buildMcodeContribution`. Other listed declarations remain private. Only previously public symbols are forwarded from the original path; newly exposed internal symbols serve production registry/sibling calls, not tests.

Residual `src/clients/config-export.ts`: expected **1299 lines**. It remains >400 intentionally; **410 / S13 L2 / #b** takes all deferred inventory rows.

Retained declarations after this layer: `OpencodeModelEntry`, `OpencodeModelVariant`, `OpencodeV2ModelEntry`, `OpencodeProviderConnection`, `OpencodeProviderBlock`, `OpencodeV2ProviderBlock`, `OpencodeProviderBlocks`, `OpencodeGeneratedConfig`, `OPENCODE_PROVIDER_NPM`, `OPENCODE_V2_PROVIDER_PACKAGE`, `OPENCODE_PROVIDER_NAME`, `opencodeGlobalConfigPath`, `OMP_PROFILE_NAME_RE`, `OMP_WINDOWS_RESERVED_PROFILE_RE`, `ompProfileName`, `piAgentDir`, `piConfigPath`, `ompAgentDir`, `ompModelsConfigPath`, `opencodeProxyBaseUrl`, `hermesHomeDir`, `hermesConfigPath`, `ClientPathError`, `absoluteClientPath`, `openclawEffectiveHome`, `openclawHomeDir`, `openclawConfigPath`, `kimiHomeDir`, `kimiConfigPath`, `gajaeHomeDir`, `gajaeConfigPath`, `dshHomeDir`, `dshConfigPath`, `mcodeHomeDir`, `mcodeConfigPath`, `zcodeHomeDir`, `zcodeConfigPath`, `primeAgentDir`, `primeConfigPath`, `asideHomeDir`, `asideCurrentAccountId`, `asideAccountDir`, `asideConfigPath`, `opencodeProviderConnection`, `opencodeEffortVariants`, `opencodeProviderBlocks`, `opencodeProviderBlock`, `opencodeV2ProviderBlock`, `buildOpencodeProviderBlockFromCatalog`, `buildOpencodeClientConfig`, `PiProviderBlock`, `PiGeneratedConfig`, `HermesProviderBlock`, `HermesModelEntry`, `HermesGeneratedConfig`, `OpenclawModelEntry`, `OpenclawProviderBlock`, `OpenclawGeneratedConfig`, `KimiProviderBlock`, `KimiModelBlock`, `KimiGeneratedConfig`, `GajaeModelEntry`, `GajaeProviderBlock`, `GajaeGeneratedConfig`, `buildPiClientConfig`, `buildHermesClientConfig`, `buildOpenclawClientConfig`, `kimiModelAlias`, `buildKimiClientConfig`, `buildGajaeClientConfig`, `summarizeOpencode`, `summarizePi`, `summarizeHermes`, `summarizeOpenclaw`, `summarizeKimi`, `summarizeGajae`, `buildOpencodeContribution`, `buildPiContribution`, `buildHermesContribution`, `buildOpenclawContribution`, `buildKimiContribution`, `buildGajaeContribution`, `buildPrimeContribution`, `buildAsideContribution`, `EXPORT_CLIENTS`, `EXPORT_CLIENT_IDS`, `isExportClientId`, `buildClientConfig`, `buildClientConfigText`, `buildClientContribution`.

Projection before unused-import pruning: 1990 original − 707 cumulative moved original lines + 16 facade glue = 1299. Across a/b: 707 + 1,041 = 1,748 moved body/trivia lines; 242 retained original lines; 1,748 + 242 = 1,990. The projected final glue is 31 lines, giving 273; L1's 16 glue lines are replaced by L2's 31, not both counted. These are estimates, not acceptance measurements: remove the now-unused provider import and measure actual import/forward/separator lines in B/C, recording the reconciled residual and leaf counts before advancing.

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
```

Explicit residual local imports (re-export binds nothing locally):

```ts
import type { OpencodeLaunchEnv, OpencodeCatalogModel, ExportContext, PiModelEntry, ManagedContribution, ManagedFragment, ExportClientId, ExportClientSpec } from "./config-export/contracts";
import { OPENCODE_API_KEY_ENV_REF, OPENCODE_PROVIDER_BLOCK_DEFAULT_CONFIG, OPENCODE_CONFIG_SCHEMA, OPENCODE_PROVIDER_ID, PI_API_DIALECT, LOOPBACK_API_KEY_PLACEHOLDER, HERMES_API_KEY_ENV_REF, OPENCLAW_API_KEY_ENV_REF, GAJAE_API_KEY_ENV, OPENCODE_API_KEY_ENV, HERMES_API_KEY_ENV, OPENCLAW_API_KEY_ENV } from "./config-export/constants";
import { exportModelLabel, authoritativeContextWindow, outputBudgetFor, normalizeExportModels, inputModalitiesForClient, proxyAdmissionHeaders, singleFragment } from "./config-export/model-metadata";
import { buildOmpClientConfig, summarizeOmp, buildOmpContribution } from "./config-export/omp";
import { buildDshClientConfig, summarizeDsh, buildDshContribution } from "./config-export/dsh";
import { buildMcodeClientConfig, summarizeMcode, buildMcodeContribution } from "./config-export/mcode";
import { buildZcodeClientConfig, summarizeZcode, buildZcodeContribution } from "./config-export/zcode";
```

Retain original external imports still used by the residual; prune only proven-unused bindings. Specifically remove the `providerCodexAccountMode` import and remove only `sanitizeCodexReasoningEfforts` from the reasoning-effort import, retaining `canonicalizeReasoningEfforts`. Keep both existing imports from `../codex/inject`: the residual still uses `shouldInjectApiAuthHeader` and `standaloneCodexRoutingTarget`. New leaves import one another directly.

## Module-level state and cycles

`CLIENT_INPUT_MODALITIES` at `src/clients/config-export.ts:761–764` owns two allowlist Sets in `config-export/model-metadata.ts`; never copy them into each client. `OMP_EFFORT_VOCABULARY` at `:1023` belongs only to `config-export/omp.ts`. No top-level let, Map, WeakMap, timer or lock exists. Function-local seen/offered Sets remain per-call. The exported default-config object at `:220–225` moves once to constants.ts; preserve object identity. `EXPORT_CLIENTS` at `:1783–1954` and derived `EXPORT_CLIENT_IDS` at `:1956` remain initialized once in the residual; preserve order.

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
- `tests/config/client-config-export.test.ts` — original import/assertions retained; facade identity and fixed-byte regressions added.
- `tests/config/client-config-new-clients.test.ts` — unchanged.
- `tests/gui/integrations-invariants.test.ts` — unchanged.
- `tests/providers/aside-client.test.ts` — unchanged.
- `tests/providers/minimax-clients.test.ts` — unchanged.
- `tests/providers/zcode-client.test.ts` — unchanged.
- `tests/server/management-client-config-route.test.ts` — unchanged.
- `tests/server/management-integration-journal-delete.test.ts` — unchanged.
- `tests/server/management-integration-routes.test.ts` — unchanged.

No source-text reader of src/clients/config-export.ts was found. `tests/config/client-config-export.test.ts:58` and `tests/server/management-client-config-route.test.ts:416` mention it in comments, not source reads. No retarget-to-leaf or add-leaf-to-scan-list action. Preserve baked serialized fixtures unchanged.

C-phase red proof: temporarily treat incompatible audio-only input as text in the moved metadata function and observe `tests/clients/client-export-modality-enum.test.ts:96` fail; restore. Temporarily retain none in the moved MCode effort list and observe `tests/providers/minimax-clients.test.ts:117` fail; restore.

The implementation uses the existing focused test file; no new test file was needed. Original assertions remain intact. The recorded red/restored-green proof applies to the unchanged tested source and test blobs; repeat it if those change. Never commit mutation probes. A future new test file requires both layout registry entries.

## Verification

Run the following Bash recipe from this session's bound checkout while its FSM is at C, after committing and publishing the layer head. The session identifier below belongs to this task; another task must use its own latest SessionStart binding. All Bun commands run on `lidge`, inside a fresh temporary clone. No shared seed checkout is switched. The local commands only validate identity, transport the verifier and retain output.

```bash
set -euo pipefail
wp400_root=$(git rev-parse --show-toplevel)
wp400_expected=$(git rev-parse HEAD)
wp400_status=$(git status --porcelain)
test -z "$wp400_status"
wp400_log="$wp400_root/.codexclaw/evidence/01a06e97-b9d8-7250-8204-bb788338c288/wp400-remote-check-$wp400_expected.log"
mkdir -p "$(dirname "$wp400_log")"
cxc receipt test --cwd "$wp400_root" --session 01a06e97-b9d8-7250-8204-bb788338c288 -- bash -c '
set -euo pipefail
test "$(git rev-parse HEAD)" = "$1"
local_status=$(git status --porcelain)
test -z "$local_status"
ssh lidge bash -s -- "$1" 2>&1 | tee "$2"
test "$(git rev-parse HEAD)" = "$1"
local_status=$(git status --porcelain)
test -z "$local_status"
' -- "$wp400_expected" "$wp400_log" <<'REMOTE'
set -euo pipefail
expected=${1:?expected SHA required}
[[ "$expected" =~ ^[0-9a-f]{40}$ ]]
run_dir=$(mktemp -d /tmp/ocx-wp400.XXXXXX)
printf 'RETAINED_RUN_DIR=%s\n' "$run_dir"
git clone --no-checkout https://github.com/lidge-jun/opencodex.git "$run_dir/repo"
cd "$run_dir/repo"
git fetch origin refs/heads/codex/split-clients-config-export-a
test "$(git rev-parse FETCH_HEAD)" = "$expected"
git checkout --detach "$expected"
bun --version
bun install --frozen-lockfile
(cd gui && bun install --frozen-lockfile)
tree_status=$(git status --porcelain)
test -z "$tree_status"
printf 'CHECKOUT=%s\nHEAD=%s\n' "$PWD" "$(git rev-parse HEAD)"
unset OCX_TEST_NO_QUEUE
bun run typecheck
bun test tests/ci-workflows/dsh-path-contract.test.ts tests/ci-workflows/dsh-writer-lock.test.ts tests/cli/cli-help.test.ts tests/clients/client-export-modality-enum.test.ts tests/clients/integrations-state.test.ts tests/clients/integrations-writer.test.ts tests/clients/omp-path-contract.test.ts tests/clients/pi-path-contract.test.ts tests/clients/prime-client.test.ts tests/clients/sync-client-integrations.test.ts tests/config/client-config-export-new-clients.test.ts tests/config/client-config-export.test.ts tests/config/client-config-new-clients.test.ts tests/gui/integrations-invariants.test.ts tests/providers/aside-client.test.ts tests/providers/minimax-clients.test.ts tests/providers/zcode-client.test.ts tests/server/management-client-config-route.test.ts tests/server/management-integration-journal-delete.test.ts tests/server/management-integration-routes.test.ts tests/cli/cli-export-command.test.ts
bun run privacy:scan
if bun run test; then
  test_rc=0
else
  test_rc=$?
fi
printf 'SUITE_EXIT=%s\n' "$test_rc"
if [ "$test_rc" -ne 0 ]; then exit "$test_rc"; fi
test "$(git rev-parse HEAD)" = "$expected"
tree_status=$(git status --porcelain)
test -z "$tree_status"
printf 'VERIFIED_HEAD=%s\n' "$expected"
REMOTE
```

The local pipeline propagates SSH and log-write failure to the receipt producer. Remote commands stop on failure; full-suite status is printed and returned. Final remote HEAD and Git status must still match the clean layer head. Keep the temporary clone and full output as evidence. A receipt proves the command actually run, not this prose; require fresh current-head CI and independent review before closure.

Local read-only structural checks are `git diff --check`, `wc -l` for the eight source files, and importer discovery with `rg -n 'clients/config-export' src gui/src scripts tests`. Resolve actual import edges when comparing consumers; a grep count alone is insufficient. New leaves must have no facade return edge, including type-only and literal dynamic imports. The full suite includes the core/Lab guard; do not weaken its protected roots. This layer's own source delta does not touch those protected files.

## Accept criteria

1. Apply PURE-MOVE-SIZE-01: ≤150 non-move changed lines, move-aware diff evidence, and exactly one implementation owner for each inventory symbol. No claim that literal added+deleted churn meets 500.
2. Every inventory declaration has exactly one implementation owner. Preserve all original export names/signatures and value/type importability; do not extract L1 declarations a second time.
3. Every new leaf is ≤400 lines. Residual target is 1299, with the sole >400 carry explicitly assigned to 410 / #b. Measure actual files and explain drift before proceeding.
4. Preserve function bodies, branch order, literals, serialized bytes/key order, class/object identity and state initialization. Only moves, explicit imports and named forwards change source structure.
5. Old-path consumers and assertions remain intact. Record the exact red/restored-green evidence named under Tests; no guard deletion, skipping, weakened assertions or empty-facade source scans.
6. Singleton state/allowlists each have one owner; no leaf imports the original even for types; resolved static/re-export/type/dynamic-literal graph has no new cycles.
7. Typecheck, focused checks, privacy, remote full suite and exact-head CI pass at this layer tip independently of later layers. No full local suite and no merge.
8. Diff stays within the original/new leaves and genuinely required existing focused tests. New tests, SoT edits, new topology or unrelated code require parent scope approval.

## PR

Title: `refactor(clients): extract low-fanout client formats and dependency foundations (split S13 L1/5)`

Branch: `codex/split-clients-config-export-a`. Current replanned base: `dev`, pinned `be81013fab6d83ff630ca5f38e7881678a303871` after prerequisite #3610 landed. Closes: none.

Use all sections of `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist), including the size-gate disposition and DEV-STACK-03 map below. This layer is PR #3611; placeholder rows refer only to future layers.

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 1 | #3611 | 400 — this layer | `codex/split-clients-config-export-a` | `dev` | extract low-fanout client formats and dependency foundations |
| 2 | #TBD-S13-L2 | 410 | `codex/split-clients-config-export-b` | `codex/split-clients-config-export-a` | finish client path and format partitions |
| 3 | #TBD-S13-L3 | 420 | `codex/split-cli-opencode` | `codex/split-clients-config-export-b` | separate OpenCode config and catalog from launch |
| 4 | #TBD-S13-L4 | 430 | `codex/split-cli-minimax` | `codex/split-cli-opencode` | isolate MMX protocol and termination owners |
| 5 | #TBD-S13-L5 | 440 | `codex/split-integrations-state` | `codex/split-clients-config-export-b` | separate classification from state reads |

Bottom S13 layer against `dev`. The former prerequisite #3610 has landed and the retarget/restack is complete. Review this layer's diff only. No S13 child had been published at this checkpoint. Future base changes require normal scoped restack and fresh verification; no open-prerequisite retargeting action remains. Merging stays out of scope.

## P stale-check (2026-09-05, wp400)

Historical stale check at origin/dev 3191fe1aa: config-export.ts unchanged since 445742966 (1990 lines). Base `dev` (S13 bottom; 410 #b, 420, 430, 440 chain on it). The planned subdirectory mirrors the src/codex/prompt-layers/ precedent from L300. 003 INTERMEDIATE-RESIDUAL-01 applies. Known upstream failures were management-route-registry ×3 and quota-reset-notify ×1. The earlier OCX_TEST_NO_QUEUE=1 instruction is withdrawn: it contaminates lock tests and must be unset for remote verification. No local suites; CI hygiene requires a test change.

## A audit synthesis (2026-09-05, wp400)

### Current execution authority

The current branch is `codex/split-clients-config-export-a`, PR #3611, base `dev` at `be81013fab6d83ff630ca5f38e7881678a303871`. That SHA is the integration base, not the layer head. The restack has already been performed. For current verification, use the clean layer HEAD and the isolated recipe above; do not repeat the retired parent rebase below. #3610 has landed as `5ab8aa9a2d9d2a3926469f9d8c82387b43c6d0e9`.

### Historical replan record — not executable

The original `244663568` split on the `850afb2e9` foundation passed focused checks but failed the full suite on four inherited quota/route cases. A temporary stack used the then-open #3610 head `afdd38ff43c64696153372fc2e27a38aff208c73`; its older foundation omitted four intervening dev commits, an explicitly recorded and audited tradeoff. The historical review anchors `7953e6d4` and `7d4a37544` belong to that retired parent arrangement.

After #3610 landed, the user authorized continued scoped verification and repair. Main replayed only its own commits onto the current dev base, preserving old refs and using `--no-update-refs` plus an exact-old-head lease. The actual `412dcba4` tree was identity-checked against the audited dev-base overlay. Its remote gates passed. Subsequent documentation repairs require a new current-head receipt; the historical hashes here are evidence anchors, never checkout or retargeting instructions.

The complete initial roadmap remains in the preserved documentation branch, at immutable local commit `dc44b08cafbbd45da81f940f1e8c00a9e5f61ce1`. Only this layer's governing documents are carried in its PR; other roadmap documents are read from that preserved ref. Implementation and receipts remain in the existing a2c0 directory, never in a replacement managed worktree.

Hooke (`01a06f9f-f57f-7fc3-9261-b07f291929be`, requested gpt-6-astra high) returned GO-WITH-FIXES with zero blockers, then PASS after the two documentation corrections above. The read-only audit matched all 153 inventory ranges, assigned all 63 moved declarations uniquely, checked seven leaf and seven facade import lists, and preserved 96 public exports (47 types, 49 values). Its dependency traversal reported no return path from the external owners to the facade at base `3191fe1aa`. These are plan-audit results, not implementation or test results.

Accepted findings: replace the stale raw-churn escalation with the binding ≤150 non-move gate; explicitly retain original blank line 33 and mark projected line counts as pre-pruning estimates. No blocker was rebutted. Re-review confirmed both closures at docs HEAD `38ad3cf5a` plus the working diff. `git diff --check` exited 0 after those edits; no local test suite was run.

Operational audit by Wegener (`01a06fa6-5e3c-7840-8172-8587e853dcc7`, explicitly `model=gpt-6-astra`, `reasoning_effort=high`) found two blockers: checkout-local source identity was incompatible with the prior separate execution tree, and the remote recipe switched a shared checkout. Both were accepted and folded into 003 WORKTREE-EVIDENCE-01 and 000. Re-audit returned PASS, with no blocker to entering B. A documentation-only delta must not stand in for implementation evidence from another checkout. The unsafe shared-checkout command has been removed; Verification now contains the isolated recipe. The actual runner received independent exact-SHA, clean-tree and failure-propagation review; changes to that recipe require the same checks. Approval of the plan is not proof that remote verification passed.

## B implementation record (2026-09-05)

### Historical temporary-stack checkpoint

At historical review anchor `7953e6d4e18b0e7c90c0c5cdb0a4256c22a25dd0`, the integration base was `afdd38ff43c64696153372fc2e27a38aff208c73` and PR #3611 temporarily targeted the then-open #3610 branch. That arrangement is retired. Only our branch was rebased/pushed; the exact-old-head lease protected publication and `--no-update-refs` preserved the old snapshots.

Independent reviewer Heisenberg confirmed identical blob IDs for all nine source/test paths versus244, exactly those nine paths plus three documents in the parent-relative diff, and an actual-tree traversal of4979edges/349facade-reachable files with no new return cycle or unresolved reachable import. Static verdict PASS; not a runtime-pass claim. This documentation checkpoint adds no source/test changes after that review anchor.

The prerequisite itself was separately verified in remote `/tmp/ocx-wp400.T036h8/repo` at exactafdd38ff: typecheck0,440focusedpass/0fail, privacy0, full suite SUITE_EXIT=0 and final HEAD/clean-tree checks passed. Full output: `wp400-prerequisite-check.log` in the session evidence directory. No local suite ran. Fresh resulting-head verification and GitHub CI for #3611 are still required.

Franklin (`01a06fac-95ee-77a0-8916-f7546c2b8996`, explicitly gpt-6-astra high) implemented only the approved source/test paths in a2c0 and handed them back without Git mutations or local tests. Main inspected the diff and measured all leaves. Source owner search and the A inventory were reused; no new algorithm or parallel implementation was introduced.

| File | Change and impact | Measured lines |
|---|---|---:|
| `src/clients/config-export.ts` | Retains dispatch/compatibility exports, imports moved owners; caller paths unchanged | 1298 |
| `src/clients/config-export/contracts.ts` | Canonical shared types, no runtime behavior | 150 |
| `src/clients/config-export/constants.ts` | Single constant/default-object owner | 69 |
| `src/clients/config-export/model-metadata.ts` | Existing normalization/modality/admission helpers moved intact | 113 |
| `src/clients/config-export/omp.ts` | Existing OMP builder, summary and owned fragment | 104 |
| `src/clients/config-export/zcode.ts` | Existing ZCode builder, summary and owned fragment | 92 |
| `src/clients/config-export/dsh.ts` | Existing DSH builder, summary and owned fragment | 132 |
| `src/clients/config-export/mcode.ts` | Existing MCode builder, summary and owned fragment | 83 |
| `tests/config/client-config-export.test.ts` | Adds identity and independent fixed-byte/fragment assertions; original assertions/fixtures unchanged | 919 |

The worker's AST inventory reports 153 unique owners (63 moved, 90 retained), 96 public exports (47 types, 49 values), 707 moved original lines and 109 non-move lines (36 leaf glue + 18 facade additions + 3 removals + 52 test additions). Actual facade size is one below the estimate because the unused provider import was removed. `git diff --check` passed. The existing test file was already over 400; its scoped extension is not a claim to resolve test-file debt. Final independent graph/syntax and runtime gates remain pending; the worker's combined graph/syntax command hit an AST no-match exit and did not establish a pass.

Verification runner: `.codexclaw/evidence/01a06e97-b9d8-7250-8204-bb788338c288/wp400-check.sh` invokes the reviewed `wp400-remote-check.sh` only over SSH. Wegener closed the pre-C hold after four clean-tree substitutions were changed to standalone Git-status assignments and the no-queue override was removed. Both scripts pass `bash -n`; runtime success is not implied.

Baseline evidence: isolated remote `/tmp/ocx-wp400.4dKWtB/repo`, exact base `850afb2e9f84979c87e914b248de482f44b34cd6`; typecheck, 440 focused tests across 21 files and privacy scan passed. Full suite exited 1. The initial runner mistakenly exported OCX_TEST_NO_QUEUE=1, inducing four lock-test failures in addition to the known upstream route-registry/rollover failures. That run is contaminated and cannot certify all gates. The variable is now explicitly unset; corrected verification is required. Full baseline output is retained as `wp400-base-check.log` in the same evidence directory. No local suite was run.

## Latest verification checkpoint

Current layer head is `bbf8d3cd25ccf70eb595bc7982f63528d060c1bd`, base dev at be81013fab6d83ff630ca5f38e7881678a303871, PR #3611 ready for review. All nine source/test blobs remain unchanged from the reviewed split. Three CodeRabbit document findings were fixed; all three threads are resolved. The S04 correction distinguishes six members from actual depth three, rather than retaining an obsolete depth-six exception. The isolated verifier and in-receipt identity guards received independent review.

The complete documented Bash recipe ran at this head and produced a fresh clean receipt: typecheck,442focusedtests,privacy and full18402pass/16skip/0fail, SUITE_EXIT=0. Evidence is in the bound a2c0 session directory, including wp400-remote-check-bbf8d3cd25ccf70eb595bc7982f63528d060c1bd.log and test-receipt.json. Prior receipts are archived by head. Final CI snapshot contains36reportedchecks with no pending/failed logical checks; configured skips remain explicit and obsolete cancellations have same-head successful replacements. All review threads are resolved. cxc completed exact-head-full-gates and closed WP400 through D, then entered P for WP450. Evidence includes ci-bbf8d3cd25ccf70eb595bc7982f63528d060c1bd.json and the head-named receipt archive. No merge occurred. Scoped CI reruns/repairs are authorized and no local suite or merge occurred.

## Central evidence journal — historical snapshots, not execution instructions

### Earlier resume checkpoint

Historical state at that checkpoint: the user explicitly granted full scoped authority after the CI-restart question. Host goal is ACTIVE; do not repeat that permission stop. #3610 externally landed and the PR auto-retargeteddev. Main performed C→P→A→B→C, audited the new candidate with Hooke, and rebased only own commits onto pinnedbe81013fab6d83ff630ca5f38e7881678a303871 using --no-update-refs and exact-old-head force-with-lease. Current clean a2c0 head is412dcba4d617bd2c6c5961a1ada9484b859d700f. Heisenberg confirmed identical9source/test blobs and exact12-path scope; security/contract review remains valid.

Fresh412remote typecheck,442focusedtests,privacy and full18402pass/16skip/0fail all passed. Receipt is clean and bound to412 with epochc-20260905044615-f4039d. Per-head output iswp400-remote-check-412dcba4d617bd2c6c5961a1ada9484b859d700f.log; previous7d4receipt was archived verbatim before producer reuse. Current hostedCIrun33945457034 is the target, with no failure/cancellation at this checkpoint. Its remaining checks are awaited; no D claim yet. The old-base retry was cancelled by Main as superseded by this restack, not treated as a new permission blocker.

The resumed goal was subsequently marked BLOCKED on a new condition: three consecutive goal turns confirmed hosted CI cancelled by the account with no replacement run or rerun confirmation. The former four baseline failures are resolved; successful7d4remote proof remains valid. No D close, CI waiver, merge or local suite was fabricated to end the loop. Resume on explicit rerun direction or fresh external replacement evidence.

The user resumed until completion. Actual FSM path was C→P→A→B→C, without a false D. Main chose an explicit prerequisite stack on #3610/afdd38ff and accepted the older basis in writing. Hooke candidate-graph and Wegener operational audits passed. Only our branch was rebased, with --no-update-refs and an exact-old-head lease; original244/audit67 refs remain.

Final clean a2c0 head: `7d4a37544b0df016cb7ba45d193d2fb9f0ad00a1`; #3611 targets the open prerequisite branch. Heisenberg independently verified identical nine source/test blobs, exact parent-relative scope and actual graph at7953e6d4. The subsequent7d4change is documentation only.

Both prerequisiteafdd and our7d4head passed isolated remote typecheck, focused tests, privacy and the full suite. At7d4:442focusedpass; full-suite lanes total18200pass/16skip/0fail; SUITE_EXIT=0; final remote HEAD/clean-tree checks passed. The actual `cxc receipt test` command exited0 and created `test-receipt.json` bound to7d4, dirtyfalse and check epochc-20260905042631-92d875. Full log: `wp400-remote-check-7d4a37544b0df016cb7ba45d193d2fb9f0ad00a1.log`. No local suite or merge occurred.

Hosted CI is still incomplete, not a source-test pass: current-head run33944657511 was cancelled. Job101248560357 has no runner/steps and its check annotation says “The run was canceled by @lidge-jun.” The run list shows no newer replacement at7d4. Missing checks include test2/4,test3/4,macos1/2,macos2/2,npm-globalmacos and a cancelled enforce-target. Do not silently override this account-initiated cancellation or count it as green. Exact-head-full-gates and c-5 remain open; no D close.

### Historical original-head C checkpoint (not a D close)

Host goal subsequently marked BLOCKED after three consecutive goal turns hit the same full-gate failure. Last fetched dev55395a9dc leaves route-registry.ts, management-api.ts and quota-reset-notify.test.ts unchanged from850; #3610 remains open/draft/unmerged. Additional update-test diagnostic scope has been requested, not granted. Source/PR244663568 remains clean and draft. No D transition, success receipt, merge or local suite was used to bypass this condition. Resume after the prerequisite is incorporated into a stable base, or after an authorized diagnostic/stabilization plan is agreed. The read-only #3610 watch has ended; no background follow-up is promised while blocked.

Code is committed and pushed at `24466356836dd567120d3d3f4e8d09574f2182d3`, PR #3611 open/draft against dev. Source and FSM remain in a2c0; this worktree is only the central documentation record, not the receipt checkout. The detailed per-file B record is in the code head's copy of this document.

- Seven leaves: contracts150, constants69, model-metadata113, omp104, zcode92, dsh132, mcode83. Facade1990→1298; WP410 remains required. Existing test file gained52lines without removing original assertions.
- Franklin implemented with explicit gpt-6-astra high. Fresh reviewer Heisenberg independently verified153uniqueowners (63moved/90retained), all96exports (47types/49values),118localbindings and4982edges/349reachablefiles with no new return cycle. Credential references, admission predicate and DSH filtering remain unchanged. Verdict PASS.
- Remote `/tmp/ocx-wp400.dg2OKt/repo` at that head: typecheck0,442focusedpass/0fail, privacy0. Full suite exited1 with exactly4baseline failures: management-route-registry×3 and quota-reset-notify enabled rollover×1. No passing receipt was written; C remains open.
- The older OCX_TEST_NO_QUEUE=1 instruction is withdrawn. It induced4lock-test failures in the initial baseline. The corrected runner unsets it and uses standalone Git-status assignments. Unchanged baseline lock tests then gave41pass/2skip/0fail; the corrected current full run has no lock-test failures.
- Two remote mutation proofs: audio-only→text triggered the named omission failure, then restored8pass/0fail; MCode retaining none triggered the named none-only failure, then restored19pass/0fail. Both red exits1; final remote HEAD unchanged and gitstatusclean. No mutant was committed or pushed.
- No local suite, merge, auto-merge or direct integration-branch push occurred.

Evidence in a2c0 `.codexclaw/evidence/01a06e97-b9d8-7250-8204-bb788338c288/`: `wp400-remote-check.log`, `wp400-red-green.log`, `wp400-baseline-lock-correction.log`, `wp400-current-checkpoint.md`. Goalplan ledger records source-extraction and focused-and-redgreen tasks done; exact-head-full-gates stays pending.

Fix PR #3610 remains open/draft. Last audited head `afdd38ff43c64696153372fc2e27a38aff208c73` causally addresses the4failures, but combined runtime/CI proof is pending. Its older foundation lacks4commits in WP400's850base; replaying onto it would change8sourcefiles in the verification tree. Main retains the current branch and watches the upstream fix, then will re-audit/restack onto a verified base containing both sets. No old receipt can certify a future head.
