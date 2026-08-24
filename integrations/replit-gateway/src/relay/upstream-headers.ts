import type { GatewayUpstreamConfig } from "../config";

export function buildOpenAiUpstreamHeaders(
  upstream: GatewayUpstreamConfig,
  contentType = "application/json",
): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${upstream.apiKey}`);
  headers.set("Content-Type", contentType);
  return headers;
}

export function buildAnthropicUpstreamHeaders(
  upstream: GatewayUpstreamConfig,
  contentType = "application/json",
): Headers {
  const headers = new Headers();
  headers.set("x-api-key", upstream.apiKey);
  headers.set("anthropic-version", "2023-06-01");
  headers.set("Content-Type", contentType);
  return headers;
}
