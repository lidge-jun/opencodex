import type { IncomingMeta } from "../base";
import type { OcxProviderConfig } from "../../types";
import {
  FORWARD_HEADERS,
  CODEX_ATTESTATION_HEADER,
  CODEX_RESPONSES_LITE_HEADER,
  isolateCodexPoolAccountHeaders,
} from "../../codex/forward-transport-headers";
import { CODEX_FORWARD_BASE_URL, isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers-destination";
import { normalizeForwardedClientHeaderName } from "../../lib/provider-client-headers";
import { AGENT_ASSERTION_HEADER } from "../../lib/authorization-scheme";
import { openaiResponsesUrl } from "../openai-responses-url";

export { FORWARD_HEADERS } from "../../codex/forward-transport-headers";

/** Carry permitted client metadata across an internal compact handoff, never credentials. */
export function copyResponsesClientMetadata(target: Headers, incoming: Headers, provider: OcxProviderConfig): void {
  const configured = Array.isArray(provider.forwardClientHeaders) ? provider.forwardClientHeaders.slice(0, 64) : [];
  for (const rawName of ["user-agent", ...configured]) {
    const name = normalizeForwardedClientHeaderName(rawName);
    const value = name === null ? null : incoming.get(name);
    if (name !== null && value && !target.has(name)) target.set(name, value);
  }
}

/**
 * Strip trailing slashes with a linear scan rather than a regex.
 *
 * `/\/+$/` retries candidate end positions when a long slash run is not at the end of the
 * string; the scan walks each character once and produces the same result on every input.
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

/** Shared Responses URL/auth/header construction; capabilities never grant auth authority. */
export function buildResponsesTransport(provider: OcxProviderConfig, incoming: Pick<IncomingMeta, "headers">): {
  url: string; headers: Record<string, string>;
} {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let url: string;
  if (provider.authMode === "forward") {
    const mayForwardCallerCredentials = isCanonicalOpenAiForwardProvider(provider);
    const baseUrl = mayForwardCallerCredentials ? CODEX_FORWARD_BASE_URL : stripTrailingSlashes(provider.baseUrl);
    url = `${baseUrl}/responses`;
    if (provider.headers) Object.assign(headers, provider.headers);
    const runtimeProvider = provider as {
      _codexAccountOverride?: { accessToken: string; chatgptAccountId: string; kind?: "pool" | "main-pool" };
      _codexAccountRequired?: boolean;
    };
    if (mayForwardCallerCredentials && runtimeProvider._codexAccountRequired && !runtimeProvider._codexAccountOverride) {
      throw new Error("Codex pool account auth is required but unavailable");
    }
    if (mayForwardCallerCredentials) {
      // Caller-existence gates also apply when provider defaults use mixed casing.
      for (const name of Object.keys(headers)) {
        if (["x-codex-installation-id", "x-codex-turn-metadata", CODEX_ATTESTATION_HEADER].includes(name.toLowerCase())) delete headers[name];
      }
      for (const name of FORWARD_HEADERS) {
        const value = incoming.headers.get(name);
        if (value === null) continue;
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
      const selected = new Headers(headers);
      selected.set("authorization", `Bearer ${override.accessToken}`);
      selected.set("chatgpt-account-id", override.chatgptAccountId);
      selected.delete(CODEX_ATTESTATION_HEADER);
      if (override.kind !== "main-pool") isolateCodexPoolAccountHeaders(selected, override.chatgptAccountId);
      // Replace every casing of managed fields after static headers and caller headers merge.
      for (const name of Object.keys(headers)) delete headers[name];
      selected.forEach((value, name) => { headers[name] = value; });
    } else if (mayForwardCallerCredentials) {
      // dual_header runtime assertion: first-party Direct only, beside the caller's own Bearer.
      // A pool override above never carries it, and non-canonical transports never see it.
      const assertion = incoming.headers.get(AGENT_ASSERTION_HEADER);
      if (assertion) headers[AGENT_ASSERTION_HEADER] = assertion;
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
