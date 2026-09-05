# 070 — S02 providers L4/4

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: **pure-move**. Classification: C3 architecture planning, docs-only bounded delegation. cxc-dev §1/§5 and cxc-dev-architecture determine size, compatibility and state ownership; parent owns loop/goal/orchestration.
- Goal: finish ordered registry entry extraction, preserving every historical export and observable behavior of `src/providers/registry.ts`.
- Non-goals: no model refresh, endpoint/auth-policy changes, validation redesign, caching, new runtime dependency, bug fix, generated metadata rewrite, repository-wide local test, merge, release or deployment. Existing behavior stays literal, including comments explaining it.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below. Current task verifies documentation only, not runtime correctness.
- Stop: this plan is complete when the inventory, ownership, exact wiring, test disposition and count ledger are consistent; execution stops only after its own tip passes the instantiated gate and records exact-head CI. Do not defer a failing layer upward.
- Escalation: execution is conditional: 3,250 → ≤400 requires removing at least 2,850 original lines; three registry layers capped at 500 cannot remove that much even if additions are free. Ask the parent to explicitly waive the per-layer move-volume cap or expand 002; do not assert these three layers meet it. Also obtain authorization for the one FastWire type-import edit in L3 and disposition the pre-existing Antigravity type cycle under the strict cycle rule.

Structural decision: the 3,250-line module combines contracts, private model metadata, ordered provider rows and lookup policy. Move the lowest-fan-in private model groups first, then contracts plus entry chunks, retaining the public facade and its lookup/validation code. Rejected alternatives: doing nothing/configuring cannot meet the line limit; deleting declarations would change behavior; changing all consumer imports would widen churn; a new provider framework or generic utils barrel is unnecessary. Existing `src/types.ts → src/types/*`, `src/config/*.ts`, and `src/codex/catalog.ts → src/codex/catalog/*` establish kebab-case co-located leaf convention. Keep legacy facades as explicit compatibility boundaries; no new index.ts or export-star barrel.

## Symbol inventory

Basis: `origin/dev` = `1362b1a3841b4de20177e5d65865a513dd7936c4`; docs HEAD `4cc219549`. Every range in this document is an original-source line range, not the intermediate branch's shifted coordinates. `git diff origin/dev -- src/providers/registry.ts` was empty.

Ranges were measured with `sg run --lang typescript --kind <kind> --json=compact src/providers/registry.ts`, taking column-zero export/lexical/function/interface/type-alias/class declarations. Imports are listed separately below; the inventory does not confuse nested declarations with ESM state.

