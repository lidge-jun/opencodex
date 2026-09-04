/**
 * Cold-start fallback from the official Qoder Global model documentation, verified 2026-09-03.
 * The account-specific `qoder --list-models` result is authoritative whenever discovery succeeds.
 */
export const QODER_GLOBAL_MODELS = [
  "Qwen3.8-Max",
  "Qwen3.7-Max",
  "Qwen3.7-Plus",
  "Kimi-K3",
  "Kimi-K2.7-Code",
  "GLM-5.3",
  "GLM-5.2",
  "DeepSeek-V4-Pro",
] as const;

export const QODER_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
