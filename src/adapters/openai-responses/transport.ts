import type { IncomingMeta } from "../base";
import type { OcxProviderConfig } from "../../types";
import { CODEX_RESPONSES_LITE_HEADER } from "../../codex/forward-transport-headers";
import { CODEX_FORWARD_BASE_URL, isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers-destination";
import { normalizeForwardedClientHeaderName } from "../../lib/provider-client-headers";
import { openaiResponsesUrl } from "../openai-responses-url";

// Caller credentials are forwarded only to the canonical Codex destination, never by capability.
export const FORWARD_HEADERS = [
  "authorization", "chatgpt-account-id", "openai-beta", "originator", "session_id", "session-id",
  "thread-id", "x-client-request-id", "x-codex-beta-features", "x-codex-installation-id",
  "x-codex-parent-thread-id", "x-codex-turn-metadata", "x-codex-turn-state", "x-codex-window-id",
  "x-oai-attestation", "x-openai-subagent", "x-responsesapi-include-timing-metrics", CODEX_RESPONSES_LITE_HEADER,
];

/** Carry permitted client metadata across an internal compact handoff, never credentials. */
export function copyResponsesClientMetadata(target: Headers, incoming: Headers, provider: OcxProviderConfig): void {
  const configured = Array.isArray(provider.forwardClientHeaders) ? provider.forwardClientHeaders.slice(0, 64) : [];
  for (const rawName of ["user-agent", ...configured]) {
    const name = normalizeForwardedClientHeaderName(rawName);
    const value = name === null ? null : incoming.get(name);
    if (name !== null && value && !target.has(name)) target.set(name, value);
  }
}

/** Shared Responses URL/auth/header construction; capabilities never grant auth authority. */
export function buildResponsesTransport(provider: OcxProviderConfig, incoming: Pick<IncomingMeta, "headers">): {
  url: string; headers: Record<string, string>;
} {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let url: string;
  if (provider.authMode === "forward") {
    const mayForwardCallerCredentials = isCanonicalOpenAiForwardProvider(provider);
    const baseUrl = mayForwardCallerCredentials ? CODEX_FORWARD_BASE_URL : provider.baseUrl.replace(/\/+$/, "");
    url = `${baseUrl}/responses`;
    if (provider.headers) Object.assign(headers, provider.headers);
    const runtimeProvider = provider as {
      _codexAccountOverride?: { accessToken: string; chatgptAccountId: string };
      _codexAccountRequired?: boolean;
    };
    if (mayForwardCallerCredentials && runtimeProvider._codexAccountRequired && !runtimeProvider._codexAccountOverride) {
      throw new Error("Codex pool account auth is required but unavailable");
    }
    if (mayForwardCallerCredentials) {
      for (const name of FORWARD_HEADERS) {
        const value = incoming.headers.get(name);
        if (!value) continue;
        if (name === CODEX_RESPONSES_LITE_HEADER) {
          for (const existing of Object.keys(headers)) {
            if (existing.toLowerCase() === name) delete headers[existing];
          }
        }
        headers[name] = value;
      }
    }
    const override = runtimeProvider._codexAccountOverride;
    if (override && mayForwardCallerCredentials) {
      headers.authorization = `Bearer ${override.accessToken}`;
      headers["chatgpt-account-id"] = override.chatgptAccountId;
    }
  } else {
    url = provider.responsesPath === undefined
      ? openaiResponsesUrl(provider.baseUrl)
      : `${provider.baseUrl.replace(/\/$/, "")}${provider.responsesPath}`;
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
    if (provider.headers) Object.assign(headers, provider.headers);
  }
  if (Array.isArray(provider.forwardClientHeaders)) {
    for (const rawName of provider.forwardClientHeaders.slice(0, 64)) {
      const name = normalizeForwardedClientHeaderName(rawName);
      if (name === null || Object.keys(headers).some(existing => existing.toLowerCase() === name)) continue;
      const value = incoming.headers.get(name);
      if (value) headers[name] = value;
    }
  }
  if (!Object.keys(headers).some(name => name.toLowerCase() === "user-agent")) {
    const userAgent = incoming.headers.get("user-agent");
    if (userAgent) headers["User-Agent"] = userAgent;
  }
  return { url, headers };
}
