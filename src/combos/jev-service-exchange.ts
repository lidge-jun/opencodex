import { readBoundedResponseBytes } from "../lib/bounded-body";
import {
  providerOutboundPost,
  providerRedirectError,
} from "../lib/provider-outbound";
import {
  isKeychainReference,
  keychainReferenceBelongsToProvider,
  resolveProviderApiKey,
} from "../providers/api-key-resolve";
import { providerMatchesRegistryTransport } from "../providers/registry";
import type { OcxConfig, OcxProviderConfig } from "../types";
import type { JevDecision, ResolveJevDecisionOptions } from "./jev";
import {
  isSystemOneEndpoint,
  jevDecisionEndpointUrl,
  JEV_DECISION_TIMEOUT_DEFAULT_MS,
  JEV_DECISION_TIMEOUT_MAX_MS,
  JEV_DECISION_TIMEOUT_MIN_MS,
} from "./jev-decision-contract";

export const JEV_PROVIDER_ID = "jev";
export const JEV_API_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

/** Environment names that hold TypeSafe credentials; a self-hosted row may never reference them. */
const TYPESAFE_ENV_KEYS = new Set(["TYPESAFE_API_KEY", "JEV_API_KEY"]);
export const JEV_MAX_REQUEST_BYTES = 65_536;
export const JEV_MAX_RESPONSE_BYTES = 65_536;
const JEV_OUTBOUND_DEPENDENCIES = {
  isCanonicalUrl: (name: string, url: string) => name === JEV_PROVIDER_ID && url === JEV_API_URL,
  // Self-hosted decision models (Ollama tev1) listen on plain HTTP loopback. The outbound wrapper
  // still requires the row's own allowPrivateNetwork and a literal local address for that.
  allowLocalCleartextPost: true,
};

/** Every non-applied outcome of one exchange: a local refusal, a transport failure or an invalid answer. */
export type JevDecisionFailureGate = Exclude<JevDecision["gate"], "apply">;

/**
 * Transport options shared with the route resolver. `signal` is the caller's cancellation and always
 * rejects with its own reason; `timeoutMs` is the separate decision deadline that yields a `timeout` gate.
 */
export type JevServiceExchangeOptions = Pick<ResolveJevDecisionOptions,
  "config" | "decisionProvider" | "isDestinationAllowed" | "timeoutMs" | "signal" | "post">;

/** Request shape only: question builders never receive the destination or credential. */
export interface JevDecisionEndpointShape {
  model: string;
  descriptiveCriteria: boolean;
}

/** The decision deadline: the configured value when in bounds, otherwise the four-second default. */
export function jevDecisionTimeoutMs(value: number | undefined): number {
  return value !== undefined
    && Number.isInteger(value)
    && value >= JEV_DECISION_TIMEOUT_MIN_MS
    && value <= JEV_DECISION_TIMEOUT_MAX_MS
    ? value
    : JEV_DECISION_TIMEOUT_DEFAULT_MS;
}

/** Retain a registry-matching JEV row's transport policy; ignore a retargeted row for hosted requests. */
function canonicalJevProvider(config: OcxConfig): OcxProviderConfig {
  const configured = config.providers[JEV_PROVIDER_ID];
  if (configured && providerMatchesRegistryTransport(JEV_PROVIDER_ID, configured)) return configured;
  return {
    adapter: "jev-decision",
    baseUrl: JEV_API_URL,
    authMode: "key",
    liveModels: false,
  };
}

interface JevDecisionEndpoint {
  name: string;
  provider: OcxProviderConfig;
  url: string;
  model: string;
  apiKey: string | undefined;
  /** Self-hosted System One services accept only string option descriptions. */
  descriptiveCriteria: boolean;
}

/** Recognize the $NAME and ${NAME} credential references before applying self-hosted ownership rules. */
function envReferenceName(value: string): string | undefined {
  const braced = /^\$\{(\w+)\}$/.exec(value);
  if (braced) return braced[1];
  return value.startsWith("$") ? value.slice(1) : undefined;
}

