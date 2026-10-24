/**
 * OCX-11 fallback policy: one resolver, one guard, one record.
 *
 * A fallback is a hop that serves a request from a different model or a different provider than
 * the one chosen or requested. Rotation among the accounts or keys of one provider pool for the
 * same model is intra-pool resilience and never passes through here (see
 * `structure/fallback-policy.md`). Every hop site calls {@link guardFallbackHop} at the point it
 * would switch targets; nothing else reads `config.fallback`.
 *
 * Precedence: a device scope set to false refuses regardless; otherwise route, then provider,
 * then global decide, most specific first; absence allows (today's behavior).
 *
 * Privacy: events carry public selectors, coarse trigger codes and device ids only. No request
 * body, credential, account id, label or email reaches the ring or the refusal body.
 */
import type { OcxConfig } from "../types";
import type { OcxFallbackConfig, OcxFallbackKind, OcxFallbackSwitches } from "../types/fallback";
import { FALLBACK_DEVICE_ID, FALLBACK_SELECTOR } from "../config/schema/fallback-policy";

export type FallbackScope = "device" | "route" | "provider" | "global" | "default";
export type FallbackSite = "combo" | "subagent" | "hard-lock" | "routing-profile";
export type FallbackTrigger =
  | "rate_limited" | "quota_exhausted" | "auth_refused" | "upstream_5xx" | "upstream_error"
  | "cooldown" | "unavailable" | "hard_lock";

export interface FallbackTarget { provider: string; model: string }

export interface FallbackDecision {
  allowed: boolean;
  scope: FallbackScope;
  scopeKey?: string;
}

export interface FallbackEvent {
  at: string;
  site: FallbackSite;
  route: string;
  kind: OcxFallbackKind;
  from: string;
  to: string;
  trigger: FallbackTrigger;
  outcome: "taken" | "refused";
  scope: FallbackScope;
  scopeKey?: string;
  deviceId?: string;
}

/** The admission slice this module reads; a configured key is the only device identity. */
export type FallbackAdmission = { kind: string; keyId?: string } | null | undefined;

const RING_SIZE = 20;
const ring: FallbackEvent[] = [];

function switches(value: unknown): OcxFallbackSwitches | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as OcxFallbackSwitches : undefined;
}

