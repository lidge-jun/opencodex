export const REPLIT_OPENAI_PROVIDER_ID = "replit";
export const REPLIT_ANTHROPIC_PROVIDER_ID = "replit-anthropic";

export const REPLIT_PROVIDER_PAIR_IDS = [
  REPLIT_OPENAI_PROVIDER_ID,
  REPLIT_ANTHROPIC_PROVIDER_ID,
] as const;

export const REPLIT_DEFAULT_HOST_SUFFIX = ".replit.app";
export const MIN_REPLIT_GATEWAY_KEY_LENGTH = 32;
export const MAX_REPLIT_GATEWAY_KEY_LENGTH = 512;
export const REPLIT_GATEWAY_KEY_PATTERN = /^[\x21-\x7E]+$/;
export const REPLIT_PROBE_TIMEOUT_MS = 8_000;
export const REPLIT_MODELS_MAX_RESPONSE_BYTES = 1_048_576;
export const REPLIT_MODELS_MAX_MODELS = 256;

/** Provider fields owned by pair derivation; everything else is operator overlay. */
export const REPLIT_DERIVED_PROVIDER_FIELDS = [
  "adapter",
  "baseUrl",
  "authMode",
  "apiKeyTransport",
  "liveModels",
  "note",
  "apiKey",
  "apiKeyPool",
] as const;
