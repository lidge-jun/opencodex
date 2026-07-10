import type { OcxProviderConfig } from "../types";
import { KIRO_MODELS, KIRO_MODEL_CONTEXT_WINDOWS, KIRO_MODEL_REASONING_EFFORTS } from "./kiro-models";
import { ANTIGRAVITY_MODELS, ANTIGRAVITY_MODEL_CONTEXT_WINDOWS } from "./antigravity-models";
import {
  CURSOR_STATIC_MODELS,
  cursorModelContextWindows,
  cursorModelIds,
  cursorModelInputModalities,
  cursorModelReasoningEfforts,
} from "../adapters/cursor/discovery";

export type ProviderAuthKind = "forward" | "oauth" | "key" | "local";
export type MetadataModelIdNormalize = "case-insensitive";

export interface ProviderRegistryEntry {
  id: string;
  label: string;
  adapter: string;
  baseUrl: string;
  authKind: ProviderAuthKind;
  keyOptional?: boolean;
  allowBaseUrlOverride?: boolean;
  modelSuffixBracketStrip?: boolean;
  featured?: boolean;
  dashboardPreset?: boolean;
  note?: string;
  dashboardUrl?: string;
  defaultModel?: string;
  models?: string[];
  liveModels?: boolean;
  contextWindow?: number;
  modelContextWindows?: Record<string, number>;
  modelInputModalities?: Record<string, string[]>;
  reasoningEfforts?: string[];
  modelReasoningEfforts?: Record<string, string[]>;
  reasoningEffortMap?: Record<string, string>;
  modelReasoningEffortMap?: Record<string, Record<string, string>>;
  noVisionModels?: string[];
  noReasoningModels?: string[];
  noTemperatureModels?: string[];
  noTopPModels?: string[];
  noPenaltyModels?: string[];
  /** Opt this provider into parallel tool calls (see OcxProviderConfig.parallelToolCalls). */
  parallelToolCalls?: boolean;
  autoToolChoiceOnlyModels?: string[];
  preserveReasoningContentModels?: string[];
  thinkingToggleModels?: string[];
  thinkingBudgetModels?: string[];
  escapeBuiltinToolNames?: boolean;
  oauthId?: string;
  jawcodeBundle?: string;
  extraMetadataAliases?: string[];
  metadataModelIdNormalize?: MetadataModelIdNormalize;
  googleMode?: "ai-studio" | "vertex" | "cloud-code-assist";
  project?: string;
  location?: string;
}

export type ProviderConfigSeed = Pick<
  OcxProviderConfig,
  "adapter" | "baseUrl" | "authMode" | "keyOptional" | "modelSuffixBracketStrip" | "defaultModel" | "models"
  | "liveModels" | "contextWindow" | "modelContextWindows" | "modelInputModalities"
  | "reasoningEfforts" | "modelReasoningEfforts" | "reasoningEffortMap" | "modelReasoningEffortMap"
  | "noVisionModels" | "noReasoningModels" | "noTemperatureModels" | "noTopPModels" | "noPenaltyModels"
  | "autoToolChoiceOnlyModels" | "preserveReasoningContentModels" | "thinkingToggleModels" | "thinkingBudgetModels" | "escapeBuiltinToolNames"
  | "googleMode" | "project" | "location"
>;

// Shared between the OAuth (Claude account) and API-key Anthropic entries so both expose the
// same static model seed.
// 260710 context refresh: Tier-2 evidence in
// devlog/_plan/260710_provider_hardening/001_research_frontier.md.
const ANTHROPIC_MODELS = ["claude-fable-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"];
const ANTHROPIC_MODEL_CONTEXT_WINDOWS: Record<string, number> = { "claude-sonnet-5": 1_000_000, "claude-fable-5": 1_000_000, "claude-opus-4-8": 1_000_000, "claude-haiku-4-5": 200_000 };

