import { KIRO_MODELS, KIRO_MODEL_CONTEXT_WINDOWS, KIRO_MODEL_REASONING_EFFORTS } from "../kiro-models";
import { DEVIN_MODEL_CONTEXT_WINDOWS, DEVIN_MODEL_EFFORTS, DEVIN_DEFAULT_EFFORTS } from "../../adapters/devin/live-models";
import { ANTIGRAVITY_MODELS, ANTIGRAVITY_MODEL_CONTEXT_WINDOWS, ANTIGRAVITY_MODEL_EFFORTS, ANTIGRAVITY_MODEL_INPUT_MODALITIES } from "../antigravity-models";
import {
  CURSOR_NO_VISION_MODELS,
  CURSOR_STATIC_MODELS,
  cursorModelContextWindows,
  cursorModelDisplayNames,
  cursorModelIds,
  cursorModelInputModalities,
  cursorModelReasoningEfforts,
} from "../../adapters/cursor/discovery";
import { cursorFastCapableBases } from "../../adapters/cursor/catalog";
import { COMMAND_CODE_MODEL_REASONING_EFFORTS } from "../command-code-efforts";
import { isCanonicalOpenRouterTarget } from "../openrouter-routing";
import type { ProviderRegistryEntry } from "./types";
import {
  ANTHROPIC_MODELS,
  ANTHROPIC_MODEL_CONTEXT_WINDOWS,
  ANTHROPIC_MODEL_INPUT_MODALITIES,
  ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS,
  ANTHROPIC_MODEL_REASONING_EFFORTS,
  ZAI_GLM_52_REASONING_EFFORTS,
  ZAI_GLM_53_REASONING_EFFORTS,
  OPENAI_GPT56_MODELS,
  OPENAI_GPT6_MODELS,
  OPENAI_GPT56_PRO_MODELS,
  OPENAI_API_GPT56_CONTEXT_WINDOWS,
  OPENAI_API_GPT56_MAX_INPUT_TOKENS,
  OPENAI_API_GPT56_VIRTUAL_MODELS,
  OPENAI_API_GPT56_REASONING_EFFORTS,
  META_MUSE_REASONING_EFFORTS,
  META_MUSE_REASONING_EFFORT_MAP,
  META_MUSE_CODE_REASONING_EFFORTS,
  META_MUSE_CODE_REASONING_EFFORT_MAP,
  META_MUSE_CONTEXT_WINDOW,
  META_MUSE_MODELS,
  OPENAI_DAYBREAK_MODELS,
  OPENAI_DAYBREAK_CONTEXT_WINDOWS,
  OPENAI_DAYBREAK_MAX_INPUT_TOKENS,
  OPENAI_DAYBREAK_REASONING_EFFORTS,
  OPENROUTER_GPT56_MODELS,
  XAI_MODELS,
  OPENROUTER_GPT56_CONTEXT_WINDOWS,
  THINKING_TOGGLE_EFFORTS,
  THINKING_TOGGLE_MAP,
  OPENCODE_GO_THINKING_TOGGLE_MODELS,
  THINKING_BUDGET_EFFORTS,
  QWEN38_REASONING_EFFORTS,
  THINKING_BUDGET_MODELS,
  OPENCODE_GO_THINKING_BUDGET_MODELS,
  DEEPSEEK_NATIVE_THINKING_MODELS,
  DEEPSEEK_GATEWAY_THINKING_MODELS,
  DEEPSEEK_VISION_PREVIEW_MODEL,
  COMMAND_CODE_MODEL_INPUT_MODALITIES,
  deepseekThinkingEffortsFor,
  deepseekReasoningMapFor,
  KIMI_K3_STANDARD_CONTEXT_WINDOW,
  KIMI_CODING_LIVE_MODELS,
  KIMI_THINKING_MODELS,
  KIMI_CODING_NO_REASONING_MODELS,
  KIMI_CODING_K3_REASONING_EFFORTS,
  KIMI_CODING_K3_REASONING_EFFORT_MAP,
  KIMI_CODING_REASONING_EFFORTS,
  KIMI_CODING_DEFAULT_REASONING_EFFORTS,
  KIMI_CODING_REASONING_EFFORT_MAPS,
  KIMI_LOCKED_PARAMETER_MODELS,
  KIMI_AUTO_TOOL_CHOICE_ONLY_MODELS,
  KIMI_CODING_MODEL_CONTEXT_WINDOWS,
  KIMI_CODING_MODEL_INPUT_MODALITIES,
  NEURALWATT_REASONING_HISTORY_MODELS,
  UMANS_MODELS,
  UMANS_REASONING_EFFORTS,
  UMANS_GLM_REASONING_EFFORTS,
  UMANS_GLM_53_REASONING_EFFORTS,
  UMANS_TEXT_ONLY_MODELS,
  UMANS_MODEL_CONTEXT_WINDOWS,
  UMANS_MODEL_INPUT_MODALITIES,
  CLINE_PASS_MODELS,
  ORCAROUTER_MODEL_DISCOVERY,
  ORCAROUTER_MODELS,
  ORCAROUTER_MODEL_REASONING_EFFORTS,
  CLINE_PASS_MODEL_CONTEXT_WINDOWS,
  CLINE_PASS_TEXT_ONLY_MODELS,
  CLINE_PASS_MODEL_INPUT_MODALITIES,
} from "./model-seeds";

