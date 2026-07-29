// Live catalog returned by WorkBuddy 5.2.6 through its public ACP session/new response.
// Model ids intentionally follow the wire values, not the UI display labels.
export const WORKBUDDY_MODELS = [
  "auto",
  "hy3",
  "glm-5.2",
  "glm-5.1",
  "glm-5v-turbo",
  "minimax-m3",
  "kimi-k3-1",
  "kimi-k2.7",
  "kimi-k2.6",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
] as const;

export const WORKBUDDY_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  auto: 168_000,
  hy3: 192_000,
  "glm-5.2": 1_000_000,
  "glm-5.1": 200_000,
  "glm-5v-turbo": 200_000,
  "minimax-m3": 1_000_000,
  "kimi-k3-1": 1_000_000,
  "kimi-k2.7": 256_000,
  "kimi-k2.6": 256_000,
  "deepseek-v4-flash": 1_000_000,
  "deepseek-v4-pro": 1_000_000,
};

export const WORKBUDDY_MODEL_INPUT_MODALITIES: Record<string, string[]> = Object.fromEntries(
  WORKBUDDY_MODELS.map(id => [id, ["text", "image"]]),
);

export const WORKBUDDY_MODEL_REASONING_EFFORTS: Record<string, string[]> = Object.fromEntries(
  WORKBUDDY_MODELS.map(id => [id, ["low", "medium", "high", "xhigh", "max"]]),
);
