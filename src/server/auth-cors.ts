import { timingSafeEqual } from "node:crypto";
import { extractAccountId } from "../oauth/chatgpt";
import { formatErrorResponse } from "../bridge";
import {
  codexAutoStartEnabled,
  modelPreferHostedToolsConfigError,
  providerModelCostsConfigError,
  requestPacingConfigError,
  retryOn429PolicyConfigError,
  sanitizeModelCostsForDisplay,
} from "../config";
import {
  apiKeyTransportConfigError,
  booleanRecordConfigError,
  modelAdapterRecordConfigError,
  nonBlankStringArrayConfigError,
  positiveIntegerConfigError,
  positiveIntegerRecordConfigError,
  providerBaseUrlConfigError,
  providerHeadersConfigError,
  reasoningSummaryDeliveryRecordConfigError,
  upstreamHttpVersionConfigError,
} from "../config/provider-validation";
import { providerDestinationConfigError } from "../lib/destination-policy";
import { redactSecretString } from "../lib/redact";
import { effectiveGoogleMode, getProviderRegistryEntry, providerCodexAccountMode, providerMatchesRegistryTransport, registryEntryForProviderDestination } from "../providers/registry";
import { providerConfigSeed } from "../providers/derive";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { openRouterRoutingConfigError } from "../providers/openrouter-routing";
import { modelAutoCompactTokenLimitsConfigError } from "../providers/auto-compact-budget";
import { vercelGatewayRoutingConfigError } from "../providers/vercel-gateway-routing";
import { googleVertexLocationConfigError } from "../providers/google-vertex-location";
import { xaiResponsesOptInState } from "../providers/xai-responses-opt-in";

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

export function isAllowedRequestOrigin(req: Request, config: RequestPolicyView): boolean {
  const origin = req.headers.get("Origin");
  if (!isApiAuthRequired(config)) {
    if (!isLoopbackRequestHost(req.headers.get("Host"))) return false;
    return !origin || isLoopbackOriginValue(origin) || isExtraAllowedOrigin(origin, config);
  }
  return !origin || isLoopbackOriginValue(origin) || isSameOriginAsRequest(req, origin) || isExtraAllowedOrigin(origin, config);
}

function isExtraAllowedOrigin(origin: string, cfg: RequestPolicyView): boolean {
  if (!cfg.corsAllowOrigins?.length) return false;
  const parsedOrigin = comparableOrigin(origin);
  return cfg.corsAllowOrigins.some(allowed => {
    const parsedAllowed = comparableOrigin(allowed);
    return parsedOrigin !== null && parsedAllowed !== null
      ? parsedAllowed === parsedOrigin
      : allowed === origin;
  });
}

function comparableOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.origin !== "null") return parsed.origin;
    // WHATWG URL exposes authority-based custom schemes (for example browser
    // extensions) as opaque `null` origins. Compare their scheme + authority so
    // one allowlisted extension cannot admit every other opaque origin.
    return parsed.host ? `${parsed.protocol}//${parsed.host}` : null;
  } catch {
    return null;
  }
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
  // Exact match against the process-derived origin, or an operator-listed corsAllowOrigins
  // entry (covers TLS-terminator https://… when the process observes http://…).
  return !origin || origin === requestOrigin || isExtraAllowedOrigin(origin, config);
}

export function browserSecurityHeaders(): Record<string, string> {
  return {
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "frame-ancestors 'none'",
  };
}

/**
 * Baseline data-plane request headers. ChatGPT-Account-Id is required for browser/Electron
 * ChatGPT & Codex App voice preflights (direct forward auth matches the bearer to this account
 * id). The OpenAI-Alpha .. X-OAI-Attestation block covers GPT-Live voice protocol headers
 * relayed by the /v1/live call-create path.
 */
const STATIC_ALLOWED_REQUEST_HEADERS =
  "Content-Type, Authorization, X-OpenCodex-API-Key, X-Api-Key, Anthropic-Version, Anthropic-Beta, ChatGPT-Account-Id, OpenAI-Alpha, X-Session-Id, Session-Id, Thread-Id, Originator, X-OAI-Attestation";

