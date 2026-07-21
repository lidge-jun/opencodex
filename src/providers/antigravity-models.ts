// Google Antigravity (Cloud Code Assist) bundled model list.
//
// Single source of truth: the Antigravity `:fetchAvailableModels` backend, the same one the `agy`
// CLI resolves labels against. The ids below separate CCA wire ids, visible client aliases, and
// hidden compatibility aliases for saved selections. The CCA envelope's `model` field must receive the wire id (for example
// "Gemini 3.1 Pro (High)" => gemini-pro-agent), while the picker can expose label-shaped aliases.
const ANTIGRAVITY_WIRE_MODELS = [
  "gemini-3.6-flash-low",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-high",
  "gemini-3.1-pro-low",
  "gemini-pro-agent",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
];

const ANTIGRAVITY_VISIBLE_MODEL_ALIASES: Record<string, string> = {
  "gemini-3.1-pro-high": "gemini-pro-agent",
  "gemini-3.1-pro-preview": "gemini-pro-agent",
};

const ANTIGRAVITY_COMPATIBILITY_MODEL_ALIASES: Record<string, string> = {
  "gemini-3.5-flash-extra-low": "gemini-3.6-flash-low",
  "gemini-3.5-flash-low": "gemini-3.6-flash-medium",
  "gemini-3.5-flash-mid": "gemini-3.6-flash-medium",
  "gemini-3.5-flash-high": "gemini-3.6-flash-high",
  "gemini-3-flash-agent": "gemini-3.6-flash-high",
};

export const ANTIGRAVITY_MODEL_ALIASES: Record<string, string> = {
  ...ANTIGRAVITY_VISIBLE_MODEL_ALIASES,
  ...ANTIGRAVITY_COMPATIBILITY_MODEL_ALIASES,
};

export const ANTIGRAVITY_MODELS = [
  ...ANTIGRAVITY_WIRE_MODELS,
  ...Object.keys(ANTIGRAVITY_VISIBLE_MODEL_ALIASES),
];

// Context windows from the upstream `:fetchAvailableModels` maxTokens per model.
const ANTIGRAVITY_WIRE_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "gemini-3.6-flash-low": 1_048_576,
  "gemini-3.6-flash-medium": 1_048_576,
  "gemini-3.6-flash-high": 1_048_576,
  "gemini-3.1-pro-low": 1_048_576,
  "gemini-pro-agent": 1_048_576,
  "claude-sonnet-4-6": 200_000,
  "claude-opus-4-6-thinking": 1_000_000,
  "gpt-oss-120b-medium": 131_072,
};

export const ANTIGRAVITY_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  ...ANTIGRAVITY_WIRE_MODEL_CONTEXT_WINDOWS,
  ...Object.fromEntries(
    Object.entries(ANTIGRAVITY_MODEL_ALIASES).map(([alias, wire]) => [
      alias,
      ANTIGRAVITY_WIRE_MODEL_CONTEXT_WINDOWS[wire],
    ]),
  ),
};

export function resolveAntigravityWireModelId(modelId: string): string {
  return ANTIGRAVITY_MODEL_ALIASES[modelId] ?? modelId;
}