Consumer count = distinct `rg -l -w '<symbol>'` files among resolved static/dynamic importers of this exact module under `src gui/src scripts tests` (`*.ts`/`*.tsx`), excluding the defining file. This is textual fan-in within the importer set, not call frequency. Private symbols have zero external import consumers; coincident names/comments elsewhere are excluded. Importer discovery starts with `rg -l 'registry' src gui/src scripts tests` and resolves each relative specifier, so other registries do not count.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `ProviderAuthKind` | type | 25–25 | yes | 1 | registry/contracts.ts (L3) |
| `MetadataModelIdNormalize` | type | 26–26 | yes | 0 | registry/contracts.ts (L3) |
| `InboundWire` | type | 33–33 | yes | 7 | registry/contracts.ts (L3) |
| `ModelWireDefault` | type | 39–45 | yes | 2 | registry/contracts.ts (L3) |
| `ResponsesTerminalRepairPolicy` | interface | 47–50 | yes | 2 | registry/contracts.ts (L3) |
| `ProviderModelDiscoveryScalar` | type | 52–52 | yes | 1 | registry/contracts.ts (L3) |
| `ProviderModelDiscoveryPredicate` | type | 54–74 | yes | 1 | registry/contracts.ts (L3) |
| `ProviderModelDiscoveryFilter` | interface | 76–83 | yes | 2 | registry/contracts.ts (L3) |
| `ProviderModelDiscoverySharedSpec` | interface | 85–99 | no | 0 | registry/contracts.ts (L3) |
| `ProviderModelDiscoveryLocation` | type | 101–116 | no | 0 | registry/contracts.ts (L3) |
| `ProviderModelDiscoverySpec` | type | 122–122 | yes | 4 | registry/contracts.ts (L3) |
| `ProviderRegistryEntry` | interface | 124–330 | yes | 6 | registry/contracts.ts (L3) |
| `ProviderConfigSeed` | type | 332–342 | yes | 0 | registry/contracts.ts (L3) |
| `ANTHROPIC_MODELS` | const | 350–350 | no | 0 | registry/frontier-models.ts (L2) |
| `ANTHROPIC_MODEL_CONTEXT_WINDOWS` | const | 351–351 | no | 0 | registry/frontier-models.ts (L2) |
| `ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS` | const | 355–355 | no | 0 | registry/frontier-models.ts (L2) |
| `ANTHROPIC_REASONING_EFFORTS` | const | 380–380 | no | 0 | registry/frontier-models.ts (L2) |
| `ANTHROPIC_MODEL_REASONING_EFFORTS` | const | 381–383 | no | 0 | registry/frontier-models.ts (L2) |
| `ZAI_GLM_53_MODELS` | const | 399–399 | no | 0 | registry/frontier-models.ts (L2) |
| `ZAI_GLM_52_MODELS` | const | 400–400 | no | 0 | registry/frontier-models.ts (L2) |
| `ZAI_GLM_5X_MODELS` | const | 401–401 | no | 0 | registry/frontier-models.ts (L2) |
| `ZAI_GLM_5X_SIDECAR_VISION_MODELS` | const | 416–416 | no | 0 | registry/frontier-models.ts (L2) |
| `ZAI_GLM_52_REASONING_EFFORTS` | const | 417–417 | no | 0 | registry/frontier-models.ts (L2) |
| `ZAI_GLM_53_REASONING_EFFORTS` | const | 425–425 | no | 0 | registry/frontier-models.ts (L2) |
| `ZAI_GLM_5X_REASONING_EFFORTS` | const | 427–430 | no | 0 | registry/frontier-models.ts (L2) |
| `MINIMAX_MODELS` | const | 433–439 | no | 0 | registry/frontier-models.ts (L2) |
| `MINIMAX_MODEL_CONTEXT_WINDOWS` | const | 440–442 | no | 0 | registry/frontier-models.ts (L2) |
| `MINIMAX_M3_REASONING_EFFORTS` | const | 443–443 | no | 0 | registry/frontier-models.ts (L2) |
| `MINIMAX_M3_REASONING_EFFORT_MAP` | const | 444–452 | no | 0 | registry/frontier-models.ts (L2) |
| `OPENAI_GPT56_MODELS` | const | 453–453 | no | 0 | registry/frontier-models.ts (L2) |
| `OPENAI_GPT56_PRO_MODELS` | const | 454–454 | no | 0 | registry/frontier-models.ts (L2) |
| `OPENAI_API_GPT56_CONTEXT_WINDOW` | const | 455–455 | no | 0 | registry/frontier-models.ts (L2) |
| `OPENAI_API_GPT56_CONTEXT_WINDOWS` | const | 456–459 | no | 0 | registry/frontier-models.ts (L2) |
| `OPENAI_API_GPT56_MAX_INPUT_TOKENS` | const | 460–463 | no | 0 | registry/frontier-models.ts (L2) |
| `OPENAI_API_GPT56_VIRTUAL_MODELS` | const | 464–468 | no | 0 | registry/frontier-models.ts (L2) |
| `OPENAI_API_GPT56_REASONING_EFFORTS` | const | 469–469 | no | 0 | registry/frontier-models.ts (L2) |
| `META_MUSE_REASONING_EFFORTS` | const | 482–482 | no | 0 | registry/frontier-models.ts (L2) |
| `META_MUSE_REASONING_EFFORT_MAP` | const | 490–492 | no | 0 | registry/frontier-models.ts (L2) |
| `META_MUSE_CONTEXT_WINDOW` | const | 494–494 | no | 0 | registry/frontier-models.ts (L2) |
| `META_MUSE_MODELS` | const | 495–495 | no | 0 | registry/frontier-models.ts (L2) |
| `OPENAI_DAYBREAK_MODELS` | const | 507–507 | no | 0 | registry/frontier-models.ts (L2) |
| `OPENAI_DAYBREAK_CONTEXT_WINDOWS` | const | 508–511 | no | 0 | registry/frontier-models.ts (L2) |
| `OPENAI_DAYBREAK_MAX_INPUT_TOKENS` | const | 512–515 | no | 0 | registry/frontier-models.ts (L2) |
| `OPENAI_DAYBREAK_REASONING_EFFORTS` | const | 524–526 | no | 0 | registry/frontier-models.ts (L2) |
| `OPENROUTER_GPT56_MODELS` | const | 527–527 | no | 0 | registry/frontier-models.ts (L2) |
| `XAI_MODELS` | const | 528–537 | no | 0 | registry/frontier-models.ts (L2) |
| `OPENROUTER_GPT56_CONTEXT_WINDOW` | const | 540–540 | no | 0 | registry/frontier-models.ts (L2) |
| `OPENROUTER_GPT56_CONTEXT_WINDOWS` | const | 541–545 | no | 0 | registry/frontier-models.ts (L2) |
| `THINKING_TOGGLE_EFFORTS` | const | 553–553 | no | 0 | registry/reasoning-models.ts (L2) |
| `THINKING_TOGGLE_MAP` | const | 554–562 | no | 0 | registry/reasoning-models.ts (L2) |
| `OPENCODE_GO_THINKING_TOGGLE_MODELS` | const | 563–565 | no | 0 | registry/reasoning-models.ts (L2) |
| `ZHIPU_BIGMODEL_TEXT_MODELS` | const | 574–574 | no | 0 | registry/reasoning-models.ts (L2) |
| `ZHIPU_BIGMODEL_MODELS` | const | 575–575 | no | 0 | registry/reasoning-models.ts (L2) |
| `ZHIPU_BIGMODEL_INPUT_MODALITIES` | const | 576–579 | no | 0 | registry/reasoning-models.ts (L2) |
| `ZHIPU_BIGMODEL_THINKING_TOGGLE_MODELS` | const | 580–580 | no | 0 | registry/reasoning-models.ts (L2) |
| `THINKING_BUDGET_EFFORTS` | const | 581–581 | no | 0 | registry/reasoning-models.ts (L2) |
| `QWEN38_REASONING_EFFORTS` | const | 584–584 | no | 0 | registry/reasoning-models.ts (L2) |
| `THINKING_BUDGET_MODELS` | const | 585–588 | no | 0 | registry/reasoning-models.ts (L2) |
| `OPENCODE_GO_THINKING_BUDGET_MODELS` | const | 589–589 | no | 0 | registry/reasoning-models.ts (L2) |
| `DEEPSEEK_THINKING_MODELS` | const | 590–590 | no | 0 | registry/reasoning-models.ts (L2) |
| `DEEPSEEK_VISION_PREVIEW_MODEL` | const | 597–597 | no | 0 | registry/reasoning-models.ts (L2) |
| `COMMAND_CODE_IMAGE_MODELS` | const | 607–617 | no | 0 | registry/reasoning-models.ts (L2) |
| `COMMAND_CODE_MODEL_INPUT_MODALITIES` | const | 618–619 | no | 0 | registry/reasoning-models.ts (L2) |
| `OPENCODE_FREE_DEEPSEEK_MODELS` | const | 620–620 | no | 0 | registry/reasoning-models.ts (L2) |
| `OPENCODE_ZEN_TEXT_ONLY_MODELS` | const | 641–648 | no | 0 | registry/reasoning-models.ts (L2) |
| `DEEPSEEK_FLASH_THINKING_EFFORTS` | const | 672–672 | no | 0 | registry/reasoning-models.ts (L2) |
| `DEEPSEEK_PRO_THINKING_EFFORTS` | const | 673–673 | no | 0 | registry/reasoning-models.ts (L2) |
| `DEEPSEEK_PRO_REASONING_MAP` | const | 674–680 | no | 0 | registry/reasoning-models.ts (L2) |
| `DEEPSEEK_FLASH_REASONING_MAP` | const | 681–687 | no | 0 | registry/reasoning-models.ts (L2) |
| `isDeepseekFlashModel` | const | 695–696 | no | 0 | registry/reasoning-models.ts (L2) |
| `deepseekThinkingEffortsFor` | const | 697–698 | no | 0 | registry/reasoning-models.ts (L2) |
| `deepseekReasoningMapFor` | const | 699–700 | no | 0 | registry/reasoning-models.ts (L2) |
| `ALIBABA_TOKEN_PLAN_MODELS` | const | 705–708 | no | 0 | registry/coding-plan-models.ts (L2) |
| `ALIBABA_TOKEN_PLAN_QWEN_MODELS` | const | 709–711 | no | 0 | registry/coding-plan-models.ts (L2) |
| `ALIBABA_TOKEN_PLAN_INPUT_MODALITIES` | const | 712–721 | no | 0 | registry/coding-plan-models.ts (L2) |
| `ALIBABA_INTL_TOKEN_PLAN_MODELS` | const | 727–733 | no | 0 | registry/coding-plan-models.ts (L2) |
| `ALIBABA_INTL_TOKEN_PLAN_QWEN_MODELS` | const | 734–736 | no | 0 | registry/coding-plan-models.ts (L2) |
| `TENCENT_CODING_PLAN_MODELS` | const | 743–743 | no | 0 | registry/coding-plan-models.ts (L2) |
| `VOLCENGINE_ARK_MODELS` | const | 758–769 | no | 0 | registry/coding-plan-models.ts (L2) |
| `VOLCENGINE_DOUBAO_THINKING_MODELS` | const | 770–774 | no | 0 | registry/coding-plan-models.ts (L2) |
| `VOLCENGINE_CODING_PLAN_MODELS` | const | 775–785 | no | 0 | registry/coding-plan-models.ts (L2) |
| `VOLCENGINE_AGENT_PLAN_MODELS` | const | 786–795 | no | 0 | registry/coding-plan-models.ts (L2) |
| `VOLCENGINE_PLAN_INPUT_MODALITIES` | const | 796–802 | no | 0 | registry/coding-plan-models.ts (L2) |
| `VOLCENGINE_PLAN_TEXT_ONLY_MODELS` | const | 806–814 | no | 0 | registry/coding-plan-models.ts (L2) |
| `ALIBABA_INTL_TOKEN_PLAN_INPUT_MODALITIES` | const | 815–833 | no | 0 | registry/coding-plan-models.ts (L2) |
| `KIMI_K3_STANDARD_CONTEXT_WINDOW` | const | 841–841 | no | 0 | registry/kimi-models.ts (L2) |
| `KIMI_K3_1M_CONTEXT_WINDOW` | const | 842–842 | no | 0 | registry/kimi-models.ts (L2) |
| `KIMI_CODING_K3_MODELS` | const | 843–843 | no | 0 | registry/kimi-models.ts (L2) |
| `KIMI_LEGACY_API_MODELS` | const | 844–844 | no | 0 | registry/kimi-models.ts (L2) |
| `KIMI_API_MODELS` | const | 845–845 | no | 0 | registry/kimi-models.ts (L2) |
| `KIMI_CODING_MODELS` | const | 846–846 | no | 0 | registry/kimi-models.ts (L2) |
| `KIMI_THINKING_MODELS` | const | 847–847 | no | 0 | registry/kimi-models.ts (L2) |
| `KIMI_CODING_NO_REASONING_MODELS` | const | 848–848 | no | 0 | registry/kimi-models.ts (L2) |
| `KIMI_API_NO_REASONING_MODELS` | const | 849–849 | no | 0 | registry/kimi-models.ts (L2) |
| `KIMI_CODING_K3_REASONING_EFFORTS` | const | 850–850 | no | 0 | registry/kimi-models.ts (L2) |
| `KIMI_CODING_K3_REASONING_EFFORT_MAP` | const | 851–858 | no | 0 | registry/kimi-models.ts (L2) |
| `KIMI_CODING_REASONING_EFFORTS` | const | 859–861 | no | 0 | registry/kimi-models.ts (L2) |
| `KIMI_CODING_DEFAULT_REASONING_EFFORTS` | const | 862–864 | no | 0 | registry/kimi-models.ts (L2) |
| `KIMI_CODING_REASONING_EFFORT_MAPS` | const | 865–867 | no | 0 | registry/kimi-models.ts (L2) |
| `KIMI_API_REASONING_EFFORTS` | const | 868–870 | no | 0 | registry/kimi-models.ts (L2) |
| `KIMI_LOCKED_PARAMETER_MODELS` | const | 871–871 | no | 0 | registry/kimi-models.ts (L2) |
| `KIMI_AUTO_TOOL_CHOICE_ONLY_MODELS` | const | 872–872 | no | 0 | registry/kimi-models.ts (L2) |
| `KIMI_API_MODEL_CONTEXT_WINDOWS` | const | 873–875 | no | 0 | registry/kimi-models.ts (L2) |
| `KIMI_API_MODEL_INPUT_MODALITIES` | const | 876–876 | no | 0 | registry/kimi-models.ts (L2) |
| `NVIDIA_NIM_KIMI_THINKING_MODELS` | const | 881–883 | no | 0 | registry/nim-models.ts (L2) |
| `NVIDIA_NIM_KIMI_MODELS` | const | 884–887 | no | 0 | registry/nim-models.ts (L2) |
| `NVIDIA_NIM_VISION_MODELS` | const | 910–920 | no | 0 | registry/nim-models.ts (L2) |
| `NVIDIA_NIM_VISION_INPUT_MODALITIES` | const | 926–928 | no | 0 | registry/nim-models.ts (L2) |
| `NVIDIA_NIM_NO_VISION_MODELS` | const | 939–958 | no | 0 | registry/nim-models.ts (L2) |
| `KIMI_CODING_MODEL_CONTEXT_WINDOWS` | const | 959–961 | no | 0 | registry/kimi-models.ts (L2) |
| `KIMI_CODING_MODEL_INPUT_MODALITIES` | const | 962–964 | no | 0 | registry/kimi-models.ts (L2) |
| `NEURALWATT_REASONING_HISTORY_MODELS` | const | 965–970 | no | 0 | registry/gateway-models.ts (L2) |
| `BASETEN_FULL_REASONING_EFFORTS` | const | 979–979 | no | 0 | registry/gateway-models.ts (L2) |
| `BASETEN_MODEL_REASONING_EFFORTS` | const | 980–990 | no | 0 | registry/gateway-models.ts (L2) |
| `BASETEN_MODEL_REASONING_EFFORT_MAP` | const | 991–1000 | no | 0 | registry/gateway-models.ts (L2) |
| `BASETEN_MODEL_DEFAULT_REASONING_EFFORTS` | const | 1001–1006 | no | 0 | registry/gateway-models.ts (L2) |
| `BASETEN_MODEL_INPUT_MODALITIES` | const | 1007–1012 | no | 0 | registry/gateway-models.ts (L2) |
| `DIGITALOCEAN_CHAT_COMPLETION_MODELS` | const | 1023–1053 | no | 0 | registry/gateway-models.ts (L2) |
| `SCALEWAY_SERVERLESS_CHAT_MODELS` | const | 1054–1069 | no | 0 | registry/gateway-models.ts (L2) |
| `SCALEWAY_MODEL_INPUT_MODALITIES` | const | 1070–1072 | no | 0 | registry/gateway-models.ts (L2) |
| `UMANS_MODELS` | const | 1073–1082 | no | 0 | registry/gateway-models.ts (L2) |
| `UMANS_REASONING_EFFORTS` | const | 1083–1083 | no | 0 | registry/gateway-models.ts (L2) |
| `UMANS_GLM_REASONING_EFFORTS` | const | 1084–1084 | no | 0 | registry/gateway-models.ts (L2) |
| `UMANS_GLM_53_REASONING_EFFORTS` | const | 1087–1087 | no | 0 | registry/gateway-models.ts (L2) |
| `UMANS_TEXT_ONLY_MODELS` | const | 1092–1092 | no | 0 | registry/gateway-models.ts (L2) |
| `UMANS_MODEL_CONTEXT_WINDOWS` | const | 1093–1104 | no | 0 | registry/gateway-models.ts (L2) |
| `UMANS_MODEL_INPUT_MODALITIES` | const | 1105–1107 | no | 0 | registry/gateway-models.ts (L2) |
| `CLINE_PASS_MODELS` | const | 1108–1123 | no | 0 | registry/gateway-models.ts (L2) |
| `CLINE_PASS_MODEL_CONTEXT_WINDOWS` | const | 1124–1138 | no | 0 | registry/gateway-models.ts (L2) |
| `CLINE_PASS_IMAGE_MODELS` | const | 1139–1151 | no | 0 | registry/gateway-models.ts (L2) |
| `CLINE_PASS_MODALITY_KNOWN_MODELS` | const | 1152–1152 | no | 0 | registry/gateway-models.ts (L2) |
| `CLINE_PASS_TEXT_ONLY_MODELS` | const | 1153–1153 | no | 0 | registry/gateway-models.ts (L2) |
| `CLINE_PASS_MODEL_INPUT_MODALITIES` | const | 1154–1156 | no | 0 | registry/gateway-models.ts (L2) |
| `PROVIDER_REGISTRY` | const | 1158–3056 | yes | 62 | residual; element leaves in L3/L4 |
| `providerRegistryFastWireError` | function | 3058–3062 | yes | 1 | residual original file |
| `getProviderRegistryEntry` | function | 3069–3071 | yes | 58 | residual original file |
| `mergeRegistryStaticHeaders` | function | 3089–3101 | yes | 2 | residual original file |
| `registryModelServiceTierCapabilityApplies` | function | 3104–3110 | yes | 4 | residual original file |
| `normalizedProviderEndpoint` | function | 3112–3121 | no | 0 | residual original file |
| `providerMatchesRegistryTransport` | function | 3131–3145 | yes | 9 | residual original file |
| `registryEntryForProviderDestination` | function | 3159–3171 | yes | 8 | residual original file |
| `providerModelWireDefault` | function | 3179–3199 | yes | 3 | residual original file |
| `providerModelResponsesUpstreamStreaming` | function | 3202–3210 | yes | 1 | residual original file |
| `providerModelResponsesTerminalRepair` | function | 3213–3224 | yes | 2 | residual original file |
| `providerCodexAccountMode` | function | 3231–3237 | yes | 25 | residual original file |
| `effectiveGoogleMode` | function | 3244–3250 | yes | 4 | residual original file |

