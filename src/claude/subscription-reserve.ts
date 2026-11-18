/**
 * Weekly quota steering for caller-forward Claude subscriptions.
 * Policy comes from the loaded config. Quota observations are process-local and scoped to
 * the exact upstream and caller credential. A managed route uses its own billing identity.
 *
 * Pattern adopted from Hermes-agent (MIT, NousResearch): reserve quota for interactive
 * use and record the request, destination and reason for a downgrade.
 */
import { SUBSCRIPTION_RESERVE_HARD, SUBSCRIPTION_RESERVE_SOFT } from "../config/schema/subscription-reserve";
import { previewRouteModel } from "../router";
import type { OcxConfig } from "../types";

export const SUBSCRIPTION_PRIORITY_HEADER = "x-ocx-priority";
const OBSERVATION_MAX_AGE_MS = 30 * 60_000;
const OBSERVATION_LIMIT = 128;

interface WeeklyObservation {
  utilization: number;
  observedAt: number;
  resetAt?: number;
}

const observations = new WeakMap<OcxConfig, Map<string, WeeklyObservation>>();

export function nativeSubscriptionObservationKey(upstream: string, bearer: string): string | undefined {
  if (!bearer.startsWith("sk-ant-oat")) return undefined;
  return Bun.CryptoHasher.hash("sha256", JSON.stringify([upstream, bearer]), "hex");
}

function finite(value: string | null): number | undefined {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value.trim())) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function observeWeeklyHeaders(config: OcxConfig, key: string, headers: Headers, now = Date.now()): void {
  const utilization = finite(headers.get("anthropic-ratelimit-unified-7d-utilization"));
  if (utilization === undefined || utilization > 1.5) return;
  const reset = finite(headers.get("anthropic-ratelimit-unified-7d-reset"));
  let seen = observations.get(config);
  if (!seen) {
    seen = new Map();
    observations.set(config, seen);
  }
  seen.delete(key);
  if (seen.size >= OBSERVATION_LIMIT) seen.delete(seen.keys().next().value!);
  seen.set(key, {
    utilization: Math.min(utilization, 1),
    observedAt: now,
    ...(reset !== undefined && reset > 0 ? { resetAt: reset * 1000 } : {}),
  });
}

/** Only an explicit caller signal can classify Haiku, subagents or short requests as background. */
export function isSubscriptionBackground(headers: Headers): boolean {
  return headers.get(SUBSCRIPTION_PRIORITY_HEADER)?.trim().toLowerCase() === "background";
}

export function decideReserve(
  config: OcxConfig,
  key: string,
  preservesSelector: (target: string) => boolean,
  now = Date.now(),
): { target: string; reason: string } | undefined {
  const policy = config.subscriptionReserve;
  const seen = observations.get(config)?.get(key);
  if (policy?.enabled !== true || !seen || seen.observedAt > now || now - seen.observedAt >= OBSERVATION_MAX_AGE_MS
    || (seen.resetAt !== undefined && seen.resetAt <= now)) return undefined;

  const soft = policy.soft ?? SUBSCRIPTION_RESERVE_SOFT;
  const hard = policy.hard ?? SUBSCRIPTION_RESERVE_HARD;
  if (seen.utilization < soft) return undefined;
  const tier = seen.utilization >= hard ? "hard" : "soft";
  const threshold = tier === "hard" ? hard : soft;
  for (const target of policy.targets ?? []) {
    try {
      // An unknown prefix can otherwise fall through to the default provider as a literal model.
      const route = previewRouteModel(config, target);
      if (route.routeKind !== "explicit-provider" || route.routeReason !== "explicit-provider-namespace"
        || route.providerName !== target.slice(0, target.indexOf("/")) || !preservesSelector(target)) continue;
    } catch {
      continue;
    }
    return { target, reason: `weekly Claude ${Math.round(seen.utilization * 100)}% >= ${Math.round(threshold * 100)}% (${tier} reserve)` };
  }
  return undefined;
}
