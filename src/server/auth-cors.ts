import { timingSafeEqual } from "node:crypto";
import { formatErrorResponse } from "../bridge";
import {
  codexAutoStartEnabled,
  providerBaseUrlConfigError,
  providerHeadersConfigError,
} from "../config";
import { providerDestinationConfigError } from "../lib/destination-policy";
import { getProviderRegistryEntry } from "../providers/registry";
import type { OcxConfig, OcxProviderConfig } from "../types";

let _corsOrigin = "http://localhost:10100";
export function setCorsOrigin(port: number): void { _corsOrigin = `http://localhost:${port}`; }
export function configuredPort(): string {
  try { return new URL(_corsOrigin).port; } catch { return "10100"; }
}

export function parseHttpHost(value: string | null): { hostname: string; port: string } | null {
  if (!value) return null;
  try {
    const parsed = new URL(`http://${value}`);
    return { hostname: parsed.hostname.toLowerCase(), port: parsed.port };
  } catch {
    return null;
  }
}

export function isLoopbackRequestHost(value: string | null): boolean {
  const parsed = parseHttpHost(value);
  if (!parsed) return true;
  if (!isLoopbackHostname(parsed.hostname)) return false;
  return parsed.port === "" || parsed.port === configuredPort();
}

export function isLoopbackOriginValue(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export function isSameOriginAsRequest(req: Request, origin: string): boolean {
  try {
    return origin === new URL(req.url).origin;
  } catch {
    return false;
  }
}

export function isAllowedRequestOrigin(req: Request, config: OcxConfig): boolean {
  function isExtraAllowedOrigin(origin: string, cfg: OcxConfig): boolean {
    if (!cfg.corsAllowOrigins?.length) return false;
    return cfg.corsAllowOrigins.some(allowed => {
      try {
        return new URL(allowed).origin === new URL(origin).origin;
      } catch {
        return allowed === origin;
      }
    });
  }
  const origin = req.headers.get("Origin");
  if (!isApiAuthRequired(config)) {
    if (!isLoopbackRequestHost(req.headers.get("Host"))) return false;
    return !origin || isLoopbackOriginValue(origin) || isExtraAllowedOrigin(origin, config);
  }
  return !origin || isLoopbackOriginValue(origin) || isSameOriginAsRequest(req, origin) || isExtraAllowedOrigin(origin, config);
}

export function corsHeaders(req?: Request, config?: OcxConfig): Record<string, string> {
  const origin = req?.headers.get("Origin");
  const allowOrigin = origin && req && config && isAllowedRequestOrigin(req, config) ? origin : _corsOrigin;
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-OpenCodex-API-Key, X-Api-Key, Anthropic-Version, Anthropic-Beta",
    "Vary": "Origin",
  };
}

export function withCors(response: Response, req: Request, config: OcxConfig): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders(req, config))) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function jsonResponse(data: unknown, status = 200, req?: Request, config?: OcxConfig): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(req, config) },
  });
}

export function configuredApiAuthToken(_config: OcxConfig): string | undefined {
  const token = process.env.OPENCODEX_API_AUTH_TOKEN?.trim();
  return token || undefined;
}