const ZAI_GLM_52_MODELS = ["glm-5.2", "glm-5.2[1m]"];
const ZAI_GLM_52_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// 260710 MiniMax models and context windows: Tier-2 evidence in
// devlog/_plan/260710_provider_hardening/002_research_cn.md.
const MINIMAX_MODELS = [
  "MiniMax-M3",
  "MiniMax-M2.7", "MiniMax-M2.7-highspeed",
  "MiniMax-M2.5", "MiniMax-M2.5-highspeed",
  "MiniMax-M2.1", "MiniMax-M2.1-highspeed",
  "MiniMax-M2",
];
const MINIMAX_MODEL_CONTEXT_WINDOWS: Record<string, number> = Object.fromEntries(
  MINIMAX_MODELS.map(id => [id, id === "MiniMax-M3" ? 1_000_000 : 204_800]),
);
const OPENAI_GPT56_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const OPENAI_GPT56_CONTEXT_WINDOW = 372_000;
const OPENAI_GPT56_CONTEXT_WINDOWS = {
  "gpt-5.6-sol": OPENAI_GPT56_CONTEXT_WINDOW,
  "gpt-5.6-terra": OPENAI_GPT56_CONTEXT_WINDOW,
  "gpt-5.6-luna": OPENAI_GPT56_CONTEXT_WINDOW,
};
const OPENROUTER_GPT56_MODELS = OPENAI_GPT56_MODELS.map(id => `openai/${id}`);
// OpenRouter's live /endpoints routes report 1,050,000; keep this separate from the
// unverified OpenAI API-key seed. Evidence: devlog/_plan/260710_provider_hardening/003_research_aggregators.md.
const OPENROUTER_GPT56_CONTEXT_WINDOW = 1_050_000;
const OPENROUTER_GPT56_CONTEXT_WINDOWS = {
  "openai/gpt-5.6-sol": OPENROUTER_GPT56_CONTEXT_WINDOW,
  "openai/gpt-5.6-terra": OPENROUTER_GPT56_CONTEXT_WINDOW,
  "openai/gpt-5.6-luna": OPENROUTER_GPT56_CONTEXT_WINDOW,
};

/**
 * Vendor thinking-toggle models (MiMo v2.x, GLM 5/5.1 on Zen Go): the wire knob is
 * `thinking: {type: enabled|disabled}` — a binary. Advertise the full Codex picker ladder
 * and map efforts onto the toggle. Zen Go
 * pass-through probed live 2026-07-07 (glm-5.2 toggle verified; mimo/minimax accept shape).
 */
const THINKING_TOGGLE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const THINKING_TOGGLE_MAP: Record<string, string> = {
  none: "disabled",
  minimal: "disabled",
  low: "disabled",
  medium: "enabled",
  high: "enabled",
  xhigh: "enabled",
  max: "enabled",
};
const OPENCODE_GO_THINKING_TOGGLE_MODELS = [
  "mimo-v2.5", "mimo-v2.5-pro", "mimo-v2-omni", "mimo-v2-pro", "glm-5", "glm-5.1",
];
const THINKING_BUDGET_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const THINKING_BUDGET_MODELS = [
  "qwen3.5-397b", "qwen3.6-35b",
  "qwen3.5-plus", "qwen3.6-plus", "qwen3.7-max", "qwen3.7-plus",
];
const OPENCODE_GO_THINKING_BUDGET_MODELS = ["qwen3.5-plus", "qwen3.6-plus", "qwen3.7-max", "qwen3.7-plus"];
const DEEPSEEK_THINKING_MODELS = ["deepseek-v4-pro", "deepseek-v4-flash"];
// "max" is advertised too: the wire map routes xhigh->max and max->max, so the picker
// should surface the max tier instead of hiding it behind xhigh.
const DEEPSEEK_THINKING_EFFORTS = ["high", "xhigh", "max"];
const DEEPSEEK_THINKING_REASONING_MAP: Record<string, string> = {
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
};
// 260710 Kimi model aliases and context windows: Tier-2 evidence in
// devlog/_plan/260710_provider_hardening/002_research_cn.md.
const KIMI_API_MODELS = ["kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2.5"];
const KIMI_CODING_MODELS = [...KIMI_API_MODELS, "kimi-for-coding"];
const KIMI_THINKING_MODELS = KIMI_CODING_MODELS;
const KIMI_LOCKED_PARAMETER_MODELS = KIMI_CODING_MODELS;
const KIMI_AUTO_TOOL_CHOICE_ONLY_MODELS = ["kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-for-coding"];
const KIMI_API_MODEL_CONTEXT_WINDOWS: Record<string, number> = Object.fromEntries(
  KIMI_API_MODELS.map(id => [id, 262_144]),
);
const KIMI_CODING_MODEL_CONTEXT_WINDOWS: Record<string, number> = Object.fromEntries(
  KIMI_CODING_MODELS.map(id => [id, 262_144]),
);
const NEURALWATT_REASONING_HISTORY_MODELS = [
  "glm-5.2", "glm-5.2-short",
  "kimi-k2.6", "kimi-k2.7-code",
  "qwen3.5-397b", "qwen3.6-35b",
];
const UMANS_MODELS = [
  "umans-coder",
  "umans-kimi-k2.7",
  "umans-flash",
  "umans-glm-5.2",
  "umans-glm-5.1",
  "umans-qwen3.6-35b-a3b",
];
const UMANS_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const UMANS_GLM_REASONING_EFFORTS = ["high", "xhigh", "max"];
const UMANS_TEXT_ONLY_MODELS = ["umans-glm-5.2", "umans-glm-5.1"];
const UMANS_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "umans-coder": 262_144,
  "umans-kimi-k2.7": 262_144,
  "umans-flash": 262_144,
  "umans-glm-5.2": 405_504,
  "umans-glm-5.1": 202_752,
  "umans-qwen3.6-35b-a3b": 262_144,
};
const UMANS_MODEL_INPUT_MODALITIES: Record<string, string[]> = Object.fromEntries(
  UMANS_MODELS.map(id => [id, UMANS_TEXT_ONLY_MODELS.includes(id) ? ["text"] : ["text", "image"]]),
);