Imports at `src/providers/registry.ts:1–23` are dependencies, not additional declared public symbols; see exact residual imports below. The top-level `for` at 3064–3067 is inventoried as an effect in Module-level state and cycles. The `PROVIDER_REGISTRY` declaration is not duplicated: its individual object literals are the entry units detailed below.

## Leaf partition

Source paths below are all NEW under `src/providers/registry/`. The ranges are cut boundaries including nearby comments/blanks; symbol ranges above exclude leading comments. Leaf counts include imports and typed array wrappers, using one import statement per physical line. Never shorten source comments to hit the limit.

### `src/providers/registry/entries-hosted.ts`

- Original ranges: `2008–2346`.
- Symbols: `HOSTED_ENTRIES`.
- Expected lines: **346** (≤400).

Own imports (complete):

```ts
import type { ProviderRegistryEntry } from "./contracts";
import { DEEPSEEK_VISION_PREVIEW_MODEL, COMMAND_CODE_MODEL_INPUT_MODALITIES } from "./reasoning-models";
import { BASETEN_MODEL_REASONING_EFFORTS, BASETEN_MODEL_REASONING_EFFORT_MAP, BASETEN_MODEL_DEFAULT_REASONING_EFFORTS, BASETEN_MODEL_INPUT_MODALITIES, DIGITALOCEAN_CHAT_COMPLETION_MODELS, SCALEWAY_SERVERLESS_CHAT_MODELS, SCALEWAY_MODEL_INPUT_MODALITIES } from "./gateway-models";
import { COMMAND_CODE_MODEL_REASONING_EFFORTS } from "../command-code-efforts";
```

