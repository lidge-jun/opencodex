# Lane C — OpenCodex current-state inventory: subagents and model catalog

## Scope and provenance

This is a current-state inventory only. It records what the checked-out OpenCodex code models, synthesizes, writes, and forwards today; it makes no recommendation about future changes.

| Checkout | Verified revision | Evidence |
| --- | --- | --- |
| OpenCodex | `7612e4c4f81544a250c3eea9fe8ca85d8022e765` (`2026-08-16T09:15:49+09:00`) | `git log -1`; tracked working tree was clean before the authorized report write |
| upstream codex-rs | `9dd22890f5ff47e4af128c20e32b9758a61d78d2` (`2026-08-12T14:09:44Z`) | `git -C /Users/jun/Developer/codex/121_openai-codex log -1`; its pre-existing untracked `codex-rs/.codexclaw/` was not read as authority or modified |
| upstream leaf-model commit (context only) | `6d4d9442c7142c08ac5c5098dfd6e82d8cd9f65a`, “Support leaf models in multi-agent v2 (#36892)” | verified with upstream `git show --format=fuller --stat`; this report does not compare or prescribe changes from it |

The repository search was source-local. Literal-hit inventories below cover tracked `src/`; tests and GUI coverage are inventoried separately. `devlog/` was not used as behavioral authority.

## Direct answers

| Question | Current answer | Primary evidence |
| --- | --- | --- |
| What is written for subagents? | A Codex-shaped JSON model catalog whose subagent contract is encoded primarily by `priority`, `visibility`, `multi_agent_version`, and `supported_reasoning_levels`; a root `model_catalog_json` pointer; optional marker-owned `[agents].default_subagent_*`; and native v1/v2 agent settings in `[agents]` / `[features.multi_agent_v2]`. | `src/codex/catalog/sync.ts:435` `buildCatalogEntriesFromObservedState`; `src/codex/catalog/parsing.ts:362` `applyMultiAgentMode`; `src/codex/inject.ts:481` `setRootModelCatalogPath`; `src/codex/subagent-defaults.ts:419` `transformManagedSubagentDefaults`; `src/codex/features.ts:357,750,767,893` |
| Does OpenCodex know v1 vs v2? | **Yes, explicitly.** It has a persisted three-state catalog override (`v1/default/v2`), reads/toggles native `multi_agent_v2`, migrates thread-limit storage, recognizes v1/v2 tool shapes, filters the effective v2 roster, and applies v2-only effort policy. | `src/types.ts:822-827`; `src/codex/catalog/parsing.ts:342-395`; `src/codex/features.ts:121-178,1426-1507`; `src/server/responses/collaboration.ts:152-179`; `src/server/effort-policy.ts:57-80` |
| How does fallback trigger? | Only on requests identified as spawned children by exact Codex headers; it selects from an ordered configured chain using routability, provider/account usability, cooldown, cached failure, and quota checks, then rewrites only `parsed.modelId` and raw-body `model`. | `src/server/effort-policy.ts:20-43`; `src/codex/subagent-model-fallback.ts:269-296,357-362,498-545`; `src/server/responses/core.ts:1727-1784` |
| User surfaces? | OpenCodex JSON config, `ocx agent ...`, `ocx v2 ...`, `/api/subagent-models`, `/api/subagent-model-fallback`, `/api/injection-model`, `/api/effort-caps`, `/api/v2`, and the GUI Subagents/Models controls. | detailed tables below |

## 1. Exact catalog and Codex-config writes

### 1.1 Catalog file and pointer

| Artifact | Produced shape / behavior | Builder or writer | Evidence |
| --- | --- | --- | --- |
| Active catalog JSON | Existing root object is preserved and `catalog.models` is replaced; serialized as pretty JSON plus newline. Abstract type is `{ models?: Record<string, unknown>[]; [k: string]: unknown }`. | `prepareCatalog`; `writeRetainedCatalogSync`; `RawCatalog` | `src/codex/catalog/parsing.ts:135-137`; `src/codex/convergence.ts:211-326`; `src/codex/catalog/sync.ts:1485-1535` |
| Catalog target in Codex TOML | Root scalar `model_catalog_json = "<catalog path>"`; removed when no OpenCodex catalog is available. | `setRootModelCatalogPath`; call in `injectCodexConfig` | `src/codex/inject.ts:478-489,744-750` |
| Codex model cache | `{ fetched_at: "2000-01-01T00:00:00Z", client_version: "0.0.0", models: [...] }`, forcing stale reload while retaining hidden account observations. | `invalidateCodexModelsCacheWithPermit` | `src/codex/catalog/sync.ts:1717-1763` |

`src/codex/catalog.ts` is a 14-line barrel, not a builder. It re-exports the parsing, metadata, effort, and sync symbols (`src/codex/catalog.ts:1-14`).

### 1.2 Subagent-relevant catalog entry shape

`RawEntry` is deliberately open (`Record<string, unknown>`), so there is no single closed TypeScript interface for serialized rows (`src/codex/catalog/parsing.ts:135`). The following is the union/conditional subagent-relevant projection produced by `deriveEntry` + `ensureStrictCatalogFields` + `applyMultiAgentMode`; template-backed rows may preserve an existing value, while literal values below are the no-template or missing-field defaults:

```ts
{
  slug: string,                         // bare native, provider/model, or selector/native
  display_name: string,
  description: string,
  priority: number,                     // ascending; configured featured models receive the low band
  visibility: "list" | "hide",
  supported_in_api?: boolean,           // no-template fallback: true
  shell_type?: string,                  // no-template fallback: "shell_command"
  supported_reasoning_levels: Array<{
    effort: string,
    description: string
  }>,
  default_reasoning_level?: string,
  multi_agent_version?: "v1" | "v2" | null,

  // Routed rows:
  tool_mode?: "code_mode_only",
  supports_search_tool?: boolean,
  web_search_tool_type?: "text_and_image",

  // OpenCodex-private extensions ignored by Codex:
  opencodex_spawn_priority?: number,     // natural priority when display-only order moved the row
  opencodex_catalog_kind?: string,

  // Strict parser/default fields also written or healed:
  supports_reasoning_summaries: boolean,
  default_reasoning_summary: string,
  support_verbosity: boolean,
  default_verbosity: string,
  apply_patch_tool_type: string,
  truncation_policy: object,            // missing-field default: {mode:"tokens",limit:10000}
  supports_parallel_tool_calls: boolean,
  supports_image_detail_original: boolean,
  experimental_supported_tools: unknown[],
  input_modalities: Array<"text" | "image" | "audio">,
  context_window: number,
  max_context_window: number,
  effective_context_window_percent: number,
  auto_compact_token_limit: number,
  comp_hash: string
}
```

| Field/group | Exact production rule | Evidence |
| --- | --- | --- |
| Base routed row | With a native template, clones it, replaces `slug/display_name/description/priority`, sets `visibility="list"`, normalizes native-only fields, applies effort and metadata, then strict fields. Without a template, creates the fallback fields shown above. | `src/codex/catalog/sync.ts:260-376` `deriveEntry` |
| Strict fields | Missing parser booleans/defaults are filled; modalities are restricted to `text/image/audio`; context defaults to 128k for unknown rows. | `src/codex/catalog/parsing.ts:300-340` `ensureStrictCatalogFields` |
| Reasoning ladder | Routed reasoning-capable rows gain mock `max` and `ultra` unless `preserveExact`; `none`-only rows do not. Catalog objects are `{effort, description}`. | `src/codex/catalog/effort.ts:201-240` `applyReasoningLevels`; canonical descriptions `src/reasoning-effort.ts:4-12` |
| Native GPT-5.6 metadata | Loaded from `src/codex/data/upstream-models.json`; current snapshot pins Sol=`v2`, Terra=`v2`, Luna=`v1`, GPT-5.5=`null`. | loader `src/codex/catalog/metadata.ts:114-133,173-177`; literal rows `src/codex/data/upstream-models.json:4,21,118,135,230,247,338,355` |
| Featured roster priority | `featured` becomes a rank map; bare native rows receive rank directly; routed rows receive `rank * priorityStride`; account clones use `rank * selectorCount + selectorIndex`. This is how `subagentModels` affects Codex's advertised first five. | `src/codex/catalog/sync.ts:452-457,517-520,543-570,593-610` |
| Five-row model | OpenCodex's own effective roster takes visible rows, applies v2 compatibility, sorts by natural spawn priority, then `.slice(0, 5)`. | constant `src/codex/catalog/sync.ts:68`; `effectiveSubagentRoster` `src/codex/catalog/sync.ts:142-212` |
| Display-order decoupling | If `modelPickerOrder` moves a non-featured routed row, natural priority is saved as `opencodex_spawn_priority`, while only public `priority` is changed. | `src/codex/catalog/sync.ts:70-80,603-611` |
| Final multi-agent pass | Routed normalization first deletes inherited `multi_agent_version`; final `applyMultiAgentMode` then restores/pins/stamps it. | delete `src/codex/catalog/parsing.ts:398-404`; final build `src/codex/catalog/sync.ts:615-627`; final merge `src/codex/catalog/sync.ts:1084-1102` |

### 1.3 Three-state `multi_agent_version` output

Built by `applyMultiAgentMode(entries, mode, v2FeatureEnabled)` (`src/codex/catalog/parsing.ts:362-395`):

| OpenCodex `multiAgentMode` | Native `multi_agent_v2` flag | Serialized row result |
| --- | --- | --- |
| `"v1"` | either | Every entry receives `multi_agent_version = "v1"`. |
| `"v2"` | either | Every entry receives `multi_agent_version = "v2"`. |
| `"default"` / absent | off | Upstream snapshot pin is restored when present; otherwise the property is deleted. Current pins: Sol/Terra v2, Luna v1, others generally absent/null. |
| `"default"` / absent | on | Upstream snapshot pin is restored when present; otherwise the entry receives `multi_agent_version = "v2"`. A genuine v1 pin remains v1. |

The mode input is captured in both write paths: retained sync (`src/codex/catalog/sync.ts:1393-1429,1485-1511`) and evidence-bound convergence (`src/codex/convergence.ts:211-230,254-318`).

### 1.4 OpenCodex-owned JSON config that drives the catalog/runtime

| Key | Shape/default | Consumer | Evidence |
| --- | --- | --- | --- |
| `subagentModels` | `string[]`, documented max five; fresh default `['gpt-5.5','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','gpt-5.4-mini']`; explicit `[]` is retained. | catalog ranking and guidance roster | `src/types.ts:667-673`; `src/config.ts:1650-1659,3298-3300`; `src/codex/catalog/sync.ts:1390-1395` |
| `multiAgentMode` | `"v1" | "default" | "v2"`; fresh config omits it, equivalent to default. | final `multi_agent_version` pass and effort gate | `src/types.ts:821-827`; `src/codex/catalog/sync.ts:1396`; `src/server/effort-policy.ts:77-80` |
| `subagentModelFallback` | ordered `string[]` | global runtime fallback chain and optional injected guidance | `src/types.ts:688-693`; `src/codex/subagent-model-fallback.ts:116-145,548-553` |
| `subagentModelFallbackByModel` | `Record<string,string[]>` | per-primary fallback stage before global chain | `src/types.ts:694-704`; `src/config.ts:1294-1299`; `src/codex/subagent-model-fallback.ts:427-456` |
| `subagentModelFallbackPollMs` | number; runtime default 60,000 ms; invalid/<1000 falls back to default; API accepts 5,000–600,000. | quota prime/failure health TTL | `src/types.ts:705-708`; `src/codex/subagent-model-fallback.ts:46,99-105`; `src/server/management/agent-settings-routes.ts:669-686` |
| `injectionModel`, `injectionEffort`, `injectionPrompt` | optional strings | proxy-authored guidance; model/effort also feed optional native defaults | `src/types.ts:709-720,758-771`; `src/server/responses/core.ts:1137-1149`; `src/codex/inject.ts:140-155` |
| `multiAgentGuidanceEnabled` | optional boolean; effective default true; fresh config writes true. | suppresses both v1 and v2 OpenCodex-authored guidance when false | `src/types.ts:772-776`; `src/config.ts:3271-3274,3299-3300`; `src/server/responses/collaboration.ts:236-254` |
| `syncCodexSubagentDefaults` | optional boolean; effective only when true and `injectionModel` is nonblank; default off. | authorizes marker-owned native `[agents]` defaults | `src/types.ts:710-714`; `src/config.ts:2245-2249`; `src/codex/inject.ts:140-155` |
| `subagentEffortCap` | optional Codex ladder string | hard cap on header-marked child turns where v2 gate applies | `src/types.ts:783-790`; `src/server/effort-policy.ts:45-80` |

### 1.5 Codex `config.toml` shapes OpenCodex can write

#### Marker-owned native defaults

Built by `configuredManagedSubagentDefaults` and `transformManagedSubagentDefaults` (`src/codex/inject.ts:140-155,778-807`; `src/codex/subagent-defaults.ts:398-550`):

```toml
# Managed by opencodex: native subagent defaults table
[agents]
# Managed by opencodex: native subagent default
default_subagent_model = "<trimmed injectionModel>"
# Managed by opencodex: native subagent default
default_subagent_reasoning_effort = "<trimmed injectionEffort>" # omitted when unset
```

This write occurs only when `syncCodexSubagentDefaults === true`, `injectionModel` is nonblank, and OpenCodex owns active Codex routing. Unmarked user values are conflicts and are not overwritten (`src/codex/subagent-defaults.ts:461-473`; ownership gates `src/codex/inject.ts:664-686,778-807`).

#### Native agent/v2 settings

The `/api/v2` and `ocx v2` surfaces can produce the following keys:

```toml
[agents]
enabled = true | false
max_depth = <signed-i32>              # v1-only semantics
max_threads = <integer >= 1>          # v1 storage; removed while v2 is active

[features.multi_agent_v2]
enabled = true | false                # flag toggle itself is delegated to `codex features`
max_concurrent_threads_per_session = <integer >= 1>  # v2 total includes root
subagent_developer_instructions = "<string>"
multi_agent_mode_hint_text = "<nonblank string>"
```

Equivalent `[features] multi_agent_v2 = true|false|{...}` encodings are read and safely upgraded/edited (`src/codex/features.ts:121-178,352-413,883-1003`). Exact writers are `setAgentsEnabled` (`:749-758`), `setAgentsMaxDepth` (`:760-778`), `setMaxConcurrentThreads` (`:351-413`), `setSubagentDeveloperInstructions` (`:1006-1008`), `setMultiAgentModeHintText` (`:1010-1037`), and `transitionMultiAgentV2` (`:1426-1507`).

OpenCodex **does not currently write** `model_fallback` into `$CODEX_HOME/agents/*.toml`. It only reads legacy role files for compatibility and explicitly places supported per-primary metadata in `subagentModelFallbackByModel` because newer Codex rejects the unknown role field (`src/types.ts:694-704`; `src/codex/subagent-model-fallback.ts:427-456,703-769`).

## 2. v1/v2, `leaf`, and `spawn_agent` awareness

### 2.1 Behavioral awareness

| Mechanism | Current behavior | Evidence |
| --- | --- | --- |
| Catalog mode | Explicit `MultiAgentMode = "v1" | "default" | "v2"`, persisted as `OcxConfig.multiAgentMode`. | `src/codex/catalog/parsing.ts:342`; `src/types.ts:821-827` |
| Native feature | Parses dedicated-table, boolean, and inline `multi_agent_v2`; toggles through native Codex CLI. | `src/codex/features.ts:121-178`; `src/cli/v2.ts:43-86,212-227` |
| Tool-shape detection | Namespaced `spawn_agent` or v1-only companions (`send_input/resume_agent/close_agent`) => v1; flat `spawn_agent` or v2-only companions (`send_message/followup_task/interrupt_agent/list_agents`) => v2; contradictory/no-spawn => null. | `src/server/responses/collaboration.ts:152-179` `collabSurface` |
| Leaf child recognition | Child effort caps do not require collab tools, because depth-limited leaves can have no collaboration tools; exact spawn headers still identify the child. | `src/server/effort-policy.ts:57-80` |
| V2 roster eligibility | OpenCodex treats `multi_agent_version` `v2`, null, or absent as eligible; explicit v1 is excluded. | `src/codex/catalog/sync.ts:90-108` `isEligibleV2SubagentEntry` |
| Prompt inventory | Models `multi-agent-mode` as a feature-gated prompt layer keyed by `features.multi_agent_v2.enabled`; this module inventories it but does not generate runtime guidance. | `src/codex/prompt-layers.ts:87-103` |

### 2.2 Exact tracked `src/` literal-hit index

This is the exact grouped output of source-only `git grep`; line lists include comments, API DTO fields, and barrel/plumbing imports as well as executable references.

#### `multi_agent`

| File | Lines |
| --- | --- |
| `src/cli/help.ts` | 45 |
| `src/cli/registry.ts` | 313, 316 |
| `src/cli/v2.ts` | 2, 43, 66, 91, 92, 97, 98, 99, 121, 125, 127, 144, 145, 160, 161, 167, 215, 219 |
| `src/codex/catalog/metadata.ts` | 175 |
| `src/codex/catalog/parsing.ts` | 352, 355, 364, 381, 383, 385, 387, 393, 402 |
| `src/codex/catalog/sync.ts` | 93, 106 |
| `src/codex/data/upstream-models.json` | 21, 135, 247, 355, 461, 562, 658, 754 |
| `src/codex/features.ts` | 6, 24, 121, 123, 124, 125, 133, 152, 154, 158, 162, 170, 172, 228, 229, 261, 262, 294, 300, 302, 328, 352, 367, 371, 376, 377, 381, 392, 396, 695, 781, 783, 794, 802, 813, 877, 879, 883, 903, 904, 906, 909, 912, 922, 926, 946, 950, 985, 988, 994, 1001, 1011, 1014, 1020, 1036, 1054, 1082, 1245, 1264, 1272, 1283, 1289, 1343, 1346, 1398, 1401, 1408, 1410, 1412, 1413, 1419, 1427, 1477, 1489 |
| `src/codex/prompt-layers.ts` | 7, 102 |
| `src/server/effort-policy.ts` | 6 |
| `src/server/management/agent-settings-routes.ts` | 218, 290, 327, 362, 365 |
| `src/server/responses/collaboration.ts` | 346, 365, 372, 461, 464 |
| `src/types.ts` | 760 |

#### `multiAgent`

| File | Lines |
| --- | --- |
| `src/cli/agent.ts` | 66 |
| `src/cli/v2.ts` | 95, 112, 193, 194, 203 |
| `src/codex/catalog/sync.ts` | 387, 392, 407, 422, 427, 442, 447, 627, 734, 735, 764, 765, 1089, 1090, 1116, 1155, 1156, 1396, 1421, 1429, 1434, 1474, 1479, 1498, 1499 |
| `src/codex/convergence.ts` | 48, 181, 205, 216, 229, 230, 261, 266, 276, 281, 306, 307, 394 |
| `src/codex/features.ts` | 130, 134 |
| `src/config.ts` | 1284, 3271, 3272, 3274, 3300 |
| `src/server/effort-policy.ts` | 63, 78 |
| `src/server/index.ts` | 970 |
| `src/server/management-api.ts` | 10 |
| `src/server/management/agent-settings-routes.ts` | 11, 234, 238, 248, 252, 257, 261, 263, 266, 267, 291, 292, 293, 295, 298, 309, 312, 331, 332, 347, 375, 379, 458, 477, 485, 493, 494, 495, 497, 535, 548 |
| `src/server/management/combo-routes.ts` | 10 |
| `src/server/management/config-routes.ts` | 10 |
| `src/server/management/logs-usage-routes.ts` | 10 |
| `src/server/management/model-routes.ts` | 81 |
| `src/server/management/oauth-account-routes.ts` | 10 |
| `src/server/management/provider-routes.ts` | 12 |
| `src/server/management/shared.ts` | 10 |
| `src/server/responses.ts` | 6 |
| `src/server/responses/collaboration.ts` | 5, 184, 236, 241 |
| `src/server/responses/compact.ts` | 5 |
| `src/server/responses/core.ts` | 8, 213, 1138, 1139, 1150 |
| `src/server/responses/encrypted-payload.ts` | 5 |
| `src/server/responses/fetch-helpers.ts` | 11 |
| `src/types.ts` | 776, 827 |

Many line-10-style management/response hits are imports from barrel modules, not separate behavior owners.

#### `agents.max_threads` and `max_concurrent_threads_per_session`

| Token | Exact `src/` hits |
| --- | --- |
| `agents.max_threads` | `src/codex/features.ts:228,1417`; `src/server/management/agent-settings-routes.ts:218` |
| `max_concurrent_threads_per_session` | `src/cli/registry.ts:318`; `src/cli/v2.ts:127,167`; `src/codex/features.ts:24,294,303,304,352,359,381,387,390,391,402,407,411,1251,1267,1269,1270,1289,1344,1347,1412,1420` |

#### whole-word `leaf`

There are 23 tracked `src/` whole-word hits. Only `src/server/effort-policy.ts:68` is a multi-agent semantic hit (“leaf guard”). The rest use “leaf” for JSON/config path segments or module-architecture descriptions:

| File | Lines |
| --- | --- |
| `src/cli/config-command.ts` | 56, 57, 58, 59 |
| `src/codex/injected-marker.ts` | 5 |
| `src/config.ts` | 3091, 3099, 3176 |
| `src/integrations/merge.ts` | 65, 66, 67 |
| `src/integrations/omp-yaml-source.ts` | 6, 111, 295 |
| `src/integrations/registry.ts` | 45 |
| `src/integrations/state.ts` | 62, 65, 140, 166 |
| `src/integrations/writer.ts` | 393 |
| `src/lib/upstream-reachability.ts` | 23 |
| `src/lib/upstream-retry.ts` | 14 |
| `src/server/effort-policy.ts` | 68 |

#### `spawn_agent`

| File | Exact lines |
| --- | --- |
| `src/codex/catalog/effort.ts` | 211 |
| `src/codex/catalog/parsing.ts` | 354 |
| `src/codex/catalog/provider-fetch.ts` | 1833 |
| `src/codex/catalog/sync.ts` | 72, 76, 79, 453, 458, 462, 476, 563, 596, 603 |
| `src/config.ts` | 1652 |
| `src/server/effort-policy.ts` | 5 |
| `src/server/management/agent-settings-routes.ts` | 442, 584 |
| `src/server/responses/collaboration.ts` | 164, 173, 259, 270, 349 |
| `src/types.ts` | 676, 683, 716 |

## 3. Quota-aware subagent model fallback

### 3.1 Trigger and call path

| Stage | Exact behavior | Evidence |
| --- | --- | --- |
| Spawn classification | True only when `x-openai-subagent` is exactly `collab_spawn`, or parsed `x-codex-turn-metadata.subagent_kind` is exactly `thread_spawn`; malformed JSON and other subagent categories are false. | `src/server/effort-policy.ts:20-43` `isThreadSpawnRequest` |
| Entry point | `handleResponses` computes `threadSpawn`; exact account selectors skip pool-wide priming/fallback. Non-combo, non-fixed-account spawned turns run quota priming, preview account selection, then fallback before route-dependent normalization. | `src/server/responses/core.ts:1722-1784` |
| Encrypted assignment | Initial fallback can be restricted to canonical native ChatGPT routes while task ciphertext is unreadable; after recovery, selection reruns with the full configured chain. | `src/server/responses/core.ts:1768-1776,1853-1875`; `src/codex/subagent-model-fallback.ts:275-288` |
| Main turn | No spawn headers => `applySubagentModelFallback` returns null without inspecting chains. | `src/codex/subagent-model-fallback.ts:510-520` |

### 3.2 Chain order and availability

For a primary model `P`, the effective order is:

```text
P
→ config.subagentModelFallbackByModel[P]
→ config.subagentModelFallback
→ legacy $CODEX_HOME/agents/*.toml model_fallback values for roles whose model matches P
```

The chain trims empties and de-duplicates; ordinary model ids are case-insensitive for de-duplication, while configured account-selector prefixes remain case-sensitive (`src/codex/subagent-model-fallback.ts:107-145,396-456,510-539`).

| Candidate rejection | Rule | Evidence |
| --- | --- | --- |
| Disabled | Matches `disabledModels`, including bare native, provider/model, and selector-qualified semantics. | `src/codex/subagent-model-fallback.ts:80-97` |
| Unroutable/disabled provider | Route fails, provider is disabled, or an unknown slash prefix is neither configured nor a known registry provider id. | `src/codex/subagent-model-fallback.ts:63-69,184-198,241-245` |
| Cached health block | Quota/rate-limit failures mark `(account when pool-scoped, model)` unavailable until poll TTL. | `src/codex/subagent-model-fallback.ts:216-232,298-322` |
| Pool account unavailable | No resolved account, paused, unusable/reauth-required, fixed-account model cooldown, or account cooldown without a probe lease. | `src/codex/subagent-model-fallback.ts:246-266` |
| Quota threshold | Known usage score at/above `autoSwitchThreshold` (default 80) rejects; unknown usage does not. | `src/codex/subagent-model-fallback.ts:147-150,200-214` |
| Encrypted native-only pass | Rejects candidates whose resolved provider is not canonical OpenAI Codex forward. | `src/codex/subagent-model-fallback.ts:275-288` |

The first available candidate wins. If every candidate is skipped, the original primary is retained and the skipped list is returned (`src/codex/subagent-model-fallback.ts:269-296`).

### 3.3 Priming, failure feedback, and rewrite shape

| Mechanism | Current behavior | Evidence |
| --- | --- | --- |
| Quota priming | Single-flight best-effort `primeCodexPoolQuotas(config, "subagent-spawn")`; success cached for poll interval; blocked when native-main reads are forbidden or ChatGPT host circuit is open; failures are swallowed and remain retryable. | `src/codex/subagent-model-fallback.ts:421-496,780-784` |
| Failure feedback | On spawned-child failures classified as quota/rate-limit (including 429/402 paths), selected model is health-blocked for poll TTL. | `src/codex/subagent-model-fallback.ts:298-322,498-508`; call sites `src/server/responses/core.ts:2555-2562,2724-2731,2805-2812,3761-3770` |
| Rewrite | Mutates `parsed.modelId` and `_rawBody.model`; does not rewrite effort. | `src/codex/subagent-model-fallback.ts:357-362,543-545`; documented SOT `structure/03_catalog-and-subagents.md:231-234` |
| Guidance | Global fallback list can be rendered into v2 OpenCodex guidance; it does not perform selection itself. | `src/codex/subagent-model-fallback.ts:548-553`; `src/server/responses/collaboration.ts:339-360` |
| Account selection dependency | Uses `previewCodexAccountForRequest` / quota-health helpers from `src/codex/routing.ts`; routing itself does not define multi-agent surfaces. | preview SOT comment `src/codex/routing.ts:1373-1379`; call `src/server/responses/core.ts:1757-1767` |

## 4. Test coverage in `tests/*.test.ts`

The table lists direct behavioral suites, not files with incidental words in unrelated fixtures.

| File | Covered scenarios (test-name evidence) |
| --- | --- |
| `tests/codex-v2-gate.test.ts` | native/route ultra ladders (`:100-139`); feature TOML readers (`:140-298`); v2 thread reader/writer (`:299-387`); mode-hint read/write/capability probe (`:388-769`); v1/v2 thread-limit migration and root-slot translation (`:770-980`); `[agents]` and subagent-instruction parity (`:981-1191`); management and CLI v2 surfaces (`:1192-1741`); three-state catalog mode and stale-pin restoration (`:1781-1986`). |
| `tests/codex-catalog.test.ts` | pinned GPT-5.6 exact per-slug specs (`:2610-2669`); snapshot upgrades and priority preservation (`:2995-3048`); catalog effort normalization and model metadata throughout the larger catalog suite. |
| `tests/codex-catalog-model-picker-order.test.ts` | display ordering does not displace or change spawn candidates, including all-routed reverse ordering (`:52-184`). |
| `tests/native-alias-maintainer-regressions.test.ts` | native aliases retain upstream multi-agent pins in default mode (`:106-121`). |
| `tests/multi-agent-compat.test.ts` | v1/v2 tool-shape classification; v1 top-tier guidance; v2 catalog-freshness gate; candidate/advertised roster intersection, account projection, five-item cap, visibility/version exclusions; injection/fallback placeholders; guidance kill switch; developer-message placement (`:97-1104`). |
| `tests/effort-policy.test.ts` | exact child-header detection (`:54-83`); child/global caps; v2 gating including tool-less leaf children and forced-v1 kill switch (`:319-421`); `/api/effort-caps` (`:442-487`). |
| `tests/subagent-defaults.test.ts` | marker-owned `[agents]` create/update/remove; escaping and CRLF; user-owned conflicts; ambiguous TOML rejection; table ownership (`:12-380`). |
| `tests/codex-inject-integration.test.ts` | opt-in native defaults, removal/restore, user-owned conflict, residue cleanup, ambiguous-marker refusal, and proof injection does not enable v2 (`:222-342,577-585`). |
| `tests/injection-model-api.test.ts` | model/effort/prompt round trips; invalid input no-mutation; guidance kill switch partial updates; native-default opt-in/model binding/normalization; persistence across catalog sync/reload (`:45-415`). |
| `tests/subagent-model-fallback.test.ts` | chain ordering/dedup; quota/account/health/disabled/routability filters; native-only encrypted selection; priming TTL/single-flight/failure; request rewrite vs main no-op; config-keyed and legacy TOML per-role chains; malformed/quoted TOML; guidance text (`:121-1170`). |
| `tests/subagent-model-fallback-api.test.ts` | atomic validation: invalid/empty entry leaves prior config intact; valid chain accepted (`:50-96`). |
| `tests/subagent-fallback-handle-responses.test.ts` | exact-account bypass; cooled primary; final-route normalization; native↔routed fallback; account preview; encrypted native-only behavior; terminal 429/402 health recording (`:201-1003`). |
| `tests/agent-task-recovery-fallback.test.ts` | recovered encrypted task routes through healthy routed fallback (`:17-66`). |
| `tests/cli-headless-parity.test.ts` | headless `ocx agent effort` and `ocx agent subagents` use the same live routes as GUI (`:314-323`). |
| `tests/codex-sync-api.test.ts` | native-default conflict warnings propagate through sync (`:375-415`) and preflight/refusal protects catalog/config (`:126-229`). |
| `tests/native-model-toggle.test.ts` | `/api/subagent-models.available` removes disabled native slugs (`:471-533`). |

Related GUI tests live under `gui/tests/`, outside the requested `tests/*.test.ts` glob: `subagents-classic.test.tsx`, `subagents-busy-race.test.tsx`, `subagents-ultra-mode.test.tsx`, and `multi-agent-guidance.test.tsx` cover the Subagents workspace, save-race guard, Ultra mode, and guidance toggle.

## 5. User configuration surfaces

### 5.1 CLI

| Command | Payload / effect | Evidence |
| --- | --- | --- |
| `ocx agent status [--json]` | GETs `/api/v2`, `/api/injection-model`, `/api/effort-caps`, `/api/subagent-models`, `/api/subagent-model-fallback`, and sidecars. | `src/cli/agent.ts:30-44` |
| `ocx agent subagents status|set|clear` | GET/PUT `/api/subagent-models`; set takes comma-separated ids; CLI rejects >5. Alias: `roster`. | `src/cli/agent.ts:94-115,171-180` |
| `ocx agent fallback status|set|clear [models] [--poll-ms]` | GET/PUT `/api/subagent-model-fallback`; API range 5,000–600,000 ms. | `src/cli/agent.ts:117-142` |
| `ocx agent injection status|set --model --effort --prompt --guidance` | GET/PUT `/api/injection-model`; `-` clears string selections. Alias: `guidance`. The CLI does **not** expose `syncCodexSubagentDefaults`; GUI/API/config do. | `src/cli/agent.ts:46-70,171-180` |
| `ocx agent effort status|set --main --subagent` | GET/PUT `/api/effort-caps`. | `src/cli/agent.ts:72-92` |
| `ocx v2 status|on|off|mode v1|default|v2|threads N|mode-hint ...` | Reads/toggles native v2, migrates thread limit, persists catalog mode, resyncs catalog, edits mode hint. | `src/cli/v2.ts:89-230` |

Exact account-qualified roster ids, which the GUI does not offer, are intentionally available through `ocx agent subagents set` or direct config (`structure/03_catalog-and-subagents.md:220-229`).

### 5.2 Management API

| Route | GET shape | PUT shape/effect | Evidence |
| --- | --- | --- | --- |
| `/api/subagent-models` | `{ chosen, available, catalogState }` | `{models}` → string values sliced to first five, persists `subagentModels`, converges catalog, syncs Claude defs/Desktop best-effort; response `{ok, applied, catalogRefresh}`. | `src/server/management/agent-settings-routes.ts:584-618` |
| `/api/subagent-model-fallback` | `{ models, pollMs, available }` | optional `{models, pollMs}` with full validation; persists global chain/poll interval. | `src/server/management/agent-settings-routes.ts:620-687` |
| `/api/injection-model` | `{multiAgentGuidanceEnabled,syncCodexSubagentDefaults,model,effort,prompt,efforts,available}` | partial patch of those settings; clearing model also clears effort and native-default sync. | `src/server/management/agent-settings-routes.ts:440-554` |
| `/api/effort-caps` | `{effortCap,subagentEffortCap,efforts}` | partial set/clear of main/global and child-only caps. | `src/server/management/agent-settings-routes.ts:556-582` |
| `/api/v2` | `{enabled,agentsMaxThreadsConflict,maxConcurrentThreadsPerSession,multiAgentMode,agentsEnabled,agentsMaxDepth,subagentDeveloperInstructions,multiAgentModeHintText,agentsMaxDepthAppliesWhenV2Disabled}` | partial flag/mode/thread/agent-depth/instruction/hint write, catalog convergence, warnings. | `src/server/management/agent-settings-routes.ts:218-383` |

### 5.3 GUI

| Panel/control | Endpoint | Exact behavior | Evidence |
| --- | --- | --- | --- |
| Subagents page — Featured roster | `/api/subagent-models` | Loads available/chosen, lets user toggle and reorder up to `FEATURED_MAX=5`, PUTs `{models: chosen}`. | `gui/src/pages/Subagents.tsx:116-176`; `gui/src/components/subagents-workspace/SubagentsWorkspace.tsx:56-71,88-149,152-213` |
| Subagents page — preferred model/effort | `/api/injection-model` | Selects `injectionModel` and `injectionEffort`. | `gui/src/pages/use-subagent-delegation.ts:42-92`; `gui/src/components/subagents-workspace/SubagentDelegationSection.tsx:66-97` |
| Subagents page — native defaults toggle | `/api/injection-model` | Toggles `syncCodexSubagentDefaults`; disabled when no model is selected. | `gui/src/components/subagents-workspace/SubagentDelegationSection.tsx:99-114` |
| Subagents page — guidance toggle | `/api/injection-model` | Toggles `multiAgentGuidanceEnabled`. | `gui/src/components/subagents-workspace/SubagentDelegationSection.tsx:116-131` |
| Subagents page — Ultra mode/hint | `/api/v2` | Writes/clears `multiAgentModeHintText`; enabling is allowed only when native v2 is enabled and catalog mode is explicitly v2. | `gui/src/pages/Subagents.tsx:28-99`; `gui/src/components/subagents-workspace/SubagentDelegationSection.tsx:133-169,227-229` |
| Models page — surface mode | `/api/v2` | Segmented `multiAgentMode` control for v1/default/v2. | `gui/src/pages/Models.tsx:776-793,1268-1281` |

There is **no GUI control for `subagentModelFallback`** in tracked `gui/src` (zero `subagent-model-fallback` hits). It is exposed through CLI, management API, and direct OpenCodex config.

### 5.4 Direct files users can edit

| File | User-owned surface | OpenCodex behavior |
| --- | --- | --- |
| OpenCodex `config.json` | all `OcxConfig` keys above | loaded/preserved by `src/config.ts`; drives catalog/runtime |
| `$CODEX_HOME/config.toml` | `[agents]`, `[features.multi_agent_v2]`, root catalog pointer | OpenCodex uses scoped, format-preserving writers; marker-owned native defaults never overwrite unmarked user keys |
| `$CODEX_HOME/agents/*.toml` | role `model`; legacy `model_fallback` may exist | fallback reads matching roles; does not write `model_fallback` |

## 6. Production module inventory

| Module | Role in this surface | Writes? | Evidence |
| --- | --- | --- | --- |
| `src/codex/catalog.ts` | Barrel exporting catalog parsing/metadata/effort/sync APIs. | No direct write | `:1-14` |
| `src/codex/catalog/parsing.ts` | Defines open catalog types, strict row shape, routed normalization, three-state `multi_agent_version`. | Mutates candidate rows | `:94-137,300-404` |
| `src/codex/catalog/effort.ts` | Builds/reads `supported_reasoning_levels`; adds mock top rungs; clamps against observed Codex support. | Mutates candidate rows | `:84-113,201-274,309-384` |
| `src/codex/catalog/metadata.ts` | Loads pinned upstream native rows and exposes native multi-agent pins/ladders/context. | No file write in relevant path | `:102-177` |
| `src/codex/catalog/sync.ts` | Builds rows, ranks featured models, computes effective five-model roster, merges/writes catalog and cache. | Yes | `:68-212,401-627,751-1168,1355-1535,1717-1763` |
| `src/codex/convergence.ts` | Evidence-bound alternative catalog gather/prepare/commit path; consumes same featured/mode/v2 inputs and same builders. | Yes | `:172-208,211-326,524-577` |
| `src/codex/sync.ts` | Orchestrates refresh before Codex config injection; forwards native-default warnings and desired-state skips. | Through dependencies | `:60-216` |
| `src/codex/subagent-defaults.ts` | Pure marker-aware TOML transform for native default model/effort. | Returns candidate content; caller writes | `:1-41,398-550` |
| `src/codex/features.ts` | Reads/writes native v1/v2 flag-adjacent config, threads, agent keys, subagent instructions, mode hint; migrates thread units. | Yes | `:121-178,226-413,749-1037,1205-1507` |
| `src/codex/subagent-model-fallback.ts` | Builds chain, checks availability/quota/health, primes quota, reads legacy role metadata, rewrites spawned-child model. | Runtime request mutation; no catalog/config write | `:1-145,200-322,357-545,703-784` |
| `src/codex/routing.ts` | Supplies effective account, quota health, cooldown, and side-effect-free preview used by fallback. It does not select v1/v2. | Runtime state only | `:673-719,1361-1467` |
| `src/codex/prompt-layers.ts` | Inventories Codex prompt layers including v2 multi-agent mode; owns generic prompt toggles/projection, not delegation guidance. | Generic prompt config writes elsewhere in module | `:1-27,87-117,384-460` |
| `src/server/responses/collaboration.ts` | Detects v1/v2 tool surface, computes effective roster/guidance, injects fallback text. | Returns guidance | `:144-191,216-373` |
| `src/server/responses/core.ts` | Calls guidance and effort policy; primes/applies fallback before final routing; records quota failures. | Mutates proxied request | `:1137-1160,1722-1784,2535-2563,3761-3770` |
| `src/server/effort-policy.ts` | Exact spawned-child header predicate and v2-only/global/subagent effort cap policy, including tool-less leaves. | Mutates request effort through `applyEffortCap` | `:20-80,106-190` |
| `src/server/management/agent-settings-routes.ts` | Owns all listed management routes and persistence/convergence calls. | Yes | `:218-383,440-687` |
| `src/reasoning-effort.ts` | Canonical low→ultra ladder and configured ladder sanitation used by catalog/API/caps. | No | `:4-43,68-111` |
| `src/providers/openai-tiers.ts` | Migrates legacy `openai-multi/` ids in `subagentModels` and `injectionModel` to current bare identity. | Mutates migration projection/config | `:111-120,172-197` |
| `src/config.ts` / `src/types.ts` | Defines persisted OpenCodex fields, defaults, validation/degradation, and effective flags. | OpenCodex config writer elsewhere in file | `src/types.ts:667-720,758-790,821-827`; `src/config.ts:1284-1299,1650-1659,2047-2114,2245-2249,3271-3304` |
| `src/cli/agent.ts` | Headless API client for roster, fallback, injection/guidance, and effort caps. | Via management API | `:16-24,30-142,171-184` |
| `src/cli/v2.ts` | Native v2 flag/mode/thread/hint CLI and catalog resync. | Yes | `:89-230` |
| `structure/03_catalog-and-subagents.md` | Repository SOT matching current catalog, three-state mode, first-five roster, fallback, and native defaults. | Documentation | `:82-96,133-153,218-243` |
| `structure/08_openai-provider-tiers.md` | Identity/migration SOT: legacy selected ids rewrite; Pool/Direct does not alter bare catalog ids; selected virtual ids remain in subagent state. | Documentation | `:69-89,108-122` |

## Inventory boundary

- Catalog generation and request-time collaboration are separate: the catalog controls what Codex sees/validates; `collaboration.ts` only adds OpenCodex-authored developer guidance.
- Fallback is request-time and header-gated; it does not change the configured roster or catalog.
- `modelPickerOrder` is display-only by design; `subagentModels` is the spawn-candidate ranking input.
- Native default synchronization is opt-in and independent of guidance enablement.
- No claim in this report is based on an unverified external page or search snippet.