/**
 * A self-hosted row may carry only its own secret: never a reference to the TypeSafe environment
 * keys, and never a keychain entry that belongs to another provider. `null` means refused.
 */
function selfHostedApiKey(name: string, apiKey: string | undefined): string | undefined | null {
  if (!apiKey) return undefined;
  const envName = envReferenceName(apiKey);
  if (envName !== undefined && TYPESAFE_ENV_KEYS.has(envName)) return null;
  if (isKeychainReference(apiKey) && !keychainReferenceBelongsToProvider(apiKey, name)) return null;
  return resolveProviderApiKey(apiKey)?.trim() || undefined;
}

/**
 * Resolve where one decision request goes and which credential it may carry.
 *
 * The `jev` id stays pinned to the canonical TypeSafe URL and `jev-latest`: its row key is used
 * only while the row still matches the registry transport, and the environment fallbacks exist
 * only for that URL. A retargeted `jev` row therefore keeps today's behavior instead of becoming a
 * custom destination. Any other id must be an enabled `jev-decision` row whose baseUrl is a
 * full HTTPS decision endpoint (or a local HTTP `/systemone` endpoint) and which names its own
 * model; only its own key may accompany it, so no TypeSafe credential can reach a self-hosted
 * service. The URL is `jevDecisionEndpointUrl`, shared with the management surfaces: an HTTPS
 * path is sent exactly as configured and only `/systemone` normalizes trailing slashes.
 * `undefined` means no usable decision service (reported through the existing `missing_key`
 * gate); `null` means the request's destination scope refused it before any credential access.
 */
function jevDecisionEndpoint(
  config: OcxConfig,
  decisionProvider: string,
  isDestinationAllowed?: ResolveJevDecisionOptions["isDestinationAllowed"],
): JevDecisionEndpoint | undefined | null {
  const configured = Object.hasOwn(config.providers, decisionProvider)
    ? config.providers[decisionProvider]
    : undefined;
  if (configured?.disabled === true) return undefined;
  if (decisionProvider === JEV_PROVIDER_ID) {
    if (isDestinationAllowed?.(JEV_PROVIDER_ID, JEV_MODEL) === false) return null;
    const configuredOwnsJev = configured
      && providerMatchesRegistryTransport(JEV_PROVIDER_ID, configured);
    const apiKey = (
      configuredOwnsJev ? resolveProviderApiKey(configured.apiKey)?.trim() : undefined
    ) || process.env.TYPESAFE_API_KEY?.trim()
      || process.env.JEV_API_KEY?.trim();
    if (!apiKey) return undefined;
    return {
      name: JEV_PROVIDER_ID,
      provider: canonicalJevProvider(config),
      url: JEV_API_URL,
      model: JEV_MODEL,
      apiKey,
      descriptiveCriteria: false,
    };
  }
  if (configured?.adapter !== "jev-decision" || typeof configured.baseUrl !== "string") return undefined;
  const url = jevDecisionEndpointUrl(configured.baseUrl);
  if (!url || !isSystemOneEndpoint(url)) return undefined;
  // `jev-latest` is TypeSafe's model name; a self-hosted host must name its own.
  const model = configured.defaultModel?.trim() || configured.models?.[0]?.trim();
  if (!model) return undefined;
  if (isDestinationAllowed?.(decisionProvider, model) === false) return null;
  const apiKey = selfHostedApiKey(decisionProvider, configured.apiKey);
  if (apiKey === null) return undefined;
  return {
    name: decisionProvider,
    provider: configured,
    url,
    model,
    apiKey,
    descriptiveCriteria: true,
  };
}

/** Run the question builder: a refusal keeps its gate; a throw or an over-cap body is `invalid`. */
function prepareRequestBody(
  prepare: (endpoint: JevDecisionEndpointShape) => { body: string } | JevDecisionFailureGate,
  shape: JevDecisionEndpointShape,
): { body: string } | { gate: JevDecisionFailureGate } {
  try {
    const prepared = prepare(shape);
    if (typeof prepared === "string") return { gate: prepared };
    const body = prepared.body;
    if (new TextEncoder().encode(body).byteLength > JEV_MAX_REQUEST_BYTES) return { gate: "invalid" };
    return { body };
  } catch {
    return { gate: "invalid" };
  }
}