`HOSTED_ENTRIES` = `export const HOSTED_ENTRIES: readonly ProviderRegistryEntry[] = [`, followed by **verbatim** original lines 2008–2346, followed by `];`. Entry ids in order: `chutes` (2008–2041), `deepinfra` (2042–2062), `hyperbolic` (2063–2078), `nscale` (2079–2111), `vultr` (2112–2141), `baseten` (2142–2166), `commandcode` (2167–2204), `sambanova` (2205–2225), `nebius` (2226–2251), `digitalocean` (2252–2274), `scaleway` (2275–2299), `featherless` (2300–2346). No sorting, mapping, cloning, default filling or conditional inclusion.

### `src/providers/registry/entries-regional.ts`

- Original ranges: `2347–2664`.
- Symbols: `REGIONAL_ENTRIES`.
- Expected lines: **328** (≤400).

Own imports (complete):

```ts
import type { ProviderRegistryEntry } from "./contracts";
import { ZAI_GLM_53_MODELS, ZAI_GLM_5X_MODELS, ZAI_GLM_5X_SIDECAR_VISION_MODELS, ZAI_GLM_5X_REASONING_EFFORTS } from "./frontier-models";
import { THINKING_TOGGLE_EFFORTS, THINKING_TOGGLE_MAP, ZHIPU_BIGMODEL_MODELS, ZHIPU_BIGMODEL_INPUT_MODALITIES, ZHIPU_BIGMODEL_THINKING_TOGGLE_MODELS, DEEPSEEK_THINKING_MODELS, deepseekThinkingEffortsFor, deepseekReasoningMapFor } from "./reasoning-models";
import { TENCENT_CODING_PLAN_MODELS, VOLCENGINE_ARK_MODELS, VOLCENGINE_DOUBAO_THINKING_MODELS, VOLCENGINE_CODING_PLAN_MODELS, VOLCENGINE_AGENT_PLAN_MODELS, VOLCENGINE_PLAN_INPUT_MODALITIES, VOLCENGINE_PLAN_TEXT_ONLY_MODELS } from "./coding-plan-models";
import { KIMI_API_MODELS, KIMI_API_NO_REASONING_MODELS, KIMI_API_REASONING_EFFORTS, KIMI_API_MODEL_CONTEXT_WINDOWS, KIMI_API_MODEL_INPUT_MODALITIES } from "./kimi-models";
import { NVIDIA_NIM_KIMI_THINKING_MODELS, NVIDIA_NIM_KIMI_MODELS, NVIDIA_NIM_VISION_INPUT_MODALITIES, NVIDIA_NIM_NO_VISION_MODELS } from "./nim-models";
import { QWEN_CLOUD_BASE_URL_CHOICES, QWEN_CLOUD_TOKEN_PLAN_BASE_URL, ALIBABA_CODING_BASE_URL_CHOICES, ALIBABA_CODING_INTL_BASE_URL, MOONSHOT_BASE_URL_CHOICES, MOONSHOT_INTL_BASE_URL } from "../base-url-choices";
```