/**
 * A fixed allow-list cannot enumerate vendor telemetry headers: the OpenAI and Anthropic
 * browser SDKs send `X-Stainless-*` describing runtime and retry state, and the browser blocks
 * the real request when the preflight omits even one of them (#1773).
 *
 * Echo what an already-allowed origin asked for, and fall back to the static list otherwise.
 * The echo is deliberately gated on the origin check that ran first: this widens which headers
 * an admitted caller may send, never which origins are admitted, and it grants nothing to an
 * origin that would have been rejected anyway. Authentication is unchanged — the preflight
 * itself carries no credential and produces no auth or account-pool side effect.
 */
function allowedRequestHeaders(req?: Request): string {
  const requested = req?.headers.get("Access-Control-Request-Headers")?.trim();
  if (!requested) return STATIC_ALLOWED_REQUEST_HEADERS;
  const seen = new Set(STATIC_ALLOWED_REQUEST_HEADERS.split(",").map(h => h.trim().toLowerCase()));
  const extra: string[] = [];
  for (const raw of requested.split(",")) {
    const name = raw.trim();
    // Header names are case-insensitive on the wire, so normalize before de-duplicating;
    // echo the caller's spelling for the ones we add.
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    extra.push(name);
  }
  return extra.length === 0 ? STATIC_ALLOWED_REQUEST_HEADERS : `${STATIC_ALLOWED_REQUEST_HEADERS}, ${extra.join(", ")}`;
}

export function corsHeaders(req?: Request, config?: RequestPolicyView): Record<string, string> {
  const origin = req?.headers.get("Origin");
  const originAllowed = Boolean(origin && req && config && isAllowedRequestOrigin(req, config));
  const allowOrigin = originAllowed && origin ? origin : _corsOrigin;
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": allowedRequestHeaders(originAllowed ? req : undefined),
    // A response that varies by the request's headers must say so, or a shared cache can
    // replay one client's allow-list to a client that asked for different headers.
    "Vary": "Origin, Access-Control-Request-Headers",
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

export function withCors(response: Response, req: Request, config: RequestPolicyView): Response {
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

export function jsonResponse(data: unknown, status = 200, req?: Request, config?: RequestPolicyView): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(req, config) },
  });
}