/**
 * One bounded System One round-trip, independent of the decision question and its choice policy.
 * Destination authorization precedes credential access and `prepare`; request bytes, deadline,
 * redirects and UTF-8 JSON are bounded here. `parse` validates the question's answer inside the
 * cancellation boundary. Local preparation/parser failures are `invalid`.
 *
 * This function owns caller cancellation: an aborted `options.signal` rejects with its reason by
 * identity, never as a gate. It is checked before endpoint, credential or `prepare` work, after
 * endpoint resolution and preparation (including failures), after POST, redirect inspection, HTTP
 * error-body cleanup and response reads, and when `parse` returns or throws. Only the caller's signal counts; expiry of
 * the separate decision deadline remains a `timeout` gate.
 */
export async function exchangeJevDecision<T>(
  options: JevServiceExchangeOptions,
  prepare: (endpoint: JevDecisionEndpointShape) => { body: string } | JevDecisionFailureGate,
  parse: (payload: unknown) => T,
): Promise<{ value: T } | { gate: JevDecisionFailureGate }> {
  if (options.signal?.aborted) throw options.signal.reason;

  let endpoint: JevDecisionEndpoint | undefined | null;
  try {
    endpoint = jevDecisionEndpoint(options.config, options.decisionProvider ?? JEV_PROVIDER_ID, options.isDestinationAllowed);
  } catch (error) {
    // Authorization and credential callbacks may cancel the caller and then throw; cancellation wins.
    if (options.signal?.aborted) throw options.signal.reason;
    throw error;
  }
  if (options.signal?.aborted) throw options.signal.reason;
  if (endpoint === null) return { gate: "invalid" };
  if (!endpoint) return { gate: "missing_key" };

  const request = prepareRequestBody(prepare, { model: endpoint.model, descriptiveCriteria: endpoint.descriptiveCriteria });
  if (options.signal?.aborted) throw options.signal.reason;
  if ("gate" in request) return request;
  const requestBody = request.body;

  const timeoutMs = jevDecisionTimeoutMs(options.timeoutMs);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  const post = options.post ?? providerOutboundPost;

  try {
    const response = await post(
      endpoint.name,
      endpoint.provider,
      endpoint.url,
      {
        headers: {
          ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
          "Content-Type": "application/json",
        },
        body: requestBody,
        signal,
      },
      JEV_OUTBOUND_DEPENDENCIES,
    );
    if (options.signal?.aborted) throw options.signal.reason;

    const redirectError = await providerRedirectError(response, endpoint.url);
    if (options.signal?.aborted) throw options.signal.reason;
    if (redirectError) return { gate: "redirect" };
    if (!response.ok) {
      try { void response.body?.cancel().catch(() => undefined); } catch { /* best effort */ }
      if (options.signal?.aborted) throw options.signal.reason;
      return { gate: "http" };
    }

    const bounded = await readBoundedResponseBytes(response, {
      maxBytes: JEV_MAX_RESPONSE_BYTES,
      signal,
    });
    if (options.signal?.aborted) throw options.signal.reason;
    if (bounded.oversized) return { gate: "malformed" };

    let payload: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bounded.bytes);
      payload = JSON.parse(text);
    } catch {
      return { gate: "malformed" };
    }

    let parsed: T;
    try {
      parsed = parse(payload);
    } catch {
      if (options.signal?.aborted) throw options.signal.reason;
      return { gate: "invalid" };
    }
    if (options.signal?.aborted) throw options.signal.reason;
    return { value: parsed };
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (timeoutSignal.aborted
      || (error instanceof DOMException && error.name === "TimeoutError")) {
      return { gate: "timeout" };
    }
    return { gate: "network" };
  }
}