`REGIONAL_ENTRIES` = `export const REGIONAL_ENTRIES: readonly ProviderRegistryEntry[] = [`, followed by **verbatim** original lines 2347–2664, followed by `];`. Entry ids in order: `novita` (2347–2389), `together` (2391–2391), `fireworks` (2392–2392), `firepass` (2393–2397), `moonshot` (2398–2414), `huggingface` (2415–2415), `nvidia` (2424–2438), `venice` (2439–2439), `zai` (2448–2462), `zhipu-bigmodel` (2472–2508), `zhipu-bigmodel-coding` (2525–2544), `nanogpt` (2545–2545), `synthetic` (2546–2546), `siliconflow` (2551–2560), `qwen-cloud` (2563–2573), `tencent-coding-plan` (2574–2587), `volcengine` (2588–2620), `volcengine-coding-plan` (2621–2642), `volcengine-agent-plan` (2643–2660), `qianfan` (2662–2662), `alibaba` (2664–2664). No sorting, mapping, cloning, default filling or conditional inclusion.

### `src/providers/registry/entries-plans.ts`

- Original ranges: `2665–2924`.
- Symbols: `PLAN_ENTRIES`.
- Expected lines: **269** (≤400).

Own imports (complete):

```ts
import type { ProviderRegistryEntry } from "./contracts";
import { ZAI_GLM_52_REASONING_EFFORTS, ZAI_GLM_53_REASONING_EFFORTS, MINIMAX_MODELS, MINIMAX_MODEL_CONTEXT_WINDOWS, MINIMAX_M3_REASONING_EFFORTS, MINIMAX_M3_REASONING_EFFORT_MAP } from "./frontier-models";
import { THINKING_BUDGET_EFFORTS, QWEN38_REASONING_EFFORTS, DEEPSEEK_THINKING_MODELS, DEEPSEEK_VISION_PREVIEW_MODEL, OPENCODE_FREE_DEEPSEEK_MODELS, OPENCODE_ZEN_TEXT_ONLY_MODELS, deepseekThinkingEffortsFor, deepseekReasoningMapFor } from "./reasoning-models";
import { ALIBABA_TOKEN_PLAN_MODELS, ALIBABA_TOKEN_PLAN_QWEN_MODELS, ALIBABA_TOKEN_PLAN_INPUT_MODALITIES, ALIBABA_INTL_TOKEN_PLAN_MODELS, ALIBABA_INTL_TOKEN_PLAN_QWEN_MODELS, ALIBABA_INTL_TOKEN_PLAN_INPUT_MODALITIES } from "./coding-plan-models";
import { KIMI_CODING_MODELS, KIMI_THINKING_MODELS, KIMI_CODING_NO_REASONING_MODELS, KIMI_CODING_REASONING_EFFORTS, KIMI_CODING_DEFAULT_REASONING_EFFORTS, KIMI_CODING_REASONING_EFFORT_MAPS, KIMI_LOCKED_PARAMETER_MODELS, KIMI_AUTO_TOOL_CHOICE_ONLY_MODELS, KIMI_CODING_MODEL_CONTEXT_WINDOWS, KIMI_CODING_MODEL_INPUT_MODALITIES } from "./kimi-models";
import { ALIBABA_INTL_BASE_URL_CHOICES, ALIBABA_INTL_TOKEN_PLAN_BASE_URL } from "../base-url-choices";
```

`PLAN_ENTRIES` = `export const PLAN_ENTRIES: readonly ProviderRegistryEntry[] = [`, followed by **verbatim** original lines 2665–2924, followed by `];`. Entry ids in order: `alibaba-token-plan` (2665–2695), `alibaba-token-plan-intl` (2696–2738), `parallel` (2742–2742), `zenmux` (2747–2750), `litellm` (2751–2758), `ollama-cloud` (2759–2801), `mistral` (2803–2803), `minimax` (2804–2826), `minimax-cn` (2827–2840), `kimi-code` (2841–2859), `opencode-zen` (2860–2884), `vercel-ai-gateway` (2885–2885), `opencode-free` (2886–2924). No sorting, mapping, cloning, default filling or conditional inclusion.

### `src/providers/registry/entries-edge.ts`

- Original ranges: `2925–3055`.
- Symbols: `EDGE_ENTRIES`.
- Expected lines: **135** (≤400).

Own imports (complete):

```ts
import type { ProviderRegistryEntry } from "./contracts";
```

`EDGE_ENTRIES` = `export const EDGE_ENTRIES: readonly ProviderRegistryEntry[] = [`, followed by **verbatim** original lines 2925–3055, followed by `];`. Entry ids in order: `xiaomi` (2925–2925), `xiaomi-mimo` (2930–2943), `kilo` (2944–2944), `mimo-free` (2945–2960), `mimo` (2971–2992), `cloudflare-ai-gateway` (2993–2993), `cloudflare-workers-ai` (2994–3022), `github-copilot` (3025–3053), `gitlab-duo` (3055–3055). No sorting, mapping, cloning, default filling or conditional inclusion.

MODIFY `src/providers/registry.ts`: expected residual **219 lines**. Under 400; no later registry split is required. Keep only the single Antigravity entry, ordered spreads, original validation and lookup policy.

| Registry stage | Original lines removed, cumulative | Residual body incl. spread placeholders | Header/import/re-export lines | Expected residual |
|---|---:|---:|---:|---:|
| #a / L2 | 814 | 2,412 | 17 | 2,429 |
| #b / L3 | 1,981 | 1,249 | 18 | 1,267 |
| #c / L4 | 3,029 | 205 | 14 | 219 |

Accounting starts from 3,250 original physical lines. Original header 1–24 is replaced by the explicit one-statement-per-line headers in each Re-export block. Body removals: 814 model lines in #a; 319 contract lines + 848 entry lines in #b; 1,048 entry lines in #c. #b inserts four spread lines; #c inserts four more. Thus #b reduces the prior residual by 1,162; #c by 1,048. These counts include retained comments/blanks and are exact for the specified compact headers; formatting may change them but must not exceed 400 for a new leaf. All 1,897 original array-content lines are accounted for: 848 + 1,048 moved, plus the one retained Antigravity line at 1903. Final original residual is 219, not an unplanned #d.

The Antigravity row is deliberately retained at its original sequence point; do not merge the two gateway arrays around it. This avoids propagating the known Antigravity/catalog type cycle into a new entry leaf. Preserve the existing eager Cursor calculations and validation timing: no factories or async initialization.

## Re-export block

All 11 public types move in #b; the exact named type re-export is retained in #c. PROVIDER_REGISTRY and all 11 exported functions stay defined in the residual, so adding value re-exports for them would duplicate declarations. The complete expected residual import/re-export header is:

