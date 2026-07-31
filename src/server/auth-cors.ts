import { timingSafeEqual } from "node:crypto";
import { formatErrorResponse } from "../bridge";
import {
  apiKeyTransportConfigError,
  booleanRecordConfigError,
  modelAdapterRecordConfigError,
  codexAutoStartEnabled,
  positiveIntegerConfigError,
  positiveIntegerRecordConfigError,
  providerBaseUrlConfigError,
  providerHeadersConfigError,
  reasoningSummaryDeliveryRecordConfigError,
} from "../config";
import { providerDestinationConfigError } from "../lib/destination-policy";
import { getProviderRegistryEntry, providerCodexAccountMode, providerMatchesRegistryTransport } from "../providers/registry";
import { providerConfigSeed } from "../providers/derive";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { openRouterRoutingConfigError } from "../providers/openrouter-routing";

let _corsOrigin = "http://localhost:10100";
export function setCorsOrigin(port: number): void { _corsOrigin = `http://localhost:${port}`; }
/** The proxy's own listening port. No admission check uses it: both loopback predicates key on hostname alone. */
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
  // Loopback is a trust boundary by hostname, not by port. `ssh -L 20100:localhost:10100`
  // legitimately arrives as `Host: localhost:20100`, and refusing it took the whole /v1/*
  // data plane down with it, not just CORS. The sibling isLoopbackOriginValue() dropped its
  // own port check for the same reason in e4e06125b ("same-trust-boundary"). Port equality
  // was never the rebinding defense: a rebinding browser connects to the real port and sends
  // it verbatim, so the hostname check below is what rejected it then and now.
  //
  // Scope of that guarantee: it holds for Hosts `parseHttpHost` can parse. An unparseable
  // Host still returns true above — pre-existing behavior, not browser-reachable (a browser
  // composes Host from its own connection), and pinned by a characterization test in
  // tests/server-loopback-host-gate.test.ts. Tightening it is separate work.
  return isLoopbackHostname(parsed.hostname);
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

export function managementRequestOrigin(req: Request, config: OcxConfig): string | null {
  const host = req.headers.get("Host");
  const parsedHost = parseHttpHost(host);
  if (!host || !parsedHost) return null;
  if (!isApiAuthRequired(config) && !isLoopbackHostname(parsedHost.hostname)) return null;
  try {
    const protocol = new URL(req.url).protocol;
    if (protocol !== "http:" && protocol !== "https:") return null;
    return new URL(`${protocol}//${host}`).origin;
  } catch {
    return null;
  }
}

export function isAllowedManagementOrigin(req: Request, config: OcxConfig): boolean {
  const requestOrigin = managementRequestOrigin(req, config);
  if (!requestOrigin) return false;
  const origin = req.headers.get("Origin");
  return !origin || origin === requestOrigin;
}

export function browserSecurityHeaders(): Record<string, string> {
  return {
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "frame-ancestors 'none'",
  };
}

export function corsHeaders(req?: Request, config?: OcxConfig): Record<string, string> {
  const origin = req?.headers.get("Origin");
  const allowOrigin = origin && req && config && isAllowedRequestOrigin(req, config) ? origin : _corsOrigin;
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    // ChatGPT-Account-Id is required for browser/Electron ChatGPT & Codex App voice preflights
    // (direct forward auth matches the bearer to this account id). The OpenAI-Alpha .. X-OAI-Attestation
    // block covers GPT-Live voice protocol headers relayed by the /v1/live call-create path.
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-OpenCodex-API-Key, X-Api-Key, Anthropic-Version, Anthropic-Beta, ChatGPT-Account-Id, OpenAI-Alpha, X-Session-Id, Session-Id, Thread-Id, Originator, X-OAI-Attestation",
    "Vary": "Origin",
    ...browserSecurityHeaders(),
  };
}

