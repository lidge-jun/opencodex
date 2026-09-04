/**
 * Curated CodeBuddy model catalogs, transcribed from the OFFICIAL model manifest bundled with the
 * vendor CLI (`@tencent-ai/codebuddy-code` v2.143.0: `product.json` for the global/`public`
 * environment, `product.internal.json` for the China/`internal` environment) and cross-checked
 * against the CLI's own `--model` accept-list. Verified 2026-09-03.
 *
 * Global and CN are deliberately NOT the same roster (§八). Context windows, output caps, vision
 * and reasoning ladders are filled ONLY where the official manifest states them; a model with no
 * published figure is omitted rather than guessed (§二十八/§二十九). CodeBuddy exposes no documented
 * third-party live `/v1/models` endpoint, so these providers seed a static catalog
 * (`liveModels: false`) exactly like the Kiro and Command Code entries.
 */

/** Global (`public`) session models accepted by `codebuddy --model`. */
export const CODEBUDDY_GLOBAL_MODELS = [
  "default-model",
  "fast-model",
  "balanced-model",
  "primary-model",
  "deep-model",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gemini-3.5-flash",
  "glm-5.3",
  "glm-5.2",
  "kimi-k3",
  "kimi-k2.6",
  "minimax-m3",
];

/** China (`internal`) session models from the official internal manifest (text/chat models only). */
export const CODEBUDDY_CN_MODELS = [
  "default",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "minimax-m3",
  "minimax-m2.7",
  "glm-5.2",
  "glm-5.1",
  "glm-5.0",
  "glm-5.0-turbo",
  "glm-5v-turbo",
  "glm-4.7",
  "kimi-k3-1",
  "kimi-k2.7",
  "kimi-k2.6",
  "kimi-k2.5",
  "deepseek-v3-2-volc",
  "hy3",
  "hunyuan-chat",
];

/**
 * The CLI documents a single `--effort` ladder (minimal, low, medium, high, xhigh, max). The Codex
 * reasoning ladder overlaps it at low..max; `minimal`/`none` are Codex sentinels normalized by
 * `mapReasoningEffort`, and `ultra` folds to `max`. Declared provider-wide, then narrowed per model
 * where the official manifest publishes a smaller `supportedEfforts`.
 */
export const CODEBUDDY_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export const CODEBUDDY_GLOBAL_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "default-model": 176_000,
  "fast-model": 200_000,
  "balanced-model": 256_000,
  "primary-model": 272_000,
  "deep-model": 176_000,
  "gpt-5.6-sol": 1_000_000,
  "gpt-5.6-terra": 1_000_000,
  "gpt-5.6-luna": 1_000_000,
  "gpt-5.5": 1_000_000,
  "gpt-5.4": 272_000,
  "gpt-5.3-codex": 272_000,
  "gemini-3.5-flash": 1_000_000,
  "glm-5.3": 1_000_000,
  "glm-5.2": 1_000_000,
  "kimi-k3": 1_000_000,
  "kimi-k2.6": 256_000,
  "minimax-m3": 512_000,
};

export const CODEBUDDY_GLOBAL_MODEL_MAX_OUTPUT_TOKENS: Record<string, number> = {
  "default-model": 24_000,
  "fast-model": 32_000,
  "balanced-model": 32_000,
  "primary-model": 72_000,
  "deep-model": 24_000,
  "gpt-5.6-sol": 128_000,
  "gpt-5.6-terra": 128_000,
  "gpt-5.6-luna": 128_000,
  "gpt-5.5": 72_000,
  "gpt-5.4": 128_000,
  "gpt-5.3-codex": 128_000,
  "gemini-3.5-flash": 65_536,
  "glm-5.3": 48_000,
  "glm-5.2": 48_000,
  "kimi-k3": 32_000,
  "kimi-k2.6": 32_000,
  "minimax-m3": 128_000,
};

/** Per-model ladders narrowed from the official manifest's `reasoning.supportedEfforts`. */
export const CODEBUDDY_GLOBAL_MODEL_REASONING_EFFORTS: Record<string, string[]> = {
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh"],
  "glm-5.3": ["low", "high", "max"],
  "glm-5.2": ["high", "xhigh"],
};

export const CODEBUDDY_GLOBAL_MODEL_DEFAULT_REASONING_EFFORTS: Record<string, string> = {
  "gpt-5.6-sol": "high",
  "gpt-5.6-terra": "high",
  "gpt-5.6-luna": "high",
  "glm-5.3": "high",
  "glm-5.2": "high",
};

export const CODEBUDDY_CN_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "default": 200_000,
  "deepseek-v4-pro": 1_000_000,
  "deepseek-v4-flash": 1_000_000,
  "minimax-m3": 512_000,
  "minimax-m2.7": 200_000,
  "glm-5.2": 1_000_000,
  "glm-5.1": 200_000,
  "glm-5.0": 200_000,
  "glm-5.0-turbo": 200_000,
  "glm-5v-turbo": 200_000,
  "glm-4.7": 200_000,
  "kimi-k3-1": 1_000_000,
  "kimi-k2.7": 256_000,
  "kimi-k2.6": 256_000,
  "kimi-k2.5": 164_000,
  "deepseek-v3-2-volc": 96_000,
  "hy3": 192_000,
  "hunyuan-chat": 200_000,
};

export const CODEBUDDY_CN_MODEL_MAX_OUTPUT_TOKENS: Record<string, number> = {
  "default": 24_000,
  "deepseek-v4-pro": 50_000,
  "deepseek-v4-flash": 50_000,
  "minimax-m3": 128_000,
  "minimax-m2.7": 48_000,
  "glm-5.2": 48_000,
  "glm-5.1": 48_000,
  "glm-5.0": 48_000,
  "glm-5.0-turbo": 48_000,
  "glm-5v-turbo": 64_000,
  "glm-4.7": 48_000,
  "kimi-k3-1": 32_000,
  "kimi-k2.7": 32_000,
  "kimi-k2.6": 32_000,
  "kimi-k2.5": 32_000,
  "deepseek-v3-2-volc": 32_000,
  "hy3": 64_000,
  "hunyuan-chat": 8_192,
};

export const CODEBUDDY_CN_MODEL_REASONING_EFFORTS: Record<string, string[]> = {
  "hy3": ["low", "high"],
};

export const CODEBUDDY_CN_MODEL_DEFAULT_REASONING_EFFORTS: Record<string, string> = {
  "hy3": "high",
};

/**
 * Text-only models (official manifest `supportsImages: false`). Images for any OTHER model are
 * passed through natively; a model listed here has its images routed through the proxy's vision
 * sidecar rather than being silently dropped (§二十九).
 */
export const CODEBUDDY_CN_NO_VISION_MODELS = [
  "default",
  "glm-5.0",
  "glm-5.0-turbo",
  "glm-4.7",
  "deepseek-v3-2-volc",
  "hunyuan-chat",
];