```ts
import type { CodexAccountMode, OcxProviderConfig } from "../types";
import type { InboundWire, ProviderRegistryEntry, ResponsesTerminalRepairPolicy } from "./registry/contracts";
import { fastWireDeclarationError } from "./fastwire";
import { ANTIGRAVITY_MODELS, ANTIGRAVITY_MODEL_CONTEXT_WINDOWS, ANTIGRAVITY_MODEL_EFFORTS, ANTIGRAVITY_MODEL_INPUT_MODALITIES } from "./antigravity-models";
import { ACCOUNT_ENTRIES } from "./registry/entries-accounts";
import { FRONTIER_ENTRIES } from "./registry/entries-frontier";
import { GATEWAY_ENTRIES_BEFORE_ANTIGRAVITY, GATEWAY_ENTRIES_AFTER_ANTIGRAVITY } from "./registry/entries-gateways";
import { HOSTED_ENTRIES } from "./registry/entries-hosted";
import { REGIONAL_ENTRIES } from "./registry/entries-regional";
import { PLAN_ENTRIES } from "./registry/entries-plans";
import { EDGE_ENTRIES } from "./registry/entries-edge";

export type { ProviderAuthKind, MetadataModelIdNormalize, InboundWire, ModelWireDefault, ResponsesTerminalRepairPolicy, ProviderModelDiscoveryScalar, ProviderModelDiscoveryPredicate, ProviderModelDiscoveryFilter, ProviderModelDiscoverySpec, ProviderRegistryEntry, ProviderConfigSeed } from "./registry/contracts";
```

At each original chunk start, replace only its range with one `...CHUNK_NAME,` line. Exact ordered composition for the extracted region:

```ts
export const PROVIDER_REGISTRY: readonly ProviderRegistryEntry[] = [
  ...ACCOUNT_ENTRIES,
  ...FRONTIER_ENTRIES,
  ...GATEWAY_ENTRIES_BEFORE_ANTIGRAVITY,
  { id: "google-antigravity", label: "Google Antigravity", adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", authKind: "oauth", allowBaseUrlOverride: true, dashboardUrl: "https://antigravity.google", models: ANTIGRAVITY_MODELS, liveModels: true, defaultModel: "gemini-3.8-flash", modelContextWindows: ANTIGRAVITY_MODEL_CONTEXT_WINDOWS, modelInputModalities: ANTIGRAVITY_MODEL_INPUT_MODALITIES, modelReasoningEfforts: ANTIGRAVITY_MODEL_EFFORTS, googleMode: "cloud-code-assist", jawcodeBundle: "google", extraMetadataAliases: ["antigravity", "gemini-antigravity"] },
  ...GATEWAY_ENTRIES_AFTER_ANTIGRAVITY,
  ...HOSTED_ENTRIES,
  ...REGIONAL_ENTRIES,
  ...PLAN_ENTRIES,
  ...EDGE_ENTRIES,
];
```

The Antigravity object above is the exact original line 1903. No new array is exported from the old path apart from the existing PROVIDER_REGISTRY binding.

## Module-level state and cycles

- `CLINE_PASS_IMAGE_MODELS` at `src/providers/registry.ts:1139–1151` has exactly one owner: `src/providers/registry/gateway-models.ts` from L2. It stays private there; its derived modality/text-only arrays stay with it. No setter, clone, lazy initializer, cache, or test hook is introduced.
- Every other top-level const is in the inventory. Model arrays/records are initialized once by their assigned leaf. Keep shared object identity, aliases (`KIMI_THINKING_MODELS` at 847, `KIMI_LOCKED_PARAMETER_MODELS` at 871), copies, and Object.fromEntries expressions unchanged. Readonly typing does not authorize freezing or cloning their values.
- `PROVIDER_REGISTRY` at 1158 remains one exported array in `registry.ts`. Entry leaves allocate each original entry object once; the facade spreads entry references in the historical sequence. The original validation loop at `src/providers/registry.ts:3064–3067` runs exactly once, after the complete array is constructed and before the facade import completes. It is a top-level effect, not a cache; never move it into each chunk or defer it.
- No top-level let, Map, WeakMap, lock or timer exists in either target. The `claimed` Set in `mergeRegistryStaticHeaders` at 3095 and callback-local Sets are invocation-local, not singleton state. No reset owner is needed.

Dependency map: `src/router.ts:20`, `src/providers/derive.ts:8`, `src/config.ts:88`, and `src/codex/catalog/parsing.ts:14` consume the old boundary; it points to data leaves and contracts. Entry leaves point directly to their model leaves and existing vendor metadata owners, never to `../registry`. This is functional/data coupling; initialization/validation is the existing temporal coupling. No common mutable-state API is introduced.

Existing type cycle: `registry.ts:2 → fastwire.ts:10 → registry.ts`. L2 leaves it unchanged; L3 moves contracts and changes only the type specifier in `src/providers/fastwire.ts:10` from `"./registry"` to `"./registry/contracts"`. This single adjacent source-file change is a required executor scope expansion for the parent to authorize, not performed by this documentation task. It reduces legacy-path importer count from 134 to 133; all other legacy consumers and all 78 test/support importers stay put. Do not pretend the literal unchanged-importer-count line in 002 can apply to this intentional one-edge repair.

A second, pre-existing type-containing cycle is `registry.ts:4 → antigravity-models.ts:2 → codex/model-cache.ts:10 → codex/catalog.ts:3 → codex/catalog/parsing.ts:13 → providers/derive.ts:8 → registry.ts`. Keep the complete `google-antigravity` object at `registry.ts:1903` and its existing import in the facade, between the two gateway arrays. Moving it into an entry leaf would put that new leaf into the existing SCC. No new leaf imports Antigravity. The known vendor dependencies remain real shared owners (KIRO at src/providers/kiro-models.ts:1; Command Code at src/providers/command-code-efforts.ts:1; Cursor discovery/catalog at src/adapters/cursor/discovery.ts:1–8), not copied snapshots. A direct import of CatalogModel from parsing would still reach derive and would not fix this cycle. Strict all-graph zero-cycle acceptance needs a separately scoped type-owner repair; report this to the parent rather than silently expanding S02 or claiming the graph is globally acyclic. Compare baseline and tip graphs including erased type edges; no new SCC may contain a planned leaf. No lazy-import workaround.

## Tests

Resolved `rg -l` importer list below: 77 test files plus one test helper (78 files). Each is **unchanged** in every layer: it continues importing the historical facade, including the dynamic import at `tests/providers/qwen38-preserve-reasoning.test.ts:106` and child-process import text at `tests/adapters/openai/openai-provider-option-e2e.test.ts:261`.

