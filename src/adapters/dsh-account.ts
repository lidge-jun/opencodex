import type { IncomingMeta, ProviderAdapter } from "./base";
import { createAnthropicAdapter } from "./anthropic";
import type { AdapterFactoryContext } from "./registry";
import type { OcxParsedRequest, OcxProviderConfig } from "../types";

export const DSH_ACCOUNT_DEFAULT_MESSAGES_URL = "https://api.deepseek.com/anthropic/v1/messages";

export const DSH_ACCOUNT_RESERVED_HEADERS = new Set([
  "x-dsh-auth-token",
  "anthropic-version",
  "authorization",
  "x-api-key",
  "host",
]);

export function resolveDshAccountMessagesUrl(baseUrl?: string): string {
  if (!baseUrl || !baseUrl.trim()) {
    return DSH_ACCOUNT_DEFAULT_MESSAGES_URL;
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    throw new Error(`Untrusted dsh-account destination: "${baseUrl}". DSH credentials may only be transmitted to https://api.deepseek.com`);
  }

  // Pin protocol and hostname strictly to official DeepSeek API endpoint
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "api.deepseek.com") {
    throw new Error(
      `Untrusted dsh-account destination host: "${parsed.hostname}". DSH credentials may only be transmitted to https://api.deepseek.com`,
    );
  }

  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (!pathname || pathname === "" || pathname === "/anthropic" || pathname === "/anthropic/v1" || pathname === "/anthropic/v1/messages") {
    return DSH_ACCOUNT_DEFAULT_MESSAGES_URL;
  }

  throw new Error(`Untrusted dsh-account destination path: "${parsed.pathname}". Expected /anthropic/v1/messages.`);
}

export function createDshAccountAdapter(
  provider: OcxProviderConfig,
  _context?: AdapterFactoryContext,
): ProviderAdapter {
  // Use key authMode internally so that createAnthropicAdapter doesn't inject Claude Code headers/prompt.
  const baseAdapter = createAnthropicAdapter({
    ...provider,
    authMode: "key",
  }, "none");

  return {
    ...baseAdapter,
    name: "dsh-account",

    formatErrorBody(status: number, headers: Headers, payloadText: string): string {
      if (status === 401) {
        return "DeepSeek Harness account authentication failed (401 / ACCOUNT_TOKEN_INVALID). Please sign in to DeepSeek Harness Desktop and re-import.";
      }
      return baseAdapter.formatErrorBody?.(status, headers, payloadText) ?? payloadText;
    },

    async buildRequest(parsed: OcxParsedRequest, incoming: IncomingMeta) {
      const token = provider.apiKey?.trim();
      if (!token) {
        throw new Error("DeepSeek Harness account token missing — import your account in Providers > DeepSeek Account (DSH)");
      }

      // Fail-closed if custom provider configuration attempts to set any reserved header
      if (provider.headers) {
        for (const key of Object.keys(provider.headers)) {
          if (DSH_ACCOUNT_RESERVED_HEADERS.has(key.toLowerCase())) {
            throw new Error(`Reserved header "${key}" cannot be overridden in dsh-account provider configuration`);
          }
        }
      }

      const req = await baseAdapter.buildRequest(parsed, incoming);
      const url = resolveDshAccountMessagesUrl(provider.baseUrl);

      const headers: Record<string, string> = { ...req.headers };

      // Apply custom provider headers strictly before authoritative authentication headers
      if (provider.headers) {
        for (const [key, value] of Object.entries(provider.headers)) {
          if (!DSH_ACCOUNT_RESERVED_HEADERS.has(key.toLowerCase()) && typeof value === "string") {
            headers[key] = value;
          }
        }
      }

      // Authoritative cleanup: strip any API key or Claude headers
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase();
        if (
          lower === "authorization"
          || lower === "x-api-key"
          || lower === "x-dsh-auth-token"
          || lower === "anthropic-version"
          || lower === "anthropic-beta"
          || lower === "x-claude-code-session-id"
          || lower === "x-client-request-id"
        ) {
          delete headers[key];
        }
      }

      // Set authoritative DeepSeek Harness Account headers strictly at the end
      headers["x-dsh-auth-token"] = token;
      headers["anthropic-version"] = "2023-06-01";
      if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
      if (!headers["Accept"]) headers["Accept"] = parsed.stream ? "text/event-stream" : "application/json";

      return {
        ...req,
        url,
        headers,
        redirect: "manual",
      };
    },
  };
}