export function managementCorsHeaders(req?: Request, config?: OcxConfig): Record<string, string> {
  const headers = corsHeaders();
  const origin = req?.headers.get("Origin");
  if (origin && req && config && isAllowedManagementOrigin(req, config)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
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

export function withManagementCors(response: Response, req: Request, config: OcxConfig): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(managementCorsHeaders(req, config))) {
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

export function configuredAdminAuthToken(): string | undefined {
  const token = process.env.OPENCODEX_ADMIN_AUTH_TOKEN?.trim();
  return token || undefined;
}

export function isLoopbackHostname(hostname: string | undefined): boolean {
  // A fully-qualified "localhost." is the same host as "localhost": curl and some clients
  // send the trailing dot verbatim, and refusing it 403s a legitimate loopback caller.
  const normalized = (hostname ?? "127.0.0.1").trim().toLowerCase().replace(/\.$/, "");
  return normalized === "" || normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

export function isApiAuthRequired(config: OcxConfig): boolean {
  return !isLoopbackHostname(config.hostname);
}

export function assertServerAuthConfig(config: OcxConfig): void {
  const hasConfiguredDataCredential = !!configuredApiAuthToken(config)
    || (config.apiKeys ?? []).some(entry => !!entry.key.trim());
  if (isApiAuthRequired(config) && !hasConfiguredDataCredential) {
    throw new Error(
      "A data-plane credential (OPENCODEX_API_AUTH_TOKEN or config.apiKeys) is required when binding opencodex to a non-loopback hostname",
    );
  }
}

function secretEquals(actual: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const enc = new TextEncoder();
  const actualBytes = enc.encode(actual);
  const expectedBytes = enc.encode(expected);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

/**
 * Which admission a data-plane request used.
 *
 * `configured` carries the matched key's id so a request can be attributed to
 * the key that opened it. The other two exist so an unattributed request is a
 * stated fact rather than a missing field: neither has a configured entry to
 * point at, and a sentinel string in the id would collide with a hand-edited
 * entry that happens to be named `loopback`.
 */
export type DataPlaneAdmission =
  | { kind: "configured"; keyId: string }
  | { kind: "environment" }
  | { kind: "loopback" };

/**
 * Which admission secret `token` is, or null when it is none of them.
 *
 * Identical comparisons in an identical order to the boolean form this replaces —
 * `secretEquals` still length-guards before `timingSafeEqual`. The only
 * difference is that the matched entry's id survives the loop instead of being
 * discarded, which is what makes per-key attribution possible without touching
 * the admission decision itself.
 */
export function resolveDataPlaneAdmissionSecret(token: string, config: OcxConfig): DataPlaneAdmission | null {
  const actual = token.trim();
  if (!actual) return null;
  if (secretEquals(actual, configuredApiAuthToken(config))) return { kind: "environment" };
  for (const k of config.apiKeys ?? []) {
    if (secretEquals(actual, k.key)) return { kind: "configured", keyId: k.id };
  }
  return null;
}

/** Whether `token` is a data-plane admission secret. */
export function isDataPlaneAdmissionSecret(token: string, config: OcxConfig): boolean {
  return resolveDataPlaneAdmissionSecret(token, config) !== null;
}

/**
 * Split an admission into the fields a log row records.
 *
 * `apiKeyId` is set only for a configured key. The other two kinds have no
 * configured entry to name, and folding them into the id as sentinel strings
 * would collide with a hand-edited entry that happens to be called `loopback` —
 * ids are only validated as non-empty strings.
 */
export function admissionFields(admission: DataPlaneAdmission): {
  admissionKind: DataPlaneAdmission["kind"];
  apiKeyId?: string;
} {
  return admission.kind === "configured"
    ? { admissionKind: "configured", apiKeyId: admission.keyId }
    : { admissionKind: admission.kind };
}

export type ApiAuthDisposition = "required" | "accepted" | "rejected";

export interface ApiAuthMatrixRow {
  endpoint: string;
  bearer: ApiAuthDisposition;
  dedicated: ApiAuthDisposition;
  xApiKey: ApiAuthDisposition;
}

/**
 * Which headers each data-plane endpoint actually accepts, shipped to the GUI so
 * it stops describing the rule from memory. The dashboard has been telling users
 * that Chat Completions takes `Authorization: Bearer`, which this file has never
 * allowed — that route uses the dedicated-header-only wrapper because
 * `Authorization` there may belong to Codex Direct passthrough.
 *
 * It lives next to the wrappers it describes, and a test drives real requests
 * against every cell rather than reading the table back to itself.
 */
export const AUTH_MATRIX: readonly ApiAuthMatrixRow[] = [
  { endpoint: "/v1/responses", bearer: "rejected", dedicated: "required", xApiKey: "rejected" },
  { endpoint: "/v1/chat/completions", bearer: "rejected", dedicated: "required", xApiKey: "rejected" },
  { endpoint: "/v1/messages", bearer: "accepted", dedicated: "accepted", xApiKey: "accepted" },
  { endpoint: "/v1/models", bearer: "accepted", dedicated: "accepted", xApiKey: "accepted" },
];

/** Whether `token` is the environment-provided management secret. */
export function isManagementAdmissionSecret(token: string): boolean {
  const actual = token.trim();
  return !!actual && secretEquals(actual, configuredAdminAuthToken());
}

/** Whether `token` is one of the proxy's own admission secrets and must never reach an upstream. */
export function isProxyAdmissionSecret(token: string, config: OcxConfig): boolean {
  const actual = token.trim();
  if (!actual) return false;
  if (/^ocx_(?:data|admin|session)_/.test(actual) || /^ocx_[0-9a-f]{40}$/.test(actual)) return true;
  return isDataPlaneAdmissionSecret(actual, config) || isManagementAdmissionSecret(actual);
}

export class ForwardAdmissionCredentialError extends Error {
  constructor() {
    super("OpenCodex admission credentials cannot be forwarded upstream");
    this.name = "ForwardAdmissionCredentialError";
  }
}

export function validateForwardAdmissionCredential(headers: Headers, config: OcxConfig): void {
  const bearer = headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (bearer && isProxyAdmissionSecret(bearer, config)) throw new ForwardAdmissionCredentialError();
}

/**
 * Resolving form of `hasValidApiAuth`: identical header precedence, identical
 * decision, but it names the admission instead of collapsing it to a boolean.
 */
export function resolveApiAuth(req: Request, config: OcxConfig): DataPlaneAdmission | null {
  // A loopback bind never reads a token at all, so there is no key to name.
  if (!isApiAuthRequired(config)) return { kind: "loopback" };
  const actual = req.headers.get("x-opencodex-api-key")?.trim()
    || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim()
    // Anthropic-SDK clients (Claude Code with ANTHROPIC_API_KEY) authenticate via x-api-key.
    || req.headers.get("x-api-key")?.trim();
  if (!actual) return null;
  return resolveDataPlaneAdmissionSecret(actual, config);
}

export function hasValidApiAuth(req: Request, config: OcxConfig): boolean {
  return resolveApiAuth(req, config) !== null;
}

export function requireApiAuth(req: Request, config: OcxConfig, _kind: "data-plane"): Response | null {
  if (hasValidApiAuth(req, config)) return null;
  return formatErrorResponse(401, "authentication_error", "opencodex API key required");
}

/**
 * Admission for OpenAI Responses transports whose Authorization header belongs to
 * Codex Direct. Remote binds must use the dedicated proxy header so the two bearer
 * domains can never be confused.
 */
export function resolveResponsesApiAuth(req: Request, config: OcxConfig): DataPlaneAdmission | null {
  if (!isApiAuthRequired(config)) return { kind: "loopback" };
  // Dedicated header ONLY. `Authorization` on these transports may belong to
  // Codex Direct passthrough, and the two bearer domains must stay unconfusable.
  const actual = req.headers.get("x-opencodex-api-key")?.trim();
  if (!actual) return null;
  return resolveDataPlaneAdmissionSecret(actual, config);
}

export function requireResponsesApiAuth(req: Request, config: OcxConfig): Response | null {
  if (resolveResponsesApiAuth(req, config)) return null;
  return formatErrorResponse(401, "authentication_error", "opencodex API key required");
}

const FORBIDDEN_PROVIDER_RUNTIME_FIELDS = [
  "virtualModels", "codexAuthContext", "selectedForwardHeaders",
  "sidecarOutcomeRecorder", "_codexAccountOverride", "_codexAccountRequired",
] as const;

function sameCanonicalProviderSeed(actual: Record<string, unknown>, expected: OcxProviderConfig): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, i) => key !== expectedKeys[i])) return false;
  return actualKeys.every(key => JSON.stringify(actual[key]) === JSON.stringify((expected as unknown as Record<string, unknown>)[key]));
}

