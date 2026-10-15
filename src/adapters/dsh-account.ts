import type { IncomingMeta, ProviderAdapter } from "./base";
import { createAnthropicAdapter } from "./anthropic";
import type { AdapterFactoryContext } from "./registry";
import type { OcxParsedRequest, OcxProviderConfig } from "../types";
import { resolveDshAccountMessagesUrl } from "../providers/dsh-account-destination";

export { DSH_ACCOUNT_DEFAULT_MESSAGES_URL, resolveDshAccountMessagesUrl } from "../providers/dsh-account-destination";

export const DSH_ACCOUNT_RESERVED_HEADERS = new Set([
  "x-dsh-auth-token",
  "anthropic-version",
  "authorization",
  "x-api-key",
  "host",
]);

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
