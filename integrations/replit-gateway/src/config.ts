import {
  DEFAULT_CLIENT_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  DEFAULT_MAX_HEADER_BYTES,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  DECIMAL_INTEGER_PATTERN,
  MAX_CONFIG_CONCURRENT,
  MAX_CONFIG_HEADER_BYTES,
  MAX_CONFIG_PORT,
  MAX_CONFIG_REQUEST_BYTES,
  MAX_CONFIG_TIMEOUT_MS,
  MIN_CONFIG_CONCURRENT,
  MIN_CONFIG_HEADER_BYTES,
  MIN_CONFIG_PORT,
  MIN_CONFIG_REQUEST_BYTES,
  MIN_CONFIG_TIMEOUT_MS,
} from "./constants";
import { canonicalizePublicOrigin, validateUpstreamBaseUrl } from "./origin";
import { validateGatewayKey } from "./gateway-key";
import { parseModelAllowlist } from "./models";

export interface GatewayLimits {
  maxRequestBytes: number;
  maxHeaderBytes: number;
  maxConcurrentRequests: number;
  upstreamTimeoutMs: number;
  clientTimeoutMs: number;
}

export interface GatewayUpstreamConfig {
  baseUrl: string;
  apiKey: string;
  allowedModels: readonly string[];
}

export interface GatewayConfig {
  publicOrigin: string;
  gatewayKey: string;
  port: number;
  openai: GatewayUpstreamConfig;
  anthropic: GatewayUpstreamConfig;
  limits: GatewayLimits;
}

function requireEnv(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function parseStrictBoundedInt(
  raw: string | undefined,
  fallback: number,
  key: string,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const trimmed = raw.trim();
  if (!DECIMAL_INTEGER_PATTERN.test(trimmed)) {
    throw new Error(`${key} must be a decimal integer`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${key} must be between ${min} and ${max}`);
  }
  return parsed;
}

export function loadGatewayConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): GatewayConfig {
  const gatewayKey = requireEnv(env, "REPLIT_GATEWAY_KEY");
  validateGatewayKey(gatewayKey);

  const publicOrigin = canonicalizePublicOrigin(requireEnv(env, "REPLIT_GATEWAY_PUBLIC_ORIGIN"));

  const openaiModels = parseModelAllowlist(requireEnv(env, "REPLIT_GATEWAY_OPENAI_MODELS"));
  const anthropicModels = parseModelAllowlist(
    requireEnv(env, "REPLIT_GATEWAY_ANTHROPIC_MODELS"),
  );

  const openaiBaseUrl = validateUpstreamBaseUrl(
    requireEnv(env, "AI_INTEGRATIONS_OPENAI_BASE_URL"),
  );
  const anthropicBaseUrl = validateUpstreamBaseUrl(
    requireEnv(env, "AI_INTEGRATIONS_ANTHROPIC_BASE_URL"),
  );

  const upstreamTimeoutMs = parseStrictBoundedInt(
    env.REPLIT_GATEWAY_UPSTREAM_TIMEOUT_MS,
    DEFAULT_UPSTREAM_TIMEOUT_MS,
    "REPLIT_GATEWAY_UPSTREAM_TIMEOUT_MS",
    MIN_CONFIG_TIMEOUT_MS,
    MAX_CONFIG_TIMEOUT_MS,
  );
  const clientTimeoutMs = parseStrictBoundedInt(
    env.REPLIT_GATEWAY_CLIENT_TIMEOUT_MS,
    DEFAULT_CLIENT_TIMEOUT_MS,
    "REPLIT_GATEWAY_CLIENT_TIMEOUT_MS",
    MIN_CONFIG_TIMEOUT_MS,
    MAX_CONFIG_TIMEOUT_MS,
  );
  if (clientTimeoutMs < upstreamTimeoutMs) {
    throw new Error("client timeout must be greater than or equal to upstream timeout");
  }

  return {
    publicOrigin,
    gatewayKey,
    port: parseStrictBoundedInt(env.PORT, 8080, "PORT", MIN_CONFIG_PORT, MAX_CONFIG_PORT),
    openai: {
      baseUrl: openaiBaseUrl,
      apiKey: requireEnv(env, "AI_INTEGRATIONS_OPENAI_API_KEY"),
      allowedModels: openaiModels,
    },
    anthropic: {
      baseUrl: anthropicBaseUrl,
      apiKey: requireEnv(env, "AI_INTEGRATIONS_ANTHROPIC_API_KEY"),
      allowedModels: anthropicModels,
    },
    limits: {
      maxRequestBytes: parseStrictBoundedInt(
        env.REPLIT_GATEWAY_MAX_REQUEST_BYTES,
        DEFAULT_MAX_REQUEST_BYTES,
        "REPLIT_GATEWAY_MAX_REQUEST_BYTES",
        MIN_CONFIG_REQUEST_BYTES,
        MAX_CONFIG_REQUEST_BYTES,
      ),
      maxHeaderBytes: parseStrictBoundedInt(
        env.REPLIT_GATEWAY_MAX_HEADER_BYTES,
        DEFAULT_MAX_HEADER_BYTES,
        "REPLIT_GATEWAY_MAX_HEADER_BYTES",
        MIN_CONFIG_HEADER_BYTES,
        MAX_CONFIG_HEADER_BYTES,
      ),
      maxConcurrentRequests: parseStrictBoundedInt(
        env.REPLIT_GATEWAY_MAX_CONCURRENT,
        DEFAULT_MAX_CONCURRENT_REQUESTS,
        "REPLIT_GATEWAY_MAX_CONCURRENT",
        MIN_CONFIG_CONCURRENT,
        MAX_CONFIG_CONCURRENT,
      ),
      upstreamTimeoutMs,
      clientTimeoutMs,
    },
  };
}
