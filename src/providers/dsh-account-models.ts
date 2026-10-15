/**
 * DeepSeek Harness Account (dsh-account) model definitions and capabilities.
 *
 * Provenance:
 * DeepSeek Harness upstream v0.2.0-rc.2 (tag: dsh-v0.2.0-rc.2, commit: 639ed01539).
 * Directly mirrors packages/llm/llm-deepseek/src/models.ts and model-info.ts.
 */

export const DSH_ACCOUNT_MODELS = [
  "deepseek-flash",
  "deepseek-v4-pro",
] as const;

export const DSH_ACCOUNT_DEFAULT_MODEL = "deepseek-flash";

export const DSH_ACCOUNT_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "deepseek-flash": 1_000_000,
  "deepseek-v4-pro": 1_000_000,
};

export const DSH_ACCOUNT_MODEL_INPUT_MODALITIES: Record<string, string[]> = {
  "deepseek-flash": ["text", "image"],
  "deepseek-v4-pro": ["text"],
};

export const DSH_ACCOUNT_MODEL_MAX_OUTPUT_TOKENS: Record<string, number> = {
  "deepseek-flash": 64_000,
  "deepseek-v4-pro": 64_000,
};

export const DSH_ACCOUNT_REASONING_EFFORTS = ["off", "low", "high", "max"] as const;

export const DSH_ACCOUNT_MODEL_REASONING_EFFORTS: Record<string, string[]> = {
  "deepseek-flash": [...DSH_ACCOUNT_REASONING_EFFORTS],
  "deepseek-v4-pro": [...DSH_ACCOUNT_REASONING_EFFORTS],
};

export const DSH_ACCOUNT_MODEL_DISPLAY_NAMES: Record<string, string> = {
  "deepseek-flash": "DeepSeek-V4.1-Flash",
  "deepseek-v4-pro": "DeepSeek-V4-Pro",
};