- `tests/adapters/adapter-tool-conformance.test.ts` — unchanged.
- `tests/adapters/anthropic/anthropic-hardening.test.ts` — unchanged.
- `tests/adapters/empty-tool-output-annotation.test.ts` — unchanged.
- `tests/adapters/google/antigravity-static-catalog.test.ts` — unchanged.
- `tests/adapters/google/gemini-37-flash-migration.test.ts` — unchanged.
- `tests/adapters/google/google-hardening.test.ts` — unchanged.
- `tests/adapters/openai/openai-api-virtual-models.test.ts` — unchanged.
- `tests/adapters/openai/openai-provider-option-e2e.test.ts` — unchanged.
- `tests/adapters/openai/openai-provider-option.test.ts` — unchanged.
- `tests/codex-integration/catalog-vision-sidecar-modalities.test.ts` — unchanged.
- `tests/codex-integration/codex-catalog.test.ts` — unchanged.
- `tests/codex-integration/codex-gather-authority.test.ts` — unchanged.
- `tests/codex-integration/compatibility-manifest.test.ts` — unchanged.
- `tests/gui/alibaba-intl-token-plan.test.ts` — unchanged.
- `tests/gui/provider-payload.test.ts` — unchanged.
- `tests/gui/qwen-cloud-endpoints.test.ts` — unchanged.
- `tests/gui/tencent-siliconflow-providers.test.ts` — unchanged.
- `tests/gui/volcengine-providers.test.ts` — unchanged.
- `tests/helpers/provider-registry-discovery.ts` — unchanged.
- `tests/images/gemini-inline.test.ts` — unchanged.
- `tests/providers/baseten-provider.test.ts` — unchanged.
- `tests/providers/chutes-provider.test.ts` — unchanged.
- `tests/providers/cline-pass-provider.test.ts` — unchanged.
- `tests/providers/cline-pass-reasoning-efforts.test.ts` — unchanged.
- `tests/providers/cline-provider.test.ts` — unchanged.
- `tests/providers/command-code-provider.test.ts` — unchanged.
- `tests/providers/commandcode-provider.test.ts` — unchanged.
- `tests/providers/cursor/cursor-display-names.test.ts` — unchanged.
- `tests/providers/cursor/cursor-fast-listing.test.ts` — unchanged.
- `tests/providers/cursor/cursor-fast-tier.test.ts` — unchanged.
- `tests/providers/deepinfra-provider.test.ts` — unchanged.
- `tests/providers/deepseek-inbound-wire.test.ts` — unchanged.
- `tests/providers/deepseek-reasoning-replay.test.ts` — unchanged.
- `tests/providers/deepseek-responses-item-id-repair.test.ts` — unchanged.
- `tests/providers/digitalocean-scaleway-provider.test.ts` — unchanged.
- `tests/providers/fast-row-ingress.test.ts` — unchanged.
- `tests/providers/featherless-provider.test.ts` — unchanged.
- `tests/providers/github-copilot/github-copilot-stream-contract.test.ts` — unchanged.
- `tests/providers/github-copilot/github-copilot-wire-defaults.test.ts` — unchanged.
- `tests/providers/hyperbolic-provider.test.ts` — unchanged.
- `tests/providers/kiro/kiro-adapter.test.ts` — unchanged.
- `tests/providers/meta-model-api-provider.test.ts` — unchanged.
- `tests/providers/meta-muse-oauth.test.ts` — unchanged.
- `tests/providers/mimo-effort.test.ts` — unchanged.
- `tests/providers/mimo-free-provider.test.ts` — unchanged.
- `tests/providers/mimo-token-plan-provider.test.ts` — unchanged.
- `tests/providers/model-rename-migration.test.ts` — unchanged.
- `tests/providers/moonshot-endpoints.test.ts` — unchanged.
- `tests/providers/muse-spark-web-search-compat.test.ts` — unchanged.
- `tests/providers/novita-provider.test.ts` — unchanged.
- `tests/providers/nscale-vultr-provider.test.ts` — unchanged.
- `tests/providers/nvidia-nim-hardening.test.ts` — unchanged.
- `tests/providers/ollama/ollama-native.test.ts` — unchanged.
- `tests/providers/opencode-free-provider.test.ts` — unchanged.
- `tests/providers/opencode-go-grok46-responses.test.ts` — unchanged.
- `tests/providers/opencode-go-luna-wire.test.ts` — unchanged.
- `tests/providers/opencode-go-muse-context.test.ts` — unchanged.
- `tests/providers/opencode-go-muse-vision.test.ts` — unchanged.
- `tests/providers/opencode-go-session-header.test.ts` — unchanged.
- `tests/providers/opencode-zen-rate-limit.test.ts` — unchanged.
- `tests/providers/provider-connection-test.test.ts` — unchanged.
- `tests/providers/provider-model-discovery-contract.test.ts` — unchanged.
- `tests/providers/provider-registry-parity.test.ts` — unchanged.
- `tests/providers/provider-static-model-discovery.test.ts` — unchanged.
- `tests/providers/qwen38-preserve-reasoning.test.ts` — unchanged.
- `tests/providers/sambanova-nebius-provider.test.ts` — unchanged.
- `tests/providers/xai/xai-transport.test.ts` — unchanged.
- `tests/providers/zhipu-bigmodel-provider.test.ts` — unchanged.
- `tests/responses/openai-responses-passthrough.test.ts` — unchanged.
- `tests/responses/responses-reasoning-summary-passthrough.test.ts` — unchanged.
- `tests/responses/responses-routed-web-search-fields.test.ts` — unchanged.
- `tests/responses/responses-stateless-dangling-call-repair.test.ts` — unchanged.
- `tests/responses/responses-terminal-repair.test.ts` — unchanged.
- `tests/routing/fastwire-policy.test.ts` — unchanged.
- `tests/routing/routing-capability-model-matching.test.ts` — unchanged.
- `tests/routing/routing-compatibility-auth-identity.test.ts` — unchanged.
- `tests/service/service-tier-capability.test.ts` — unchanged.
- `tests/vision/vision-sidecar-e2e.test.ts` — unchanged.

Text-oracle classification:

- Direct source-text readers of `src/providers/registry.ts`: **none found** by full-path, basename and segmented-path searches. `001_stale_check.md`'s count 1 is not accepted as a real oracle: `tests/routing/routing-compatibility-model-matching.test.ts:15` only mentions the source path in a comment, does not read it, and tests catalog model matching through other modules. Unchanged. This agrees with lane 012's inspected conclusion.
- `tests/lab/core-lab-boundary.test.ts:69` reads each transitively reached runtime source via `current`; it already follows re-exports/imports, so new data/destination leaves are automatically scanned. **Unchanged**, no retarget and no add-leaf-to-scan-list; leave PROTECTED at line 20 untouched. This is a graph-boundary oracle, not a provider-value text oracle.
- Fixture reads such as `tests/providers/nscale-vultr-provider.test.ts:28–29`, `tests/providers/commandcode-provider.test.ts:23`, and catalog-cache reads at `tests/codex-integration/codex-catalog.test.ts:3063` read JSON data, not the split TypeScript source. Unchanged.

