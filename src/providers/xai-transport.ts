import { createHash, randomUUID } from "node:crypto";
import type { OcxProviderConfig } from "../types";
import { resolveGithubCopilotTransport } from "./github-copilot-transport";

export const XAI_GROK_CLI_BASE_URL = "https://cli-chat-proxy.grok.com/v1";

/** The two hosts that serve xAI's Responses API: the public API and the Grok CLI proxy. */
const XAI_RESPONSES_HOSTS = new Set(["api.x.ai", "cli-chat-proxy.grok.com"]);

/**
 * True when this provider's Responses traffic terminates at xAI itself.
 *
 * Probed 2026-08-22 one field per request: the two hosts accept and refuse exactly the same
 * web_search fields, so they are one dialect rather than two. Matching is exact-host over
 * https, which keeps lookalikes (`api.x.ai.evil.test`) and nonstandard ports out.
 */
export function isXaiResponsesDestination(provider: Pick<OcxProviderConfig, "baseUrl">): boolean {
  try {
    const url = new URL(provider.baseUrl);
    return url.protocol === "https:"
      && XAI_RESPONSES_HOSTS.has(url.hostname.toLowerCase())
      && (url.port === "" || url.port === "443");
  } catch {
    return false;
  }
}

export const XAI_GROK_COMPATIBILITY = {
  version: "0.2.93",
  userAgent: "opencodex-grok/0.2.93",
  headers: {
    clientIdentifier: "x-grok-client-identifier",
    clientVersion: "x-grok-client-version",
    tokenAuth: "x-xai-token-auth",
    authenticateResponse: "x-authenticateresponse",
    conversationId: "x-grok-conv-id",
    requestId: "x-grok-req-id",
    sessionId: "x-grok-session-id",
    userAgent: "User-Agent",
  },
} as const;

export const XAI_GROK_CLIENT_VERSION = XAI_GROK_COMPATIBILITY.version;
export const XAI_CONV_ID_HEADER = XAI_GROK_COMPATIBILITY.headers.conversationId;

export type OcxProviderTransport = OcxProviderConfig & {
  /** Request executor used only at runtime; never persisted. */
  fetch?: typeof globalThis.fetch;
};

const XAI_GROK_CLI_HEADERS: Readonly<Record<string, string>> = {
  [XAI_GROK_COMPATIBILITY.headers.clientIdentifier]: "opencodex",
  [XAI_GROK_COMPATIBILITY.headers.clientVersion]: XAI_GROK_CLIENT_VERSION,
  [XAI_GROK_COMPATIBILITY.headers.tokenAuth]: "xai-grok-cli",
  [XAI_GROK_COMPATIBILITY.headers.authenticateResponse]: "authenticate-response",
};

function hasHeaderCaseInsensitive(
  headers: Record<string, string> | undefined,
  name: string,
): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers ?? {}).some(key => key.toLowerCase() === target);
}

function withoutUserOverridden(
  defaults: Readonly<Record<string, string>>,
  userHeaders: Record<string, string> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(defaults).filter(([name]) => !hasHeaderCaseInsensitive(userHeaders, name)),
  );
}

function withGeneratedRequestId(
  init: RequestInit | undefined,
  pinnedRequestId: string,
  stableHeaders: Readonly<Record<string, string>>,
): RequestInit {
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(stableHeaders)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  if (!headers.has(XAI_GROK_COMPATIBILITY.headers.requestId)) {
    headers.set(
      XAI_GROK_COMPATIBILITY.headers.requestId,
      pinnedRequestId,
    );
  }
  return { ...init, headers };
}

function findHeaderCaseInsensitive(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === target)?.[1];
}

export function deriveXaiConvId(promptCacheKey: string): string {
  return createHash("sha256").update(promptCacheKey).digest("hex").slice(0, 32);
}

/**
 * Resolve xAI's runtime transport without mutating persisted config. Conversation/session
 * affinity is stable for this resolved transport; request identity is pinned per resolved
 * transport (= per logical request until key rotation), so same-target replays and transient
 * retries carry the same id while a rotated key gets a fresh one.
 * Agent, deployment, model-override, turn, mode, and user identity headers are intentionally
 * omitted because opencodex has no truthful values for the official fields.
 */
export function resolveProviderTransport(
  providerName: string,
  provider: OcxProviderTransport,
  promptCacheKey?: string,
  apiBaseUrl?: string,
): OcxProviderTransport {
  if (providerName === "github-copilot") {
    return resolveGithubCopilotTransport(provider, apiBaseUrl);
  }
  if (providerName !== "xai") return provider;

  const cacheKey = promptCacheKey?.trim();
  const affinity = cacheKey ? deriveXaiConvId(cacheKey) : undefined;
  const stableDefaults: Record<string, string> = {
    [XAI_GROK_COMPATIBILITY.headers.userAgent]: XAI_GROK_COMPATIBILITY.userAgent,
    ...(affinity
      ? {
          [XAI_GROK_COMPATIBILITY.headers.conversationId]: affinity,
          [XAI_GROK_COMPATIBILITY.headers.sessionId]: affinity,
        }
      : {}),
    ...(provider.authMode === "oauth" ? XAI_GROK_CLI_HEADERS : {}),
  };
  const stableHeaders = {
    ...withoutUserOverridden(stableDefaults, provider.headers),
    ...(provider.headers ?? {}),
  };
  // Keep API-key provider metadata compatible with key-pool rotation; session/UA defaults
  // remain transport-scoped and are applied by the wrapper immediately below.
  const headers = provider.authMode === "oauth"
    ? stableHeaders
    : {
        ...(affinity && !hasHeaderCaseInsensitive(provider.headers, XAI_GROK_COMPATIBILITY.headers.conversationId)
          ? { [XAI_GROK_COMPATIBILITY.headers.conversationId]: affinity }
          : {}),
        ...(provider.headers ?? {}),
      };
  const configuredRequestId = findHeaderCaseInsensitive(
    provider.headers,
    XAI_GROK_COMPATIBILITY.headers.requestId,
  );
  // Pin the request id per resolved transport (= per logical request until key rotation):
  // same-target 429 replays must carry the SAME x-grok-req-id as the original dispatch, and
  // transient retries reuse one id so the upstream can dedupe them. A rotated key resolves a
  // fresh transport, which gets its own id.
  const requestId = configuredRequestId ?? randomUUID();
  const baseFetch = provider.fetch ?? globalThis.fetch;
  const attemptFetch = ((input, init) =>
    baseFetch(input, withGeneratedRequestId(init, requestId, stableHeaders))) as typeof globalThis.fetch;

  return {
    ...provider,
    ...(provider.authMode === "oauth" ? { baseUrl: XAI_GROK_CLI_BASE_URL } : {}),
    headers,
    fetch: attemptFetch,
  };
}
