import {
  QWEN_CLOUD_BASE_URL_CHOICES,
  QWEN_CLOUD_TOKEN_PLAN_BASE_URL,
  ALIBABA_INTL_BASE_URL_CHOICES,
  ALIBABA_INTL_TOKEN_PLAN_BASE_URL,
  ALIBABA_CODING_BASE_URL_CHOICES,
  ALIBABA_CODING_INTL_BASE_URL,
  MOONSHOT_BASE_URL_CHOICES,
  MOONSHOT_INTL_BASE_URL,
} from "../base-url-choices";
import { COMMAND_CODE_MODEL_REASONING_EFFORTS } from "../command-code-efforts";
import {
  CODEBUDDY_CN_MODELS,
  CODEBUDDY_CN_MODEL_CONTEXT_WINDOWS,
  CODEBUDDY_CN_MODEL_DEFAULT_REASONING_EFFORTS,
  CODEBUDDY_CN_MODEL_MAX_OUTPUT_TOKENS,
  CODEBUDDY_CN_MODEL_REASONING_EFFORTS,
  CODEBUDDY_CN_NO_VISION_MODELS,
  CODEBUDDY_GLOBAL_MODELS,
  CODEBUDDY_GLOBAL_MODEL_CONTEXT_WINDOWS,
  CODEBUDDY_GLOBAL_MODEL_DEFAULT_REASONING_EFFORTS,
  CODEBUDDY_GLOBAL_MODEL_MAX_OUTPUT_TOKENS,
  CODEBUDDY_GLOBAL_MODEL_REASONING_EFFORTS,
  CODEBUDDY_REASONING_EFFORTS,
} from "../codebuddy-models";
import { QODER_CN_MODELS, QODER_GLOBAL_MODELS, QODER_REASONING_EFFORTS } from "../qoder-models";
import type { ProviderRegistryEntry } from "./types";
import {
  ZAI_GLM_53_MODELS,
  ZAI_GLM_5X_MODELS,
  ZAI_GLM_5X_SIDECAR_VISION_MODELS,
  ZAI_GLM_5X_INPUT_MODALITIES,
  ZAI_GLM_52_REASONING_EFFORTS,
  ZAI_GLM_53_REASONING_EFFORTS,
  ZAI_GLM_5X_REASONING_EFFORTS,
  MINIMAX_MODELS,
  MINIMAX_MODEL_CONTEXT_WINDOWS,
  MINIMAX_M3_REASONING_EFFORTS,
  MINIMAX_M3_REASONING_EFFORT_MAP,
  THINKING_TOGGLE_EFFORTS,
  THINKING_TOGGLE_MAP,
  ZHIPU_BIGMODEL_MODELS,
  ZHIPU_BIGMODEL_INPUT_MODALITIES,
  ZHIPU_BIGMODEL_THINKING_TOGGLE_MODELS,
  THINKING_BUDGET_EFFORTS,
  QWEN38_REASONING_EFFORTS,
  DEEPSEEK_V4_LEGACY_MODELS,
  DEEPSEEK_GATEWAY_THINKING_MODELS,
  DEEPSEEK_VISION_PREVIEW_MODEL,
  COMMAND_CODE_MIMO_CONTEXT_WINDOWS,
  COMMAND_CODE_MODEL_INPUT_MODALITIES,
  OPENCODE_FREE_DEEPSEEK_MODELS,
  OPENCODE_ZEN_TEXT_ONLY_MODELS,
  OPENCODE_ZEN_IMAGE_MODELS,
  deepseekThinkingEffortsFor,
  deepseekReasoningMapFor,
  ALIBABA_TOKEN_PLAN_MODELS,
  ALIBABA_TOKEN_PLAN_QWEN_MODELS,
  ALIBABA_TOKEN_PLAN_INPUT_MODALITIES,
  ALIBABA_TOKEN_PLAN_CONTEXT_WINDOWS,
  ALIBABA_TOKEN_PLAN_MAX_OUTPUT_TOKENS,
  ALIBABA_TOKEN_PLAN_NO_VISION,
  ALIBABA_TOKEN_PLAN_PRESERVE_REASONING,
  QWEN38_FAMILY,
  ALIBABA_INTL_TOKEN_PLAN_MODELS,
  ALIBABA_INTL_TOKEN_PLAN_QWEN_MODELS,
  TENCENT_CODING_PLAN_MODELS,
  VOLCENGINE_ARK_MODELS,
  VOLCENGINE_DOUBAO_THINKING_MODELS,
  VOLCENGINE_CODING_PLAN_MODELS,
  VOLCENGINE_AGENT_PLAN_MODELS,
  VOLCENGINE_PLAN_INPUT_MODALITIES,
  VOLCENGINE_PLAN_TEXT_ONLY_MODELS,
  ALIBABA_INTL_TOKEN_PLAN_INPUT_MODALITIES,
  KIMI_API_MODELS,
  KIMI_THINKING_MODELS,
  KIMI_CODING_NO_REASONING_MODELS,
  KIMI_API_NO_REASONING_MODELS,
  KIMI_CODING_LIVE_MODELS,
  KIMI_CODING_REASONING_EFFORTS,
  KIMI_CODING_DEFAULT_REASONING_EFFORTS,
  KIMI_CODING_REASONING_EFFORT_MAPS,
  KIMI_API_REASONING_EFFORTS,
  KIMI_LOCKED_PARAMETER_MODELS,
  KIMI_AUTO_TOOL_CHOICE_ONLY_MODELS,
  KIMI_API_MODEL_CONTEXT_WINDOWS,
  KIMI_API_MODEL_INPUT_MODALITIES,
  NVIDIA_NIM_KIMI_THINKING_MODELS,
  NVIDIA_NIM_KIMI_MODELS,
  NVIDIA_NIM_VISION_MODELS,
  NVIDIA_NIM_VISION_INPUT_MODALITIES,
  NVIDIA_NIM_NO_VISION_MODELS,
  KIMI_CODING_MODEL_CONTEXT_WINDOWS,
  KIMI_CODING_MODEL_INPUT_MODALITIES,
  BASETEN_MODEL_REASONING_EFFORTS,
  BASETEN_MODEL_REASONING_EFFORT_MAP,
  BASETEN_MODEL_DEFAULT_REASONING_EFFORTS,
  BASETEN_MODEL_INPUT_MODALITIES,
  DIGITALOCEAN_CHAT_COMPLETION_MODELS,
  SCALEWAY_SERVERLESS_CHAT_MODELS,
  SCALEWAY_MODEL_INPUT_MODALITIES,
  OPPER_MODELS,
  OPPER_MODEL_CONTEXT_WINDOWS,
  OPPER_MODEL_MAX_OUTPUT_TOKENS,
  OPPER_MODEL_INPUT_MODALITIES,
  STEPFUN_MODELS,
  STEPFUN_MODEL_CONTEXT_WINDOWS,
  STEPFUN_MODEL_INPUT_MODALITIES,
  STEPFUN_NO_VISION_MODELS,
  STEPFUN_REASONING_EFFORTS,
  ANTHROPIC_MODELS,
  ANTHROPIC_MODEL_CONTEXT_WINDOWS,
  ANTHROPIC_MODEL_INPUT_MODALITIES,
  ANTHROPIC_MODEL_REASONING_EFFORTS,
  ANTHROPIC_REASONING_EFFORTS,
  ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS,
} from "./model-seeds";