// The parameter is vestigial — the token has always come from the environment — but callers
// pass a config, so keep accepting one. Typed as `unknown` rather than `OcxConfig` so a narrow
// policy view can reach it too (#1102); widening to OcxConfig here would force every caller in
// the admission path back to the full config.
export function configuredApiAuthToken(_config?: unknown): string | undefined {
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

export function isApiAuthRequired(config: Pick<OcxConfig, "hostname">): boolean {
  return !isLoopbackHostname(config.hostname);
}

/**
 * The slice of config that decides admission and CORS, and nothing else (#1102).
 *
 * The unauthenticated loopback listener shares this process with the public one: same routing,
 * same account pool, same drain. The only thing it must see differently is its own bind
 * address, because `isApiAuthRequired` reads `hostname` and the shared config says "0.0.0.0".
 *
 * Two ways to express that were rejected. Passing the whole config with `hostname` rewritten
 * and holding it for the listener's lifetime would go stale the moment the management API
 * changes a setting. Adding an `allowUnauthenticated` parameter to the resolvers would create a
 * callable admission bypass that the PUBLIC listener could also reach — the switch would exist
 * on the wrong side of the boundary.
 *
 * So this type is deliberately narrow: it cannot masquerade as a business config, and a policy
 * view that leaks into a routing path fails to typecheck rather than silently taking effect.
 */
export type RequestPolicyView = Pick<OcxConfig, "hostname" | "corsAllowOrigins" | "apiKeys">;

/** Derive the per-request policy view for a listener. Cheap enough to build per request. */
export function requestPolicyView(config: OcxConfig, bindHostname: string): RequestPolicyView {
  return {
    hostname: bindHostname,
    ...(config.corsAllowOrigins ? { corsAllowOrigins: config.corsAllowOrigins } : {}),
    ...(config.apiKeys ? { apiKeys: config.apiKeys } : {}),
  };
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
/**
 * HOW an admission credential was presented.
 *
 * The credential IDENTITY (which key matched) and its PRESENTATION (which header carried it)
 * are different facts, and #1686 needs both: a proxy secret arriving as a bearer on the
 * Responses transport is admissible, but only if the upstream credential is then guaranteed to
 * be substituted. Collapsing the two is what made that flow unexpressible.
 */
export type DataPlaneAdmissionSource = "loopback" | "dedicated" | "bearer" | "x-api-key";

export type DataPlaneAdmission =
  | { kind: "configured"; keyId: string; source: DataPlaneAdmissionSource }
  | { kind: "environment"; source: DataPlaneAdmissionSource }
  | { kind: "loopback"; source: "loopback" };

/**
 * Which admission secret `token` is, or null when it is none of them.
 *
 * Identical comparisons in an identical order to the boolean form this replaces —
 * `secretEquals` still length-guards before `timingSafeEqual`. The only
 * difference is that the matched entry's id survives the loop instead of being
 * discarded, which is what makes per-key attribution possible without touching
 * the admission decision itself.
 */
export function resolveDataPlaneAdmissionSecret(
  token: string,
  config: Pick<OcxConfig, "apiKeys">,
  source: DataPlaneAdmissionSource = "dedicated",
): DataPlaneAdmission | null {
  const actual = token.trim();
  if (!actual) return null;
  if (secretEquals(actual, configuredApiAuthToken(config))) return { kind: "environment", source };
  for (const k of config.apiKeys ?? []) {
    if (secretEquals(actual, k.key)) return { kind: "configured", keyId: k.id, source };
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
  // #1686: a bearer that is one of OUR admission secrets is now accepted here. It is safe
  // because materializeCodexUpstreamAuth substitutes the stored main credential rather than
  // forwarding it; a bearer that is NOT our secret stays unadmitted and remains Codex Direct
  // passthrough, so the two bearer domains still never mix. `x-api-key` is still rejected.
  { endpoint: "/v1/responses", bearer: "accepted", dedicated: "accepted", xApiKey: "rejected" },
  { endpoint: "/v1/chat/completions", bearer: "accepted", dedicated: "accepted", xApiKey: "rejected" },
  { endpoint: "/v1/messages", bearer: "accepted", dedicated: "accepted", xApiKey: "accepted" },
  { endpoint: "/v1/models", bearer: "accepted", dedicated: "accepted", xApiKey: "accepted" },
  // #809: least-privilege catalog read for remote Codex clients. Same admission set as
  // /v1/models and for the same reason — it forwards no caller credential upstream — so a
  // remote client no longer needs an admin token just to read the model catalog.
  { endpoint: "/v1/catalog", bearer: "accepted", dedicated: "accepted", xApiKey: "accepted" },
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

/** Whether Authorization carries a caller-owned native Codex credential safe to forward. */
export function hasForwardableCodexBearer(headers: Headers, config: OcxConfig): boolean {
  const bearer = headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  const accountId = headers.get("chatgpt-account-id")?.trim()
    || (bearer ? extractAccountId(undefined, bearer) : undefined);
  return !!bearer && !!accountId && !isProxyAdmissionSecret(bearer, config);
}

/**
 * Resolving form of `hasValidApiAuth`: identical header precedence, identical
 * decision, but it names the admission instead of collapsing it to a boolean.
 */
export function resolveApiAuth(req: Request, config: RequestPolicyView): DataPlaneAdmission | null {
  // A loopback bind never reads a token at all, so there is no key to name.
  if (!isApiAuthRequired(config)) return { kind: "loopback", source: "loopback" };
  const dedicated = req.headers.get("x-opencodex-api-key")?.trim();
  if (dedicated) return resolveDataPlaneAdmissionSecret(dedicated, config, "dedicated");
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (bearer) return resolveDataPlaneAdmissionSecret(bearer, config, "bearer");
  // Anthropic-SDK clients (Claude Code with ANTHROPIC_API_KEY) authenticate via x-api-key.
  const apiKey = req.headers.get("x-api-key")?.trim();
  if (apiKey) return resolveDataPlaneAdmissionSecret(apiKey, config, "x-api-key");
  return null;
}

export function hasValidApiAuth(req: Request, config: RequestPolicyView): boolean {
  return resolveApiAuth(req, config) !== null;
}

export function requireApiAuth(req: Request, config: RequestPolicyView, _kind: "data-plane"): Response | null {
  if (hasValidApiAuth(req, config)) return null;
  return formatErrorResponse(401, "authentication_error", "opencodex API key required");
}

/**
 * Admission for OpenAI Responses transports whose Authorization header belongs to
 * Codex Direct. Remote binds must use the dedicated proxy header so the two bearer
 * domains can never be confused.
 */
export function resolveResponsesApiAuth(req: Request, config: RequestPolicyView): DataPlaneAdmission | null {
  if (!isApiAuthRequired(config)) return { kind: "loopback", source: "loopback" };
  // The dedicated header still WINS, because it is unambiguous.
  const dedicated = req.headers.get("x-opencodex-api-key")?.trim();
  if (dedicated) return resolveDataPlaneAdmissionSecret(dedicated, config, "dedicated");
  // #1686: a bearer may also be one of OUR admission secrets. Rejecting it outright meant a
  // Codex client configured with `env_key` could not reach Direct at all. Admitting it is only
  // safe because the upstream credential is then SUBSTITUTED rather than forwarded -- see
  // materializeCodexUpstreamAuth. A bearer that is NOT our secret stays unadmitted here and
  // remains Codex Direct passthrough, so the two bearer domains still never mix.
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (bearer) return resolveDataPlaneAdmissionSecret(bearer, config, "bearer");
  // `x-api-key` is deliberately NOT accepted on this transport.
  return null;
}



export function requireResponsesApiAuth(req: Request, config: RequestPolicyView): Response | null {
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

function positiveWindowValue(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Shape-check the two context overlays before the canonical seed comparison drops them.
 *
 * `null` means "clear this" and is normalized by the PATCH field mask, but this validator
 * also runs for POST and reload, where a whole provider object lands on disk verbatim. A
 * `null` surviving there would be a value no reader expects, so full objects must carry a
 * real number or omit the field.
 */
function nativeContextOverlayError(raw: Record<string, unknown>): string | null {
  if (Object.hasOwn(raw, "contextWindow") && !positiveWindowValue(raw.contextWindow)) {
    return "provider openai contextWindow must be a positive safe integer";
  }
  if (Object.hasOwn(raw, "modelContextWindows")) {
    const windows = raw.modelContextWindows;
    if (typeof windows !== "object" || windows === null || Array.isArray(windows)) {
      return "provider openai modelContextWindows must be a plain object";
    }
    for (const [model, value] of Object.entries(windows as Record<string, unknown>)) {
      if (model.trim() === "") return "provider openai modelContextWindows keys must be nonblank model ids";
      if (!positiveWindowValue(value)) {
        return "provider openai modelContextWindows values must be positive safe integers";
      }
    }
  }
  return null;
}

/**
 * Validate a provider object arriving at the management write boundary. Returns an error
 * string, or null when the provider may be persisted. Caller-controlled names/fields are
 * redacted and JSON-escaped so secrets never reach the response.
 */
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
    const canonicalCandidate = { ...raw };
    delete canonicalCandidate.responsesSnapshotRepair;
    // modelCosts is a user-owned display overlay, not part of the canonical
    // forward seed; it is validated separately below (providerModelCostsConfigError).
    delete canonicalCandidate.modelCosts;
    // requestPacing is a user-owned transport overlay, not part of the canonical seed.
    delete canonicalCandidate.requestPacing;
    // Context windows are the same kind of user-owned overlay as requestPacing: the operator
    // narrowing what their own native rows advertise. They can only ever LOWER the measured
    // window (see nativeOpenAiContextWindow), so admitting them cannot widen what the proxy
    // claims. Validated first — this function also guards POST/reload, where nothing
    // normalizes the shape afterwards, so a bad value would reach disk.
    const contextOverlayError = nativeContextOverlayError(raw);
    if (contextOverlayError) return contextOverlayError;
    delete canonicalCandidate.contextWindow;
    delete canonicalCandidate.modelContextWindows;
    // User-owned soft compaction policy; it does not alter the canonical transport seed.
    delete canonicalCandidate.modelAutoCompactTokenLimits;
    // Same category: annotating empty tool outputs is a user-owned request-shaping preference,
    // not part of the canonical transport seed. Without this the field is accepted by
    // validation and then rejected by the seed comparison, so canonical OpenAI could never
    // set OR clear it — the value was admitted and then refused in the same request.
    delete canonicalCandidate.annotateEmptyToolOutputs;
    const canonical = seed && sameCanonicalProviderSeed(canonicalCandidate, seed);
    if (!canonical) {
      return `provider ${name} must equal the canonical built-in provider seed`;
    }
  } else if (Object.hasOwn(raw, "codexAccountMode")) {
    return `provider ${name} must not include codexAccountMode`;
  }
  const typed = provider as unknown as OcxProviderConfig;
  const baseUrlError = providerBaseUrlConfigError(typed.baseUrl);
  if (baseUrlError) return `provider ${name} ${baseUrlError}`;
  if (effectiveGoogleMode(name, typed) === "vertex" && typed.location !== undefined) {
    const locationError = googleVertexLocationConfigError(typed.location);
    if (locationError) return `provider ${name} ${locationError}`;
  }
  const destinationError = providerDestinationConfigError(name, typed);
  if (destinationError) return `provider ${name} ${destinationError}`;
  const headersError = providerHeadersConfigError(typed.headers);
  if (headersError) return `provider ${name} ${headersError}`;
  const retryOn429Error = retryOn429PolicyConfigError(raw.retryOn429);
  if (retryOn429Error) {
    // The provider name is caller-controlled and can be token-shaped; redact and JSON-escape
    // it before it reaches the management API response.
    return `provider ${JSON.stringify(redactSecretString(name))} ${retryOn429Error}`;
  }
  const requestPacingError = requestPacingConfigError(raw.requestPacing);
  if (requestPacingError) {
    return `provider ${JSON.stringify(redactSecretString(name))} ${requestPacingError}`;
  }
  const upstreamHttpVersionError = upstreamHttpVersionConfigError(raw.upstreamHttpVersion);
  if (upstreamHttpVersionError) {
    return `provider ${JSON.stringify(redactSecretString(name))} ${upstreamHttpVersionError}`;
  }
  const modelCostsError = providerModelCostsConfigError(raw.modelCosts);
  if (modelCostsError) {
    // The provider name is caller-controlled and can be token-shaped; redact and JSON-escape
    // it before it reaches the management API response (same rule as retryOn429 above).
    return `provider ${JSON.stringify(redactSecretString(name))} ${modelCostsError}`;
  }
  const apiKeyTransportError = apiKeyTransportConfigError(typed);
  if (apiKeyTransportError) return `provider ${name} ${apiKeyTransportError}`;
  const maxInputError = positiveIntegerRecordConfigError(raw.modelMaxInputTokens, "modelMaxInputTokens");
  if (maxInputError) return `provider ${name} ${maxInputError}`;
  const autoCompactError = modelAutoCompactTokenLimitsConfigError(
    raw.modelAutoCompactTokenLimits,
    { requireNativeIds: name === "openai" },
  );
  if (autoCompactError) {
    return `provider ${JSON.stringify(redactSecretString(name))} ${autoCompactError}`;
  }
  const reasoningSummariesError = booleanRecordConfigError(raw.modelSupportsReasoningSummaries, "modelSupportsReasoningSummaries");
  if (reasoningSummariesError) return `provider ${name} ${reasoningSummariesError}`;
  const reasoningSummaryDeliveryError = reasoningSummaryDeliveryRecordConfigError(
    raw.modelReasoningSummaryDelivery,
    raw.modelSupportsReasoningSummaries,
  );
  if (reasoningSummaryDeliveryError) return `provider ${name} ${reasoningSummaryDeliveryError}`;
  const modelAdaptersError = modelAdapterRecordConfigError(raw.modelAdapters, "modelAdapters", name, typed);
  if (modelAdaptersError) return `provider ${name} ${modelAdaptersError}`;
  const preferHostedToolsError = modelPreferHostedToolsConfigError(
    raw.modelPreferHostedTools,
    "modelPreferHostedTools",
    name,
    typed,
  );
  if (preferHostedToolsError) return `provider ${name} ${preferHostedToolsError}`;
  if (raw.responsesSnapshotRepair !== undefined && typeof raw.responsesSnapshotRepair !== "boolean") {
    return `provider ${name} responsesSnapshotRepair must be a boolean`;
  }
  if (raw.xaiResponsesXSearch !== undefined && typeof raw.xaiResponsesXSearch !== "boolean") {
    return `provider ${name} xaiResponsesXSearch must be a boolean`;
  }
  const defaultMaxOutputError = positiveIntegerConfigError(raw.defaultMaxOutputTokens, "defaultMaxOutputTokens");
  if (defaultMaxOutputError) return `provider ${name} ${defaultMaxOutputError}`;
  const maxOutputError = positiveIntegerRecordConfigError(raw.modelMaxOutputTokens, "modelMaxOutputTokens");
  if (maxOutputError) return `provider ${name} ${maxOutputError}`;
  const structuredOutputOptOutError = nonBlankStringArrayConfigError(
    raw.noStructuredOutputModels,
    "noStructuredOutputModels",
  );
  if (structuredOutputOptOutError) return `provider ${name} ${structuredOutputOptOutError}`;
  const openRouterError = openRouterRoutingConfigError(typed);
  if (openRouterError) return `provider ${name} ${openRouterError}`;
  const vercelError = vercelGatewayRoutingConfigError(typed);
  if (vercelError) return `provider ${name} ${vercelError}`;
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

/** Public dashboard DTO for config.json: provider entries with secrets stripped and documented fields exposed (including `modelCosts`). */
export function safeConfigDTO(config: OcxConfig): unknown {
  const providers: Record<string, Record<string, unknown>> = {};
  for (const [name, provider] of Object.entries(config.providers)) {
    const dto: Record<string, unknown> = {
      adapter: provider.adapter,
      baseUrl: publicProviderBaseUrl(provider.baseUrl),
      hasApiKey: !!provider.apiKey,
      hasHeaders: !!provider.headers && Object.keys(provider.headers).length > 0,
    };
    if (name === "xai") {
      dto.xaiResponsesOptInState = xaiResponsesOptInState(provider);
    }
    for (const key of [
      "defaultModel",
      "alias",
      "modelAliases",
      "defaultAliases",
      "disabled",
      "allowPrivateNetwork",
      "authMode",
      "apiKeyTransport",
      "keyOptional",
      "freeTier",
      "liveModels",
      "requestPacing",
      "models",
      "contextWindow",
      "modelContextWindows",
      "modelAutoCompactTokenLimits",
      "defaultMaxOutputTokens",
      "modelMaxOutputTokens",
      "openRouterRouting",
      "modelOpenRouterRouting",
      "vercelGatewayRouting",
      "modelVercelGatewayRouting",
      "reasoningEfforts",
      "modelReasoningEfforts",
      "reasoningWireFormat",
      "noVisionModels",
      "noReasoningModels",
      "noTemperatureModels",
      "noTopPModels",
      "noPenaltyModels",
      "noStructuredOutputModels",
      "upstreamHttpVersion",
      "autoToolChoiceOnlyModels",
      "preserveReasoningContentModels",
      "requiresReasoningPlaceholderModels",
      "escapeBuiltinToolNames",
    ] as const) {
      copyIfDefined(dto, provider, key);
    }
    const modelCosts = sanitizeModelCostsForDisplay(provider.modelCosts);
    if (modelCosts) dto.modelCosts = modelCosts;
    // Resolve the note by DESTINATION, not by name. A preset saved under a custom name is
    // still pointed at the same vendor route, and a usage restriction the user needs to see
    // must not disappear because the row was renamed. Prefer the same-name entry so an
    // unrenamed provider keeps its exact registry note.
    const registryNote = (providerMatchesRegistryTransport(name, provider)
      ? getProviderRegistryEntry(name)
      : registryEntryForProviderDestination(provider))?.note;
    if (typeof registryNote === "string" && registryNote.trim()) dto.note = registryNote;
    const codexAccountMode = providerCodexAccountMode(name, provider);
    if (codexAccountMode) dto.codexAccountMode = codexAccountMode;
    providers[name] = dto;
  }
  return {
    port: config.port,
    hostname: config.hostname ?? "127.0.0.1",
    defaultProvider: config.defaultProvider,
    defaultModelAliases: config.defaultModelAliases,
    codexAutoStart: codexAutoStartEnabled(config),
    websockets: config.websockets,
    // The GUI's browser-open toggle reads and writes this; absent means the
    // historical auto-open behavior.
    oauthOpenBrowser: config.oauthOpenBrowser !== false,
    providers,
  };
}