function policyOf(config: Pick<OcxConfig, "fallback"> | undefined): OcxFallbackConfig | undefined {
  const value = config?.fallback;
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function entry(map: Record<string, unknown> | undefined, key: string, pattern: RegExp): OcxFallbackSwitches | undefined {
  if (!map || typeof map !== "object" || !pattern.test(key) || !Object.hasOwn(map, key)) return undefined;
  return switches(map[key]);
}

export function selector(target: FallbackTarget): string {
  return target.provider + "/" + target.model;
}

/** The kind of a hop, or null when the target does not change. */
export function fallbackHopKind(from: FallbackTarget, to: FallbackTarget): OcxFallbackKind | null {
  if (from.provider !== to.provider) return "provider";
  return from.model === to.model ? null : "model";
}

/** Resolve one hop against the configured scopes. Pure; device ids are passed in. */
export function resolveFallbackPolicy(
  config: Pick<OcxConfig, "fallback"> | undefined,
  query: { kind: OcxFallbackKind; routes?: readonly string[]; provider?: string; deviceIds?: readonly string[] },
): FallbackDecision {
  const policy = policyOf(config);
  if (!policy) return { allowed: true, scope: "default" };
  for (const id of query.deviceIds ?? []) {
    if (entry(policy.devices, id, FALLBACK_DEVICE_ID)?.[query.kind] === false) {
      return { allowed: false, scope: "device", scopeKey: id };
    }
  }
  for (const route of query.routes ?? []) {
    const value = entry(policy.routes, route, FALLBACK_SELECTOR)?.[query.kind];
    if (typeof value === "boolean") return { allowed: value, scope: "route", scopeKey: route };
  }
  if (query.provider) {
    const value = entry(policy.providers, query.provider, FALLBACK_SELECTOR)?.[query.kind];
    if (typeof value === "boolean") return { allowed: value, scope: "provider", scopeKey: query.provider };
  }
  const global = policy[query.kind];
  if (typeof global === "boolean") return { allowed: global, scope: "global" };
  return { allowed: true, scope: "default" };
}

/**
 * Core-owned slot (AGENTS.md "optional subsystems stay off the core path"): the link listener
 * lifecycle registers how a data key id maps to its Remote Link id, so this request-path module
 * never imports link state. With nothing registered a key id is its own device id (a Hub client).
 */
export type FallbackLinkResolver = (keyId: string) => string | undefined;
let linkResolver: FallbackLinkResolver | undefined;

/** Register the key-to-link resolver; returns a disposer that clears it if still current. */
export function registerFallbackLinkResolver(resolver: FallbackLinkResolver): () => void {
  linkResolver = resolver;
  linkCache = undefined;
  return () => {
    if (linkResolver === resolver) linkResolver = undefined;
    linkCache = undefined;
  };
}

let linkCache: { at: number; byKey: Map<string, string | undefined> } | undefined;
const LINK_CACHE_MS = 5_000;

/** Test seam: forget the cached link-key map. */
export function resetFallbackLinkCacheForTests(): void {
  linkCache = undefined;
}

function linkIdForKey(keyId: string, now: number): string | undefined {
  if (!linkResolver) return undefined;
  if (!linkCache || now - linkCache.at > LINK_CACHE_MS) linkCache = { at: now, byKey: new Map() };
  if (!linkCache.byKey.has(keyId)) {
    let linkId: string | undefined;
    try { linkId = linkResolver(keyId); } catch { /* unreadable store: the key id alone still identifies the device */ }
    linkCache.byKey.set(keyId, linkId);
  }
  return linkCache.byKey.get(keyId);
}

/**
 * Device ids for a request: the Remote Link id its data key belongs to, then the key id itself
 * (a Hub client). The registered link resolver runs only when a device override exists.
 */
export function fallbackDeviceIds(config: Pick<OcxConfig, "fallback">, admission: FallbackAdmission, now = Date.now()): string[] {
  const devices = policyOf(config)?.devices;
  if (!devices || Object.keys(devices).length === 0) return [];
  if (!admission || admission.kind !== "configured" || typeof admission.keyId !== "string") return [];
  const linkId = linkIdForKey(admission.keyId, now);
  return linkId ? [linkId, admission.keyId] : [admission.keyId];
}

/** A coarse trigger code for a failed upstream status. */
export function fallbackTriggerForStatus(status: number): FallbackTrigger {
  if (status === 429) return "rate_limited";
  if (status === 402) return "quota_exhausted";
  if (status === 401 || status === 403) return "auth_refused";
  if (status >= 500) return "upstream_5xx";
  return "upstream_error";
}

function record(event: FallbackEvent): void {
  ring.push(event);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
}

export function recentFallbackEvents(): FallbackEvent[] {
  return ring.map(event => ({ ...event }));
}

export function clearFallbackEventsForTests(): void {
  ring.length = 0;
}

export interface FallbackHop {
  site: FallbackSite;
  /** The public selector the client asked for (combo/<id>, policy/<id>, a model). */
  route: string;
  /** Further selectors that name the same route, such as a resolved alias. */
  aliases?: readonly string[];
  from: FallbackTarget;
  to: FallbackTarget;
  trigger: FallbackTrigger;
  admission?: FallbackAdmission;
  /** Status of the failure that triggered the hop; absent for a proactive hop. */
  failureStatus?: number;
  retryAfter?: string | null;
  now?: number;
}

export type FallbackGuardResult =
  | {
    ok: true;
    kind: OcxFallbackKind | null;
    /**
     * Record the hop as taken at the site's admission boundary (body rewrite, send-budget
     * reservation, or accepted candidate). This does not prove upstream contact or billing;
     * later preparation may still refuse. Idempotent; a no-op for a same-target retry.
     */
    commit: () => void;
  }
  | { ok: false; kind: OcxFallbackKind; decision: FallbackDecision; response: Response };

const NO_COMMIT = (): void => {};

/**
 * Check one hop. A refusal is recorded at once; an allowed hop is recorded only through the
 * returned `commit`. A same-target retry is not a hop and always passes unrecorded.
 */
export function guardFallbackHop(config: OcxConfig, hop: FallbackHop): FallbackGuardResult {
  const kind = fallbackHopKind(hop.from, hop.to);
  if (kind === null) return { ok: true, kind: null, commit: NO_COMMIT };
  const now = hop.now ?? Date.now();
  const deviceIds = fallbackDeviceIds(config, hop.admission, now);
  const routes = [hop.route, ...(hop.aliases ?? [])].filter((value, index, all) => value && all.indexOf(value) === index);
  const decision = resolveFallbackPolicy(config, { kind, routes, provider: hop.from.provider, deviceIds });
  const event: FallbackEvent = {
    at: new Date(now).toISOString(),
    site: hop.site,
    route: hop.route,
    kind,
    from: selector(hop.from),
    to: selector(hop.to),
    trigger: hop.trigger,
    outcome: decision.allowed ? "taken" : "refused",
    scope: decision.scope,
    ...(decision.scopeKey !== undefined ? { scopeKey: decision.scopeKey } : {}),
    ...(deviceIds[0] !== undefined ? { deviceId: deviceIds[0] } : {}),
  };
  if (decision.allowed) {
    let committed = false;
    return { ok: true, kind, commit: () => { if (!committed) { committed = true; record(event); } } };
  }
  record(event);
  return { ok: false, kind, decision, response: fallbackRefusedResponse(event, hop) };
}

function scopeFlag(event: FallbackEvent): string {
  switch (event.scope) {
    case "device": return " --device " + event.scopeKey;
    case "route": return " --route " + event.scopeKey;
    case "provider": return " --provider " + event.scopeKey;
    default: return "";
  }
}

function scopePhrase(event: FallbackEvent): string {
  return event.scope === "global" ? "globally" : "for " + event.scope + " " + event.scopeKey;
}

/** The stable `fallback_refused` error. Status follows the triggering failure. */
export function fallbackRefusedResponse(event: FallbackEvent, hop: Pick<FallbackHop, "failureStatus" | "retryAfter">): Response {
  const status = typeof hop.failureStatus === "number" && hop.failureStatus >= 400 && hop.failureStatus <= 599
    ? hop.failureStatus
    : event.trigger === "cooldown" || event.trigger === "quota_exhausted" || event.trigger === "rate_limited"
      || event.trigger === "hard_lock" ? 429 : 503;
  const kindWord = event.kind === "provider" ? "Provider" : "Model";
  const message = event.route + ": " + event.from + " failed (" + event.trigger + "). " + kindWord
    + " fallback to " + event.to + " is off " + scopePhrase(event) + ", so OpenCodex did not send the request there."
    + " To allow it: ocx fallback on --kind " + event.kind + scopeFlag(event);
  const headers = new Headers({ "x-opencodex-fallback": "refused", "cache-control": "no-store" });
  if (hop.retryAfter) headers.set("retry-after", hop.retryAfter);
  return Response.json({
    error: {
      message,
      type: "fallback_refused",
      code: "fallback_refused",
      fallback: {
        kind: event.kind,
        scope: event.scope,
        ...(event.scopeKey !== undefined ? { scopeKey: event.scopeKey } : {}),
        from: event.from,
        to: event.to,
        trigger: event.trigger,
      },
    },
  }, { status, headers });
}

/** Whether a response is this module's refusal. */
export function isFallbackRefusal(response: Response): boolean {
  return response.headers.get("x-opencodex-fallback") === "refused";
}

/** Carries a refusal out of a site that cannot return a Response itself. */
export class FallbackRefusedError extends Error {
  constructor(readonly response: Response) {
    super("fallback_refused");
    this.name = "FallbackRefusedError";
  }
}