export function providerManagementConfigError(name: unknown, provider: unknown): string | null {
  if (typeof name !== "string" || !provider || typeof provider !== "object" || Array.isArray(provider)) {
    return "provider must be a plain object";
  }
  const raw = provider as Record<string, unknown>;
  for (const field of FORBIDDEN_PROVIDER_RUNTIME_FIELDS) {
    if (Object.hasOwn(raw, field)) return `provider ${name} must not include runtime field "${field}"`;
  }
  if (name === "chatgpt") return "provider chatgpt is reserved for internal credential compatibility";
  if (name === "openai-multi") return "provider openai-multi is reserved for legacy config migration";
  if (name === "openai") {
    const entry = getProviderRegistryEntry(name);
    const seed = entry ? providerConfigSeed(entry) : undefined;
    if (!Object.hasOwn(raw, "codexAccountMode") || (raw.codexAccountMode !== "pool" && raw.codexAccountMode !== "direct")) {
      return "provider openai codexAccountMode must be pool or direct";
    }
    if (seed) seed.codexAccountMode = raw.codexAccountMode;
    const canonical = seed && sameCanonicalProviderSeed(raw, seed);
    if (!canonical) {
      return `provider ${name} must equal the canonical built-in provider seed`;
    }
  } else if (Object.hasOwn(raw, "codexAccountMode")) {
    return `provider ${name} must not include codexAccountMode`;
  }
  const typed = provider as unknown as OcxProviderConfig;
  const baseUrlError = providerBaseUrlConfigError(typed.baseUrl);
  if (baseUrlError) return `provider ${name} ${baseUrlError}`;
  const destinationError = providerDestinationConfigError(name, typed);
  if (destinationError) return `provider ${name} ${destinationError}`;
  const headersError = providerHeadersConfigError(typed.headers);
  if (headersError) return `provider ${name} ${headersError}`;
  const apiKeyTransportError = apiKeyTransportConfigError(typed);
  if (apiKeyTransportError) return `provider ${name} ${apiKeyTransportError}`;
  const maxInputError = positiveIntegerRecordConfigError(raw.modelMaxInputTokens, "modelMaxInputTokens");
  if (maxInputError) return `provider ${name} ${maxInputError}`;
  const reasoningSummariesError = booleanRecordConfigError(raw.modelSupportsReasoningSummaries, "modelSupportsReasoningSummaries");
  if (reasoningSummariesError) return `provider ${name} ${reasoningSummariesError}`;
  const reasoningSummaryDeliveryError = reasoningSummaryDeliveryRecordConfigError(
    raw.modelReasoningSummaryDelivery,
    raw.modelSupportsReasoningSummaries,
  );
  if (reasoningSummaryDeliveryError) return `provider ${name} ${reasoningSummaryDeliveryError}`;
  const modelAdaptersError = modelAdapterRecordConfigError(raw.modelAdapters, "modelAdapters", name, typed);
  if (modelAdaptersError) return `provider ${name} ${modelAdaptersError}`;
  const defaultMaxOutputError = positiveIntegerConfigError(raw.defaultMaxOutputTokens, "defaultMaxOutputTokens");
  if (defaultMaxOutputError) return `provider ${name} ${defaultMaxOutputError}`;
  const maxOutputError = positiveIntegerRecordConfigError(raw.modelMaxOutputTokens, "modelMaxOutputTokens");
  if (maxOutputError) return `provider ${name} ${maxOutputError}`;
  const openRouterError = openRouterRoutingConfigError(typed);
  if (openRouterError) return `provider ${name} ${openRouterError}`;
  if (typed.authMode === "local") {
    // "local" bypasses key-requirement enforcement (api-keys/key-failover treat non-oauth/
    // forward as key auth; openai-chat skips credential checks for local). Only providers
    // whose registry entry is genuinely local (Ollama/vLLM/LM Studio) may claim it.
    const entry = getProviderRegistryEntry(name);
    if (entry && entry.authKind !== "local") {
      return `provider ${name} cannot use authMode "local" — its registry entry requires ${entry.authKind} auth`;
    }
  }
  if (typed.authMode === "forward") {
    const normalizedName = name.trim().toLowerCase();
    const base = typed.baseUrl.replace(/\/+$/, "");
    const isBuiltInChatGptForward = normalizedName === "openai"
      && typed.adapter === "openai-responses"
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
      "apiKeyTransport",
      "keyOptional",
      "freeTier",
      "liveModels",
      "models",
      "contextWindow",
      "modelContextWindows",
      "defaultMaxOutputTokens",
      "modelMaxOutputTokens",
      "openRouterRouting",
      "modelOpenRouterRouting",
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
    const registryNote = providerMatchesRegistryTransport(name, provider)
      ? getProviderRegistryEntry(name)?.note
      : undefined;
    if (typeof registryNote === "string" && registryNote.trim()) dto.note = registryNote;
    const codexAccountMode = providerCodexAccountMode(name, provider);
    if (codexAccountMode) dto.codexAccountMode = codexAccountMode;
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