export function isLoopbackHostname(hostname: string | undefined): boolean {
  const normalized = (hostname ?? "127.0.0.1").trim().toLowerCase();
  return normalized === "" || normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

export function isApiAuthRequired(config: OcxConfig): boolean {
  return !isLoopbackHostname(config.hostname);
}

export function assertServerAuthConfig(config: OcxConfig): void {
  if (isApiAuthRequired(config) && !configuredApiAuthToken(config)) {
    throw new Error("OPENCODEX_API_AUTH_TOKEN is required when binding opencodex to a non-loopback hostname");
  }
}

/** Whether `token` is one of the proxy's own admission secrets (env token or config API keys). */
export function isProxyAdmissionSecret(token: string, config: OcxConfig): boolean {
  const actual = token.trim();
  if (!actual) return false;
  const enc = new TextEncoder();
  const actualBytes = enc.encode(actual);
  // Check env-based token
  const expected = configuredApiAuthToken(config);
  if (expected) {
    const expectedBytes = enc.encode(expected);
    if (expectedBytes.length === actualBytes.length && timingSafeEqual(actualBytes, expectedBytes)) return true;
  }
  // Check config-based API keys
  for (const k of config.apiKeys ?? []) {
    const keyBytes = enc.encode(k.key);
    if (keyBytes.length === actualBytes.length && timingSafeEqual(actualBytes, keyBytes)) return true;
  }
  return false;
}

export function hasValidApiAuth(req: Request, config: OcxConfig): boolean {
  if (!isApiAuthRequired(config)) return true;
  const actual = req.headers.get("x-opencodex-api-key")?.trim()
    || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim()
    // Anthropic-SDK clients (Claude Code with ANTHROPIC_API_KEY) authenticate via x-api-key.
    || req.headers.get("x-api-key")?.trim();
  if (!actual) return false;
  return isProxyAdmissionSecret(actual, config);
}

export function requireApiAuth(req: Request, config: OcxConfig, kind: "management" | "data-plane"): Response | null {
  if (hasValidApiAuth(req, config)) return null;
  if (kind === "management") return jsonResponse({ error: "opencodex API key required" }, 401);
  return formatErrorResponse(401, "authentication_error", "opencodex API key required");
}

export function providerManagementConfigError(name: string, provider: OcxProviderConfig): string | null {
  const baseUrlError = providerBaseUrlConfigError(provider.baseUrl);
  if (baseUrlError) return `provider ${name} ${baseUrlError}`;
  const destinationError = providerDestinationConfigError(name, provider);
  if (destinationError) return `provider ${name} ${destinationError}`;
  const headersError = providerHeadersConfigError(provider.headers);
  if (headersError) return `provider ${name} ${headersError}`;
  if (provider.authMode === "forward") {
    const normalizedName = name.trim().toLowerCase();
    const base = provider.baseUrl.replace(/\/+$/, "");
    const isBuiltInChatGptForward = (normalizedName === "openai" || normalizedName === "chatgpt")
      && provider.adapter === "openai-responses"
      && base === "https://chatgpt.com/backend-api/codex";
    if (isBuiltInChatGptForward) return null;
    return `provider ${name} uses reserved authMode "forward"; configure ChatGPT passthrough via the built-in provider`;
  }
  return null;
}

export function publicProviderBaseUrl(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "(invalid URL)";
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, baseUrl.endsWith("/") ? "/" : "");
  } catch {
    return "(invalid URL)";
  }
}

export function copyIfDefined<K extends keyof OcxProviderConfig>(
  out: Record<string, unknown>,
  provider: OcxProviderConfig,
  key: K,
): void {
  const value = provider[key];
  if (value !== undefined) out[key as string] = value as unknown;
}

export function safeConfigDTO(config: OcxConfig): unknown {
  const providers: Record<string, Record<string, unknown>> = {};
  for (const [name, provider] of Object.entries(config.providers)) {
    const registryEntry = getProviderRegistryEntry(name);
    const dto: Record<string, unknown> = {
      adapter: provider.adapter,
      baseUrl: publicProviderBaseUrl(provider.baseUrl),
      hasApiKey: !!provider.apiKey,
      hasHeaders: !!provider.headers && Object.keys(provider.headers).length > 0,
    };
    for (const key of [
      "defaultModel",
      "disabled",
      "allowPrivateNetwork",
      "authMode",
      "keyOptional",
      "freeTier",
      "liveModels",
      "models",
      "contextWindow",
      "modelContextWindows",
      "reasoningEfforts",
      "modelReasoningEfforts",
      "noVisionModels",
      "noReasoningModels",
      "noTemperatureModels",
      "noTopPModels",
      "noPenaltyModels",
      "autoToolChoiceOnlyModels",
      "preserveReasoningContentModels",
      "escapeBuiltinToolNames",
    ] as const) {
      copyIfDefined(dto, provider, key);
    }
    // Older saved configs omit free-tier flags (e.g. mimo-free, opencode-free, nvidia).
    // Backfill from the registry so the GUI shows Free badge / Free filter correctly.
    // keyOptional still means "no key required"; freeTier is pricing-only (key may still be needed).
    if (dto.keyOptional === undefined && registryEntry?.keyOptional !== undefined) {
      dto.keyOptional = registryEntry.keyOptional;
    }
    if (dto.freeTier === undefined && registryEntry?.freeTier !== undefined) {
      dto.freeTier = registryEntry.freeTier;
    }
    const registryNote = registryEntry?.note;
    if (typeof registryNote === "string" && registryNote.trim()) dto.note = registryNote;
    providers[name] = dto;
  }
  return {
    port: config.port,
    hostname: config.hostname ?? "127.0.0.1",
    defaultProvider: config.defaultProvider,
    codexAutoStart: codexAutoStartEnabled(config),
    websockets: config.websockets,
    providers,
  };
}