export const PROVIDER_REGISTRY_EXTENDED: readonly ProviderRegistryEntry[] = [
  {
    // Verified 2026-09-21: docs.typesafe.ai/introduction/quickstart and /api document the fixed
    // endpoint, Bearer auth, jev-latest, and TYPESAFE_API_KEY; typesafe.ai/legal/mca permits API integration.
    id: "jev",
    label: "TypeSafe JEV",
    baseUrl: "https://api.typesafe.ai/v1/systemone",
    adapter: "jev-decision",
    authKind: "key",
    credentialOnly: true,
    dashboardUrl: "https://console.typesafe.ai",
    liveModels: false,
    apiKeyValidation: "unknown",
    preserveCustomDestination: true,
    note: "TypeSafe JEV decision service for the optional JEV Combo strategy. This credential-only preset does not publish a directly routable model.",
  },
  {
    id: "baseten",
    label: "Baseten Model APIs",
    baseUrl: "https://inference.baseten.co/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://app.baseten.co/settings/api_keys",
    liveModels: true,
    preserveCustomDestination: true,
    // Baseten's Chat Completions contract documents parallel_tool_calls as default-on.
    parallelToolCalls: true,
    // Baseten says models outside its reasoning table do not support reasoning. Keep
    // unknown/new live slugs conservative until an official-docs registry refresh proves it.
    reasoningEfforts: [],
    // `text.verbosity` is an OpenAI Responses parameter. Baseten documents its Model
    // APIs as Chat Completions compatible, so there is nothing on that wire for it to
    // become, and a routed row must not inherit the Codex template's verbosity picker
    // (#4630: Codex sent `text: { verbosity: "low" }` and the turn 400'd before any
    // model output). Provider-wide rather than per-model because this catalog is live-
    // discovered: a slug that arrives tomorrow supports it no more than the seeded ones.
    supportsVerbosity: false,
    modelReasoningEfforts: BASETEN_MODEL_REASONING_EFFORTS,
    modelReasoningEffortMap: BASETEN_MODEL_REASONING_EFFORT_MAP,
    modelDefaultReasoningEfforts: BASETEN_MODEL_DEFAULT_REASONING_EFFORTS,
    modelInputModalities: BASETEN_MODEL_INPUT_MODALITIES,
    modelDiscovery: {
      path: "models",
      maxResponseBytes: 1_048_576,
      maxModels: 256,
    },
    note: "Shared Model APIs only (personal API key, or team key with Call Model APIs access); dedicated Truss predict endpoints are outside this preset.",
  },
  {
    id: "commandcode",
    label: "Command Code - API",
    adapter: "openai-chat",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    authKind: "key",
    dashboardUrl: "https://commandcode.ai/studio/",
    liveModels: true,
    preserveCustomDestination: true,
    defaultModel: "deepseek/deepseek-v4-flash",
    promptCacheKey: true,
    // The default is also the cold-start seed: live discovery failure must not empty the catalog
    // for a freshly configured provider with no stale cache (issue #308 pattern).
    models: ["deepseek/deepseek-v4-flash"],
    // The public model catalog is unauthenticated, so a Bearer probe cannot prove key validity.
    apiKeyValidation: "unknown",
    // The public catalog reports ids/context windows only; no trustworthy reasoning contract.
    reasoningEfforts: [],
    // Official Command Code model-profile reasoning facts (shared with the OAuth
    // `command-code` entry). Without them the API-key preset never advertises a
    // reasoning picker, and the router's known-ids decode source misses the native
    // slash ids — so a Codex-facing slug like `commandcode/deepseek-deepseek-v4-flash`
    // is sent upstream verbatim and rejected with `unsupported_model`.
    modelReasoningEfforts: COMMAND_CODE_MODEL_REASONING_EFFORTS,
    // The DeepSeek vision preview id is preemptive for when the catalog serves it
    // (merges into v4-flash later).
    modelContextWindows: {
      [`deepseek/${DEEPSEEK_VISION_PREVIEW_MODEL}`]: 1_048_576,
      ...COMMAND_CODE_MIMO_CONTEXT_WINDOWS,
    },
    modelInputModalities: COMMAND_CODE_MODEL_INPUT_MODALITIES,
    modelDiscovery: {
      path: "models",
      maxResponseBytes: 256 * 1024,
      maxModels: 256,
    },
    // Verified 2026-08-03: public /provider/v1/models returns 51 rows; /chat/completions returns
    // 401 UNAUTHORIZED without a Bearer key. Primary source: https://commandcode.ai/docs/provider.
    note: "Command Code Provider API (OpenAI-compatible); API access requires the Provider plan. Use `ocx login command-code` for OAuth account login (imports an existing local Command Code CLI credential when present). Docs: https://commandcode.ai/docs/provider.",
  },
  {
    id: "sambanova",
    label: "SambaNova Cloud",
    baseUrl: "https://api.sambanova.ai/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://cloud.sambanova.ai/apis",
    liveModels: true,
    preserveCustomDestination: true,
    apiKeyValidation: "unknown",
    // SambaNova documents this request field but does not yet support parallel function calls.
    parallelToolCalls: false,
    // The public catalog does not report a trustworthy per-model reasoning contract.
    reasoningEfforts: [],
    modelDiscovery: {
      path: "models",
      maxResponseBytes: 128 * 1024,
      maxModels: 128,
    },
    note: "SambaNova Cloud text-generation models only; private SambaStudio deployment endpoints are outside this preset.",
  },
  {
    id: "nebius",
    label: "Nebius Token Factory",
    baseUrl: "https://api.tokenfactory.nebius.com/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://tokenfactory.nebius.com",
    liveModels: true,
    preserveCustomDestination: true,
    // The public tools guide documents single function selection, not parallel tool calls.
    parallelToolCalls: false,
    // Missing reasoning metadata must not promote a model to Codex's full fallback ladder.
    reasoningEfforts: [],
    modelDiscovery: {
      path: "models",
      query: { verbose: "true" },
      maxResponseBytes: 512 * 1024,
      maxModels: 512,
      filter: {
        // Keep rows whose reported architecture output includes text (for example,
        // text->text or text+image->text); embedding and image-generation rows are excluded.
        allOf: [{ path: ["architecture", "modality"], containsAny: ["->text"] }],
      },
    },
    note: "Shared Token Factory text-output inference only; live discovery excludes embedding and image-generation rows.",
  },
  {
    // Primary sources checked 2026-09-11:
    // - https://docs.crusoecloud.com/quickstart/getting-started-with-serverless-inference documents
    //   the fixed OpenAI-compatible host https://api.inference.crusoecloud.com/v1, Bearer API keys
    //   created in the Cloud console (Intelligence Foundry > Inference > Create API Key), and an
    //   OpenAI SDK chat.completions example against meta-llama/Llama-3.3-70B-Instruct.
    // - https://docs.crusoecloud.com/serverless-inference/available-models lists the served models
    //   with slash-delimited ids; https://docs.crusoecloud.com/serverless-inference/rate-limits
    //   documents per-project, per-model TPM/RPM limits (429 when exceeded, 503 under shared load).
    // - GET /v1/models rejects unauthenticated requests with 401 {"errors":["Authentication failed"]},
    //   so a successful authenticated list response is evidence that the supplied key is valid.
    //   An authenticated capture on 2026-09-12 returned 18 rows shaped like OpenRouter's catalog
    //   (`is_public`, `type`, `context_length`, `architecture.modality` of "text" or "multimodal",
    //   `tags`, `pricing`, `supported_parameters`); 17 were public serverless models and one was an
    //   account-private dedicated deployment with empty `type`/`modality`. `type` is blank on one
    //   public model, so the filter keys on `is_public` plus `architecture.modality` instead.
    // - https://legal.crusoe.ai/ hosts the Crusoe Cloud Platform Terms of Service v1.10 (effective
    //   2026-08-10), which name Crusoe Technologies LLC as the contracting entity, and the Service
    //   Specific Terms v5.0 (effective 2026-07-14), whose Crusoe Intelligence Foundry Terms cover the
    //   Managed Inference Service reached through the Crusoe API.
    // - https://models.dev/api.json (provider "crusoe") records openai/gpt-oss-120b as the one served
    //   model with a low/medium/high reasoning_effort ladder; the other reasoning models expose an
    //   on/off toggle only.
    // Maintainer: @acheamponge, who works at Crusoe (affiliation disclosed) and also maintains the
    // models.dev crusoe entry.
    id: "crusoe",
    label: "Crusoe",
    baseUrl: "https://api.inference.crusoecloud.com/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://console.crusoecloud.com",
    liveModels: true,
    preserveCustomDestination: true,
    // The getting-started guide documents tools through the OpenAI SDK but no provider-wide
    // parallel tool-call contract.
    parallelToolCalls: false,
    // Only gpt-oss-120b has a real effort ladder; toggle-style reasoning models must not be promoted
    // to Codex's full fallback ladder.
    reasoningEfforts: [],
    modelReasoningEfforts: { "openai/gpt-oss-120b": ["low", "medium", "high"] },
    directReasoningEffortModels: ["openai/gpt-oss-120b"],
    // The catalog reports `architecture.modality: "multimodal"` without an input list. Four rows
    // also carry the explicit "image text to text" tag; yutori/n2 instead reports multimodal
    // type/modality plus browser/computer-use tags. Those five captured rows are classified here.
    modelInputModalities: {
      "google/gemma-4-31b-it": ["text", "image"],
      "moonshotai/Kimi-K2.6": ["text", "image"],
      "nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B": ["text", "image"],
      "yutori/n2": ["text", "image"],
      "zai-org/GLM-5.3-Flash": ["text", "image"],
    },
    modelDiscovery: {
      path: "models",
      maxResponseBytes: 256 * 1024,
      maxModels: 256,
      filter: {
        // Keep public serverless rows whose architecture produces text; account-private
        // deployments (blank modality) and any embedding or media rows fail closed.
        allOf: [
          { path: ["is_public"], equalsAny: [true] },
          { path: ["architecture", "modality"], equalsAny: ["text", "multimodal"] },
        ],
      },
    },
    note: "Public Serverless Inference chat models on the shared OpenAI-compatible host; account-private and self-serve dedicated deployments are excluded from discovery and out of scope.",
  },
  {
    id: "digitalocean",
    label: "DigitalOcean Serverless Inference",
    baseUrl: "https://inference.do-ai.run/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://cloud.digitalocean.com/model-studio/manage-keys",
    liveModels: true,
    preserveCustomDestination: true,
    // The Chat Completions contract documents function calls but not universal parallel support.
    parallelToolCalls: false,
    // Unknown catalog rows must not inherit Codex's full fallback reasoning ladder.
    reasoningEfforts: [],
    modelDiscovery: {
      path: "models",
      maxResponseBytes: 256 * 1024,
      maxModels: 256,
      filter: {
        allOf: [{ path: ["id"], equalsAny: DIGITALOCEAN_CHAT_COMPLETION_MODELS }],
      },
    },
    note: "Shared Serverless Inference Chat Completions only; agent-specific, dedicated, Responses-only, embedding, and media-generation models are outside this preset.",
  },
  {
    id: "scaleway",
    label: "Scaleway Generative APIs",
    baseUrl: "https://api.scaleway.ai/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://console.scaleway.com/generative-api",
    liveModels: true,
    freeTier: true,
    preserveCustomDestination: true,
    // Parallel support varies by model; avoid advertising it as a provider-wide capability.
    parallelToolCalls: false,
    // The generic `/models` rows carry no trustworthy reasoning metadata.
    reasoningEfforts: [],
    modelInputModalities: SCALEWAY_MODEL_INPUT_MODALITIES,
    modelDiscovery: {
      path: "models",
      maxResponseBytes: 128 * 1024,
      maxModels: 128,
      filter: {
        allOf: [{ path: ["id"], equalsAny: SCALEWAY_SERVERLESS_CHAT_MODELS }],
      },
    },
    note: "Shared Generative APIs Serverless Chat Completions only; project-qualified and dedicated deployment hosts require a custom provider.",
  },
  {
    // Primary sources checked 2026-08-08:
    // - https://featherless.ai/docs/api-overview-and-common-options documents the fixed
    //   OpenAI-compatible base URL, Bearer keys, and Chat Completions.
    // - https://featherless.ai/docs/api-reference-models documents authenticated plan filtering,
    //   chat capability filtering, popularity sorting, pagination, and per-row tool metadata.
    // - https://featherless.ai/legal/terms-of-service identifies Featherless as a Delaware LLC,
    //   covers developers building on its APIs, and reserves arbitrary applications for Scale
    //   plans. Maintainer: @olddonkey; no affiliation with Featherless.
    id: "featherless",
    label: "Featherless AI",
    baseUrl: "https://api.featherless.ai/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://featherless.ai/account/api-keys",
    liveModels: true,
    preserveCustomDestination: true,
    // /v1/models is documented as callable authenticated or unauthenticated, so a 2xx catalog
    // response cannot prove that the supplied Bearer key is valid.
    apiKeyValidation: "unknown",
    // Featherless documents tool calling, but not a provider-wide parallel tool-call contract.
    parallelToolCalls: false,
    // Reasoning controls use model-specific chat_template_kwargs, not OpenAI reasoning_effort.
    reasoningEfforts: [],
    modelDiscovery: {
      path: "models",
      query: {
        available_on_current_plan: "true",
        capabilities: "chat",
        page: "1",
        per_page: "100",
        sort: "-popularity",
      },
      maxResponseBytes: 128 * 1024,
      maxModels: 100,
      filter: {
        // Treat server-side filters as a size optimization, not an authority boundary. A row must
        // independently prove plan availability, no separate Hugging Face gate, and tool support.
        allOf: [
          { path: ["available_on_current_plan"], equalsAny: [true] },
          { path: ["is_gated"], equalsAny: [false] },
          { path: ["features", "tool_use"], equalsAny: [true] },
        ],
      },
    },
    note: "Authenticated first page of popular chat models only; live discovery admits at most 100 plan-available, ungated rows whose metadata explicitly reports tool use.",
  },
  {
    // Primary sources checked 2026-08-08:
    // - https://novita.ai/docs/api-reference/model-apis-llm-create-chat-completion and
    //   https://novita.ai/docs/api-reference/model-apis-llm-list-models document the fixed
    //   OpenAI-compatible Chat Completions and model-list endpoints.
    // - https://novita.ai/docs/api-reference/basic-authentication documents Bearer API keys.
    // - https://novita.ai/legal/terms-of-service (updated 2026-08-05) expressly covers AI
    //   inference APIs, third-party Model Providers, and customer Input/Output processing.
    // - https://huggingface.co/docs/inference-providers/main/providers/novita lists Novita as an
    //   Inference Providers partner for chat/VLM traffic, independently supporting routing use.
    // - https://tsdr.uspto.gov/statusview/sn99255805 is the official use-in-commerce record
    //   connecting the NOVITA AI mark to Hivemind Labs, Inc., a Delaware corporation. The mark
    //   application is now abandoned; it is cited only as the public operator-identity record.
    // Maintainer: @olddonkey; no affiliation with Novita AI or Hivemind Labs, Inc.
    id: "novita",
    label: "Novita AI",
    baseUrl: "https://api.novita.ai/openai/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://novita.ai/settings/key-management",
    liveModels: true,
    preserveCustomDestination: true,
    // The live catalog is public even though the reference shows an Authorization header, so a
    // successful model fetch cannot prove that a supplied key is valid.
    apiKeyValidation: "unknown",
    // The request reference documents tools but not a provider-wide parallel-tool contract.
    parallelToolCalls: false,
    // Novita exposes model-specific thinking flags, not an OpenAI reasoning_effort contract.
    reasoningEfforts: [],
    modelDiscovery: {
      path: "models",
      maxResponseBytes: 512 * 1024,
      maxModels: 256,
      filter: {
        // Require both Novita's chat classification and the exact configured wire endpoint.
        allOf: [
          { path: ["model_type"], equalsAny: ["chat"] },
          { path: ["endpoints"], containsAny: ["chat/completions"] },
        ],
      },
    },
    note: "Public live catalog filtered to rows that explicitly report chat type and Chat Completions support; key validity remains unknown until an authenticated inference request.",
  },
  // FREEZE 2026-07-10: exact serverless ids remain auth-gated/unverified. Evidence: devlog/_plan/260710_provider_hardening/003_research_aggregators.md.
  { id: "together", label: "Together", baseUrl: "https://api.together.xyz/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://api.together.xyz/settings/api-keys" },
  { id: "fireworks", label: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://fireworks.ai/account/api-keys" },
  {
    id: "firepass", label: "Fire Pass (Fireworks Kimi)", baseUrl: "https://api.fireworks.ai/inference/v1", adapter: "openai-chat", authKind: "key",
    dashboardUrl: "https://fireworks.ai/account/api-keys",
    note: "Model data frozen pending Tier-2 entitlement proof",
  },
  {
    id: "moonshot", label: "Moonshot (Kimi API)", baseUrl: MOONSHOT_INTL_BASE_URL, adapter: "openai-chat", authKind: "key",
    allowBaseUrlOverride: true,
    baseUrlChoices: MOONSHOT_BASE_URL_CHOICES,
    dashboardUrl: "https://platform.moonshot.ai/console/api-keys", defaultModel: "kimi-k2.7-code", jawcodeBundle: "moonshot",
    models: KIMI_API_MODELS,
    modelContextWindows: KIMI_API_MODEL_CONTEXT_WINDOWS,
    modelInputModalities: KIMI_API_MODEL_INPUT_MODALITIES,
    noReasoningModels: KIMI_API_NO_REASONING_MODELS,
    modelReasoningEfforts: KIMI_API_REASONING_EFFORTS,
    noTemperatureModels: KIMI_API_MODELS,
    noTopPModels: KIMI_API_MODELS,
    noPenaltyModels: KIMI_API_MODELS,
    autoToolChoiceOnlyModels: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    preserveReasoningContentModels: KIMI_API_MODELS,
    note: "International default (api.moonshot.ai). China accounts: choose China (.cn) or Custom for api.moonshot.cn.",
  },
  { id: "huggingface", label: "Hugging Face", baseUrl: "https://router.huggingface.co/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://huggingface.co/settings/tokens" },
  // 260715 NIM hardening (issue #126, devlog/_plan/260715_issue126_nim_kimi):
  // - NIM kimi rejects `parallel_tool_calls: true` with 400 "This model only supports single
  //   tool-calls at once!" (openclaw#37048). NVIDIA's own function-calling docs default the
  //   Boolean to false, so provider-wide `false` is the documented-safe wire value.
  // - `reasoning_effort` is not portable on NIM (models use chat_template_kwargs); the kimi
  //   family is live-discovered with no capability metadata, so Codex would otherwise send
  //   reasoning_effort=medium. Exact-id lists per modelInList semantics; gpt-oss on NIM keeps
  //   its working reasoning_effort. Future kimi ids must be appended individually.
  {
    id: "nvidia", label: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://build.nvidia.com",
    // Free pricing, but an API key is still required (free key from build.nvidia.com).
    freeTier: true,
    parallelToolCalls: false,
    // 260804 issue #956: NIM exposes no input modalities, so vision capability is
    // classified here. Both lists are verified per-model; unlisted ids stay unclassified
    // by design (see the comment on NVIDIA_NIM_VISION_MODELS).
    noVisionModels: NVIDIA_NIM_NO_VISION_MODELS,
    modelInputModalities: NVIDIA_NIM_VISION_INPUT_MODALITIES,
    noReasoningModels: NVIDIA_NIM_KIMI_MODELS,
    modelReasoningEfforts: Object.fromEntries(NVIDIA_NIM_KIMI_MODELS.map(id => [id, []])),
    preserveReasoningContentModels: NVIDIA_NIM_KIMI_THINKING_MODELS,
    note: "Free tier on NVIDIA NIM — API key still required (get a free key at build.nvidia.com).",
  },
  { id: "venice", label: "Venice", baseUrl: "https://api.venice.ai/api/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://venice.ai/settings/api" },
  // 260710 GLM-5.2 context and path-specific ids: Tier-2 evidence in
  // devlog/_plan/260710_provider_hardening/002_research_cn.md.
  // 260814: glm-5.3 / glm-5.3[1m] added per docs.z.ai/devpack/latest-model, which lists them as
  // Coding Plan ids on this same endpoint.
  // 260815: docs.z.ai/guides/llm/glm-5.3 now publishes the capability table (thinking, streaming,
  // function calling, caching, structured output) and a 128K output budget, recorded here as the
  // exact 131_072 every other source in this repo uses for that model. Coding Plan pricing stays
  // unpublished, so no cost entry is asserted.
  {
    id: "zai", label: "Z.AI — GLM Coding Plan", baseUrl: "https://api.z.ai", adapter: "openai-responses", authKind: "key",
    // One subscription and one key, three protocols. docs.z.ai/guides/llm/glm-5.3 lists them:
    // Chat Completions at /api/coding/paas/v4, Responses at /api/v1, Anthropic Messages at
    // /api/anthropic. docs.z.ai/devpack/latest-model points Codex-family clients at /api/v1,
    // and the Chat path is the one that misbehaves in practice.
    //
    // Responses is the default and Chat stays reachable per model through `modelAdapters`.
    // The two wires sit under different prefixes, and a wire override swaps the adapter
    // without touching baseUrl, so each wire carries its own relative send path.
    //
    // Measured 2026-09-12 against a live key: every roster id answers 200 on
    // /api/v1/responses, and every one also answers 200 on the Chat prefix, so no model
    // needs a `modelWireDefaults` pin. /api/v1/chat/completions returns 403
    // model_access_denied, which is why the Chat path cannot simply hang off the new base.
    responsesPath: "/api/v1/responses",
    chatCompletionsPath: "/api/coding/paas/v4/chat/completions",
    modelDiscovery: { path: "/api/v1/models", envelopeKey: "models", idField: "slug" },
    // The address this row occupied before the move. A saved custom provider still pointing
    // at the Chat endpoint keeps receiving this row's metadata (#1100).
    destinationAliases: [{ baseUrl: "https://api.z.ai/api/coding/paas/v4", adapter: "openai-chat" }],
    dashboardUrl: "https://z.ai/manage-apikey/apikey-list", defaultModel: "glm-5.3",
    note: "GLM-5.3 coding subscription",
    models: ["glm-5.3", "glm-5.3[1m]", "glm-5.3-flash", "glm-5.2", "glm-5.2[1m]", "glm-5.1", "glm-5", "glm-4.6"],
    // The upstream catalog reports 1_048_576 for the 5.3 family, which is what the domestic
    // Responses row already carries. Both are documented as "1M"; this is that number.
    modelContextWindows: { "glm-5.3": 1_048_576, "glm-5.3[1m]": 1_048_576, "glm-5.3-flash": 1_048_576, "glm-5.2": 1_000_000, "glm-5.2[1m]": 1_000_000 },
    // Z.AI returns 400 for bracketed model ids on both wires; the aliases are local.
    modelSuffixBracketStrip: true,
    noVisionModels: ZAI_GLM_5X_SIDECAR_VISION_MODELS,
    modelInputModalities: ZAI_GLM_5X_INPUT_MODALITIES,
    modelReasoningEfforts: ZAI_GLM_5X_REASONING_EFFORTS,
    modelDefaultReasoningEfforts: Object.fromEntries(ZAI_GLM_53_MODELS.map(id => [id, "max"])),
    modelMaxOutputTokens: Object.fromEntries(ZAI_GLM_53_MODELS.map(id => [id, 131_072])),
    modelSupportsReasoningSummaries: Object.fromEntries(ZAI_GLM_5X_MODELS.map(id => [id, true])),
    preserveReasoningContentModels: ZAI_GLM_5X_MODELS,
    // Responses replay uses this provider-level flag; the model list above still covers a
    // caller who opts back into Chat.
    preserveResponsesReasoningContent: true,
  },
  // Zhipu's domestic BigModel platform: OpenAI-compatible pay-as-you-go on open.bigmodel.cn — a
  // different host and billing product from the `zai` coding-plan subscription above.
  // The id is deliberately NOT `glm` or `glm-cn`: both are already bound in FREE_PROVIDER_DIRECTORY
  // (to api.z.ai and to the BigModel *coding* path), and routedProviderConfig() canonicalizes a
  // saved provider onto the registry baseUrl — reusing either id would silently retarget an
  // existing config's endpoint and send its API key to another host.
  // Evidence: docs.bigmodel.cn/api-reference (OpenAI-compatible chat completions),
  // docs.bigmodel.cn/cn/guide/models/text/glm-4.6 (thinking: {type: enabled|disabled}).
  // Originally proposed in #536 by @Lucinegogo.
  {
    id: "zhipu-bigmodel",
    label: "Zhipu AI — BigModel",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://bigmodel.cn/console/usercenter/apikeys",
    defaultModel: "glm-4.6",
    models: ZHIPU_BIGMODEL_MODELS,
    // The GLM families here are the same ones the `zai` metadata bundle already describes, so the
    // bundle owns context windows and modalities for the whole list instead of a hand-copied table.
    jawcodeBundle: "zai",
    // Declared explicitly for the default model so its window survives a bundle-lookup miss:
    // without it, catalog normalization falls back to a generic 128k and compacts ~76,800 early.
    modelContextWindows: { "glm-4.6": 204_800 },
    modelInputModalities: ZHIPU_BIGMODEL_INPUT_MODALITIES,
    // GLM exposes a binary thinking knob, not an effort ladder: the adapter emits
    // `thinking: {type}` for these ids and would otherwise send a rejected reasoning_effort.
    thinkingToggleModels: ZHIPU_BIGMODEL_THINKING_TOGGLE_MODELS,
    modelReasoningEfforts: Object.fromEntries(
      ZHIPU_BIGMODEL_THINKING_TOGGLE_MODELS.map(id => [id, THINKING_TOGGLE_EFFORTS]),
    ),
    modelReasoningEffortMap: Object.fromEntries(
      ZHIPU_BIGMODEL_THINKING_TOGGLE_MODELS.map(id => [id, THINKING_TOGGLE_MAP]),
    ),
    modelSupportsReasoningSummaries: Object.fromEntries(
      ZHIPU_BIGMODEL_THINKING_TOGGLE_MODELS.map(id => [id, true]),
    ),
    preserveReasoningContentModels: ZHIPU_BIGMODEL_THINKING_TOGGLE_MODELS,
    // GLM thinking is a binary toggle (low maps to disabled), so a legitimate
    // tool round can carry no reasoning at all; never fabricate a placeholder
    // for it, only replay real recorded text (P2 on #1205).
    requiresReasoningPlaceholderModels: [],
    // No liveModels: GET /api/paas/v4/models has not been observed to answer on this host, and a
    // false live claim yields an empty picker at runtime. Flip it on once someone verifies it.
    note: "Domestic BigModel pay-as-you-go endpoint (open.bigmodel.cn)",
  },
  // BigModel's Coding Plan is a SEPARATE endpoint from the pay-as-you-go row above, and that is
  // the whole reason this one exists. #1100 was reported against
  // `https://open.bigmodel.cn/api/coding/paas/v4`; the row above covers only `/api/paas/v4`, so
  // destination enrichment matched nothing, `modelSupportsReasoningSummaries` stayed unset, and
  // Codex kept dropping the inbound reasoning object — effort displayed as `-`.
  //
  // A prefix or fuzzy endpoint match would have been the shortcut. It is also how a config
  // pointed at one vendor route silently inherits another route's metadata, so endpoints stay
  // exact and each one gets its own row.
  //
  // The id is NOT `glm-cn`, which the free-provider directory already binds to this same coding
  // path: registering it here would let routedProviderConfig() canonicalize a saved `glm-cn`
  // config onto this baseUrl. Same reasoning as `zhipu-bigmodel` above.
  //
  // Models follow Z.AI's coding-plan list rather than the pay-as-you-go one. This endpoint is
  // the subscription product, and the reporter's `glm-5.2` is only on that side.
  {
    id: "zhipu-bigmodel-coding",
    label: "Zhipu AI — BigModel Coding Plan",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://bigmodel.cn/console/usercenter/apikeys",
    defaultModel: "glm-5.3",
    models: ["glm-5.3", "glm-5.3[1m]", "glm-5.3-flash", "glm-5.2", "glm-5.2[1m]", "glm-5.1", "glm-5", "glm-4.6"],
    jawcodeBundle: "zai",
    modelContextWindows: { "glm-5.3": 1_000_000, "glm-5.3[1m]": 1_000_000, "glm-5.3-flash": 1_000_000, "glm-5.2": 1_000_000, "glm-5.2[1m]": 1_000_000 },
    modelSuffixBracketStrip: true,
    noVisionModels: ZAI_GLM_5X_SIDECAR_VISION_MODELS,
    modelInputModalities: ZAI_GLM_5X_INPUT_MODALITIES,
    modelReasoningEfforts: ZAI_GLM_5X_REASONING_EFFORTS,
    modelSupportsReasoningSummaries: Object.fromEntries(ZAI_GLM_5X_MODELS.map(id => [id, true])),
    preserveReasoningContentModels: ZAI_GLM_5X_MODELS,
    // No liveModels: the same reasoning as the pay-as-you-go row — an unverified live claim
    // yields an empty picker at runtime.
    note: "Domestic BigModel Coding Plan endpoint (open.bigmodel.cn)",
  },
  // Narrowed carry of #3641: the official Codex example declares a local static catalog,
  // not an HTTP /models contract. Keep Responses separate from the Chat endpoint above.
  // Source: https://docs.bigmodel.cn/cn/coding-plan/tool/codex.md (checked 2026-09-07).
  //
  // #4201 completes the roster. The `models.json` example on that Codex page is a *starter
  // catalog*, not the set of models the endpoint serves, and reading it as the latter is what
  // left Flash off a subscription that sells it. Three upstream pages say so directly, all
  // checked 2026-09-11:
  //   - coding-plan/latest-model.md pins Codex to THIS baseUrl
  //     (`Codex：https://open.bigmodel.cn/api/v1`) and opens with GLM Coding Plan supporting
  //     GLM-5.3 and GLM-5.3-Flash for every tier (Max & Pro & Lite), then treats
  //     `glm-5.3-flash` as an already-callable id in that same tool.
  //   - coding-plan/overview.md: every plan supports GLM-5.3 and GLM-5.3-Flash, and calls to
  //     GLM-5-Turbo are auto-switched to GLM-5.3-Flash. Turbo below is therefore an alias of
  //     the very model this row omitted, which is the clearest statement that the endpoint
  //     serves Flash: it was already serving it under another name.
  //   - guide/models/vlm/glm-5.3-flash.md: native multimodal input, 1M context, and text
  //     parameters explicitly "consistent with GLM-5.3".
  // No authenticated /models probe is implied by any of this, so `liveModels` and
  // `apiKeyValidation` below are deliberately unchanged.
  {
    id: "zhipu-bigmodel-responses",
    label: "Zhipu AI — BigModel Coding Plan (Responses)",
    baseUrl: "https://open.bigmodel.cn/api/v1",
    adapter: "openai-responses",
    authKind: "key",
    dashboardUrl: "https://bigmodel.cn/console/usercenter/apikeys",
    defaultModel: "glm-5.3",
    models: ["glm-5.3", "glm-5.3-flash", "glm-5-turbo"],
    liveModels: false,
    // The local Codex catalog does not establish an authenticated HTTP /models contract.
    apiKeyValidation: "unknown",
    jawcodeBundle: "zai",
    // A pre-existing same-named custom provider must retain its destination and key boundary.
    preserveCustomDestination: true,
    // Flash tracks its 5.3 sibling on this row rather than the Chat row's 1_000_000. Both
    // models are documented as "1M", and this preset expresses that family's 1M the way
    // BigModel's own Codex declaration does. Splitting the two would leave one preset
    // claiming two different sizes for one documented window.
    modelContextWindows: { "glm-5.3": 1_048_576, "glm-5.3-flash": 1_048_576, "glm-5-turbo": 204_800 },
    // Flash is the only row here that can actually see an image. Its siblings are declared
    // text-only and get `image` back from the vision sidecar at catalog-build time; declaring
    // Flash text-only would route a native VLM's pictures through a describe-it-first detour
    // and hand the model prose about an image it could have read (same defect
    // ZAI_GLM_5X_SIDECAR_VISION_MODELS exists to prevent on the Chat rows).
    modelInputModalities: { "glm-5.3": ["text"], "glm-5.3-flash": ["text", "image"], "glm-5-turbo": ["text"] },
    modelReasoningEfforts: {
      "glm-5.3": ZAI_GLM_53_REASONING_EFFORTS,
      // Same three effective tiers: upstream documents Flash's text parameters as identical
      // to GLM-5.3, and the Codex effort table folds every inbound value into low/high/max.
      "glm-5.3-flash": ZAI_GLM_53_REASONING_EFFORTS,
      // Explicitly empty: Turbo must not inherit the generic selectable effort ladder.
      "glm-5-turbo": [],
    },
    modelDefaultReasoningEfforts: { "glm-5.3": "max", "glm-5.3-flash": "max", "glm-5-turbo": "max" },
    modelSupportsReasoningSummaries: { "glm-5.3": true, "glm-5.3-flash": true, "glm-5-turbo": true },
    // Responses replay uses this provider-level flag, not the Chat-path model list.
    preserveResponsesReasoningContent: true,
    note: "Domestic BigModel Coding Plan Responses endpoint; static model roster",
  },
  { id: "nanogpt", label: "NanoGPT", baseUrl: "https://nano-gpt.com/api/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://nano-gpt.com/api" },
  { id: "synthetic", label: "Synthetic", baseUrl: "https://api.synthetic.new/openai/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://synthetic.new" },
  // SiliconFlow publishes an OpenAI-compatible chat endpoint and a dynamic model catalog. Do not
  // freeze reasoning controls here: enable_thinking/thinking_budget support and limits vary by
  // model, so live metadata or an explicit user override must own those capabilities.
  // Evidence: https://docs.siliconflow.cn/en/api-reference/chat-completions/chat-completions
  {
    id: "siliconflow",
    label: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://cloud.siliconflow.cn/account/ak",
    liveModels: true,
    note: "OpenAI-compatible live model catalog; reasoning controls vary by model.",
  },
  // Qwen Cloud: token plan is the preset default; GUI offers pay-as-you-go + custom via baseUrlChoices.
  // Formerly `qwen-portal` / portal.qwen.ai — that host is outdated.
  {
    id: "qwen-cloud",
    label: "Qwen Cloud",
    baseUrl: QWEN_CLOUD_TOKEN_PLAN_BASE_URL,
    adapter: "openai-chat",
    authKind: "key",
    allowBaseUrlOverride: true,
    baseUrlChoices: QWEN_CLOUD_BASE_URL_CHOICES,
    dashboardUrl: "https://docs.qwencloud.com",
    note: "Pick token plan, pay as you go, or a custom compatible-mode base URL",
  },
  {
    id: "tencent-coding-plan",
    label: "Tencent Cloud Coding Plan",
    baseUrl: "https://api.lkeap.cloud.tencent.com/coding/v3",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://console.cloud.tencent.com/tokenhub/codingplan",
    defaultModel: "tc-code-latest",
    models: TENCENT_CODING_PLAN_MODELS,
    liveModels: true,
    modelInputModalities: Object.fromEntries(TENCENT_CODING_PLAN_MODELS.map(id => [id, ["text"]])),
    noVisionModels: TENCENT_CODING_PLAN_MODELS,
    note: "Coding tools only. Tencent forbids general API automation, custom backends, and non-interactive batch use.",
  },
  {
    id: "volcengine",
    label: "Volcengine Ark",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    adapter: "openai-chat",
    authKind: "key",
    preserveCustomDestination: true,
    dashboardUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apikey",
    defaultModel: "doubao-seed-2-1-pro-260628",
    models: VOLCENGINE_ARK_MODELS,
    liveModels: false,
    modelReasoningEfforts: Object.fromEntries(
      VOLCENGINE_DOUBAO_THINKING_MODELS.map(id => [id, THINKING_TOGGLE_EFFORTS]),
    ),
    modelReasoningEffortMap: Object.fromEntries(
      VOLCENGINE_DOUBAO_THINKING_MODELS.map(id => [id, THINKING_TOGGLE_MAP]),
    ),
    thinkingToggleModels: VOLCENGINE_DOUBAO_THINKING_MODELS,
    preserveReasoningContentModels: [
      "deepseek-v4-flash-260425",
      "glm-5-2-260617",
      "glm-4-7-251222",
    ],
    noVisionModels: [
      "deepseek-v4-flash-260425",
      "deepseek-v3-2-251201",
      "glm-5-2-260617",
      "glm-4-7-251222",
    ],
    note: "Pay-as-you-go Ark API with a curated text/agent catalog. Calls on this endpoint do not consume Coding Plan or Agent Plan quota.",
  },
  {
    id: "volcengine-coding-plan",
    label: "Volcengine Ark Coding Plan",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    responsesPath: "/responses",
    adapter: "openai-responses",
    authKind: "key",
    supportsServiceTier: false,
    preserveCustomDestination: true,
    // A row already saved on Chat keeps Chat. This is a `preserveCustomDestination` key entry,
    // so `providerMatchesRegistryTransport` refuses the adapter mismatch and the request path
    // returns the stored row untouched; the alias below still hands it this entry's metadata.
    // Deliberately no startup config migration: the Z.AI one (`zai-responses-migration.ts`) is
    // safe only because it rewrites rows the router already canonicalizes, and it gates on
    // `providerMatchesRegistryTransport` to guarantee that. A Chat row here is NOT canonicalized,
    // so migrating it would change a wire the operator is actually using, and a marker added
    // now cannot tell the old default apart from a deliberate pre-upgrade Chat choice.
    destinationAliases: [{ baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", adapter: "openai-chat" }],
    // Validated Ark Coding Plan continuations reject replayed reasoning items.
    dropResponsesReasoningItems: true,
    dashboardUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/overview",
    defaultModel: "ark-code-latest",
    models: VOLCENGINE_CODING_PLAN_MODELS,
    liveModels: false,
    modelInputModalities: VOLCENGINE_PLAN_INPUT_MODALITIES,
    noVisionModels: VOLCENGINE_PLAN_TEXT_ONLY_MODELS,
    modelReasoningEfforts: Object.fromEntries(
      DEEPSEEK_V4_LEGACY_MODELS.map(id => [id, deepseekThinkingEffortsFor(id)]),
    ),
    modelReasoningEffortMap: Object.fromEntries(
      DEEPSEEK_V4_LEGACY_MODELS.map(id => [id, deepseekReasoningMapFor(id)]),
    ),
    preserveReasoningContentModels: DEEPSEEK_V4_LEGACY_MODELS,
    note: "Coding tools only. Volcengine restricts Coding Plan quota to supported AI coding tools and warns that using this key for general API calls may suspend the subscription or ban the account. Use the plan key issued by the Ark console.",
  },
  {
    id: "volcengine-agent-plan",
    label: "Volcengine Ark Agent Plan",
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
    responsesPath: "/responses",
    adapter: "openai-responses",
    authKind: "key",
    // Ark's plan route does not document `service_tier`; fail closed like DeepSeek.
    supportsServiceTier: false,
    preserveCustomDestination: true,
    dashboardUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/overview",
    // Was `deepseek-v4-pro` until DeepSeek retired it; the plan roster's other DeepSeek
    // entry takes over so a fresh install still lands on a working default.
    defaultModel: "deepseek-v4-flash",
    models: VOLCENGINE_AGENT_PLAN_MODELS,
    liveModels: false,
    modelInputModalities: VOLCENGINE_PLAN_INPUT_MODALITIES,
    noVisionModels: VOLCENGINE_PLAN_TEXT_ONLY_MODELS,
    note: "Coding tools only. Agent Plan is a subscription endpoint over the native Responses API with a static fallback catalog; Ark plan quota is intended for supported AI coding and agent tools, so avoid using this key as a general-purpose API key.",
  },
  // 2026-07-10: docs unverified; model data frozen. Evidence: devlog/_plan/260710_provider_hardening/002_research_cn.md.
  { id: "qianfan", label: "Qianfan (Baidu)", baseUrl: "https://qianfan.baidubce.com/v2", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://console.bce.baidu.com/iam/#/iam/apikey/list" },
  // 2026-07-10: docs unverified; model data frozen. Evidence: devlog/_plan/260710_provider_hardening/002_research_cn.md.
  { id: "alibaba", label: "Alibaba Coding Plan", baseUrl: ALIBABA_CODING_INTL_BASE_URL, adapter: "openai-chat", authKind: "key", allowBaseUrlOverride: true, baseUrlChoices: ALIBABA_CODING_BASE_URL_CHOICES, dashboardUrl: "https://dashscope.console.aliyun.com/apiKey" },
  {
    id: "alibaba-token-plan",
    label: "Alibaba Token Plan (Beijing)",
    baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://bailian.console.aliyun.com/cn-beijing?tab=plan",
    defaultModel: "qwen3.8-max",
    models: ALIBABA_TOKEN_PLAN_MODELS,
    liveModels: false,
    // Alibaba documents an OpenAI-compatible Responses API on this same /compatible-mode/v1 base
    // and ships an official Codex integration guide on wire_api = "responses" (#5097). The
    // gateway serves the same models over both wires, and qwen3.8-flash, qwen3.7-plus and
    // glm-5.3 carry live end-to-end evidence there (custom tools, reasoning replay, streaming,
    // multi-turn continuation).
    //
    // That evidence is now expressed as a modelWireDefaults pin scoped to Responses inbound
    // only: Codex clients ride the native wire with zero translation hops, while chat and
    // anthropic inbound keep the provider-wide chat wire and its measured prefix-cache
    // behavior. The pin was held back until the one open delta was closed with its own live
    // evidence: the Responses serializer replays reasoning content through the separate
    // preserveResponsesReasoningContent flag, which the Chat-side preserveReasoningContentModels
    // list does not cover. Measured 260922 on this gateway (#5188): a two-turn replay that
    // round-trips a reasoning item WITH its plaintext content array is accepted (HTTP 200) and
    // the model continues from it, so the flag is set beside the pins — the same pairing Z.AI
    // and DeepSeek use. qwen3.7-plus is the one pinned model in thinkingBudgetModels, and its
    // full low/medium/high/xhigh/max effort ladder is accepted as reasoning.effort strings on
    // this wire (measured same day), so the Responses path does not need the numeric
    // thinking_budget translation the Chat wire applies. The rest of the family stays a
    // documented per-model modelAdapters opt-in; modelAdapters always wins over the pin in
    // both directions.
    // tests/providers/alibaba-token-plan-responses-optin.test.ts holds the opt-in half and the
    // flag guard; tests/providers/alibaba-token-plan-wire-defaults.test.ts holds the pins.
    // The intl sibling stays unpinned until the same four-axis verification runs against its
    // gateway (its /responses route is registered, #5097).
    modelWireDefaults: {
      "qwen3.8-flash": { wire: "openai-responses", inbound: ["responses"] },
      "qwen3.7-plus": { wire: "openai-responses", inbound: ["responses"] },
      "glm-5.3": { wire: "openai-responses", inbound: ["responses"] },
    },
    note: "Token Plan Personal Edition · China (Beijing)",
    modelInputModalities: ALIBABA_TOKEN_PLAN_INPUT_MODALITIES,
    modelContextWindows: ALIBABA_TOKEN_PLAN_CONTEXT_WINDOWS,
    modelMaxOutputTokens: ALIBABA_TOKEN_PLAN_MAX_OUTPUT_TOKENS,
    modelReasoningEfforts: {
      ...Object.fromEntries(ALIBABA_TOKEN_PLAN_QWEN_MODELS.map(id => [id, THINKING_BUDGET_EFFORTS])),
      ...Object.fromEntries(QWEN38_FAMILY.map(id => [id, QWEN38_REASONING_EFFORTS])),
      "glm-5.2": ZAI_GLM_52_REASONING_EFFORTS,
      "glm-5.3": ZAI_GLM_53_REASONING_EFFORTS,
      "deepseek-v4-pro": deepseekThinkingEffortsFor("deepseek-v4-pro"),
      "deepseek-v4-pro-0813": deepseekThinkingEffortsFor("deepseek-v4-pro-0813"),
      "deepseek-v4-flash-0731": deepseekThinkingEffortsFor("deepseek-v4-flash-0731"),
      "deepseek-v4.1-flash": deepseekThinkingEffortsFor("deepseek-v4.1-flash"),
    },
    modelReasoningEffortMap: {
      "deepseek-v4-pro": deepseekReasoningMapFor("deepseek-v4-pro"),
      "deepseek-v4-pro-0813": deepseekReasoningMapFor("deepseek-v4-pro-0813"),
      "deepseek-v4-flash-0731": deepseekReasoningMapFor("deepseek-v4-flash-0731"),
      "deepseek-v4.1-flash": deepseekReasoningMapFor("deepseek-v4.1-flash"),
    },
    // Probed 260915 on the plan gateway: json_object returns valid JSON, strict
    // json_schema is rejected 400 ("This response_format type is unavailable now")
    // in both thinking modes, so requests downgrade to json_object rather than
    // sending a schema the gateway refuses.
    noJsonSchemaModels: ["deepseek-v4.1-flash"],
    modelDefaultReasoningEfforts: Object.fromEntries(QWEN38_FAMILY.map(id => [id, "xhigh"])),
    directReasoningEffortModels: QWEN38_FAMILY,
    thinkingBudgetModels: ALIBABA_TOKEN_PLAN_QWEN_MODELS.filter(id => !QWEN38_FAMILY.includes(id)),
    preserveReasoningContentModels: ALIBABA_TOKEN_PLAN_PRESERVE_REASONING,
    // Responses replay uses this provider-level flag, not the Chat-path model list above;
    // measured live on this gateway (see the pin comment). The model list still covers a
    // caller who opts back into Chat.
    preserveResponsesReasoningContent: true,
    noVisionModels: ALIBABA_TOKEN_PLAN_NO_VISION,
    // The gateway accepts prompt_cache_key on every Token Plan chat model (probed 260902).
    promptCacheKey: true,
  },
  {
    id: "alibaba-token-plan-intl",
    label: "Alibaba Token Plan (International)",
    baseUrl: ALIBABA_INTL_TOKEN_PLAN_BASE_URL,
    adapter: "openai-chat",
    authKind: "key",
    allowBaseUrlOverride: true,
    baseUrlChoices: ALIBABA_INTL_BASE_URL_CHOICES,
    dashboardUrl: "https://modelstudio.console.alibabacloud.com/?tab=api#/api",
    defaultModel: "qwen3.7-max",
    models: ALIBABA_INTL_TOKEN_PLAN_MODELS,
    liveModels: false,
   note: "Token Plan Team Edition · Singapore (ap-southeast-1)",
    metadataModelIdNormalize: "case-insensitive",
   modelInputModalities: ALIBABA_INTL_TOKEN_PLAN_INPUT_MODALITIES,
    modelContextWindows: ALIBABA_TOKEN_PLAN_CONTEXT_WINDOWS,
    modelMaxOutputTokens: ALIBABA_TOKEN_PLAN_MAX_OUTPUT_TOKENS,
    modelReasoningEfforts: {
      ...Object.fromEntries(ALIBABA_INTL_TOKEN_PLAN_QWEN_MODELS.map(id => [id, THINKING_BUDGET_EFFORTS])),
      ...Object.fromEntries(QWEN38_FAMILY.map(id => [id, QWEN38_REASONING_EFFORTS])),
      "glm-5.2": ZAI_GLM_52_REASONING_EFFORTS,
      "glm-5.3": ZAI_GLM_53_REASONING_EFFORTS,
      "deepseek-v4-pro": deepseekThinkingEffortsFor("deepseek-v4-pro"),
      "deepseek-v4-pro-0813": deepseekThinkingEffortsFor("deepseek-v4-pro-0813"),
      "deepseek-v4-flash": deepseekThinkingEffortsFor("deepseek-v4-flash"),
      "deepseek-v4-flash-0731": deepseekThinkingEffortsFor("deepseek-v4-flash-0731"),
      "deepseek-v4.1-flash": deepseekThinkingEffortsFor("deepseek-v4.1-flash"),
    },
    modelReasoningEffortMap: {
      "deepseek-v4-pro": deepseekReasoningMapFor("deepseek-v4-pro"),
      "deepseek-v4-pro-0813": deepseekReasoningMapFor("deepseek-v4-pro-0813"),
      "deepseek-v4-flash": deepseekReasoningMapFor("deepseek-v4-flash"),
      "deepseek-v4-flash-0731": deepseekReasoningMapFor("deepseek-v4-flash-0731"),
      "deepseek-v4.1-flash": deepseekReasoningMapFor("deepseek-v4.1-flash"),
    },
    // Same 260915 json_schema rejection probe as the Beijing entry.
    noJsonSchemaModels: ["deepseek-v4.1-flash"],
    directReasoningEffortModels: QWEN38_FAMILY,
    thinkingBudgetModels: ALIBABA_INTL_TOKEN_PLAN_QWEN_MODELS.filter(id => !QWEN38_FAMILY.includes(id)),
    preserveReasoningContentModels: ALIBABA_TOKEN_PLAN_PRESERVE_REASONING,
    noVisionModels: ALIBABA_TOKEN_PLAN_NO_VISION,
    noReasoningModels: ["kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5", "deepseek-v3.2", "glm-5.1", "glm-5", "MiniMax-M2.5"],
    modelDefaultReasoningEfforts: Object.fromEntries(QWEN38_FAMILY.map(id => [id, "xhigh"])),
    promptCacheKey: true,
  },
  // NEEDS_HUMAN 2026-07-10: kept for config compatibility, but this is a dashboard URL,
  // no /models endpoint is documented, and tools are silently ignored upstream per docs.parallel.ai.
  // Evidence: devlog/_plan/260710_provider_hardening/003_research_aggregators.md.
  { id: "parallel", label: "Parallel", baseUrl: "https://platform.parallel.ai", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://platform.parallel.ai" },
  // ZenMux native ids are vendor-namespaced (`<vendor>/<model>`), verified live against
  // https://zenmux.ai/api/v1/models on 2026-07-18. The static seed doubles as the
  // cold-cache decode source for the Codex slug codec (src/providers/slug-codec.ts);
  // live discovery still owns the full catalog.
  {
    id: "zenmux", label: "ZenMux", baseUrl: "https://zenmux.ai/api/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://zenmux.ai",
    models: ["moonshotai/kimi-k3-free", "moonshotai/kimi-k3"],
  },
  {
    id: "litellm", label: "LiteLLM (self-hosted)", baseUrl: "http://localhost:4000/v1", adapter: "openai-chat", authKind: "key",
    dashboardUrl: "https://docs.litellm.ai/docs/proxy/quick_start",
    allowPrivateNetworkByDefault: true,
    allowBaseUrlOverride: true,
    // A self-hosted proxy may legitimately run without a master key.
    keyOptional: true,
  },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    // The upstream /v1 spelling is deliberately unchanged: ollamaNativeChatUrl() normalizes it
    // to /api/chat, and live model discovery declares its own /v1/models path against the origin,
    // so the native transport needs no base-URL edit here or in the free-provider directory.
    baseUrl: "https://ollama.com/v1",
    // The native transport must be declared HERE, not in configuration. routedProviderConfig()
    // overwrites provider.adapter with the registry adapter for every row whose transport
    // matches, so a config-level adapter is silently discarded.
    adapter: "ollama-native",
    authKind: "key",
    dashboardUrl: "https://ollama.com/settings/keys",
    // Live IDs verified 2026-07-10; qwen3-coder:480b retires 2026-07-15.
    models: ["glm-5.3", "glm-5.3-flash", "glm-5.2", "qwen3-coder:480b", "gpt-oss:120b", "kimi-k2.6", "minimax-m3", "qwen3.5:397b", "gemma4:31b"],
    defaultModel: "glm-5.3",
    // Owner-audited exact outage fallback: these current Ollama Cloud GLM-5.3 rows have
    // 1,048,576-token context windows. Live discovery and successful /api/show enrichment keep
    // their existing precedence; these values prevent a failed show from becoming generic.
    modelContextWindows: { "glm-5.3": 1_048_576, "glm-5.3-flash": 1_048_576 },
    noVisionModels: [
      // glm-5.3-flash is absent on purpose: native VLM
      // (docs.z.ai/guides/vlm/glm-5.3-flash), so its images skip the sidecar.
      "glm-5.3", "glm-5.2", "glm-5.1", "glm-5", "glm-4.7",
      "minimax-m2.7", "minimax-m2.5", "minimax-m2.1",
      "nemotron-3-ultra", "nemotron-3-super",
      "deepseek-v4-flash",
      "gpt-oss", "qwen3-coder:480b",
    ],
    // Ollama's native chat API has no `text.verbosity` equivalent and the ollama-native adapter
    // never emits one, so a routed row must not inherit the Codex template's verbosity picker.
    // Provider-wide rather than per-model: this catalog is discovery-authoritative, so ids that
    // arrive later from live discovery must opt out too (the live-discovery gap closed by #2578).
    supportsVerbosity: false,
    // Live model discovery: Ollama serves the standard OpenAI-style data[] envelope at /v1/models,
    // so the generic discovery pipeline needs no special-casing. The path is spelled against the
    // ORIGIN (model-discovery resolves a leading-slash path against base.origin). A discovery
    // spec is REQUIRED here: without one the pipeline probes https://ollama.com/models, which
    // 307-redirects to /search and discovery falls back to the configured list.
    modelDiscovery: {
      path: "/v1/models",
    },
  },
  // FREEZE 2026-07-10: codestral-latest is unconfirmed behind auth. Evidence: devlog/_plan/260710_provider_hardening/003_research_aggregators.md.
  { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://console.mistral.ai/api-keys", defaultModel: "codestral-latest" },
  {
    id: "minimax", label: "MiniMax — Coding Plan", baseUrl: "https://api.minimax.io/v1", adapter: "openai-chat", authKind: "key",
    dashboardUrl: "https://platform.minimax.io", defaultModel: "MiniMax-M3", models: MINIMAX_MODELS,
    modelContextWindows: MINIMAX_MODEL_CONTEXT_WINDOWS,
    modelReasoningEfforts: { "MiniMax-M3": MINIMAX_M3_REASONING_EFFORTS },
    modelDefaultReasoningEfforts: { "MiniMax-M3": "medium" },
    modelReasoningEffortMap: { "MiniMax-M3": MINIMAX_M3_REASONING_EFFORT_MAP },
    preserveReasoningContentModels: MINIMAX_MODELS,
    // MiniMax-M3 low effort maps to thinking disabled, so a legitimate tool
    // round can carry no reasoning at all; only replay real recorded text,
    // never a fabricated placeholder (chatgpt-codex-connector P2 on #1205).
    requiresReasoningPlaceholderModels: [],
    reasoningSplitModels: MINIMAX_MODELS,
    // With reasoning_split the upstream returns thinking as a structured
    // reasoning_details array (cumulative text snapshots per stream chunk) and
    // requires that array back verbatim on the next turn — a reasoning_content
    // string replay is the native-format pass-back the docs say is unsupported.
    // Evidence: platform.minimax.io/docs/guides/text-m3-function-call and
    // /docs/api-reference/text-openai-api (verified 2026-09-01).
    reasoningDetailsModels: MINIMAX_MODELS,
    thinkingToggleModels: ["MiniMax-M3"],
    jawcodeBundle: "minimax", metadataModelIdNormalize: "case-insensitive", note: "Subscription Key or API Key",
  },
  {
    id: "minimax-cn", label: "MiniMax — Coding Plan (CN)", baseUrl: "https://api.minimaxi.com/v1", adapter: "openai-chat", authKind: "key",
    dashboardUrl: "https://platform.minimaxi.com", defaultModel: "MiniMax-M3", models: MINIMAX_MODELS,
    modelContextWindows: MINIMAX_MODEL_CONTEXT_WINDOWS,
    modelReasoningEfforts: { "MiniMax-M3": MINIMAX_M3_REASONING_EFFORTS },
    modelDefaultReasoningEfforts: { "MiniMax-M3": "medium" },
    modelReasoningEffortMap: { "MiniMax-M3": MINIMAX_M3_REASONING_EFFORT_MAP },
    preserveReasoningContentModels: MINIMAX_MODELS,
    requiresReasoningPlaceholderModels: [],
    reasoningSplitModels: MINIMAX_MODELS,
    reasoningDetailsModels: MINIMAX_MODELS,
    thinkingToggleModels: ["MiniMax-M3"],
    jawcodeBundle: "minimax", metadataModelIdNormalize: "case-insensitive", note: "中国区 Subscription Key",
  },
  {
    id: "kimi-code", label: "Kimi (coding)", baseUrl: "https://api.kimi.com/coding/v1", adapter: "openai-chat", authKind: "key",
    // 260921: kimi-k2.7-code was retired from the coding endpoint; the kimi-for-coding alias
    // is the stable ID and currently routes to K2.8 Preview (same as the OAuth preset).
    dashboardUrl: "https://platform.moonshot.cn/console/api-keys", defaultModel: "kimi-for-coding",
    modelSuffixBracketStrip: true,
    // API-key form of the same Kimi Code Plan transport; keep cache affinity identical to OAuth.
    promptCacheKey: true,
    // Keep Responses tool-result adjacency aligned with the OAuth preset (#4726).
    requiresAdjacentResponsesToolResults: true,
    // 260921: same live-id picker as the OAuth preset — the retired k2.x ids are repaired
    // in saved configs by MODEL_RENAMES, not offered on fresh installs.
    models: KIMI_CODING_LIVE_MODELS,
    modelContextWindows: KIMI_CODING_MODEL_CONTEXT_WINDOWS,
    modelInputModalities: KIMI_CODING_MODEL_INPUT_MODALITIES,
    noReasoningModels: KIMI_CODING_NO_REASONING_MODELS,
    modelReasoningEfforts: KIMI_CODING_REASONING_EFFORTS,
    modelDefaultReasoningEfforts: KIMI_CODING_DEFAULT_REASONING_EFFORTS,
    modelReasoningEffortMap: KIMI_CODING_REASONING_EFFORT_MAPS,
    noTemperatureModels: KIMI_LOCKED_PARAMETER_MODELS,
    noTopPModels: KIMI_LOCKED_PARAMETER_MODELS,
    noPenaltyModels: KIMI_LOCKED_PARAMETER_MODELS,
    autoToolChoiceOnlyModels: KIMI_AUTO_TOOL_CHOICE_ONLY_MODELS,
    preserveReasoningContentModels: KIMI_THINKING_MODELS,
  },
  {
    id: "opencode-zen", label: "opencode zen", baseUrl: "https://opencode.ai/zen/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://opencode.ai/auth",
    // Same opencode.ai/zen/v1 gateway as `opencode-free` (keyed tier): DeepSeek thinking mode
    // requires the assistant's original reasoning_content to be replayed on tool-call
    // continuations, or the gateway answers HTTP 400 (issues #950/#994). Mirror the DeepSeek
    // reasoning + thinking metadata so `opencode-zen/deepseek-v4-flash-free` — and the other
    // Zen DeepSeek thinking models — never serialize a bare tool-call turn.
    note: "Keyed OpenCode Zen gateway. Free models on this tier are often short-window rate-limited at roughly 15-20 requests/minute (community-measured; OpenCode does not publish RPM). Zen may return generic 429s without Retry-After / X-RateLimit headers; when Retry-After is omitted, opencodex adds a synthetic backoff hint (upstream Retry-After still wins). Distinct from the keyless opencode-free desktop quota (~200 Big Pickle/free-model requests per 5 hours). Docs: https://opencode.ai/docs/zen/. Free-model prompts may be retained for training — do not send confidential material.",
    modelReasoningEfforts: Object.fromEntries(
      [...DEEPSEEK_GATEWAY_THINKING_MODELS, ...OPENCODE_FREE_DEEPSEEK_MODELS].map(id => [id, deepseekThinkingEffortsFor(id)]),
    ),
    modelReasoningEffortMap: Object.fromEntries(
      [...DEEPSEEK_GATEWAY_THINKING_MODELS, ...OPENCODE_FREE_DEEPSEEK_MODELS].map(id => [id, deepseekReasoningMapFor(id)]),
    ),
    preserveReasoningContentModels: [...DEEPSEEK_GATEWAY_THINKING_MODELS, ...OPENCODE_FREE_DEEPSEEK_MODELS],
    // Same Zen gateway as opencode-free: the DeepSeek vision preview id
    // (merges into deepseek-v4-flash later).
    modelContextWindows: {
      [DEEPSEEK_VISION_PREVIEW_MODEL]: 1_048_576,
    },
    modelInputModalities: {
      [DEEPSEEK_VISION_PREVIEW_MODEL]: ["text", "image"],
      ...Object.fromEntries(OPENCODE_ZEN_IMAGE_MODELS.map(id => [id, ["text", "image"] as string[]])),
    },
    noVisionModels: [...OPENCODE_ZEN_TEXT_ONLY_MODELS, ...DEEPSEEK_GATEWAY_THINKING_MODELS],
    // Same DeepSeek routes as the Go preset above, behind the same vendor, so they carry
    // the same json_schema rejection (#1338 / #1415).
    noJsonSchemaModels: [...DEEPSEEK_GATEWAY_THINKING_MODELS, ...OPENCODE_FREE_DEEPSEEK_MODELS],
    // Muse Spark on Zen can sit silent during prolonged reasoning and close without a protocol terminal.
    modelResponsesTerminalRepair: {
      "muse-spark-1.2-contributor-free": { graceMs: 5_000 },
      "muse-spark-1.3-contributor-free": { graceMs: 5_000 },
    },
  },
  { id: "vercel-ai-gateway", label: "Vercel AI Gateway", baseUrl: "https://ai-gateway.vercel.sh/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://vercel.com/dashboard" },
  {
    // Opper: EU-hosted AI gateway (Opper AI AB, Stockholm). One OpenAI-compatible endpoint and one
    // key in front of 30+ upstream providers. Seeded ids are Opper *pools* (bare names such as
    // `claude-sonnet-4-6`): the gateway chooses the provider/region per request, and a
    // `vendor/model` id (`anthropic/claude-sonnet-4-6`, `aws/claude-sonnet-4-6-eu`) pins one route.
    // The original provider author reported on 2026-09-08 that GET /v3/compat/models answers 401
    // without a key, so the default discovery URL doubles as key validation. Windows, output caps
    // and modalities live in model-seeds.ts (smallest value / shared modality across each pool's
    // members); live discovery owns which models exist.
    id: "opper",
    label: "Opper",
    adapter: "openai-chat",
    baseUrl: "https://api.opper.ai/v3/compat",
    authKind: "key",
    dashboardUrl: "https://platform.opper.ai",
    liveModels: true,
    preserveCustomDestination: true,
    defaultModel: "claude-sonnet-4-6",
    models: OPPER_MODELS,
    modelContextWindows: OPPER_MODEL_CONTEXT_WINDOWS,
    modelMaxOutputTokens: OPPER_MODEL_MAX_OUTPUT_TOKENS,
    modelInputModalities: OPPER_MODEL_INPUT_MODALITIES,
    note: "EU-hosted AI gateway: one OpenAI-compatible endpoint and one key in front of 30+ providers. Bare model ids are pools (claude-sonnet-4-6, gpt-5.5) and Opper picks the route per request; vendor/model ids (anthropic/claude-sonnet-4-6) pin one provider. The catalogue is discovered live from /v3/compat/models with your key; the public list is at opper.ai/models. Token rates are the model providers' rates with no markup; Opper charges a 3% fee when you buy credits.",
  },
  {
    id: "opencode-free",
    label: "OpenCode Free",
    adapter: "openai-chat",
    baseUrl: "https://opencode.ai/zen/v1",
    authKind: "key",
    keyOptional: true,
    featured: true,
    liveModels: true,
    note: "No key needed, but OpenCode now gates this tier to its own client: Zen refuses any request that arrives without an x-opencode-session header (error type MissingSessionID, \"OpenCode's free tier can only be used in OpenCode\"). opencodex does not mint that header or claim an OpenCode client identity, because no upstream contract authorizes a third-party agent to present itself as OpenCode. Until OpenCode publishes a third-party integration path for the keyless tier, use the keyed opencode-zen provider instead (https://opencode.ai/auth). Quota figures for when the tier admitted a request: OpenCode advertises about 200 Big Pickle/free-model requests per 5 hours, and the same Zen gateway can short-window rate-limit free models at roughly 15-20 requests/minute, and may return generic 429s without Retry-After (opencodex synthesizes backoff only when that header is omitted). Free models are discovered live from Zen. Data use: per OpenCode's Zen docs (https://opencode.ai/docs/zen/), prompts sent to free models may be retained and used for training/improvement — do not send confidential material through this provider.",
    dashboardUrl: "https://opencode.ai",
    staticHeaders: {
      // Zen answers a bare runtime User-Agent (Bun/x.y.z) more aggressively than a client
      // that identifies itself, which is what the 429 in #2067 traced to. The value is
      // deliberately unversioned: a pinned "opencode-cli/<version>" is a claim about an
      // install we do not have and goes stale on the vendor's schedule, not ours.
      // Corroboration, not authority: OmniRoute — an independent open-source broker against
      // the same Zen upstream — defaults to exactly this pair (userAgent "opencode", client
      // "desktop") in open-sse/executors/opencode.ts, and got there by RETREATING from its
      // own earlier "opencode-cli/1.0.0" pin. An operator can still override either value
      // through the provider headers API; user headers win case-insensitively at route time.
      "User-Agent": "opencode",
      "x-opencode-client": "desktop",
    },
    modelReasoningEfforts: Object.fromEntries(OPENCODE_FREE_DEEPSEEK_MODELS.map(id => [id, deepseekThinkingEffortsFor(id)])),
    modelReasoningEffortMap: Object.fromEntries(OPENCODE_FREE_DEEPSEEK_MODELS.map(id => [id, deepseekReasoningMapFor(id)])),
    preserveReasoningContentModels: OPENCODE_FREE_DEEPSEEK_MODELS,
    // The DeepSeek vision preview id is preemptive metadata for when Zen starts
    // serving it (merges into v4-flash later).
    modelContextWindows: {
      [DEEPSEEK_VISION_PREVIEW_MODEL]: 1_048_576,
    },
    modelInputModalities: {
      [DEEPSEEK_VISION_PREVIEW_MODEL]: ["text", "image"],
      ...Object.fromEntries(OPENCODE_ZEN_IMAGE_MODELS.map(id => [id, ["text", "image"] as string[]])),
    },
    // Same Zen roster behind the same base URL, so it carries the same measured
    // text-only list rather than only its DeepSeek member (#1043).
    noVisionModels: OPENCODE_ZEN_TEXT_ONLY_MODELS,
    // Same reasoning: the free tier is the same Zen roster, so its DeepSeek members get
    // the keyed tier's json_schema treatment and its reasoning contract rather than a
    // narrower table that silently falls behind whenever the keyed one is updated.
    noJsonSchemaModels: [...DEEPSEEK_GATEWAY_THINKING_MODELS, ...OPENCODE_FREE_DEEPSEEK_MODELS],
  },
  // Xiaomi retires mimo-v2.5 and mimo-v2.5-pro on 2026-10-21 with no redirect
  // (https://mimo.mi.com/docs/en-US/updates/deprecate), so the first-party presets default to V2.6.
  // Saved defaults are not rewritten; V2.5 stays listed until it stops answering.
  // Both first-party presets read the xiaomi metadata bundle for window, output, modalities and price.
  { id: "xiaomi", label: "Xiaomi MiMo", baseUrl: "https://api.xiaomimimo.com/anthropic", adapter: "anthropic", authKind: "key", dashboardUrl: "https://xiaomimimo.com", defaultModel: "mimo-v2.6-pro", models: ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.6-pro-ultraspeed", "mimo-v2.5-pro", "mimo-v2.5"], jawcodeBundle: "xiaomi" },
  // Xiaomi's public OpenAI-compatible endpoint is a distinct transport from both the Anthropic
  // preset above and the paid token-plan host below. Keep a separate fixed-destination contract
  // so existing custom providers are never retargeted while the official route receives the
  // strict reasoning ladder its validator enforces (#1483).
  {
    id: "xiaomi-mimo",
    label: "Xiaomi MiMo (OpenAI Chat)",
    baseUrl: "https://api.xiaomimimo.com/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://platform.xiaomimimo.com/console/balance",
    defaultModel: "mimo-v2.6-flash",
    models: ["mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed", "mimo-v2.5"],
    jawcodeBundle: "xiaomi",
    reasoningEfforts: ["low", "medium", "high"],
    reasoningEffortMap: { xhigh: "high", max: "high", ultra: "high" },
    preserveCustomDestination: true,
    note: "Official Xiaomi MiMo OpenAI-compatible Chat endpoint. The upstream validator accepts reasoning_effort none/low/medium/high; higher Codex tiers are clamped to high.",
  },
  { id: "kilo", label: "Kilo", baseUrl: "https://api.kilo.ai/api/gateway", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://kilo.ai" },
  {
    id: "mimo-free",
    label: "MiMo Free",
    adapter: "mimo-free",
    baseUrl: "https://api.xiaomimimo.com/api/free-ai/openai/chat",
    authKind: "key",
    keyOptional: true,
    featured: true,
    liveModels: true,
    dashboardUrl: "https://xiaomimimo.com",
    defaultModel: "mimo-auto",
    models: ["mimo-auto"],
    reasoningEfforts: ["low", "medium", "high"],
    reasoningEffortMap: { xhigh: "high", max: "high", ultra: "high" },
    note: "No key needed — uses Xiaomi MiMo's free public tier (limited-time offer). A JWT is bootstrapped automatically with an anonymous random client id stored locally. The endpoint contract mirrors the official MiMoCode client and is not publicly documented — Xiaomi may change or restrict it at any time. Prompts may be processed/retained by Xiaomi; do not send confidential material.",
  },
  // Xiaomi MiMo paid token plan. Separate host and wire from both `xiaomi` (Anthropic) and
  // `mimo-free` (free tier, bespoke adapter), so it needs its own entry rather than a variant.
  //
  // Pinned to openai-chat deliberately (#1158). The endpoint answers the Responses wire for
  // plain turns, which is why users configuring it by hand pick `openai-responses` — MiMo
  // documents Responses support. But its gateway rejects `type: "custom"` tools with
  // `400 responses_feature_not_supported`, and `apply_patch` is a custom tool, so every agentic
  // turn fails while chat turns succeed. The Chat path lowers custom tools to `{input: string}`
  // functions and restores them as `custom_tool_call`, so the capability survives intact.
  // Stripping the tools instead would stop the 400 and disable the agent loop.
  {
    id: "mimo",
    label: "Xiaomi MiMo (token plan)",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://xiaomimimo.com",
    // Token-plan roster per Xiaomi's token-plan model list (V2.6 Pro and Flash). Model-level facts
    // come from Xiaomi's model pages (mimo.mi.com/models/en-US/<id>, fetched 2026-09-24): 1M context,
    // 128K max output; V2.6 Pro/Flash and V2.5 take text/image/video/audio, V2.5 Pro text only. The
    // catalog vocabulary has no video or audio, so only text/image are claimed. The token plan speaks
    // the same API format as pay-as-you-go, so these are model facts rather than plan facts. No
    // jawcodeBundle: pricing and entitlement stay unclaimed, and usage estimates still come from the
    // model-level vendor price fallback, exactly as they did for V2.5.
    defaultModel: "mimo-v2.6-pro",
    models: ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.5-pro", "mimo-v2.5"],
    modelContextWindows: { "mimo-v2.6-pro": 1_048_576, "mimo-v2.6-flash": 1_048_576, "mimo-v2.5-pro": 1_048_576, "mimo-v2.5": 1_048_576 },
    modelMaxOutputTokens: { "mimo-v2.6-pro": 131_072, "mimo-v2.6-flash": 131_072, "mimo-v2.5-pro": 131_072, "mimo-v2.5": 131_072 },
    modelInputModalities: {
      "mimo-v2.6-pro": ["text", "image"],
      "mimo-v2.6-flash": ["text", "image"],
      "mimo-v2.5": ["text", "image"],
      "mimo-v2.5-pro": ["text"],
    },
    // The gateway validates the ladder strictly and rejects anything above `high`.
    reasoningEfforts: ["low", "medium", "high"],
    reasoningEffortMap: { xhigh: "high", max: "high", ultra: "high" },
    // Live token-plan verification (#1927): the Pro route rejects image input while
    // mimo-v2.5 accepts it natively. Keep this provider-scoped so a hand-rolled
    // provider with the same id but another destination does not inherit the claim.
    noVisionModels: ["mimo-v2.5-pro"],
    // A user may already have hand-rolled a provider under this id against a different host;
    // without this, routedProviderConfig() would canonicalize their base URL onto ours and send
    // their key somewhere they did not choose.
    preserveCustomDestination: true,
    note: "Xiaomi MiMo paid token plan. Pinned to the Chat wire: the Responses endpoint rejects freeform (custom) tools such as apply_patch with 400 responses_feature_not_supported, so agentic turns fail there while plain turns succeed. Reasoning tiers above high are clamped.",
  },
  { id: "cloudflare-ai-gateway", label: "Cloudflare AI Gateway", baseUrl: "https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic", adapter: "anthropic", authKind: "key", dashboardUrl: "https://dash.cloudflare.com/?to=/:account/ai/ai-gateway" },
  {
    // Cloudflare Workers AI: OpenAI-compatible endpoint. The base URL contains {account_id}
    // which must be resolved by the user at setup time. Model IDs use the @cf/ prefix.
    // Live-verified 2026-07-21 against https://developers.cloudflare.com/workers-ai/models/
    // Official search is sibling to /ai/v1 (GET .../ai/models/search?format=openrouter).
    id: "cloudflare-workers-ai", label: "Cloudflare Workers AI",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
    adapter: "openai-chat", authKind: "key", freeTier: true,
    dashboardUrl: "https://dash.cloudflare.com/?to=/:account/ai/workers-ai",
    defaultModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    models: [
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      "@cf/qwen/qwq-32b",
      "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
      "@cf/moonshotai/kimi-k2.7-code",
      "@cf/zai-org/glm-5.3",
      "@cf/zai-org/glm-5.3-flash",
      "@cf/zai-org/glm-5.2",
      "@cf/mistralai/mistral-small-3.1-24b-instruct",
    ],
    liveModels: true,
    modelDiscovery: {
      path: "../models/search",
      query: { format: "openrouter", per_page: "1000" },
      stripIdPrefix: "workers-ai/",
      maxModels: 256,
    },
    note: "Workers AI · Free tier included · Account ID required in base URL",
  },
  // FREEZE 2026-07-10: /models was auth-gated under key login. OAuth device-flow + copilot_internal
  // exchange (issue #151) unlocks live discovery; static seed is a cold-start fallback only.
  {
    id: "github-copilot",
    label: "GitHub Copilot",
    baseUrl: "https://api.githubcopilot.com",
    adapter: "openai-chat",
    authKind: "oauth",
    allowKeyAuthOverride: true,
    featured: false,
    dashboardUrl: "https://github.com/settings/copilot",
    liveModels: true,
    models: ["gpt-4o", "gpt-4.1", "gpt-4.1-mini", "claude-sonnet-4", "gemini-2.5-pro", "gpt-5-mini", "gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-sol", "gpt-6-luna"],
    defaultModel: "gpt-4o",
    // Copilot fronts a mixed-wire catalog: these models reject /chat/completions for
    // real Codex-agent traffic (function tools + reasoning), so every inbound wire
    // rides Responses. Evidence: issue #748 field runs, pi.dev/models/github-copilot/*
    // wire declarations, BerriAI/litellm#23332 (gpt-5.4), JetBrains LLM-29711
    // (gpt-5.6-sol). gpt-5.4-nano is deliberately absent — it has no field report; a
    // user can opt it in with an explicit modelAdapters entry, which always wins.
    modelWireDefaults: {
      "gpt-5.3-codex": "openai-responses",
      "gpt-5.4": "openai-responses",
      "gpt-5.4-mini": "openai-responses",
      "gpt-5.5": "openai-responses",
      "gpt-5.6-luna": "openai-responses",
      "gpt-5.6-sol": "openai-responses",
      "gpt-5.6-terra": "openai-responses",
      "gpt-6-astra": "openai-responses",
      // 260923 preemptive: GPT-6 Sol/Luna ride Responses like every GPT-5.6/6 row above.
      "gpt-6-sol": "openai-responses",
      "gpt-6-luna": "openai-responses",
      "grok-4.5": "openai-responses",
      "grok-4.6": "openai-responses",
      "mai-code-1.1-flash": "openai-responses",
      "mai-code-1-flash-picker": "openai-responses",
    },
    note: "Experimental unofficial Copilot bridge. Logs in via GitHub device flow using the public VS Code OAuth client id, then exchanges for a short-lived Copilot API token (copilot_internal). Requires an active Copilot subscription. GitHub may tighten or revoke this path; do not send confidential material you would not paste into Copilot Chat.",
  },
  // FREEZE 2026-07-10: no public OpenAI-compatible endpoint is documented. Evidence: devlog/_plan/260710_provider_hardening/003_research_aggregators.md.
  { id: "gitlab-duo", label: "GitLab Duo", baseUrl: "https://cloud.gitlab.com/ai/v1/proxy/openai/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://gitlab.com/-/user_settings/personal_access_tokens" },
  {
    // Official Qoder Global CLI automation surface. The canonical URL is an identity boundary;
    // inference and model discovery are performed only by the installed vendor CLI. Authentication
    // uses the documented PAT environment variable and never imports desktop/session credentials.
    id: "qoder",
    label: "Qoder (Global)",
    adapter: "qoder",
    baseUrl: "https://qoder.com",
    authKind: "key",
    apiKeyValidation: "unknown",
    preserveCustomDestination: true,
    dashboardUrl: "https://qoder.com/account/integrations",
    defaultModel: "Qwen3.8-Max",
    models: [...QODER_GLOBAL_MODELS],
    liveModels: true,
    reasoningEfforts: [...QODER_REASONING_EFFORTS],
    noVisionModels: [...QODER_GLOBAL_MODELS],
    note: "Official Qoder Global CLI using QODER_PERSONAL_ACCESS_TOKEN. Models are discovered per account with `qoder --list-models`; the documented roster is a degraded fallback. The CLI runs single-turn with tools, MCP, settings hooks, and session persistence disabled. Requires `npm install -g @qoder-ai/qodercli`.",
  },
  {
    // Qoder CN is a separate credential, executable, destination, entitlement cache, and health
    // domain. It deliberately does not reuse the OAuth/private-protocol design from #3010.
    id: "qoder-cn",
    label: "Qoder CN",
    adapter: "qoder",
    baseUrl: "https://qoder.cn",
    authKind: "key",
    apiKeyValidation: "unknown",
    preserveCustomDestination: true,
    dashboardUrl: "https://qoder.cn/account/integrations",
    defaultModel: "Qwen3.8-Max",
    models: [...QODER_CN_MODELS],
    liveModels: true,
    reasoningEfforts: [...QODER_REASONING_EFFORTS],
    noVisionModels: [...QODER_CN_MODELS],
    note: "Official Qoder CN CLI using QODERCN_PERSONAL_ACCESS_TOKEN. Models are discovered per account with `qodercn --list-models`; the verified roster is a degraded fallback. The CLI runs single-turn with tools, MCP, settings hooks, and session persistence disabled. Requires `npm install -g @qodercn-ai/qoderclicn`.",
  },
  {
    // Official CodeBuddy Code CLI provider (Tencent Cloud), GLOBAL / `public` environment.
    // Transport is the vendor-documented headless CLI automation surface
    // (`codebuddy -p --output-format stream-json --tools ""`) authenticated with the official
    // `CODEBUDDY_API_KEY` (https://www.codebuddy.ai/profile/keys). It does NOT read desktop
    // session files, import desktop bearer tokens, impersonate the desktop client, or call the
    // private console endpoint — the approach closed in #687 and left in draft in #2244.
    // baseUrl is the canonical region identity: the adapter fails closed if it is overridden, so a
    // global key is never sent to the CN environment (that is the separate `codebuddy-cn` entry).
    // The CLI always runs tools-disabled; a capture-only MCP bridge advertises the request's
    // Codex tool catalog, so approval, sandboxing, and execution stay with the client.
    // Free/trial/promotional/subscription credits draw from the same official API-key pool.
    // Requires the CLI: `npm i -g @tencent-ai/codebuddy-code`.
    // GOVERNANCE: whether routing this vendor automation surface behind a proxy for a third-party
    // agent satisfies CodeBuddy's AUP is an open question flagged for maintainer security review.
    id: "codebuddy",
    label: "CodeBuddy (Global)",
    adapter: "codebuddy",
    baseUrl: "https://www.codebuddy.ai",
    authKind: "key",
    apiKeyValidation: "unknown",
    preserveCustomDestination: true,
    dashboardUrl: "https://www.codebuddy.ai/profile/keys",
    defaultModel: "default-model",
    models: CODEBUDDY_GLOBAL_MODELS,
    liveModels: true,
    modelContextWindows: CODEBUDDY_GLOBAL_MODEL_CONTEXT_WINDOWS,
    modelMaxOutputTokens: CODEBUDDY_GLOBAL_MODEL_MAX_OUTPUT_TOKENS,
    defaultMaxOutputTokens: 32_000,
    reasoningEfforts: CODEBUDDY_REASONING_EFFORTS,
    modelReasoningEfforts: CODEBUDDY_GLOBAL_MODEL_REASONING_EFFORTS,
    modelDefaultReasoningEfforts: CODEBUDDY_GLOBAL_MODEL_DEFAULT_REASONING_EFFORTS,
    note: "Official CodeBuddy Code CLI (Tencent Cloud), global/public environment. Uses the documented CODEBUDDY_API_KEY + headless CLI surface; never reads desktop sessions or private console endpoints. Region-isolated from codebuddy-cn. The CLI always runs tools-disabled (--tools \"\"); a capture-only MCP bridge surfaces the request's Codex tool catalog as capturable calls, with approval and execution kept by the client. Requires `npm i -g @tencent-ai/codebuddy-code`. AUP/routing authorization flagged for maintainer security review.",
  },
  {
    // Official CodeBuddy Code CLI provider, CHINA / `internal` environment. Identical adapter and
    // binary as `codebuddy`; the region is fixed by the profile's CODEBUDDY_INTERNET_ENVIRONMENT
    // and this canonical baseUrl. CN key: https://copilot.tencent.com/profile/keys. The CN model
    // roster differs from Global and is discovered live from the key-authenticated product
    // configuration roster; the seeded list in codebuddy-models.ts is only the degraded
    // fallback (§八).
    id: "codebuddy-cn",
    label: "CodeBuddy (CN)",
    adapter: "codebuddy",
    baseUrl: "https://www.codebuddy.cn",
    authKind: "key",
    apiKeyValidation: "unknown",
    preserveCustomDestination: true,
    dashboardUrl: "https://copilot.tencent.com/profile/keys",
    defaultModel: "default",
    models: CODEBUDDY_CN_MODELS,
    liveModels: true,
    modelContextWindows: CODEBUDDY_CN_MODEL_CONTEXT_WINDOWS,
    modelMaxOutputTokens: CODEBUDDY_CN_MODEL_MAX_OUTPUT_TOKENS,
    defaultMaxOutputTokens: 32_000,
    reasoningEfforts: CODEBUDDY_REASONING_EFFORTS,
    modelReasoningEfforts: CODEBUDDY_CN_MODEL_REASONING_EFFORTS,
    modelDefaultReasoningEfforts: CODEBUDDY_CN_MODEL_DEFAULT_REASONING_EFFORTS,
    noVisionModels: CODEBUDDY_CN_NO_VISION_MODELS,
    note: "Official CodeBuddy Code CLI (Tencent Cloud), China/internal environment. Uses the documented CODEBUDDY_API_KEY + headless CLI surface; never reads desktop sessions or private console endpoints. Region-isolated from codebuddy (Global); credentials are never exchanged across regions. The CLI always runs tools-disabled (--tools \"\"); a capture-only MCP bridge surfaces the request's Codex tool catalog as capturable calls, with approval and execution kept by the client. Requires `npm i -g @tencent-ai/codebuddy-code`. AUP/routing authorization flagged for maintainer security review.",
  },
  {
    id: "stepfun",
    label: "StepFun",
    baseUrl: "https://api.stepfun.com/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://platform.stepfun.com",
    defaultModel: "step-5-preview",
    models: STEPFUN_MODELS,
    liveModels: true,
    preserveCustomDestination: true,
    modelContextWindows: STEPFUN_MODEL_CONTEXT_WINDOWS,
    modelInputModalities: STEPFUN_MODEL_INPUT_MODALITIES,
    noVisionModels: STEPFUN_NO_VISION_MODELS,
    reasoningEfforts: STEPFUN_REASONING_EFFORTS,
    note: "StepFun (阶跃星辰) official OpenAI-compatible API.",
  },
  {
    // Official Claude Code CLI as the transport for a Claude subscription (§三十一). The CLI owns
    // the account: this row stores no token and the adapter reads and injects none, so the request
    // path is Anthropic's own harness rather than a replayed Claude Code identity against the
    // Messages API. `baseUrl` is the destination the subscription's traffic reaches; OpenCodex
    // never sends it. Fails closed if the row's base URL is overridden.
    // v1 runs tools-disabled (`--tools ""`, no `--mcp-config`) so the client keeps tool ownership:
    // text/reasoning only until the shared capture-only tool bridge lands. Requires the CLI:
    // `npm i -g @anthropic-ai/claude-code`, plus a signed-in session (`claude` -> /login).
    // GOVERNANCE: whether a subscription login may be driven through a proxy for a third-party
    // agent is Anthropic's call rather than OpenCodex's — flagged for maintainer review, as with
    // the CodeBuddy rows above.
    id: "claude-cli",
    label: "Claude Code CLI (subscription)",
    adapter: "claude-cli",
    baseUrl: "https://api.anthropic.com",
    // `key` + `keyOptional`, deliberately not `local`. "local" (Ollama, vLLM, LM Studio) means the
    // traffic never leaves the machine and there is no credential to classify; this row reaches
    // api.anthropic.com, so `local` misreported it wherever auth is classified — the account
    // surface answered "local provider ... has no credentials" (`classifyAccount`,
    // src/cli/account-api.ts) and the dashboard filed the row as a local runtime. What IS true is
    // keyless: the CLI reads the operator's own sign-in, so `keyOptional` is the existing flag that
    // exempts a row from key enforcement without claiming a key exists. Key rows are also what
    // `deriveProviderPresets` lists, so this entry needs no `dashboardPreset` flag to stay
    // reachable from the Providers page.
    authKind: "key",
    keyOptional: true,
    // There is no key console for a keyless row: the link that helps an operator is the one that
    // documents the install and sign-in this provider requires.
    dashboardUrl: "https://docs.claude.com/en/docs/claude-code/setup",
    defaultModel: "claude-sonnet-5",
    models: [...ANTHROPIC_MODELS],
    // Static roster, exactly like the CodeBuddy rows. Without this the catalog treats the row as a
    // live-discovery candidate and requests a model list the CLI route never serves: a real start
    // logged `Provider model discovery for "claude-cli" failed with HTTP 404` and then fell back to
    // these ids anyway. `liveModels: false` makes the configured roster authoritative and skips the
    // request entirely (src/codex/catalog/provider-models.ts).
    liveModels: false,
    modelContextWindows: { ...ANTHROPIC_MODEL_CONTEXT_WINDOWS },
    // Text-only for v1, not the image modality the Messages API rows publish. The CLI parses an
    // image frame (verified against 2.1.270), but a headless turn has no verified contract that the
    // harness hands those bytes to the model, and advertising a modality the route cannot honour
    // makes a route selection pick this row for a picture it then answers blind. The adapter refuses
    // direct image input for the same reason; the vision sidecar still captions images into text.
    noVisionModels: [...ANTHROPIC_MODELS],
    reasoningEfforts: ANTHROPIC_REASONING_EFFORTS,
    modelReasoningEfforts: { ...ANTHROPIC_MODEL_REASONING_EFFORTS },
    defaultMaxOutputTokens: ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS,
    note: "Runs Claude subscription traffic through Anthropic's own harness: the official Claude Code CLI headlessly (`claude -p`), one turn per request. OpenCodex stores no Claude token, reads none and injects none — the CLI signs in and bills the account itself, which is why this row is keyless and an API key saved here never reaches the harness (use `anthropic-apikey` for key billing). The sign-in is the one of the user this proxy runs as, so every request served through this row — by any client of this proxy — spends that same account; OpenCodex neither pools nor multiplexes Claude sign-ins. Requires the CLI (`npm i -g @anthropic-ai/claude-code`) and a signed-in session (`claude` -> /login). v1 disables CLI tools (--tools \"\", --strict-mcp-config) so the client retains tool ownership: text/reasoning only for now. Subscription routing authorization flagged for maintainer review.",
  },
];
