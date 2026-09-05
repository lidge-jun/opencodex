// Shared client export constants.
import type { OcxConfig } from "../../types";


/** Provider key owned by this project; the only key any exporter ever emits. */
export const OPENCODE_PROVIDER_ID = "opencodex";

export const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json";

/**
 * Env var carrying the proxy admission key to opencode. The config only ever holds the
 * `{env:...}` reference, so the secret never lands on disk. opencode substitutes it at
 * load time.
 */
export const OPENCODE_API_KEY_ENV = "OPENCODEX_OPENCODE_API_KEY";

/** Env reference shared by apiKey and the dedicated proxy admission header. */
export const OPENCODE_API_KEY_ENV_REF = `{env:${OPENCODE_API_KEY_ENV}}`;

/**
 * Hermes interpolates `${VAR}` anywhere in config.yaml, so the credential stays
 * in the environment exactly as it does for OpenCode.
 */
export const HERMES_API_KEY_ENV = "OPENCODEX_HERMES_API_KEY";
export const HERMES_API_KEY_ENV_REF = `\${${HERMES_API_KEY_ENV}}`;

/** OpenClaw interpolates `${UPPERCASE_VAR}` and fails closed when it is unset. */
export const OPENCLAW_API_KEY_ENV = "OPENCODEX_OPENCLAW_API_KEY";
export const OPENCLAW_API_KEY_ENV_REF = `\${${OPENCLAW_API_KEY_ENV}}`;

/**
 * Placeholder credential for loopback-only clients (Kimi, Pi). A loopback
 * bind needs no real admission key, so we emit the same placeholder the Grok
 * managed block uses rather than a user secret. Pi resolves `apiKey` before
 * building its model list and hides the provider when an env reference is unset.
 */
export const LOOPBACK_API_KEY_PLACEHOLDER = "opencodex-loopback";

/**
 * Gajae's `apiKeyEnv` is env-name-only and fail-closed. Its sibling `apiKey`
 * falls back to treating the literal text as the token when the variable is
 * unset, which would silently ship a bogus credential — so we never emit it.
 */
export const GAJAE_API_KEY_ENV = "OPENCODEX_GAJAE_API_KEY";

/** Pi's wire-dialect selector for an OpenAI-compatible endpoint. */
export const PI_API_DIALECT = "openai-completions";

/**
 * opencode's config schema rejects a `limit` block that carries `context` without
 * `output`, but CatalogModel has no authoritative per-model output field. Dropping
 * `limit` entirely would also throw away the authoritative context window we DO have,
 * so the block is emitted with this budget standing in for the missing half.
 *
 * The value matches REASONING_MAX_TOKENS_CEILING in src/adapters/anthropic.ts — the
 * project's existing "safe ceiling across current models" figure. It is a ceiling for
 * schema validity, NOT a claim about any specific model's true maximum, and it is
 * clamped to the context window so a small-context model can never be emitted with
 * output > context. Pi's `maxTokens` uses the same stand-in and the same clamp.
 */
export const SCHEMA_REQUIRED_OUTPUT_BUDGET = 32_000;

/** Deterministic loopback default for exported provider-block helpers in tests. */
export const OPENCODE_PROVIDER_BLOCK_DEFAULT_CONFIG: OcxConfig = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as OcxConfig;