Guards to drive red once in the future implementation C phase: temporarily duplicate an entry id and then swap adjacent key-provider positions; `tests/providers/provider-registry-parity.test.ts:44–46` (uniqueness) and `:50–51` (ordered keys) must fail respectively. Restore the exact intended content and rerun. After entry extraction, perturb one moved entry field and confirm its existing provider parity assertion fails through the old import path. No assertion removal, fixture regeneration to hide a mismatch, or weakened scan. For the recursive boundary guard, temporarily add a forbidden Lab edge to a new reachable runtime leaf (not a PROTECTED root), observe failure, remove it, and rerun. These are planned commands, not executed evidence.

## Verification

Instantiate `002_layer_map.md` → **Per-layer gate** at this layer's exact tip. This delegated turn is docs-only: do not run these now. Remote full-suite execution, branch creation and PR publication belong to the parent/executor, not this drafting task.

```sh
bun run typecheck
bun test tests/providers
bun test tests/routing/fastwire-policy.test.ts tests/routing/routing-capability-model-matching.test.ts tests/routing/routing-compatibility-auth-identity.test.ts tests/service/service-tier-capability.test.ts
bun test tests/adapters/openai tests/adapters/google tests/adapters/anthropic/anthropic-hardening.test.ts tests/adapters/adapter-tool-conformance.test.ts tests/adapters/empty-tool-output-annotation.test.ts
bun test tests/codex-integration/codex-catalog.test.ts tests/codex-integration/catalog-vision-sidecar-modalities.test.ts tests/codex-integration/codex-gather-authority.test.ts tests/codex-integration/compatibility-manifest.test.ts
bun test tests/gui/alibaba-intl-token-plan.test.ts tests/gui/provider-payload.test.ts tests/gui/qwen-cloud-endpoints.test.ts tests/gui/tencent-siliconflow-providers.test.ts tests/gui/volcengine-providers.test.ts
bun test tests/responses/openai-responses-passthrough.test.ts tests/responses/responses-reasoning-summary-passthrough.test.ts tests/responses/responses-routed-web-search-fields.test.ts tests/responses/responses-stateless-dangling-call-repair.test.ts tests/responses/responses-terminal-repair.test.ts tests/images/gemini-inline.test.ts tests/vision/vision-sidecar-e2e.test.ts
bun run privacy:scan
bun test tests/lab/core-lab-boundary.test.ts
wc -l src/providers/registry/frontier-models.ts src/providers/registry/reasoning-models.ts src/providers/registry/coding-plan-models.ts src/providers/registry/kimi-models.ts src/providers/registry/nim-models.ts src/providers/registry/gateway-models.ts src/providers/registry/entries-accounts.ts src/providers/registry/entries-frontier.ts src/providers/registry/entries-gateways.ts src/providers/registry/entries-hosted.ts src/providers/registry/entries-regional.ts src/providers/registry/entries-plans.ts src/providers/registry/entries-edge.ts src/providers/registry/contracts.ts src/providers/registry.ts
rg -n 'from "[^"]*/registry"' src gui/src scripts tests | wc -l
git diff --check
# Remote only, after parent confirms this checkout is dedicated to the layer:
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-providers-registry-c && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'
```

The 002 grep is a trend signal, not an exact module-resolution count: it omits `./registry`, dynamic imports and type-only ownership corrections. Compare the resolved importer list as well: 134 baseline callers; 134 after L2, 133 from L3 solely because fastwire now imports contracts. Run no repository-wide local suite. Every local focused group above must show zero failures; typecheck/privacy/diff checks must exit zero. The remote pipeline's final `tail` exit status alone is not proof of Bun success: retain the complete log and Bun exit status (pipefail or PIPESTATUS in the executor shell), exact tested commit, and pass/fail totals. Record exact-head CI rollup before claiming PR-ready. No passes are claimed here.

Static architecture verification is separate from typecheck: use the installed ast-grep import/export scan, resolve relative .ts/.tsx/index paths, include type-only edges and compare return paths to the baseline witnesses in Module-level state and cycles. Reject any new leaf-to-facade edge or new SCC; unresolved existing strict cycle constraints go back to the parent. Compare moved AST bodies/literal arrays with original spans (permit only import/export wiring, indentation, and array wrapper/spread scaffolding). Keep exported function signatures and original-path runtime export names identical.

## Accept criteria

1. Before implementation, the parent explicitly resolves the ≤500 changed-source-line contradiction; the fixed three registry parts are not claimed to satisfy that cap.
2. All 146 original top-level declarations have one inventory row and one owner; original exported name/type/signature sets are unchanged.
3. Exactly four new entry leaves in this layer, each ≤400 physical lines; residual is 219 with the named successor layer when over 400.
4. All model literals, metadata maps, object aliases, entry field requiredness and original entry order match origin/dev; retained Antigravity remains between the two gateway arrays.
5. PROVIDER_REGISTRY is allocated once; the FastWire validation loop remains one eager post-construction loop; no new locks, caches, or state copies.
6. Only the authorized FastWire type-import edge moves to contracts; 133 remaining legacy importers and all 78 test/support importers remain unchanged. Re-export statements do not stand in for local type/value imports.
7. No new leaf-to-facade/type cycle; baseline FastWire and Antigravity cycle dispositions are explicit. Do not mark a globally strict zero-cycle gate passed while a baseline witness remains.
8. All test dispositions and restored red-once checks are satisfied; instantiated local focused/privacy/type gates and remote full suite have fresh exact-tip evidence.
9. PR body uses the repository template with this complete four-layer map, correct parent base, own-layer verification, no Closes reference and no merge.

## PR

Title: `refactor(providers): finish ordered registry entry extraction (split S02 L4/4)`

Branch: `codex/split-providers-registry-c`. Base: `codex/split-providers-registry-b`. Closes: **none**.

Use all sections of `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist), recording only this layer's exact-tip evidence. Review only this layer's diff. Placeholder PR numbers below are intentional planning references, not opened PRs.

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 1 | #TBD-S02-L1 | separate OpenAI destination classification | `codex/split-providers-openai-tiers` | `dev` | destination predicates and migration parity |
| 2 | #TBD-S02-L2 | extract private model metadata | `codex/split-providers-registry-a` | `dev` | model values and single ownership |
| 3 | #TBD-S02-L3 | extract registry contracts and primary entries | `codex/split-providers-registry-b` | `codex/split-providers-registry-a` | types, initial entries, FastWire import |
| 4 | #TBD-S02-L4 | **Current: finish ordered registry entry extraction** | `codex/split-providers-registry-c` | `codex/split-providers-registry-b` | tail ordering and final size |

Depends on #TBD-S02-L3. A rewrite of the real parent `codex/split-providers-registry-b` requires cascading this layer and re-verifying its base (DEV-STACK-02). Publication is parent-owned; merges remain prohibited for this split train.
