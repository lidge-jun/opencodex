/**
 * Client for the protocol routes (`GET /api/protocols`, `GET /api/protocols?provider=<name>`,
 * `POST /api/protocols/plan`, `PATCH /api/protocols/settings`).
 *
 * The dashboard never computes a plan itself; it asks the server and validates the answer
 * with the shared leaf validator, so a record from an older or newer server is refused rather
 * than half-rendered. An older server that does not have the routes answers 404, which turns
 * the preview off quietly instead of showing an error.
 */
import { isProtocol, type Protocol } from "../../src/protocols/contract";
import {
  isProtocolPlanV1,
  isProtocolProviderSummaryV1,
  type ProtocolPlanV1,
  type ProtocolProviderSummaryV1,
} from "../../src/protocols/dto";
import { isProtocolFeature, type ProtocolFeature } from "../../src/protocols/features";

export interface ProtocolPlanQuery {
  model: string;
  inbound: Protocol;
  features: readonly ProtocolFeature[];
}

export interface ProtocolInfo {
  policyRevision: string;
  features: ProtocolFeature[];
  surfaces: Record<Protocol, { enabled: boolean }>;
}

export type ProtocolPlanResult =
  | { kind: "plan"; plan: ProtocolPlanV1 }
  /** The server predates the preview routes. */
  | { kind: "unavailable" }
  | { kind: "error" };

const CACHE_LIMIT = 32;
const planCache = new Map<string, ProtocolPlanV1>();

export function protocolPlanCacheKey(apiBase: string, query: ProtocolPlanQuery, policyRevision: string): string {
  return JSON.stringify([apiBase, query.model, query.inbound, [...new Set(query.features)].sort(), policyRevision]);
}

function remember(key: string, plan: ProtocolPlanV1): void {
  planCache.delete(key);
  planCache.set(key, plan);
  while (planCache.size > CACHE_LIMIT) {
    const oldest = planCache.keys().next().value;
    if (oldest === undefined) break;
    planCache.delete(oldest);
  }
}

/** Test seam. */
export function clearProtocolPlanCache(): void {
  planCache.clear();
}

type Rec = Record<string, unknown>;
function isRec(value: unknown): value is Rec {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseProtocolInfo(value: unknown): ProtocolInfo | null {
  if (!isRec(value) || value.schemaVersion !== 1 || typeof value.policyRevision !== "string") return null;
  if (!Array.isArray(value.features) || !value.features.every(isProtocolFeature)) return null;
  if (!isRec(value.surfaces)) return null;
  const surfaces = {} as Record<Protocol, { enabled: boolean }>;
  for (const [name, surface] of Object.entries(value.surfaces)) {
    if (!isProtocol(name) || !isRec(surface) || typeof surface.enabled !== "boolean") return null;
    surfaces[name] = { enabled: surface.enabled };
  }
  if (!surfaces.responses || !surfaces.chat || !surfaces.messages) return null;
  return { policyRevision: value.policyRevision, features: [...value.features], surfaces };
}

/** `null` when the server has no protocol routes; throws on any other failure. */
export async function fetchProtocolInfo(apiBase: string, signal?: AbortSignal): Promise<ProtocolInfo | null> {
  const res = await fetch(`${apiBase}/api/protocols`, { signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const info = parseProtocolInfo(await res.json());
  if (!info) throw new Error("invalid protocol info");
  return info;
}

/**
 * Preview one request path. The current policy revision is read first so a cached plan is
 * reused only while the policy that produced it is still the active one.
 */
export async function fetchProtocolPlan(
  apiBase: string,
  query: ProtocolPlanQuery,
  signal?: AbortSignal,
): Promise<ProtocolPlanResult> {
  try {
    const info = await fetchProtocolInfo(apiBase, signal);
    if (!info) return { kind: "unavailable" };
    const key = protocolPlanCacheKey(apiBase, query, info.policyRevision);
    const cached = planCache.get(key);
    if (cached) return { kind: "plan", plan: cached };
    const res = await fetch(`${apiBase}/api/protocols/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: query.model, inbound: query.inbound, features: [...query.features] }),
      signal,
    });
    if (res.status === 404) return { kind: "unavailable" };
    if (!res.ok) return { kind: "error" };
    const plan: unknown = await res.json();
    if (!isProtocolPlanV1(plan)) return { kind: "error" };
    remember(protocolPlanCacheKey(apiBase, query, plan.policyRevision), plan);
    return { kind: "plan", plan };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { kind: "error" };
  }
}

export interface ProtocolSettingsPatchBody {
  messagesEnabled?: boolean;
}

export type ProtocolSettingsPatchResult =
  | { kind: "ok"; info: ProtocolInfo }
  /** The server predates the settings route. */
  | { kind: "unavailable" }
  | { kind: "error"; code?: string };

/**
 * Change protocol settings on the target `apiBase` names (this machine or the shared hub). The
 * server answers with the fresh `GET /api/protocols` shape, validated like any other read.
 */
export async function patchProtocolSettings(
  apiBase: string,
  body: ProtocolSettingsPatchBody,
  signal?: AbortSignal,
): Promise<ProtocolSettingsPatchResult> {
  try {
    const res = await fetch(`${apiBase}/api/protocols/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (res.status === 404 || res.status === 405) return { kind: "unavailable" };
    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const code = isRec(payload) && isRec(payload.error) && typeof payload.error.code === "string" ? payload.error.code : undefined;
      return code ? { kind: "error", code } : { kind: "error" };
    }
    const info = parseProtocolInfo(payload);
    return info ? { kind: "ok", info } : { kind: "error" };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { kind: "error" };
  }
}

export type ProtocolProviderSummaryResult =
  | { kind: "summary"; summary: ProtocolProviderSummaryV1 }
  /** The server predates the provider block, or no longer has this provider. */
  | { kind: "unavailable" }
  | { kind: "error" };

/**
 * The upstream wire one provider receives, from `GET /api/protocols?provider=<name>`. A 404
 * (older server without the routes, or a provider removed meanwhile) and a 200 without a
 * `provider` block (a server that ignores the parameter) both read as unavailable, so the
 * panel hides instead of guessing.
 */
export async function fetchProtocolProviderSummary(
  apiBase: string,
  provider: string,
  signal?: AbortSignal,
): Promise<ProtocolProviderSummaryResult> {
  try {
    const res = await fetch(`${apiBase}/api/protocols?${new URLSearchParams({ provider }).toString()}`, { signal });
    if (res.status === 404) return { kind: "unavailable" };
    if (!res.ok) return { kind: "error" };
    const payload: unknown = await res.json();
    if (!isRec(payload) || payload.provider === undefined) return { kind: "unavailable" };
    if (!isProtocolProviderSummaryV1(payload.provider) || payload.provider.name !== provider) return { kind: "error" };
    return { kind: "summary", summary: payload.provider };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { kind: "error" };
  }
}