export const PROVIDER_REGISTRY_CORE: readonly ProviderRegistryEntry[] = [
  {
    id: "openai",
    label: "OpenAI (Codex login)",
    adapter: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    authKind: "forward",
    codexAccountMode: "pool",
    supportsServiceTier: true,
    featured: true,
    note: "Codex login account pool (default) or Direct main-account mode via codexAccountMode",
  },
  {
    id: "cursor",
    label: "Cursor (experimental)",
    adapter: "cursor",
    baseUrl: "https://api2.cursor.sh",
    authKind: "oauth",
    featured: false,
    dashboardPreset: true,
    note: "Experimental Cursor bridge. Live transport and live model discovery are enabled after a standalone PKCE browser login via 'ocx login cursor'; native read/write/delete/shell/fetch execution is disabled by default and request text such as Codex sandbox markers never authorizes it. Set \"nativeLocalExec\": \"on\" on providers.cursor in ~/.opencodex/config.json (dashboard: Providers → Cursor → Edit JSON) only for a trusted local experiment where every data-plane caller is trusted. \"off\" denies all, \"codex-sandbox\" is accepted for backwards compatibility but fails closed, and legacy \"unsafeAllowNativeLocalExec\": true still means explicit operator opt-in.",
    models: cursorModelIds(CURSOR_STATIC_MODELS),
    liveModels: true,
    defaultModel: "auto",
    modelContextWindows: cursorModelContextWindows(CURSOR_STATIC_MODELS),
    modelDisplayNames: cursorModelDisplayNames(),
    // Cursor's Fast product is a model VARIANT, not a service_tier field, so the wire kind
    // is cursor-variant and the request builder consumes the decision.
    fastWire: { kind: "cursor-variant", canonicalToWire: { priority: "fast" }, foreignCallerTiers: "drop" },
    // Deliberately NO provider-level supportsServiceTier: resolveFastPolicy short-circuits on
    // `capability.provider === false` BEFORE consulting the per-model map, which would make
    // these entries dead config. Absent leaves unlisted bases "unclassified", and a
    // non-service-tier adapter cannot forward a caller tier, so they still publish no toggle.
    modelSupportsServiceTier: Object.fromEntries(cursorFastCapableBases().map(id => [id, true])),
    fastTierDescription: "Cursor Fast variant",
    modelInputModalities: cursorModelInputModalities(CURSOR_STATIC_MODELS),
    modelReasoningEfforts: cursorModelReasoningEfforts(CURSOR_STATIC_MODELS),
    // Kimi K3 documents `max` as its API default, and its Cursor ladder has no `medium`
    // rung — so applyReasoningLevels' medium->high->first fallback would settle the catalog
    // default on `high`, the picker would send `high` explicitly, and the request builder's
    // no-effort fallback to `kimi-k3-max` would never be reached. Mirrors the other K3
    // routes (kimi, kimi-code, opencode-go).
    modelDefaultReasoningEfforts: { "kimi-k3": "max" },
    // Blind Cursor models (Auto routers, Composer, GLM-5.2, GLM-5.3) go through the vision sidecar;
    // multimodal hosts (Claude/Gemini/GPT/Kimi/Grok) take native SelectedImage. The catalog
    // still advertises image for noVision members so Codex can attach (sidecar option B).
    noVisionModels: [...CURSOR_NO_VISION_MODELS],
  },
  {
    // The canonical Cognition account provider, after absorbing `devin-cli`
    // (devlog/_plan/260913_devin_provider_merge). The two ids were the same
    // `devin` adapter, the same server.codeium.com api-server, and the same
    // `devin-session-token$<JWT>` credential — only the account source
    // differed: this entry did an Auth0 browser sign-in while `devin-cli`
    // imported the token the installed CLI's own PKCE login had already
    // written to credentials.toml. The merged login is import-first with a
    // browser fallback: the CLI credential is taken when present (no browser
    // opens), and the Auth0 flow remains because it is the only path for
    // users without the CLI. `devin-cli` survives only as a deprecated
    // alias; a startup migration rewrites saved provider rows, cross-config
    // references, and auth.json slots to `devin`.
    //
    // `oauth` classifies the ACCOUNT, not the transport. This is not a local
    // runtime: unlike Ollama or LM Studio it cannot answer at all until a
    // vendor account is signed in, and `local` grouped it with things that
    // have no account. It is also the only classification that reaches the
    // dashboard Accounts tab, which is built from OAUTH_PROVIDERS.
    id: "devin",
    label: "Cognition (Devin/Windsurf)",
    adapter: "devin",
    baseUrl: "https://server.codeium.com",
    authKind: "oauth",
    featured: false,
    // Off: `deriveProviderPresets` keys the preset catalog off this flag, so a
    // true row would draw the provider twice — an Accounts login row and a
    // preset tile.
    dashboardPreset: false,
    note: "Experimental unofficial Cognition/Devin bridge. ocx login devin first imports the credential an installed Devin CLI already holds (no browser); without one it opens Auth0 browser sign-in and exchanges the token via Cognition's RegisterUser for a long-lived API key.",
    // Union seed of the two merged rosters: the newer devin-cli lineup first
    // (it is the current catalog, so its default ordering wins), then the ids
    // only the old devin entry carried. Degraded-mode seed only either way —
    // `liveModels` discovers the account's real roster.
    models: ["swe-2", "swe-1-7", "gpt-5-6-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5", "glm-5-3", "kimi-k3", "gemini-3-8-flash", "grok-4-6", "swe-1-7-lightning", "gpt-5-6-luna", "gpt-5-6-terra", "claude-opus-4-8", "glm-5-2", "kimi-k2-7", "grok-4-5"],
    liveModels: true,
    defaultModel: "swe-2",
    modelContextWindows: DEVIN_MODEL_CONTEXT_WINDOWS,
    // Degraded-mode ladders only. Once a credential is present the account
    // catalog supplies each base model its measured rungs; these two fields are
    // what a signed-out picker and the Pi-shaped client exports fall back to.
    modelReasoningEfforts: DEVIN_MODEL_EFFORTS,
    reasoningEfforts: DEVIN_DEFAULT_EFFORTS,
  },
  {
    id: "xai",
    label: "xAI Grok",
    adapter: "openai-chat",
    baseUrl: "https://api.x.ai/v1",
    authKind: "oauth",
    allowKeyAuthOverride: true,
    // Priority Processing is documented for xAI's public API-key Chat Completions and
    // Responses endpoints. The OAuth lane is classified per-model below, not here:
    // do not turn this into a provider-wide supportsServiceTier declaration.
    keyAuthServiceTier: {
      supportsServiceTier: true,
      chatServiceTier: true,
    },
    // OAuth (Grok subscription gateway) service-tier capability, classified by live probe
    // on 2026-09-13 (devlog/_fin/260913_xai_oauth_fast/020_probe-evidence.md): each listed
    // model accepted service_tier "priority" over grok-oauth and echoed priority upstream.
    // Key-auth already declares provider-wide support above, so this map only newly opens
    // the OAuth lane. grok-4.20-multi-agent-0309 is deliberately absent: the gateway accepts
    // the field but answers service_tier "default" — a live downgrade, not a fast tier.
    // Unlisted and future-discovered ids stay unclassified.
    modelSupportsServiceTier: {
      "grok-4.6": true,
      "grok-4.5": true,
      "grok-4.3": true,
      "grok-4.20-0309-reasoning": true,
      "grok-4.20-0309-non-reasoning": true,
      "grok-build-0.1": true,
      "grok-composer-2.5-fast": true,
    },
    // Lets a caller-sent service_tier forward on the Chat wire (fastwire forwardCallerTier
    // chain). Provider-wide by construction: unclassified chat-wire models then preserve a
    // caller tier verbatim, the same contract other unclassified Responses routes already
    // follow; --fast publication and proxy-owned fast injection stay capability-scoped by
    // the map above. Key-auth declared the same value via keyAuthServiceTier, so the key
    // lane is unchanged.
    chatServiceTier: true,
    // Shared across key and OAuth catalog rows. OAuth subscription has no
    // per-token price, so the 2x claim is scoped to key auth.
    fastTierDescription: "Priority processing; tier pricing applies on key auth only",
    featured: true,
    oauthId: "xai",
    jawcodeBundle: "xai",
    supportsOpenAiWebSearchToolFields: false,
    // Live A/B on 2026-08-20: xAI rejects native custom/custom_tool_call shapes while accepting
    // the otherwise-identical request after the custom tool is lowered to a function.
    supportsResponsesCustomTools: false,
    note: "Log in with your Grok account",
    // Parallel tool calls: officially supported and default-on per docs.x.ai function-calling
    // (verified 260709, devlog/_plan/260709_parallel_tool_calls). Streamed calls arrive whole
    // per chunk, so the buffered parser assembles them losslessly.
    parallelToolCalls: true,
    // Live /v1/models discovery is the authoritative lineup (verified 260709: returns grok-4.5);
    // the static list below is the logged-out fallback seed.
    liveModels: true,
    // 260709 refresh: lineup + metadata from official docs.x.ai (grok-4.5 announced 07-08);
    // grok-composer-2.5-fast kept as account-verified (absent from public docs). Evidence:
    // devlog/model_update/260709_model_refresh/001_xai_lineup.md.
    // 260823: grok-4.20-multi-agent-0309 still returns 400 on Chat Completions, but works
    // on Responses. The server reports this dated id for both it and the floating
    // grok-4.20-multi-agent-beta-latest alias, so expose only the dated deployment id.
    // 260813: grok-4.6 added per docs.x.ai/developers/grok-4-6. Context/vision still match
    // grok-4.5; the reasoning ladder does not — 4.6 adds the documented xhigh rung.
    models: XAI_MODELS,
    // Measured only on grok-4.6 against cli-chat-proxy.grok.com: even an invalid
    // `text.verbosity` value is accepted and low/high/omitted output length is non-monotonic.
    // Apply the resulting opt-out to the whole xAI lineup because `text.verbosity` is an OpenAI
    // Responses parameter absent from xAI's documented API, not because every model was probed.
    // Keep this separate from reasoning-summary support: that bit gates Codex's
    // entire Responses reasoning object, including reasoning.effort.
    modelSupportsVerbosity: Object.fromEntries(XAI_MODELS.map(id => [id, false])),
    // Provider-wide, not merely per-model: `text.verbosity` is an OpenAI Responses parameter
    // absent from xAI's documented API, so a model discovered later has no more support for it
    // than the seeded ones do.
    supportsVerbosity: false,
    defaultModel: "grok-4.5",
    // Grok 4.6/4.5 subscription Responses callers use the native wire with the existing
    // namespace/web-search/replay normalization. Chat remains an explicit modelAdapters
    // opt-in. Multi-agent has no Chat wire and uses Responses under both auth modes.
    // grok-4.6/4.5 are classified OAuth fast-tier models (modelSupportsServiceTier above),
    // so a caller-sent service_tier:"priority" forwards on this lane — the Codex fast-toggle
    // path. Multi-agent keeps its pin: probed 2026-09-13, the gateway downgrades its tier to
    // "default", so forwarding a caller tier would advertise a tier it does not get.
    modelWireDefaults: {
      "grok-4.6": {
        wire: "openai-responses",
        inbound: ["responses"],
        authModes: ["oauth"],
      },
      "grok-4.5": {
        wire: "openai-responses",
        inbound: ["responses"],
        authModes: ["oauth"],
      },
      "grok-4.20-multi-agent-0309": {
        // Even at high effort it emits no reasoning-summary deltas or encrypted replay
        // material. Do not encode that as modelSupportsReasoningSummaries:false: through
        // Codex #1100 that suppresses the entire reasoning object, including the effort
        // that controls this model's agent count. An empty summary pane is harmless.
        // Chat Completions returns 400 for this model, so every inbound uses Responses —
        // `anthropic` included. Omitting it left providerModelWireDefault returning undefined
        // for the Claude Messages lane, so resolveWireProtocolOverride kept xAI's provider-wide
        // openai-chat adapter and sent this model to the wire it 400s on.
        wire: "openai-responses",
        inbound: ["responses", "chat", "anthropic"],
        forwardCallerServiceTier: false,
      },
    },
    // Grok 4.6/4.5 OAuth Responses replays Codex tool history. After a mid-stream 502/reset,
    // the client can resend a function_call without a matching output, or with hook-injected
    // developer context between the pair. Google already synthesizes a missing tool_result
    // (#2199). xAI's Responses parser does not, so the next turns 400 and the thread snowballs.
    // Reuse the existing adjacency capability (Kimi #4726, DeepSeek #1292). Do not set
    // statelessResponses: xAI stores responses for 30 days and documents previous_response_id.
    // https://docs.x.ai/developers/model-capabilities/text/comparison
    requiresAdjacentResponsesToolResults: true,
    // The dangling half of the same failure: a call whose output never arrived. Kimi accepts that
    // shape, so this is a second capability rather than a widening of the one above.
    requiresPairedResponsesToolResults: true,
    // Vision lineup per docs.x.ai model-capabilities/images/understanding: the grok-4.x chat
    // models accept image input (JPEG/PNG, URL or base64). Without this the catalog leaves
    // inputModalities undefined, and deriveComboCatalogModel defaults an undefined member to
    // ["text"] — so any combo containing an xAI target is advertised to Codex as text-only and
    // the app blocks attachments client-side. grok-build-0.1 / grok-composer-2.5-fast stay out
    // (they are already listed in noVisionModels below).
    modelInputModalities: {
      "grok-4.6": ["text", "image"],
      "grok-4.5": ["text", "image"],
      "grok-4.3": ["text", "image"],
      "grok-4.20-multi-agent-0309": ["text", "image"],
      "grok-4.20-0309-reasoning": ["text", "image"],
      "grok-4.20-0309-non-reasoning": ["text", "image"],
    },
    noReasoningModels: ["grok-4.20-0309-non-reasoning", "grok-build-0.1", "grok-composer-2.5-fast"],
    // Replay assistant reasoning_content for grok reasoning models: xAI documents dropped
    // reasoning_content as the top cause of prompt-cache misses on multi-turn conversations
    // (docs.x.ai prompt-caching/multi-turn, verified 2026-07-13 — devlog/_plan/260713_grok_caching).
    // Models that never emit reasoning simply have no thinking parts to replay (no-op).
    preserveReasoningContentModels: ["grok-4.6", "grok-4.5", "grok-4.3", "grok-4.20-0309-reasoning"],
    // grok-4.5 reasoning is always-on with low/medium/high (no off tier, no xhigh).
    // grok-4.6 adds xhigh per docs.x.ai/developers/model-capabilities/text/reasoning;
    // multi-agent accepts the same four wire values to select 4 or 16 collaborators. xAI
    // documents high as the 4.6 default but no multi-agent default, so do not invent one.
    modelReasoningEfforts: {
      "grok-4.6": ["low", "medium", "high", "xhigh"],
      "grok-4.5": ["low", "medium", "high"],
      "grok-4.20-multi-agent-0309": ["low", "medium", "high", "xhigh"],
    },
    modelDefaultReasoningEfforts: { "grok-4.6": "high" },
    modelContextWindows: {
      "grok-4.6": 500_000,
      "grok-4.5": 500_000,
      "grok-4.3": 1_000_000,
      "grok-4.20-multi-agent-0309": 1_000_000,
      "grok-4.20-0309-reasoning": 1_000_000,
      "grok-4.20-0309-non-reasoning": 1_000_000,
      "grok-build-0.1": 256_000,
    },
    noVisionModels: ["grok-build-0.1", "grok-composer-2.5-fast"],
  },
  {
    id: "command-code",
    label: "Command Code - Auth",
    adapter: "command-code",
    baseUrl: "https://api.commandcode.ai",
    authKind: "oauth",
    oauthId: "command-code",
    featured: true,
    note: "Log in with your Command Code account",
    // OAuth needs one initial selection, but the exposed catalog is always discovered from the
    // signed-in account. Do not add a static model list here.
    defaultModel: "deepseek/deepseek-v4-flash",
    liveModels: true,
    modelDiscovery: {
      url: "https://api.commandcode.ai/provider/v1/models",
      maxResponseBytes: 262_144,
      maxModels: 256,
    },
    // These are capability facts from official Command Code model profiles, not seeded models.
    // Unknown/new live models deliberately do not advertise a reasoning picker.
    reasoningEfforts: [],
    modelReasoningEfforts: COMMAND_CODE_MODEL_REASONING_EFFORTS,
    // The DeepSeek vision preview id is preemptive metadata — it is expected to
    // merge into deepseek-v4-flash later.
    modelContextWindows: {
      [`deepseek/${DEEPSEEK_VISION_PREVIEW_MODEL}`]: 1_048_576,
    },
    modelInputModalities: COMMAND_CODE_MODEL_INPUT_MODALITIES,
    defaultMaxOutputTokens: 64_000,
    // The proprietary generate wire has no verified per-request serialization flag.
    parallelToolCalls: false,
  },
  {
    id: "orcarouter-oauth",
    label: "OrcaRouter - Auth",
    adapter: "openai-chat",
    baseUrl: "https://api.orcarouter.ai/v1",
    authKind: "oauth",
    oauthId: "orcarouter-oauth",
    featured: true,
    allowBaseUrlOverride: true,
    defaultModel: "openai/gpt-5.5",
    models: ORCAROUTER_MODELS,
    liveModels: true,
    modelDiscovery: ORCAROUTER_MODEL_DISCOVERY,
    modelReasoningEfforts: ORCAROUTER_MODEL_REASONING_EFFORTS,
    note: "Connect your OrcaRouter account with OAuth 2.0 + PKCE; the issued API key is stored in OpenCodex's existing credential store.",
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authKind: "oauth",
    allowBaseUrlOverride: true,
    featured: true,
    oauthId: "anthropic",
    jawcodeBundle: "anthropic",
    note: "Log in with your Claude account",
    models: [...ANTHROPIC_MODELS],
    modelContextWindows: { ...ANTHROPIC_MODEL_CONTEXT_WINDOWS },
    modelInputModalities: { ...ANTHROPIC_MODEL_INPUT_MODALITIES },
    modelReasoningEfforts: { ...ANTHROPIC_MODEL_REASONING_EFFORTS },
    // Codex omits max_output_tokens; without a provider budget the Anthropic adapter
    // falls back to 8192, which truncates long answers with stop_reason=max_tokens.
    defaultMaxOutputTokens: ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS,
    defaultModel: "claude-sonnet-5",
  },
  {
    id: "anthropic-apikey",
    label: "Anthropic (API key)",
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authKind: "key",
    featured: true,
    dashboardUrl: "https://console.anthropic.com/settings/keys",
    jawcodeBundle: "anthropic",
    extraMetadataAliases: ["anthropic-key"],
    note: "Direct Anthropic API billing — no Claude subscription",
    models: [...ANTHROPIC_MODELS],
    liveModels: true,
    modelContextWindows: { ...ANTHROPIC_MODEL_CONTEXT_WINDOWS },
    modelInputModalities: { ...ANTHROPIC_MODEL_INPUT_MODALITIES },
    modelReasoningEfforts: { ...ANTHROPIC_MODEL_REASONING_EFFORTS },
    defaultMaxOutputTokens: ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS,
    defaultModel: "claude-sonnet-5",
  },
  {
    id: "kimi",
    label: "Kimi",
    adapter: "openai-chat",
    baseUrl: "https://api.kimi.com/coding/v1",
    authKind: "oauth",
    modelSuffixBracketStrip: true,
    // Kimi Code Plan documents a stable session/task prompt_cache_key as required to improve
    // cache hit rates.
    // The chat adapter only forwards a key already on the internal request (Codex's session key,
    // or the one the Claude /v1/messages inbound derives); the adapter itself never invents one.
    // Evidence: https://platform.kimi.com/docs/api/chat
    promptCacheKey: true,
    // Kimi's Responses endpoint rejects hook-provided context between a tool call and
    // its matching result (#4726), the same strict shape DeepSeek exposed in #1292.
    // The flag is inert while this preset uses the Chat wire.
    requiresAdjacentResponsesToolResults: true,
    featured: true,
    oauthId: "kimi",
    jawcodeBundle: "moonshot",
    note: "Log in with your Kimi account",
    // 260921: the retired k2.x ids stay out of the picker — live /coding/v1/models lists
    // only kimi-for-coding[-highspeed], k3, k3-256k. Saved rows still naming kimi-k2.7-code
    // are repaired by MODEL_RENAMES in model-rename-migration.ts.
    models: KIMI_CODING_LIVE_MODELS,
    // 260921: kimi-k2.7-code was retired from the subscription endpoint (live /models lists
    // only kimi-for-coding[-highspeed], k3, k3-256k). The kimi-for-coding alias is the
    // stable ID and currently routes to K2.8 Preview.
    defaultModel: "kimi-for-coding",
    modelContextWindows: KIMI_CODING_MODEL_CONTEXT_WINDOWS,
    modelInputModalities: KIMI_CODING_MODEL_INPUT_MODALITIES,
    // K3 accepts low/high/max; Codex aliases are normalized by the model-scoped wire map.
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
    id: "kiro",
    label: "Kiro (AWS CodeWhisperer)",
    adapter: "kiro",
    baseUrl: "https://runtime.us-east-1.kiro.dev",
    authKind: "oauth",
    oauthId: "kiro",
    note: "Import-first: reuses your installed and signed-in Kiro CLI session (requires `kiro-cli login`). Add account logs `kiro-cli` out, switches it through a fresh browser login, stores the account by profile ARN, and restores the previous CLI session on cancellation or failure. Experimental third-party harness — see Kiro ToS.",
    models: KIRO_MODELS,
    defaultModel: "kiro-auto",
    // Kiro speaks CodeWhisperer wire, not OpenAI-style GET /models. Keep the static
    // catalog authoritative so a spurious 2xx from runtime.../models cannot drop seeded ids
    // (e.g. newly listed GPT-5.6 tiers) via live-discovery reconciliation.
    liveModels: false,
    // Per-model context metadata is maintained next to the Kiro model list.
    modelContextWindows: KIRO_MODEL_CONTEXT_WINDOWS,
    modelReasoningEfforts: KIRO_MODEL_REASONING_EFFORTS,
    modelSupportsVerbosity: Object.fromEntries(KIRO_MODELS.map(id => [id, false])),
  },
  {
    // Nous Portal — Nous Research subscription gateway (same backend Hermes Agent
    // uses). OAuth is a device grant (src/oauth/nous.ts): the access token IS the
    // per-request inference JWT (scope inference:invoke), refresh tokens are
    // single-use and rotated on every refresh. Catalog is a mix of paid models
    // (billed against the Portal subscription) and `:free` slugs (e.g.
    // tencent/hy3:free, stepfun/step-3.7-flash:free, inclusionai/ling-3.0-flash:free);
    // free-tier gating is decided live by the Portal per account, so discovery
    // from the signed-in account is authoritative; the static seed below is the
    // logged-out fallback and only lists free models verified on a real account
    // (2026-08-10): the Portal free list is authoritative and currently has
    // exactly 4 :free models: tencent/hy3:free, poolside/laguna-s-2.1:free,
    // stepfun/step-3.7-flash:free, poolside/laguna-xs-2.1:free.
    // inclusionai/ling-3.0-flash:free was removed from the Portal free list
    // (404 on the inference API since 2026-08-07) and must not be seeded.
    id: "nous",
    label: "Nous Portal",
    adapter: "openai-chat",
    baseUrl: "https://inference-api.nousresearch.com/v1",
    authKind: "oauth",
    oauthId: "nous",
    featured: true,
    // Mixed free + paid provider: the free tier is per-model (the `:free`
    // slugs), not a property of the whole provider, so freeTier stays false to
    // avoid implying every model is free.
    freeTier: false,
    dashboardUrl: "https://portal.nousresearch.com",
    defaultModel: "tencent/hy3:free",
    liveModels: true,
    models: ["tencent/hy3:free", "poolside/laguna-s-2.1:free", "stepfun/step-3.7-flash:free", "poolside/laguna-xs-2.1:free"],
    modelDiscovery: {
      // Resolves against effectiveBaseUrl (registry baseUrl .../v1) to the same
      // canonical endpoint https://inference-api.nousresearch.com/v1/models.
      // Nous returns a mixed paid/free catalog whose JSON can exceed 256 KiB;
      // keep the provider-specific limit below the process-wide 4 MiB ceiling.
      path: "models",
      maxResponseBytes: 1_048_576,
      maxModels: 512,
    },
    note: "Nous Research subscription gateway. OAuth device login with your own Portal account; mixed paid + :free models discovered live (fallback seed 2026-08-10: tencent/hy3:free, poolside/laguna-s-2.1:free, stepfun/step-3.7-flash:free, poolside/laguna-xs-2.1:free).",
  },
  {
    id: "openai-apikey",
    label: "OpenAI API",
    adapter: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    authKind: "key",
    supportsServiceTier: true,
    featured: true,
    dashboardUrl: "https://platform.openai.com/api-keys",
    defaultModel: "gpt-5.5",
    models: ["gpt-5.5", ...OPENAI_GPT56_MODELS, ...OPENAI_GPT56_PRO_MODELS, ...OPENAI_DAYBREAK_MODELS, "gpt-6-astra", ...OPENAI_GPT6_MODELS],
    liveModels: true,
    modelContextWindows: {
      ...OPENAI_API_GPT56_CONTEXT_WINDOWS, ...OPENAI_DAYBREAK_CONTEXT_WINDOWS, "gpt-6-astra": 1_050_000,
      ...Object.fromEntries(OPENAI_GPT6_MODELS.map(id => [id, 1_050_000])),
    },
    modelMaxInputTokens: {
      ...OPENAI_API_GPT56_MAX_INPUT_TOKENS, ...OPENAI_DAYBREAK_MAX_INPUT_TOKENS, "gpt-6-astra": 922_000,
      ...Object.fromEntries(OPENAI_GPT6_MODELS.map(id => [id, 922_000])),
    },
    modelMaxOutputTokens: { "gpt-6-astra": 128_000, ...Object.fromEntries(OPENAI_GPT6_MODELS.map(id => [id, 128_000])) },
    modelInputModalities: Object.fromEntries(
      ["gpt-5.5", ...OPENAI_GPT56_MODELS, ...OPENAI_GPT56_PRO_MODELS, ...OPENAI_DAYBREAK_MODELS, "gpt-6-astra", ...OPENAI_GPT6_MODELS]
        .map(id => [id, ["text", "image"]]),
    ),
    modelReasoningEfforts: {
      ...Object.fromEntries(
        [...OPENAI_GPT56_MODELS, ...OPENAI_GPT56_PRO_MODELS].map(id => [id, OPENAI_API_GPT56_REASONING_EFFORTS]),
      ),
      ...OPENAI_DAYBREAK_REASONING_EFFORTS,
      "gpt-6-astra": ["low", "medium", "high", "xhigh", "max"],
      ...Object.fromEntries(OPENAI_GPT6_MODELS.map(id => [id, ["low", "medium", "high", "xhigh", "max"]])),
    },
    virtualModels: OPENAI_API_GPT56_VIRTUAL_MODELS,
  },
  /* [Decision Log]
  - 목적과 의도: Reach Meta's Muse Spark models directly on Meta's own Model API, instead of only through the Command Code and OpenCode Zen resellers already in this registry.
  - 기존 구현 및 제약 조건: Meta publishes both POST /v1/responses and POST /v1/chat/completions at https://api.meta.ai/v1, and no API key was issued for this change — every value here comes from the published spec (devlog/_plan/260903_muse_spark_plan_oauth/001).
  - 검토한 주요 대안: register as openai-chat; use provider id "meta"; enable live discovery; wire the Muse Code subscription credential as OAuth.
  - 선택한 방식: an openai-responses key provider under the id "meta-model", with a static two-model roster and no OAuth.
  - 다른 대안 대신 이 방식을 선택한 이유: Meta calls Responses "the recommended default for new work ... OpenAI-compatible and exposes the full feature set", carrying reasoning replay and native input_image that Chat would forfeit. The id is "meta-model" because "meta" would capture the LIVE Command Code selector meta/muse-spark-1.3 at router.ts's provider-prefix branch, and would derive META_API_KEY — the Muse Code CLI's variable, not this API's MODEL_API_KEY.
  - 장점, 단점 및 영향: users reach Muse Spark without a reseller; discovery stays off until an authenticated /v1/models payload is actually observed, so an unseen roster (Meta also serves image and voice families here) cannot leak into the picker.
  */
  {
    id: "meta-model",
    label: "Meta Model API",
    adapter: "openai-responses",
    baseUrl: "https://api.meta.ai/v1",
    authKind: "key",
    dashboardUrl: "https://dev.meta.ai/docs/authentication",
    defaultModel: "muse-spark-1.3",
    models: META_MUSE_MODELS,
    // Static roster: no authenticated /v1/models payload was ever observed (the only
    // contact was an unauthenticated GET returning 401 invalid_api_key), and Meta serves
    // non-agent families on this same base URL. Turning discovery on would publish an
    // unseen roster into the picker.
    liveModels: false,
    // A user may already own a custom provider named "meta-model" pointing elsewhere;
    // without this, registry transport canonicalization would retarget it and send their
    // saved key to Meta.
    preserveCustomDestination: true,
    modelContextWindows: Object.fromEntries(META_MUSE_MODELS.map(id => [id, META_MUSE_CONTEXT_WINDOW])),
    // text+image only. Meta also documents video, audio (degraded on 1.3), and PDF, but
    // the catalog modality enum is text/image and over-advertising poisons the exported
    // client config (see tests/codex-integration/catalog-input-modality-enum.test.ts).
    modelInputModalities: Object.fromEntries(META_MUSE_MODELS.map(id => [id, ["text", "image"] as ["text", "image"]])),
    modelReasoningEfforts: Object.fromEntries(META_MUSE_MODELS.map(id => [id, META_MUSE_REASONING_EFFORTS])),
    modelReasoningEffortMap: Object.fromEntries(META_MUSE_MODELS.map(id => [id, META_MUSE_REASONING_EFFORT_MAP])),
    // No defaultMaxOutputTokens: Meta publishes none. The only number in its docs
    // (131072) appears inside a third-party config sample, and the protocol pages call
    // the real limit "model-dependent".
    // Meta names its variable MODEL_API_KEY, but the env var opencodex reads is derived
    // from the provider id (META_MODEL_API_KEY). Saying only Meta's name would send a
    // user to export a variable this proxy never reads.
    note: "Pay-as-you-go Meta Model API. Get a key at https://dev.meta.ai (Meta calls it MODEL_API_KEY; export it here as META_MODEL_API_KEY) — a Meta developer account needs a payment method before it can serve requests, and every call is metered per token. A Muse Code subscription does NOT work here: Meta scopes that credential to the Muse Code CLI and bills any other key pay-as-you-go (dev.meta.ai/docs/muse-code/subscriptions). The Contributor tier (muse-spark-1.3-contributor) is cheap because Meta trains on your prompts — about 92% off input, 95% off output, 99% off cached input; do not send confidential material through it. Muse Spark is also reachable through resellers: command-code carries both tiers, opencode-go serves only muse-spark-1.3-contributor.",
  },
  /* [Decision Log]
  - 목적과 의도: Let an operator who already signed the Muse Code CLI in reach Muse Spark with that credential, instead of provisioning a second key.
  - 기존 구현 및 제약 조건: The CLI stores a pointer at ~/.config/muse/auth.json and the secret in the macOS Keychain (ai.meta.dev.credentials/meta). Measured: the OAuth access_token 401s on /v1/models while the sibling api_key returns 200, so the usable artifact is a static key, not a refreshable token.
  - 검토한 주요 대안: spawn `muse login` and poll; reimplement Meta's device grant; treat it as a second key preset; ship nothing.
  - 선택한 방식: an OAuth provider that imports the existing credential on macOS and accepts a pasted key elsewhere, validates either once, and never spawns or reimplements anything.
  - 다른 대안 대신 이 방식을 선택한 이유: `muse login` has no non-interactive mode, so a spawned child could outlive cancellation, and polling for the pointer file is satisfied instantly by the one already on disk — reimporting the OLD account on a force-login. Reimplementing the grant would mean guessing a client id the vendor does not publish.
  - 장점, 단점 및 영향: no new credential to provision, and the id is distinct from meta-model so neither pool contaminates the other. Meta scopes this credential to its own CLI, so the provider carries a HIGH_RISK ToS warning, a CLI-side warning before any read, and a note that says plainly what is unsupported.
  */
  {
    id: "meta-muse",
    label: "Meta Muse Code (CLI credential)",
    adapter: "openai-responses",
    baseUrl: "https://api.meta.ai/v1",
    // Meta's own client sends these on every Muse Code call. The compatibility marker
    // is transparent while selecting the credential surface that accepts `max`.
    // Declared here rather than in a transport hook so it also covers model discovery
    // (src/oauth/index.ts:1176) and still yields to a user-set header
    // (mergeRegistryStaticHeaders, src/providers/registry.ts:3494).
    staticHeaders: {
      "User-Agent": "muse-build/1.3.0 (opencodex compatibility)",
      "x-api-version": "1.0.0",
    },
    authKind: "oauth",
    oauthId: "meta-muse",
    dashboardUrl: "https://dev.meta.ai",
    defaultModel: "muse-spark-1.3",
    models: META_MUSE_MODELS,
    // Same reason as meta-model: the authenticated roster carries muse-image-1.0 and
    // muse-voice-transcribe-1.0, which this Responses-agent provider cannot drive.
    liveModels: false,
    modelContextWindows: Object.fromEntries(META_MUSE_MODELS.map(id => [id, META_MUSE_CONTEXT_WINDOW])),
    modelInputModalities: Object.fromEntries(META_MUSE_MODELS.map(id => [id, ["text", "image"] as ["text", "image"]])),
    modelReasoningEfforts: Object.fromEntries(META_MUSE_MODELS.map(id => [id, META_MUSE_CODE_REASONING_EFFORTS])),
    modelReasoningEffortMap: Object.fromEntries(META_MUSE_MODELS.map(id => [id, META_MUSE_CODE_REASONING_EFFORT_MAP])),
    note: "Signs in to Meta with a browser device code on any platform, then mints the Muse Code subscription key. That grant is reimplemented from the one the Muse Code CLI performs and has NOT been exercised against Meta from OpenCodex, so treat the first login as unverified. If the Muse Code CLI is already signed in on macOS, the existing key is imported instead of starting a new grant. A pasted key from https://dev.meta.ai still works as a fallback when a device login cannot complete, and faces the same format check and live validation. A device login authenticates as Meta own Muse Code client, which is a stronger claim than reusing a key the CLI already minted. Meta scopes that credential to the Muse Code CLI, so this is an UNSUPPORTED use: Meta does not authorize subscription coverage outside its own CLI, how these calls settle is not observable from the API, and you should treat every call as billable against your account. The key, imported or pasted, is copied into OpenCodex's auth store. For an account signed in with the device login, OpenCodex refreshes Meta's subscription windows on demand from the same key endpoint the login uses, at most once every five minutes. For an imported or pasted key there is no endpoint to query them on demand, so OpenCodex reads them from streaming responses and shows the last observed value with its age; refreshing one then requires another streaming turn, and translated (non-passthrough) turns report none. Rate limits apply per team, not per key. For a supported path use the meta-model provider with your own key (export it as META_MODEL_API_KEY).",
  },
  {
    id: "umans",
    label: "Umans AI Coding Plan",
    adapter: "anthropic",
    baseUrl: "https://api.code.umans.ai",
    authKind: "key",
    featured: true,
    dashboardUrl: "https://app.umans.ai/billing",
    defaultModel: "umans-coder",
    models: UMANS_MODELS,
    modelContextWindows: UMANS_MODEL_CONTEXT_WINDOWS,
    modelInputModalities: UMANS_MODEL_INPUT_MODALITIES,
    note: "Coding plan via Anthropic Messages",
    modelReasoningEfforts: {
      "umans-coder": UMANS_REASONING_EFFORTS,
      "umans-kimi-k2.7": UMANS_REASONING_EFFORTS,
      "umans-flash": UMANS_REASONING_EFFORTS,
      "umans-glm-5.3": UMANS_GLM_53_REASONING_EFFORTS,
      "umans-glm-5.3-flash": UMANS_GLM_53_REASONING_EFFORTS,
      "umans-glm-5.2": UMANS_GLM_REASONING_EFFORTS,
      "umans-glm-5.1": UMANS_GLM_REASONING_EFFORTS,
      "umans-qwen3.6-35b-a3b": UMANS_REASONING_EFFORTS,
    },
    noVisionModels: UMANS_TEXT_ONLY_MODELS,
    escapeBuiltinToolNames: true,
  },
  {
    id: "opencode-go", label: "opencode go", adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1",
    authKind: "key", featured: true, dashboardUrl: "https://opencode.ai/auth", defaultModel: "kimi-k2.7-code",
    jawcodeBundle: "opencode-go", note: "GLM, DeepSeek, Kimi, Qwen, MiMo…",
    // Zen Go can close a Chat stream after a fully assembled function call without sending
    // finish_reason or [DONE] (#2260). The adapter still rejects incomplete argument JSON.
    openaiChatEofTolerance: true,
    // Muse Spark on OpenCode Go can sit silent during prolonged reasoning and close without a protocol terminal.
    modelResponsesTerminalRepair: {
      "muse-spark-1.2-contributor": { graceMs: 5_000 },
      "muse-spark-1.3-contributor": { graceMs: 5_000 },
    },
    // Go rejects reasoning.encrypted_content with previous_response_id (#3838).
    // Use explicit replay history and the existing stateless Responses policy.
    statelessResponses: true,
    /* [Decision Log]
    - 목적과 의도: Route the exact models OpenCode Go documents on the Responses endpoint — GPT 5.6 Luna, Grok 4.6, and Muse Spark Contributor (#2617).
    - 기존 구현 및 제약 조건: The provider is mixed-wire but its provider-wide `openai-chat` adapter sent Luna to `/chat/completions`; explicit user `modelAdapters` entries must remain authoritative.
    - 검토한 주요 대안: Change the whole provider to Responses; infer the wire from model-family names; add one registry-only exact-model default.
    - 선택한 방식: Declare only the named models as `openai-responses` through the existing registry default mechanism; the map stays an exact-model allowlist rather than a family or provider-wide rule.
    - 다른 대안 대신 이 방식을 선택한 이유: OpenCode Go documents sibling models on Chat or Anthropic endpoints, and an exact registry default preserves both those routes and explicit opt-out precedence.
    - 장점, 단점 및 영향: Each listed model reaches `/responses` from every inbound surface without changing siblings; a future upstream endpoint change requires an evidence-backed registry update.
    */
    modelWireDefaults: {
      "gpt-5.6-luna": "openai-responses",
      "grok-4.6": "openai-responses",
      "muse-spark-1.3-contributor": "openai-responses",
      "muse-spark-1.2-contributor": "openai-responses",
    },
    modelContextWindows: {
      "kimi-k3": KIMI_K3_STANDARD_CONTEXT_WINDOW,
      // Zen Go discovers only the gateway id, so carry DeepSeek's official 1M V4.1
      // window here or Codex falls back to its conservative 128k routed-model default.
      "deepseek-v4.1-flash": 1_048_576,
      // The DeepSeek vision preview id is metadata-only here: the Go roster is
      // discovered live, so it applies the moment the gateway serves the id.
      [DEEPSEEK_VISION_PREVIEW_MODEL]: 1_048_576,
      // Muse Spark Contributor serves a 1,048,576-token (1M) context window over
      // /responses on Zen Go, matching its 1.1 sibling (Meta developer docs, verified 2026-08-28).
      // Without this declaration the catalog falls back to 128k, capping real usable context.
      // 1.3 ships the same window as 1.2 and is served from the same Zen Go roster.
      "muse-spark-1.3-contributor": 1_048_576,
      "muse-spark-1.2-contributor": 1_048_576,
    },
    modelInputModalities: {
      "kimi-k3": ["text", "image"],
      // glm-5.3-flash is a native VLM (docs.z.ai/guides/vlm/glm-5.3-flash). It is
      // deliberately absent from this preset's noVisionModels, which is the
      // correct NEGATIVE half, but with no positive modelInputModalities entry
      // configuredInputModalities returns undefined and the catalog falls through
      // to the ["text"] floor. The same model is already declared ["text","image"]
      // on the zai and zhipu-bigmodel-coding presets, so the registry described
      // one model two ways (#4505).
      "glm-5.3-flash": ["text", "image"],
      // Experimental DeepSeek vision preview — expected to merge into deepseek-v4-flash later.
      [DEEPSEEK_VISION_PREVIEW_MODEL]: ["text", "image"],
      // This route became natively multimodal; it is NOT a sidecar consumer.
      //
      // History: the id was declared text-only here and listed in this preset's
      // noVisionModels, which routed its images through the vision sidecar (#4505).
      // That classification came from jawcode metadata and went stale. Probed
      // 2026-09-19 against https://opencode.ai/zen/go/v1/chat/completions with the
      // headers this proxy sends: the route accepts an image_url part and the model
      // reads it correctly (a four-band colour chart was described in the right
      // order). Its sibling deepseek-v4-flash on the same gateway still answers
      // HTTP 400 "Model only supports text input", which is what keeps the two
      // distinct here rather than collapsing them.
      //
      // The declaration is what reaches an EXISTING install: derive.ts fills
      // noVisionModels all-or-nothing, so a config persisted while the stale list
      // was current keeps it forever, and modelInputModalities is filled per-key
      // BENEATH the saved value. Both halves are repaired by
      // stale-vision-classification-migration.ts; correcting the registry alone
      // would fix new installs and leave existing ones stripping images.
      "deepseek-v4.1-flash": ["text", "image"],
      // Muse Spark Contributor is natively multimodal on Zen Go: it accepts input_image
      // parts over /responses (probed 2026-08-26). Without this declaration the catalog
      // advertises it text-only and the Codex app blocks image attachments client-side with
      // "This model does not support image inputs" before the request ever reaches the proxy.
      // 1.3 is the same-shaped successor and Command Code documents it as multimodal.
      "muse-spark-1.3-contributor": ["text", "image"],
      "muse-spark-1.2-contributor": ["text", "image"],
    },
    modelReasoningEfforts: {
      "gpt-5.6-luna": OPENAI_API_GPT56_REASONING_EFFORTS,
      "grok-4.6": ["low", "medium", "high", "xhigh"],
      "glm-5.3": ZAI_GLM_53_REASONING_EFFORTS,
      "glm-5.3-flash": ZAI_GLM_53_REASONING_EFFORTS,
      "glm-5.2": ZAI_GLM_52_REASONING_EFFORTS,
      "qwen3.8-max": QWEN38_REASONING_EFFORTS,
      "kimi-k3": KIMI_CODING_K3_REASONING_EFFORTS,
      "kimi-k2.7-code": [],
      "kimi-k2.7-code-highspeed": [],
      ...Object.fromEntries(OPENCODE_GO_THINKING_TOGGLE_MODELS.map(id => [id, THINKING_TOGGLE_EFFORTS])),
      ...Object.fromEntries(OPENCODE_GO_THINKING_BUDGET_MODELS.map(id => [id, THINKING_BUDGET_EFFORTS])),
      ...Object.fromEntries(DEEPSEEK_GATEWAY_THINKING_MODELS.map(id => [id, deepseekThinkingEffortsFor(id)])),
    },
    modelDefaultReasoningEfforts: { "grok-4.6": "high", "kimi-k3": "max" },
    // glm-5.2 uses identity labels now that `max` is a native Codex level (no alias map);
    // the thinking-toggle map is a REAL wire alias (effort -> enabled/disabled) and stays.
    modelReasoningEffortMap: {
      "kimi-k3": KIMI_CODING_K3_REASONING_EFFORT_MAP,
      ...Object.fromEntries(OPENCODE_GO_THINKING_TOGGLE_MODELS.map(id => [id, THINKING_TOGGLE_MAP])),
      ...Object.fromEntries(DEEPSEEK_GATEWAY_THINKING_MODELS.map(id => [id, deepseekReasoningMapFor(id)])),
    },
    modelSupportsReasoningSummaries: {
      "glm-5.3": true,
      "glm-5.3-flash": true,
      "glm-5.2": true,
      "glm-5.1": true,
      "glm-5": true,
      ...Object.fromEntries(DEEPSEEK_GATEWAY_THINKING_MODELS.map(id => [id, true])),
    },
    thinkingToggleModels: OPENCODE_GO_THINKING_TOGGLE_MODELS,
    /*
     * The Go-specific list, not the shared one. The shared `THINKING_BUDGET_MODELS` also
     * carries Neuralwatt-only ids (`qwen3.5-397b`, `qwen3.6-35b`) that this preset never
     * gives a ladder to, so a live roster serving one of them armed the thinking-budget
     * wire path with nothing to advertise: the catalog showed no effort control while the
     * adapter still translated effort into `thinking_budget`.
     */
    thinkingBudgetModels: OPENCODE_GO_THINKING_BUDGET_MODELS,
    noReasoningModels: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    // Text-only Zen Go models (jawcode metadata) — the vision sidecar describes images for
    // every model listed here (and the catalog advertises image input on their behalf).
    // Kimi K2.7 Code accepts text+image+video: do NOT list it here.
    noVisionModels: [
      "glm-5.3", "glm-5.2", "glm-5", "glm-5.1",
      // deepseek-v4.1-flash is deliberately absent: probed natively multimodal on this
      // gateway 2026-09-19 (see the modelInputModalities note above). Its sibling
      // deepseek-v4-flash stays listed — that route rejects image_url upstream.
      "deepseek-v4-flash",
      "mimo-v2-pro", "mimo-v2.5-pro",
      "minimax-m2.5", "minimax-m2.7",
      "qwen3.7-max",
    ],
    noTemperatureModels: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    noTopPModels: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    noPenaltyModels: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    autoToolChoiceOnlyModels: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    // Issue #78: DeepSeek V4 thinking mode requires reasoning_content replay on tool-call turns.
    preserveReasoningContentModels: ["glm-5.3", "glm-5.3-flash", "glm-5.2", "kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", ...DEEPSEEK_GATEWAY_THINKING_MODELS],
    /*
     * Issues #1338 / #1415: this gateway answers a `response_format` of type
     * `json_schema` with HTTP 400 `This response_format type is unavailable now`
     * (quoted from the upstream body as `Error from provider (Console Go)`), which
     * breaks every Codex auto-review turn on a DeepSeek route. #1424 shipped the
     * operator-side opt-out; operators have been applying it by hand ever since.
     * The reported rejection is type-specific, so this narrower list downgrades the
     * request to `json_object` instead of claiming the whole field is unavailable.
     */
    noJsonSchemaModels: [...DEEPSEEK_GATEWAY_THINKING_MODELS],
  },
  {
    id: "neuralwatt",
    label: "Neuralwatt Cloud",
    adapter: "openai-chat",
    baseUrl: "https://api.neuralwatt.com/v1",
    authKind: "key",
    dashboardUrl: "https://portal.neuralwatt.com",
    defaultModel: "glm-5.3",
    // 2026-07-10 live /v1/models: K2.5 rows were removed and GLM-5.2 short variants added.
    // 260814: the glm-5.3 quartet is speculative; live discovery is authoritative and drops
    // any id Neuralwatt has not published yet.
    // Evidence: devlog/_plan/260710_provider_hardening/003_research_aggregators.md and https://api.neuralwatt.com/v1/models.
    models: [
      "glm-5.3", "glm-5.3-fast", "glm-5.3-short", "glm-5.3-short-fast",
      "glm-5.3-flash",
      "glm-5.2", "glm-5.2-fast", "glm-5.2-short", "glm-5.2-short-fast",
      "kimi-k2.6", "kimi-k2.6-fast",
      "kimi-k2.7-code",
      "qwen3.5-397b", "qwen3.5-397b-fast", "qwen3.6-35b", "qwen3.6-35b-fast",
    ],
    // Neuralwatt's /v1/models metadata is authoritative; these static hints are the offline fallback.
    modelReasoningEfforts: {
      "glm-5.3": ZAI_GLM_53_REASONING_EFFORTS,
      "glm-5.3-fast": [],
      "glm-5.3-short": ZAI_GLM_53_REASONING_EFFORTS,
      "glm-5.3-short-fast": [],
      // No `-fast`/`-short` variants are asserted for the flash tier: those suffixes
      // encode routing Neuralwatt documents per model, and this seed has no source for them.
      "glm-5.3-flash": ZAI_GLM_53_REASONING_EFFORTS,
      "glm-5.2": ZAI_GLM_52_REASONING_EFFORTS,
      "glm-5.2-fast": [],
      "glm-5.2-short": ZAI_GLM_52_REASONING_EFFORTS,
      "glm-5.2-short-fast": [],
      "kimi-k2.6": [],
      "kimi-k2.6-fast": [],
      "kimi-k2.7-code": [],
      // Qwen3.x uses thinking_budget, NOT graded reasoning_effort; the adapter maps the five
      // Codex picker levels onto budget fractions.
      "qwen3.5-397b": THINKING_BUDGET_EFFORTS,
      "qwen3.5-397b-fast": [],
      "qwen3.6-35b": THINKING_BUDGET_EFFORTS,
      "qwen3.6-35b-fast": [],
    },
    thinkingBudgetModels: THINKING_BUDGET_MODELS,
    noReasoningModels: ["glm-5.3-fast", "glm-5.3-short-fast", "glm-5.2-fast", "glm-5.2-short-fast", "kimi-k2.6-fast", "qwen3.5-397b-fast", "qwen3.6-35b-fast"],
    noVisionModels: ["glm-5.3", "glm-5.3-fast", "glm-5.3-short", "glm-5.3-short-fast", "glm-5.2", "glm-5.2-fast", "glm-5.2-short", "glm-5.2-short-fast", "qwen3.5-397b", "qwen3.5-397b-fast"],
    noTemperatureModels: ["kimi-k2.7-code"],
    noTopPModels: ["kimi-k2.7-code"],
    noPenaltyModels: ["kimi-k2.7-code"],
    autoToolChoiceOnlyModels: ["kimi-k2.7-code"],
    preserveReasoningContentModels: NEURALWATT_REASONING_HISTORY_MODELS,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    adapter: "openai-chat",
    baseUrl: "https://openrouter.ai/api/v1",
    authKind: "key",
    featured: true,
    dashboardUrl: "https://openrouter.ai/keys",
    jawcodeBundle: "openrouter",
    models: ["anthropic/claude-sonnet-5", ...OPENROUTER_GPT56_MODELS, ...OPENAI_GPT6_MODELS.map(id => `openai/${id}`)],
    modelContextWindows: {
      "anthropic/claude-sonnet-5": 1_000_000,
      ...OPENROUTER_GPT56_CONTEXT_WINDOWS,
    },
    // OpenRouter documents priority support for OpenAI endpoints, but not Anthropic. Keep the
    // provider unclassified and opt in only the exact OpenAI-backed slugs we ship. These facts
    // belong only to the canonical destination; a same-named custom gateway is unknown to us.
    modelServiceTierCapabilityBaseUrlGuard: isCanonicalOpenRouterTarget,
    modelSupportsServiceTier: {
      "openai/gpt-5.6-sol": true,
      "openai/gpt-5.6-terra": true,
      "openai/gpt-5.6-luna": true,
      // 260923 preemptive: GPT-6 Sol/Luna are OpenAI-backed routes like the GPT-5.6 rows above.
      "openai/gpt-6-sol": true,
      "openai/gpt-6-luna": true,
    },
    // Deliberately no OpenRouter route pin: it bills the endpoint actually used and reports the
    // actual service_tier. B0 confirmation therefore owns downgrade safety. Forcing `only` plus
    // `allow_fallbacks:false` would turn a graceful priority-capacity fallback into a hard failure.
  },
  {
    // Primary sources checked 2026-08-02:
    // - docs.cline.bot/getting-started/clinepass publishes this exact catalog and explicitly
    //   authorizes using the full slugs through Cline's external API.
    // - docs.cline.bot/api/chat-completions and /api/errors define the endpoint, reasoning delta,
    //   and choice-scoped mid-stream error contract.
    // - Cline's official catalog source resolves per-model capabilities through OpenRouter data;
    //   the static context/modality snapshot below was cross-checked against that catalog.
    // - cline.bot/tos identifies Cline Bot Inc. as the operator. Maintenance owner: @lidge-jun.
    id: "cline-pass",
    label: "ClinePass",
    adapter: "openai-chat",
    baseUrl: "https://api.cline.bot/api/v1",
    authKind: "key",
    dashboardUrl: "https://app.cline.bot",
    defaultModel: "cline-pass/kimi-k3",
    models: CLINE_PASS_MODELS,
    modelContextWindows: CLINE_PASS_MODEL_CONTEXT_WINDOWS,
    modelInputModalities: CLINE_PASS_MODEL_INPUT_MODALITIES,
    noVisionModels: CLINE_PASS_TEXT_ONLY_MODELS,
    // Live-probed 2026-08-13 across every static ClinePass model: the gateway accepts and
    // validates low/medium/high/xhigh/max, and rejects an invalid sentinel. Preserve the
    // caller's requested tier and let ClinePass own any backend-specific normalization.
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    reasoningWireFormat: "gateway-object",
    preserveCustomDestination: true,
    note: "ClinePass subscription API. Uses a Cline API key and the full cline-pass/<model> upstream slug; quota is shared across the account's rolling 5-hour, weekly, and monthly limits.",
  },
  // Cline API (usage-billing): OpenAI-compatible Chat Completions. Model IDs follow the
  // OpenRouter-style `provider/model` convention. Live /models discovery is key-gated (401
  // without auth), so the static seed is the cold-start fallback. Evidence: docs.cline.bot/api/*.
  {
    id: "cline",
    label: "Cline",
    adapter: "openai-chat",
    baseUrl: "https://api.cline.bot/api/v1",
    authKind: "key",
    dashboardUrl: "https://app.cline.bot",
    liveModels: true,
    defaultModel: "anthropic/claude-sonnet-4-6",
    models: [
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-4o",
      "google/gemini-2.5-pro",
      "deepseek/deepseek-chat",
      "minimax/minimax-m2.5",
    ],
    preserveCustomDestination: true,
    note: "Cline usage-billing API: one key, 100+ models, OpenRouter-style ids. Promotional free models are IDE/CLI-only per Cline docs; minimax/minimax-m2.5 is the documented API free experimentation model.",
  },
  {
    // OrcaRouter: OpenAI-compatible adaptive router (api.orcarouter.ai). The public live
    // catalog is authoritative; model ids and input modalities are never maintained here.
    id: "orcarouter", label: "OrcaRouter - API", adapter: "openai-chat", baseUrl: "https://api.orcarouter.ai/v1",
    authKind: "key", dashboardUrl: "https://www.orcarouter.ai/console",
    // The catalog is public, so a successful /models probe cannot validate a submitted key.
    apiKeyValidation: "unknown",
    // Standard sponsor under SPONSORS.md (agreement signed 2026-09-07). Pins the row in the
    // picker and adds the chip; nothing about routing or defaults changes.
    sponsor: { tier: "standard", url: "https://www.orcarouter.ai/?utm_source=opencodex&utm_medium=readme" },
    defaultModel: "openai/gpt-5.5",
    models: ORCAROUTER_MODELS,
    liveModels: true,
    modelDiscovery: ORCAROUTER_MODEL_DISCOVERY,
    // Catalog discovery owns WHICH models exist. These entries only retain verified
    // request-shaping facts that the upstream catalog does not currently publish.
    modelReasoningEfforts: ORCAROUTER_MODEL_REASONING_EFFORTS,
    note: "OpenAI-compatible adaptive router. Models and multimodal capabilities are discovered live from the public chat catalog. Use the OrcaRouter account entry for PKCE login.",
  },
  {
    // PackyCode: API relay (packyapi.com) for Claude Code, Codex, Gemini and more. Codex traffic
    // uses the OpenAI-compatible host from their Codex/Kimi Code guides (docs.packyapi.com):
    // https://cf.api.fan/v1 — GET /v1/models answers 401 without a key, so the host is live and
    // discovery narrows to what the key's token group allows. Model ids are bare OpenAI-style
    // ids (the Codex token group lists gpt-5.5 / gpt-5.1-codex).
    // Standard sponsor under SPONSORS.md; the dashboardUrl carries their affiliate code.
    id: "packycode", label: "PackyCode", adapter: "openai-chat", baseUrl: "https://cf.api.fan/v1",
    authKind: "key", dashboardUrl: "https://www.packyapi.com/register?aff=k5KT",
    sponsor: { tier: "standard", url: "https://www.packyapi.com/register?aff=k5KT" },
    defaultModel: "gpt-5.5",
    models: ["gpt-5.5", "gpt-5.1-codex"],
    liveModels: true,
    // New key preset: opt into collision preservation so a row named `packycode` that a user
    // points at a different PackyCode host keeps its own destination instead of being pulled
    // back onto the Codex endpoint below.
    preserveCustomDestination: true,
    note: "API relay for Claude Code, Codex, Gemini and more. Create a Codex-group token at packyapi.com; live discovery lists what the token group allows.",
  },
  {
    // BizRouter: Korean enterprise LLM gateway (api.bizrouter.ai). Model ids are
    // vendor-namespaced (`<vendor>/<model>`) and pass through to the upstream as-is.
    // Live-verified 2026-07-24: /v1/chat/completions accepts the `tools` field and
    // streams, and GET /v1/models returns the per-API-key allowed catalog in the
    // OpenAI list shape, so live model discovery narrows to what the key can use.
    id: "bizrouter", label: "BizRouter", adapter: "openai-chat", baseUrl: "https://api.bizrouter.ai/v1",
    authKind: "key", dashboardUrl: "https://bizrouter.ai/settings/keys",
    defaultModel: "openai/gpt-5.6-sol",
    models: ["openai/gpt-5.6-sol", "openai/gpt-6-sol", "openai/gpt-6-luna", "anthropic/claude-sonnet-5", "google/gemini-3.5-flash"],
    note: "Korean enterprise LLM gateway. Per-key allowed models are discovered live from /v1/models. Full catalog: https://bizrouter.ai/models",
  },
  { id: "groq", label: "Groq", adapter: "openai-chat", baseUrl: "https://api.groq.com/openai/v1", authKind: "key", featured: true, dashboardUrl: "https://console.groq.com/keys" },
  // 2026-07-10 Gemini API refresh: Tier-2 ai.google.dev evidence recorded in
  // devlog/_plan/260710_provider_hardening/001_research_frontier.md.
  {
    id: "google", label: "Google Gemini", adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", authKind: "key", featured: true,
    dashboardUrl: "https://aistudio.google.com/apikey", defaultModel: "gemini-3.5-flash", models: ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview", "gemini-3.7-flash"],
    modelContextWindows: { "gemini-3.8-flash": 1_048_576, "gemini-3.6-flash": 1_048_576, "gemini-3.5-flash": 1_000_000, "gemini-3.5-flash-lite": 1_048_576, "gemini-3.7-flash": 1_048_576 },
    modelInputModalities: { "gemini-3.8-flash": ["text", "image"], "gemini-3.6-flash": ["text", "image"], "gemini-3.5-flash-lite": ["text", "image"], "gemini-3.7-flash": ["text", "image"] },
    modelReasoningEfforts: {
      // 3.7 and 3.8 omit `minimal`: Google documents it as a validation error on both model
      // pages, so advertising it hands the user a rung the API rejects. 3.5/3.6 keep theirs —
      // their pages still list it, and this unit has no evidence to change them.
      "gemini-3.8-flash": ["low", "medium", "high"],
      "gemini-3.7-flash": ["low", "medium", "high"],
      "gemini-3.6-flash": ["minimal", "low", "medium", "high"],
      "gemini-3.5-flash": ["minimal", "low", "medium", "high"],
      "gemini-3.1-pro-preview": ["low", "medium", "high"],
    },
    jawcodeBundle: "google", extraMetadataAliases: ["gemini"],
  },
  // 2026-07-10: defaultModel is frozen pending Vertex-specific Tier-2 evidence; Gemini API
  // evidence from ai.google.dev does not establish Vertex publisher availability.
  { id: "google-vertex", label: "Google Vertex AI", adapter: "google", baseUrl: "https://aiplatform.googleapis.com", authKind: "key", dashboardUrl: "https://console.cloud.google.com/vertex-ai", defaultModel: "gemini-3-pro", googleMode: "vertex", jawcodeBundle: "google", extraMetadataAliases: ["gemini-vertex"] },
  // Antigravity discovers models with a POST to the CCA `:fetchAvailableModels` RPC, which
  // `buildModelsRequest` already built by hand. Declaring it here changes no request URL — the
  // relative path resolves to the same destination — but it lets `isRegistryModelDiscoveryUrl`
  // prove that URL, which is what admits a Clash/Surge/Mihomo TUN fake-IP answer (#4261). The
  // path must stay RELATIVE: this row sets `allowBaseUrlOverride`, and an absolute `url` would
  // retarget a user's custom base back to Google. A leading `./` is required because a bare
  // `v1internal:` reads as a URL scheme and `providerModelDiscoverySpecError` rejects it.
  { id: "google-antigravity", alias: "agy", label: "Google Antigravity", adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", authKind: "oauth", allowBaseUrlOverride: true, dashboardUrl: "https://antigravity.google", models: ANTIGRAVITY_MODELS, liveModels: true, defaultModel: "gemini-3.8-flash", modelContextWindows: ANTIGRAVITY_MODEL_CONTEXT_WINDOWS, modelInputModalities: ANTIGRAVITY_MODEL_INPUT_MODALITIES, modelReasoningEfforts: ANTIGRAVITY_MODEL_EFFORTS, googleMode: "cloud-code-assist", showThinkingSummary: true, jawcodeBundle: "google", extraMetadataAliases: ["antigravity", "gemini-antigravity"], modelDiscovery: { path: "./v1internal:fetchAvailableModels" } },
  { id: "azure-openai", label: "Azure OpenAI", adapter: "azure-openai", baseUrl: "https://{resource}.openai.azure.com/openai", authKind: "key", featured: true, dashboardUrl: "https://portal.azure.com" },
  { id: "ollama", label: "Ollama (local)", adapter: "openai-chat", baseUrl: "http://localhost:11434/v1", authKind: "local", allowPrivateNetworkByDefault: true, allowBaseUrlOverride: true, featured: true, note: "Local — key usually blank" },
  { id: "vllm", label: "vLLM (local)", adapter: "openai-chat", baseUrl: "http://localhost:8000/v1", authKind: "local", allowPrivateNetworkByDefault: true, allowBaseUrlOverride: true, featured: true, note: "Local — key usually blank" },
  { id: "lm-studio", label: "LM Studio (local)", adapter: "openai-chat", baseUrl: "http://localhost:1234/v1", authKind: "local", allowPrivateNetworkByDefault: true, allowBaseUrlOverride: true, featured: true, note: "Local — no key needed" },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://platform.deepseek.com/api_keys",
    // Route DeepSeek's own catalog bundle so routed rebuilds restore the official
    // context window from the vendored model-metadata bundle instead of falling
    // back to the 128k strict-fields default (scripts/model-metadata.source.json,
    // verified 2026-08-08).
    jawcodeBundle: "deepseek",
    // deepseek-chat/deepseek-reasoner were deprecated upstream on 2026-07-24 15:59 UTC;
    // the current official identifier is deepseek-flash. They stay in
    // the list only as compatibility aliases so existing saved configs and requests
    // keep validating and routing (they previously mapped to v4-flash; devlog
    // _fin/260710_provider_hardening/002_research_cn.md). The current offerings are
    // V4.1-Flash — defaultModel and the model-specific wiring below use its live id.
    // Keep the legacy vision-preview alias; see DEEPSEEK_VISION_PREVIEW_MODEL.
    models: ["deepseek-chat", "deepseek-reasoner", ...DEEPSEEK_NATIVE_THINKING_MODELS, DEEPSEEK_VISION_PREVIEW_MODEL],
    // V4.1-Flash is the current first-party offering; `deepseek-v4-flash` now routes there
    // as a compatibility alias, so a new install should ask for the live id by name.
    defaultModel: "deepseek-flash",
    // Official DeepSeek Codex setup (codex-deepseek-setup.sh) advertises 1,048,576
    // for both V4 models; the older 1,000,000 figure was a rounded approximation.
    modelContextWindows: { "deepseek-flash": 1_048_576, "deepseek-v4-flash": 1_048_576, [DEEPSEEK_VISION_PREVIEW_MODEL]: 1_048_576 },
    modelInputModalities: {
      "deepseek-flash": ["text", "image"],
      [DEEPSEEK_VISION_PREVIEW_MODEL]: ["text", "image"],
    },
    // DeepSeek documents both V4 models as native Responses API models adapted for Codex
    // (model table marks Responses API ✓ for flash and pro; the /responses reference lists
    // both ids as accepted `model` values — verified 2026-08-13 with the V4 Pro GA,
    // version label DeepSeek-V4-Pro-0813).
    modelWireDefaults: {
      // Codex speaks Responses natively and DeepSeek ships a Codex-compatible
      // apply_patch tool on that wire, so a Responses inbound goes straight out with
      // no translation. Claude Code and OpenAI-compatible clients keep the
      // provider-wide Chat wire: DeepSeek serves Chat Completions natively too, so
      // translating them into Responses would add a hop onto our newest upstream path
      // for no gain.
      "deepseek-v4-flash": { wire: "openai-responses", inbound: ["responses"] },
      // Same Responses contract as the V4 ids it succeeds; without this row the new
      // default would fall back to the provider-wide Chat wire.
      "deepseek-flash": { wire: "openai-responses", inbound: ["responses"] },
    },
    // The #875-era bounded-JSON force (`modelResponsesUpstreamStreaming`) is retired
    // for this entry: the official guide documents a `response.completed` /
    // `response.incomplete` / `response.failed` terminal with NO `data: [DONE]`
    // sentinel, and live probes (2026-08-07, including the tool-result replay shape
    // that originally stalled) close on the terminal. The relay's terminal boundary
    // (src/server/relay.ts) already cuts the stream at that event and synthesizes
    // `[DONE]`, so forcing stream:false only delayed every byte until generation
    // finished (28-46 s of silence on long turns). The registry knob itself remains
    // for providers that need it — re-adding one line here restores the old policy.
    // Evidence: https://api-docs.deepseek.com/guides/responses_api/ +
    // devlog/_fin/260807_deepseek_responses_streaming/000_plan.md.
    // Current official streams normally carry a real terminal; retain a narrow grace
    // repair for the historical shape that closes after a complete graph without one.
    modelResponsesTerminalRepair: { "deepseek-flash": { graceMs: 5_000 }, "deepseek-v4-flash": { graceMs: 5_000 } },
    // DeepSeek's Responses route emits bare UUID item ids, which leave Codex
    // clients stuck on an uncommitted turn (#938). Client-facing only — raw
    // continuation snapshots keep the upstream ids.
    responsesItemIdRepair: { repairInvalidIds: true, repairMissingTerminalIds: true },
    // DeepSeek's Responses route is `POST /responses` with no `/v1` segment. Without
    // this the passthrough adapter falls back to its legacy `/v1/responses`
    // construction and the wire above can never route.
    // Evidence: https://api-docs.deepseek.com/api/create-response/
    responsesPath: "/responses",
    // DeepSeek's Responses reference does not list `service_tier`; unsupported
    // parameters are documented as silently ignored, but the fail-closed policy
    // strips the field rather than forwarding a knob the upstream never asked for.
    supportsServiceTier: false,
    // DeepSeek's Responses compatibility guide accepts plaintext reasoning items and
    // merges them into the adjacent assistant message, so replayed reasoning must
    // not be blanked the way the ChatGPT backend requires. (Whether the Responses
    // route REQUIRES replay on tool-call continuations is an inference from the
    // Chat Thinking-Mode docs, not a confirmed Responses contract.)
    preserveResponsesReasoningContent: true,
    // "The API is stateless: responses and conversations are not stored on the
    // server." https://api-docs.deepseek.com/api/create-response/
    statelessResponses: true,
    // DeepSeek rejects a valid Codex continuation when hook-provided developer
    // context splits a call from its result (#1292); parallel calls remain one
    // reasoning-bearing assistant batch rather than being split per pair (#1477).
    requiresAdjacentResponsesToolResults: true,
    // DeepSeek exec tool results can be present-but-empty (a script that ran without
    // calling text(...)); annotate them so routed models do not silently accept an
    // empty result or re-issue the same call.
    annotateEmptyToolOutputs: true,
    /* [Decision Log]
    - 목적: DeepSeek V4 thinking mode multi-turn/tool-call requests must replay prior assistant reasoning_content.
    - 대안 분석: Globally preserve reasoning_content for all OpenAI-compatible models; preserve it for legacy deepseek-reasoner too; mark only V4 thinking models in registry metadata.
    - 선택 근거: DeepSeek V4 thinking mode requires history replay, while older DeepSeek reasoner has different compatibility rules. A model-scoped registry flag fixes built-in and stale saved configs without broad provider regressions.
    */
    modelReasoningEfforts: Object.fromEntries(DEEPSEEK_NATIVE_THINKING_MODELS.map(id => [id, deepseekThinkingEffortsFor(id)])),
    modelReasoningEffortMap: Object.fromEntries(DEEPSEEK_NATIVE_THINKING_MODELS.map(id => [id, deepseekReasoningMapFor(id)])),
    modelSupportsReasoningSummaries: Object.fromEntries(DEEPSEEK_NATIVE_THINKING_MODELS.map(id => [id, true])),
    preserveReasoningContentModels: DEEPSEEK_NATIVE_THINKING_MODELS,
    // #4436: first-party deepseek-flash accepts native images on Chat and Responses.
    // Keep unprobed compatibility aliases on the #88 sidecar path. This must be fixed
    // here: router enrichment unions this list with saved config, so config cannot remove it.
    noVisionModels: ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash"],
  },
  // llama-3.3-70b was deprecated by Cerebras on 2026-02-16. Evidence: devlog/_plan/260710_provider_hardening/003_research_aggregators.md.
  { id: "cerebras", label: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://cloud.cerebras.ai/platform/apikeys", defaultModel: "gpt-oss-120b" },
  {
    // Primary sources checked 2026-08-08:
    // - https://chutes.ai/pricing documents the shared llm.chutes.ai/v1 OpenAI-compatible
    //   gateway, Bearer API keys, and chat completions. Its public
    //   https://llm.chutes.ai/v1/models response supplies supported_features for filtering.
    // - https://chutes.ai/terms identifies Chutes Global Corp as the platform operator, applies
    //   to API consumers, and directs production/high-volume automated inference to PAYGO.
    //   Maintainer: @olddonkey; no affiliation with Chutes.
    id: "chutes",
    label: "Chutes",
    baseUrl: "https://llm.chutes.ai/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://chutes.ai/auth/start",
    liveModels: true,
    preserveCustomDestination: true,
    // The public model catalog cannot prove that a supplied Bearer key is valid.
    apiKeyValidation: "unknown",
    // Chutes documents tool calling, but not a provider-wide parallel tool-call contract.
    parallelToolCalls: false,
    // The live catalog reports reasoning support, but not a stable effort ladder.
    reasoningEfforts: [],
    modelDiscovery: {
      path: "models",
      maxResponseBytes: 256 * 1024,
      maxModels: 128,
      filter: {
        // The shared LLM catalog also contains rows without native tool support. Codex needs a
        // complete agent loop, so admit only rows whose live metadata advertises tools.
        allOf: [{ path: ["supported_features"], containsAny: ["tools"] }],
      },
    },
    note: "Shared OpenAI-compatible LLM gateway only; live discovery exposes tool-capable rows. User-deployed custom Chute endpoints and non-LLM APIs require a custom provider.",
  },
  {
    id: "deepinfra",
    label: "DeepInfra",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://deepinfra.com/dash/api_keys",
    liveModels: true,
    preserveCustomDestination: true,
    modelDiscovery: {
      // DeepInfra documents the OpenAI model catalog outside the chat-compatible `/v1/openai`
      // namespace, so keep this destination registry-owned instead of deriving it from baseUrl.
      url: "https://api.deepinfra.com/v1/models",
      maxResponseBytes: 512 * 1024,
      maxModels: 512,
      filter: {
        allOf: [{ path: ["metadata", "tags"], containsAny: ["chat"] }],
      },
    },
    note: "OpenAI-compatible chat models only; live discovery excludes non-chat rows from DeepInfra's mixed model catalog.",
  },
  {
    id: "hyperbolic",
    label: "Hyperbolic",
    baseUrl: "https://api.hyperbolic.xyz/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://app.hyperbolic.ai",
    liveModels: true,
    preserveCustomDestination: true,
    modelDiscovery: {
      path: "models",
      maxResponseBytes: 256 * 1024,
      maxModels: 256,
    },
    note: "Serverless text and vision-language chat models only; Hyperbolic's separate image, audio, and GPU endpoints are out of scope.",
  },
  {
    // Primary sources checked 2026-08-03:
    // - docs.nscale.com documents the production OpenAI-compatible endpoint, bearer service
    //   tokens, /v1/models, and a tool-calling request using this exact Llama model id.
    // - nscale.com/policies/terms-conditions identifies Nscale AS as the service operator and
    //   covers customers using its public-cloud inference offering. Maintainer: @olddonkey;
    //   no affiliation with Nscale.
    id: "nscale",
    label: "Nscale Serverless Inference",
    baseUrl: "https://inference.api.nscale.com/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://console.nscale.com",
    defaultModel: "meta-llama/Llama-3.1-8B-Instruct",
    models: ["meta-llama/Llama-3.1-8B-Instruct"],
    liveModels: true,
    preserveCustomDestination: true,
    // Nscale documents tools but not parallel tool calls. Keep requests serialized.
    parallelToolCalls: false,
    // The API schema accepts reasoning_effort, but does not publish per-model tiers.
    reasoningEfforts: [],
    modelDiscovery: {
      path: "models",
      maxResponseBytes: 256 * 1024,
      maxModels: 256,
      filter: {
        // Nscale's catalog mixes chat, image, and embedding rows without a modality field.
        // Admit only the exact model used in its official tool-calling API example.
        allOf: [{ path: ["id"], equalsAny: ["meta-llama/Llama-3.1-8B-Instruct"] }],
      },
    },
    note: "Serverless OpenAI-compatible inference. Live discovery admits only the tool-capable model established by Nscale's official API example; other mixed-catalog rows remain hidden pending equivalent evidence.",
  },
  {
    // Primary sources checked 2026-08-03:
    // - docs.vultr.com documents the fixed OpenAI-compatible base URL, per-subscription bearer
    //   key, /v1/models, and states that tool calling is currently limited to kimi-k2-instruct.
    // - Vultr's official properties identify VULTR as a The Constant Company, LLC trademark and
    //   document customer API integrations. Maintainer: @olddonkey; no affiliation with Vultr.
    id: "vultr",
    label: "Vultr Serverless Inference",
    baseUrl: "https://api.vultrinference.com/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://my.vultr.com",
    defaultModel: "kimi-k2-instruct",
    models: ["kimi-k2-instruct"],
    liveModels: true,
    preserveCustomDestination: true,
    parallelToolCalls: false,
    reasoningEfforts: [],
    modelDiscovery: {
      path: "models",
      maxResponseBytes: 256 * 1024,
      maxModels: 256,
      filter: {
        // Vultr explicitly limits tool calling to this model. A coding agent must not select
        // another chat model that cannot complete its tool loop.
        allOf: [{ path: ["id"], equalsAny: ["kimi-k2-instruct"] }],
      },
    },
    note: "Serverless Inference subscription API. Live discovery exposes only kimi-k2-instruct because Vultr documents it as the sole tool-calling model.",
  },
];
