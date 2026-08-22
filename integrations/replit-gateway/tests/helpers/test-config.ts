import type { GatewayConfig } from "../../src/config";

export const TEST_GATEWAY_KEY = "gateway-key-01234567890123456789012";

export const TEST_OPENAI_UPSTREAM_HOST = "integrations.replit.com";
export const TEST_ANTHROPIC_UPSTREAM_HOST = "integrations.replit.com";

export function createTestGatewayConfig(
  overrides: Partial<{
    openaiBaseUrl: string;
    anthropicBaseUrl: string;
    openaiModels: string[];
    anthropicModels: string[];
    clientTimeoutMs: number;
    upstreamTimeoutMs: number;
  }> = {},
): GatewayConfig {
  return {
    publicOrigin: "https://my-app.replit.app",
    gatewayKey: TEST_GATEWAY_KEY,
    port: 8080,
    openai: {
      baseUrl: overrides.openaiBaseUrl ?? `https://${TEST_OPENAI_UPSTREAM_HOST}/openai/v1`,
      apiKey: "replit-openai-secret",
      allowedModels: overrides.openaiModels ?? ["gpt-4o"],
    },
    anthropic: {
      baseUrl: overrides.anthropicBaseUrl ?? `https://${TEST_ANTHROPIC_UPSTREAM_HOST}/anthropic`,
      apiKey: "replit-anthropic-secret",
      allowedModels: overrides.anthropicModels ?? ["claude-sonnet-4-6"],
    },
    limits: {
      maxRequestBytes: 32 * 1024 * 1024,
      maxHeaderBytes: 32 * 1024,
      maxConcurrentRequests: 10,
      upstreamTimeoutMs: overrides.upstreamTimeoutMs ?? 300_000,
      clientTimeoutMs: overrides.clientTimeoutMs ?? 310_000,
    },
  };
}
