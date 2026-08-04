import type { OcxConfig } from "../../types";
import { probeHostname } from "../proxy-liveness";

export interface ApiAccessEndpoints {
  baseUrl: string;
  responsesEndpoint: string;
  chatCompletionsEndpoint: string;
  messagesEndpoint: string;
  modelsEndpoint: string;
  claudeCodeEnabled: boolean;
  /** Back-compat alias for older GUI clients. */
  endpoint: string;
}

export type BuildApiAccessEndpointsOptions = {
  /** Full request URL (preferred when the bind host is a wildcard). */
  requestUrl?: string | URL | null;
  /** Raw `Host` header from the inbound request. */
  requestHost?: string | null;
  /** Raw `Origin` header from the inbound request. */
  requestOrigin?: string | null;
};

function isWildcardBindHost(hostname: string | undefined): boolean {
  const trimmed = (hostname ?? "").trim();
  return !trimmed || trimmed === "0.0.0.0" || trimmed === "::" || trimmed === "[::]";
}

/** Bracket bare IPv6 literals for URL authority composition. */
export function formatAuthorityHost(hostname: string): string {
  const trimmed = hostname.trim();
  if (!trimmed) return "127.0.0.1";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  return trimmed.includes(":") ? `[${trimmed}]` : trimmed;
}

function hostnameFromAuthority(authority: string): string | null {
  const raw = authority.trim();
  if (!raw) return null;
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end > 0) return raw.slice(1, end) || null;
    return null;
  }
  // Host headers for IPv6 are bracketed; treat multi-colon values as unusable.
  if (raw.includes(":") && raw.split(":").length > 2) return null;
  const colon = raw.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(raw.slice(colon + 1))) {
    return raw.slice(0, colon) || null;
  }
  return raw;
}

function originBaseUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!url.hostname || isWildcardBindHost(url.hostname)) return null;
    return `${url.protocol}//${url.host}/v1`;
  } catch {
    return null;
  }
}

/**
 * Prefer the client's request host/origin when the proxy is bound to a wildcard.
 * Falls back to loopback only when no usable request context is available.
 */
export function resolveApiAccessBaseUrl(
  config: Pick<OcxConfig, "hostname" | "port">,
  opts: BuildApiAccessEndpointsOptions = {},
): string {
  const port = config.port ?? 10100;

  if (!isWildcardBindHost(config.hostname)) {
    return `http://${probeHostname(config.hostname)}:${port}/v1`;
  }

  const fromOrigin = opts.requestOrigin ? originBaseUrl(opts.requestOrigin) : null;
  if (fromOrigin) return fromOrigin;

  if (opts.requestUrl) {
    try {
      const url = typeof opts.requestUrl === "string" ? new URL(opts.requestUrl) : opts.requestUrl;
      if (url.hostname && !isWildcardBindHost(url.hostname)) {
        return `${url.protocol}//${url.host}/v1`;
      }
    } catch {
      /* ignore malformed request URL */
    }
  }

  const hostHeader = opts.requestHost?.trim();
  if (hostHeader) {
    const hostname = hostnameFromAuthority(hostHeader);
    if (hostname && !isWildcardBindHost(hostname)) {
      // Preserve an explicit port from the Host header; otherwise use the bind port.
      const hasPort = hostHeader.startsWith("[")
        ? /\]:\d+$/.test(hostHeader)
        : /:\d+$/.test(hostHeader) && hostHeader.split(":").length === 2;
      const authority = hasPort
        ? (hostHeader.startsWith("[") ? hostHeader : hostHeader)
        : `${formatAuthorityHost(hostname)}:${port}`;
      return `http://${authority}/v1`;
    }
  }

  return `http://127.0.0.1:${port}/v1`;
}

/** @deprecated Prefer resolveApiAccessBaseUrl; retained for focused host-format tests. */
export function resolveApiAccessDisplayHost(
  configHostname: string | undefined,
  opts: BuildApiAccessEndpointsOptions = {},
): string {
  if (!isWildcardBindHost(configHostname)) {
    return probeHostname(configHostname);
  }
  try {
    return new URL(resolveApiAccessBaseUrl({ hostname: configHostname, port: 10100 }, opts)).hostname
      || "127.0.0.1";
  } catch {
    return "127.0.0.1";
  }
}

export function buildApiAccessEndpoints(
  config: OcxConfig,
  opts: BuildApiAccessEndpointsOptions = {},
): ApiAccessEndpoints {
  const baseUrl = resolveApiAccessBaseUrl(config, opts);
  const responsesEndpoint = `${baseUrl}/responses`;
  return {
    baseUrl,
    responsesEndpoint,
    chatCompletionsEndpoint: `${baseUrl}/chat/completions`,
    messagesEndpoint: `${baseUrl}/messages`,
    modelsEndpoint: `${baseUrl}/models`,
    claudeCodeEnabled: config.claudeCode?.enabled !== false,
    endpoint: responsesEndpoint,
  };
}
