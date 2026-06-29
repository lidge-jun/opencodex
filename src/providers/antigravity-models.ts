// Google Antigravity (Cloud Code Assist) bundled model list.
//
// Single source of truth: the Antigravity `:fetchAvailableModels` backend, the same one the `agy`
// CLI resolves labels against. The 8 ids below are the WIRE ids (not the human labels) that the CCA
// `streamGenerateContent` envelope's `model` field accepts, each verified to return 200 live. The
// effort tier is baked into the id by the backend (e.g. "Gemini 3.1 Pro (High)" => gemini-pro-agent),
// so opencodex must send these exact strings, not the label-shaped guesses. Antigravity's OAuth
// backend has no OpenAI-style `GET /models`, so this static list is what surfaces in the picker.
export const ANTIGRAVITY_MODELS = [
  "gemini-3.5-flash-low",
  "gemini-3-flash-agent",
  "gemini-3.5-flash-extra-low",
  "gemini-3.1-pro-low",
  "gemini-pro-agent",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
];

// Context windows from the upstream `:fetchAvailableModels` maxTokens per model.
export const ANTIGRAVITY_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "gemini-3.5-flash-low": 1_048_576,
  "gemini-3-flash-agent": 1_048_576,
  "gemini-3.5-flash-extra-low": 1_048_576,
  "gemini-3.1-pro-low": 1_048_576,
  "gemini-pro-agent": 1_048_576,
  "claude-sonnet-4-6": 200_000,
  "claude-opus-4-6-thinking": 1_000_000,
  "gpt-oss-120b-medium": 131_072,
};