export const PROVIDER_REGISTRY: readonly ProviderRegistryEntry[] = [
  {
    id: "openai",
    label: "OpenAI (ChatGPT login)",
    adapter: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    authKind: "forward",
    featured: true,
    note: "Uses your codex login — no API key",
  },
  {
    id: "cursor",
    label: "Cursor (experimental)",
    adapter: "cursor",
    baseUrl: "https://api2.cursor.sh",
    authKind: "oauth",
    featured: false,
    dashboardPreset: true,
    note: "Experimental Cursor bridge. Live transport and live model discovery are enabled after a standalone PKCE browser login via 'ocx login cursor'; native read/write/delete/shell/fetch execution stays disabled unless you set \"unsafeAllowNativeLocalExec\": true on providers.cursor in ~/.opencodex/config.json (dashboard: Providers → Cursor → Edit JSON) for a trusted local experiment.",
    models: cursorModelIds(CURSOR_STATIC_MODELS),
    liveModels: true,
    defaultModel: "auto",
    modelContextWindows: cursorModelContextWindows(CURSOR_STATIC_MODELS),
    modelInputModalities: cursorModelInputModalities(CURSOR_STATIC_MODELS),
    modelReasoningEfforts: cursorModelReasoningEfforts(CURSOR_STATIC_MODELS),
    // Cursor's wire protocol never forwards image parts (request-builder emits an unsupported-
    // content marker), so the vision sidecar covers ALL cursor models regardless of what the
    // upstream model could natively do. Live-discovered models outside the static list fall back
    // to the same marker until they appear here.
    noVisionModels: cursorModelIds(CURSOR_STATIC_MODELS),
  },
  {
    id: "xai",
    label: "xAI Grok",
    adapter: "openai-chat",
    baseUrl: "https://api.x.ai/v1",
    authKind: "oauth",
    featured: true,
    oauthId: "xai",
    jawcodeBundle: "xai",
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
    models: ["grok-4.5", "grok-4.3", "grok-4.20-multi-agent-0309", "grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning", "grok-build-0.1", "grok-composer-2.5-fast"],
    defaultModel: "grok-4.5",
    noReasoningModels: ["grok-4.20-0309-non-reasoning", "grok-build-0.1", "grok-composer-2.5-fast"],
    // grok-4.5 reasoning is always-on with low/medium/high control (no off tier upstream).
    modelReasoningEfforts: { "grok-4.5": ["low", "medium", "high"] },
    modelContextWindows: {
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
    id: "anthropic",
    label: "Anthropic Claude",
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authKind: "oauth",
    featured: true,
    oauthId: "anthropic",
    jawcodeBundle: "anthropic",
    note: "Log in with your Claude account",
    models: [...ANTHROPIC_MODELS],
    modelContextWindows: { ...ANTHROPIC_MODEL_CONTEXT_WINDOWS },
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
    defaultModel: "claude-sonnet-5",
  },
  {
    id: "kimi",
    label: "Kimi",
    adapter: "openai-chat",
    baseUrl: "https://api.kimi.com/coding/v1",
    authKind: "oauth",
    featured: true,
    oauthId: "kimi",
    jawcodeBundle: "moonshot",
    note: "Log in with your Kimi account",
    models: KIMI_CODING_MODELS,
    defaultModel: "kimi-k2.7-code",
    modelContextWindows: KIMI_CODING_MODEL_CONTEXT_WINDOWS,
    // Kimi thinking is controlled by Kimi's `thinking` extension, not OpenAI `reasoning_effort`.
    noReasoningModels: KIMI_THINKING_MODELS,
    modelReasoningEfforts: Object.fromEntries(KIMI_THINKING_MODELS.map(id => [id, []])),
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
    note: "Import-first: reuses your installed kiro-cli login (no browser). Experimental third-party harness — see Kiro ToS.",
    models: KIRO_MODELS,
    defaultModel: "kiro-auto",
    // Per-model context metadata is maintained next to the Kiro model list.
    modelContextWindows: KIRO_MODEL_CONTEXT_WINDOWS,
    modelReasoningEfforts: KIRO_MODEL_REASONING_EFFORTS,
  },
  { id: "openai-apikey", label: "OpenAI (API key)", adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authKind: "key", featured: true, dashboardUrl: "https://platform.openai.com/api-keys", defaultModel: "gpt-5.5", models: ["gpt-5.5", ...OPENAI_GPT56_MODELS], liveModels: true, modelContextWindows: OPENAI_GPT56_CONTEXT_WINDOWS },
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
    modelReasoningEfforts: {
      "glm-5.2": ZAI_GLM_52_REASONING_EFFORTS,
      "kimi-k2.7-code": [],
      "kimi-k2.7-code-highspeed": [],
      ...Object.fromEntries(OPENCODE_GO_THINKING_TOGGLE_MODELS.map(id => [id, THINKING_TOGGLE_EFFORTS])),
      ...Object.fromEntries(OPENCODE_GO_THINKING_BUDGET_MODELS.map(id => [id, THINKING_BUDGET_EFFORTS])),
      ...Object.fromEntries(DEEPSEEK_THINKING_MODELS.map(id => [id, DEEPSEEK_THINKING_EFFORTS])),
    },
    // glm-5.2 uses identity labels now that `max` is a native Codex level (no alias map);
    // the thinking-toggle map is a REAL wire alias (effort -> enabled/disabled) and stays.
    modelReasoningEffortMap: {
      ...Object.fromEntries(OPENCODE_GO_THINKING_TOGGLE_MODELS.map(id => [id, THINKING_TOGGLE_MAP])),
      ...Object.fromEntries(DEEPSEEK_THINKING_MODELS.map(id => [id, DEEPSEEK_THINKING_REASONING_MAP])),
    },
    thinkingToggleModels: OPENCODE_GO_THINKING_TOGGLE_MODELS,
    thinkingBudgetModels: THINKING_BUDGET_MODELS,
    noReasoningModels: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    // Text-only Zen Go models (jawcode metadata) — the vision sidecar describes images for
    // every model listed here (and the catalog advertises image input on their behalf).
    // Kimi K2.7 Code accepts text+image+video: do NOT list it here.
    noVisionModels: [
      "glm-5.2", "glm-5", "glm-5.1",
      "deepseek-v4-flash", "deepseek-v4-pro",
      "mimo-v2-pro", "mimo-v2.5-pro",
      "minimax-m2.5", "minimax-m2.7",
      "qwen3.7-max",
    ],
    noTemperatureModels: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    noTopPModels: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    noPenaltyModels: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    autoToolChoiceOnlyModels: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    // Issue #78: DeepSeek V4 thinking mode requires reasoning_content replay on tool-call turns.
    preserveReasoningContentModels: ["glm-5.2", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", ...DEEPSEEK_THINKING_MODELS],
  },
  {
    id: "neuralwatt",
    label: "Neuralwatt Cloud",
    adapter: "openai-chat",
    baseUrl: "https://api.neuralwatt.com/v1",
    authKind: "key",
    dashboardUrl: "https://portal.neuralwatt.com",
    defaultModel: "glm-5.2",
    // 2026-07-10 live /v1/models: K2.5 rows were removed and GLM-5.2 short variants added.
    // Evidence: devlog/_plan/260710_provider_hardening/003_research_aggregators.md and https://api.neuralwatt.com/v1/models.
    models: [
      "glm-5.2", "glm-5.2-fast", "glm-5.2-short", "glm-5.2-short-fast",
      "kimi-k2.6", "kimi-k2.6-fast",
      "kimi-k2.7-code",
      "qwen3.5-397b", "qwen3.5-397b-fast", "qwen3.6-35b", "qwen3.6-35b-fast",
    ],
    // Neuralwatt's /v1/models metadata is authoritative; these static hints are the offline fallback.
    modelReasoningEfforts: {
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
    noReasoningModels: ["glm-5.2-fast", "glm-5.2-short-fast", "kimi-k2.6-fast", "qwen3.5-397b-fast", "qwen3.6-35b-fast"],
    noVisionModels: ["glm-5.2", "glm-5.2-fast", "glm-5.2-short", "glm-5.2-short-fast", "qwen3.5-397b", "qwen3.5-397b-fast"],
    noTemperatureModels: ["kimi-k2.7-code"],
    noTopPModels: ["kimi-k2.7-code"],
    noPenaltyModels: ["kimi-k2.7-code"],
    autoToolChoiceOnlyModels: ["kimi-k2.7-code"],
    preserveReasoningContentModels: NEURALWATT_REASONING_HISTORY_MODELS,
  },
  { id: "openrouter", label: "OpenRouter", adapter: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", authKind: "key", featured: true, dashboardUrl: "https://openrouter.ai/keys", jawcodeBundle: "openrouter", models: ["anthropic/claude-sonnet-5", ...OPENROUTER_GPT56_MODELS], modelContextWindows: { "anthropic/claude-sonnet-5": 1_000_000, ...OPENROUTER_GPT56_CONTEXT_WINDOWS } },
  { id: "groq", label: "Groq", adapter: "openai-chat", baseUrl: "https://api.groq.com/openai/v1", authKind: "key", featured: true, dashboardUrl: "https://console.groq.com/keys" },
  // 2026-07-10 Gemini API refresh: Tier-2 ai.google.dev evidence recorded in
  // devlog/_plan/260710_provider_hardening/001_research_frontier.md.
  {
    id: "google", label: "Google Gemini", adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", authKind: "key", featured: true,
    dashboardUrl: "https://aistudio.google.com/apikey", defaultModel: "gemini-3.5-flash", models: ["gemini-3.5-flash", "gemini-3.1-pro-preview"],
    modelContextWindows: { "gemini-3.5-flash": 1_000_000 },
    modelReasoningEfforts: {
      "gemini-3.5-flash": ["minimal", "low", "medium", "high"],
      "gemini-3.1-pro-preview": ["low", "medium", "high"],
    },
    jawcodeBundle: "google", extraMetadataAliases: ["gemini"],
  },
  // 2026-07-10: defaultModel is frozen pending Vertex-specific Tier-2 evidence; Gemini API
  // evidence from ai.google.dev does not establish Vertex publisher availability.
  { id: "google-vertex", label: "Google Vertex AI", adapter: "google", baseUrl: "https://aiplatform.googleapis.com", authKind: "key", dashboardUrl: "https://console.cloud.google.com/vertex-ai", defaultModel: "gemini-3-pro", googleMode: "vertex", jawcodeBundle: "google", extraMetadataAliases: ["gemini-vertex"] },
  { id: "google-antigravity", label: "Google Antigravity", adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", authKind: "oauth", dashboardUrl: "https://antigravity.google", models: ANTIGRAVITY_MODELS, defaultModel: "gemini-3.5-flash-low", modelContextWindows: ANTIGRAVITY_MODEL_CONTEXT_WINDOWS, googleMode: "cloud-code-assist", jawcodeBundle: "google", extraMetadataAliases: ["antigravity", "gemini-antigravity"] },
  { id: "azure-openai", label: "Azure OpenAI", adapter: "azure-openai", baseUrl: "https://{resource}.openai.azure.com/openai", authKind: "key", featured: true, dashboardUrl: "https://portal.azure.com" },
  { id: "ollama", label: "Ollama (local)", adapter: "openai-chat", baseUrl: "http://localhost:11434/v1", authKind: "local", allowBaseUrlOverride: true, featured: true, note: "Local — key usually blank" },
  { id: "vllm", label: "vLLM (local)", adapter: "openai-chat", baseUrl: "http://localhost:8000/v1", authKind: "local", allowBaseUrlOverride: true, featured: true, note: "Local — key usually blank" },
  { id: "lm-studio", label: "LM Studio (local)", adapter: "openai-chat", baseUrl: "http://localhost:1234/v1", authKind: "local", allowBaseUrlOverride: true, featured: true, note: "Local — no key needed" },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://platform.deepseek.com/api_keys",
    // deepseek-chat/deepseek-reasoner are upstream-deprecated at 2026-07-24 15:59 UTC;
    // kept until then. Evidence: devlog/_plan/260710_provider_hardening/002_research_cn.md.
    models: ["deepseek-chat", "deepseek-reasoner", ...DEEPSEEK_THINKING_MODELS],
    defaultModel: "deepseek-v4-flash",
    modelContextWindows: { "deepseek-v4-flash": 1_000_000, "deepseek-v4-pro": 1_000_000 },
    /* [Decision Log]
    - 목적: DeepSeek V4 thinking mode multi-turn/tool-call requests must replay prior assistant reasoning_content.
    - 대안 분석: Globally preserve reasoning_content for all OpenAI-compatible models; preserve it for legacy deepseek-reasoner too; mark only V4 thinking models in registry metadata.
    - 선택 근거: DeepSeek V4 thinking mode requires history replay, while older DeepSeek reasoner has different compatibility rules. A model-scoped registry flag fixes built-in and stale saved configs without broad provider regressions.
    */
    modelReasoningEfforts: Object.fromEntries(DEEPSEEK_THINKING_MODELS.map(id => [id, DEEPSEEK_THINKING_EFFORTS])),
    modelReasoningEffortMap: Object.fromEntries(DEEPSEEK_THINKING_MODELS.map(id => [id, DEEPSEEK_THINKING_REASONING_MAP])),
    preserveReasoningContentModels: DEEPSEEK_THINKING_MODELS,
    // Issue #88: every DeepSeek API model is text-only input (no image support upstream) — the
    // vision sidecar describes attached images for them, and the catalog advertises image input
    // on their behalf (same treatment as opencode-go's DeepSeek V4 entries above).
    noVisionModels: ["deepseek-chat", "deepseek-reasoner", ...DEEPSEEK_THINKING_MODELS],
  },
  // llama-3.3-70b was deprecated by Cerebras on 2026-02-16. Evidence: devlog/_plan/260710_provider_hardening/003_research_aggregators.md.
  { id: "cerebras", label: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://cloud.cerebras.ai/platform/apikeys", defaultModel: "gpt-oss-120b" },
  // FREEZE 2026-07-10: exact serverless ids remain auth-gated/unverified. Evidence: devlog/_plan/260710_provider_hardening/003_research_aggregators.md.
  { id: "together", label: "Together", baseUrl: "https://api.together.xyz/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://api.together.xyz/settings/api-keys" },
  { id: "fireworks", label: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://fireworks.ai/account/api-keys" },
  {
    id: "firepass", label: "Fire Pass (Fireworks Kimi)", baseUrl: "https://api.fireworks.ai/inference/v1", adapter: "openai-chat", authKind: "key",
    dashboardUrl: "https://fireworks.ai/account/api-keys",
    note: "Model data frozen pending Tier-2 entitlement proof",
  },
  {
    id: "moonshot", label: "Moonshot (Kimi API)", baseUrl: "https://api.moonshot.ai/v1", adapter: "openai-chat", authKind: "key",
    dashboardUrl: "https://platform.moonshot.ai/console/api-keys", defaultModel: "kimi-k2.7-code", jawcodeBundle: "moonshot",
    models: KIMI_API_MODELS,
    modelContextWindows: KIMI_API_MODEL_CONTEXT_WINDOWS,
    noReasoningModels: KIMI_API_MODELS,
    modelReasoningEfforts: Object.fromEntries(KIMI_API_MODELS.map(id => [id, []])),
    noTemperatureModels: KIMI_API_MODELS,
    noTopPModels: KIMI_API_MODELS,
    noPenaltyModels: KIMI_API_MODELS,
    autoToolChoiceOnlyModels: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    preserveReasoningContentModels: KIMI_API_MODELS,
  },
  { id: "huggingface", label: "Hugging Face", baseUrl: "https://router.huggingface.co/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://huggingface.co/settings/tokens" },
  { id: "nvidia", label: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://build.nvidia.com" },
  { id: "venice", label: "Venice", baseUrl: "https://api.venice.ai/api/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://venice.ai/settings/api" },
  // 260710 GLM-5.2 context and path-specific ids: Tier-2 evidence in
  // devlog/_plan/260710_provider_hardening/002_research_cn.md.
  {
    id: "zai", label: "Z.AI — GLM Coding Plan", baseUrl: "https://api.z.ai/api/coding/paas/v4", adapter: "openai-chat", authKind: "key",
    dashboardUrl: "https://z.ai/manage-apikey/apikey-list", defaultModel: "glm-5.2",
    note: "GLM-5.2 coding subscription",
    models: ["glm-5.2", "glm-5.2[1m]", "glm-5.1", "glm-5", "glm-4.6"],
    modelContextWindows: { "glm-5.2": 1_000_000, "glm-5.2[1m]": 1_000_000 },
    // Z.AI's OpenAI path returns 400 code 1211 for bracketed model ids.
    modelSuffixBracketStrip: true,
    noVisionModels: ZAI_GLM_52_MODELS,
    modelReasoningEfforts: Object.fromEntries(ZAI_GLM_52_MODELS.map(id => [id, ZAI_GLM_52_REASONING_EFFORTS])),
    preserveReasoningContentModels: ZAI_GLM_52_MODELS,
  },
  { id: "nanogpt", label: "NanoGPT", baseUrl: "https://nano-gpt.com/api/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://nano-gpt.com/api" },
  { id: "synthetic", label: "Synthetic", baseUrl: "https://api.synthetic.new/openai/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://synthetic.new" },
  // 2026-07-10: docs unverified; model data frozen. Evidence: devlog/_plan/260710_provider_hardening/002_research_cn.md.
  { id: "qwen-portal", label: "Qwen Portal", baseUrl: "https://portal.qwen.ai/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://portal.qwen.ai" },
  // 2026-07-10: docs unverified; model data frozen. Evidence: devlog/_plan/260710_provider_hardening/002_research_cn.md.
  { id: "qianfan", label: "Qianfan (Baidu)", baseUrl: "https://qianfan.baidubce.com/v2", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://console.bce.baidu.com/iam/#/iam/apikey/list" },
  // 2026-07-10: docs unverified; model data frozen. Evidence: devlog/_plan/260710_provider_hardening/002_research_cn.md.
  { id: "alibaba", label: "Alibaba Coding Plan", baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://dashscope.console.aliyun.com/apiKey" },
  // NEEDS_HUMAN 2026-07-10: kept for config compatibility, but this is a dashboard URL,
  // no /models endpoint is documented, and tools are silently ignored upstream per docs.parallel.ai.
  // Evidence: devlog/_plan/260710_provider_hardening/003_research_aggregators.md.
  { id: "parallel", label: "Parallel", baseUrl: "https://platform.parallel.ai", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://platform.parallel.ai" },
  // FREEZE 2026-07-10: model ids remain unverified. Evidence: devlog/_plan/260710_provider_hardening/003_research_aggregators.md.
  { id: "zenmux", label: "ZenMux", baseUrl: "https://zenmux.ai/api/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://zenmux.ai" },
  {
    id: "litellm", label: "LiteLLM (self-hosted)", baseUrl: "http://localhost:4000/v1", adapter: "openai-chat", authKind: "key",
    dashboardUrl: "https://docs.litellm.ai/docs/proxy/quick_start",
    allowBaseUrlOverride: true,
    // A self-hosted proxy may legitimately run without a master key.
    keyOptional: true,
  },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    baseUrl: "https://ollama.com/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://ollama.com/settings/keys",
    // Live IDs verified 2026-07-10; qwen3-coder:480b retires 2026-07-15.
    // Evidence: .codexclaw/evidence/260710_wp9_ollama_cloud_model_ids.md.
    models: ["glm-5.2", "deepseek-v4-pro", "qwen3-coder:480b", "gpt-oss:120b", "kimi-k2.6", "minimax-m3", "qwen3.5:397b", "gemma4:31b"],
    defaultModel: "glm-5.2",
    noVisionModels: [
      "glm-5.2", "glm-5.1", "glm-5", "glm-4.7",
      "minimax-m2.7", "minimax-m2.5", "minimax-m2.1",
      "nemotron-3-ultra", "nemotron-3-super",
      "deepseek-v4-pro", "deepseek-v4-flash",
      "gpt-oss", "qwen3-coder:480b",
    ],
  },
  // FREEZE 2026-07-10: codestral-latest is unconfirmed behind auth. Evidence: devlog/_plan/260710_provider_hardening/003_research_aggregators.md.
  { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://console.mistral.ai/api-keys", defaultModel: "codestral-latest" },
  {
    id: "minimax", label: "MiniMax — Coding Plan", baseUrl: "https://api.minimax.io/v1", adapter: "openai-chat", authKind: "key",
    dashboardUrl: "https://platform.minimax.io", defaultModel: "MiniMax-M3", models: MINIMAX_MODELS,
    modelContextWindows: MINIMAX_MODEL_CONTEXT_WINDOWS,
    jawcodeBundle: "minimax", metadataModelIdNormalize: "case-insensitive", note: "Subscription Key or API Key",
  },
  {
    id: "minimax-cn", label: "MiniMax — Coding Plan (CN)", baseUrl: "https://api.minimaxi.com/v1", adapter: "openai-chat", authKind: "key",
    dashboardUrl: "https://platform.minimaxi.com", defaultModel: "MiniMax-M3", models: MINIMAX_MODELS,
    modelContextWindows: MINIMAX_MODEL_CONTEXT_WINDOWS,
    jawcodeBundle: "minimax", metadataModelIdNormalize: "case-insensitive", note: "中国区 Subscription Key",
  },
  {
    id: "kimi-code", label: "Kimi (coding)", baseUrl: "https://api.kimi.com/coding/v1", adapter: "openai-chat", authKind: "key",
    dashboardUrl: "https://platform.moonshot.cn/console/api-keys", defaultModel: "kimi-k2.7-code",
    models: KIMI_CODING_MODELS,
    modelContextWindows: KIMI_CODING_MODEL_CONTEXT_WINDOWS,
    noReasoningModels: KIMI_THINKING_MODELS,
    modelReasoningEfforts: Object.fromEntries(KIMI_THINKING_MODELS.map(id => [id, []])),
    noTemperatureModels: KIMI_LOCKED_PARAMETER_MODELS,
    noTopPModels: KIMI_LOCKED_PARAMETER_MODELS,
    noPenaltyModels: KIMI_LOCKED_PARAMETER_MODELS,
    autoToolChoiceOnlyModels: KIMI_AUTO_TOOL_CHOICE_ONLY_MODELS,
    preserveReasoningContentModels: KIMI_THINKING_MODELS,
  },
  { id: "opencode-zen", label: "opencode zen", baseUrl: "https://opencode.ai/zen/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://opencode.ai/auth" },
  { id: "vercel-ai-gateway", label: "Vercel AI Gateway", baseUrl: "https://ai-gateway.vercel.sh/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://vercel.com/dashboard" },
  { id: "xiaomi", label: "Xiaomi MiMo", baseUrl: "https://api.xiaomimimo.com/anthropic", adapter: "anthropic", authKind: "key", dashboardUrl: "https://xiaomimimo.com", defaultModel: "mimo-v2.5-pro" },
  { id: "kilo", label: "Kilo", baseUrl: "https://api.kilo.ai/api/gateway", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://kilo.ai" },
  { id: "cloudflare-ai-gateway", label: "Cloudflare AI Gateway", baseUrl: "https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic", adapter: "anthropic", authKind: "key", dashboardUrl: "https://dash.cloudflare.com/?to=/:account/ai/ai-gateway" },
  // FREEZE 2026-07-10: /models is auth-gated, so ids remain unverified. Evidence: devlog/_plan/260710_provider_hardening/003_research_aggregators.md.
  { id: "github-copilot", label: "GitHub Copilot", baseUrl: "https://api.githubcopilot.com", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://github.com/settings/copilot" },
  // FREEZE 2026-07-10: no public OpenAI-compatible endpoint is documented. Evidence: devlog/_plan/260710_provider_hardening/003_research_aggregators.md.
  { id: "gitlab-duo", label: "GitLab Duo", baseUrl: "https://cloud.gitlab.com/ai/v1/proxy/openai/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://gitlab.com/-/user_settings/personal_access_tokens" },
];

export function getProviderRegistryEntry(id: string): ProviderRegistryEntry | undefined {
  return PROVIDER_REGISTRY.find(entry => entry.id === id);
}

/**
 * Effective Google wire mode for a provider: config value, else registry backfill (a saved
 * key-login config may omit `googleMode` — mirrors the router's backfill), else "ai-studio"
 * (the Generative Language API default). Null for non-google adapters.
 */
export function effectiveGoogleMode(
  providerId: string,
  prov: { adapter?: string; googleMode?: "ai-studio" | "vertex" | "cloud-code-assist" },
): "ai-studio" | "vertex" | "cloud-code-assist" | null {
  if (prov.adapter !== "google") return null;
  return prov.googleMode ?? getProviderRegistryEntry(providerId)?.googleMode ?? "ai-studio";
}
