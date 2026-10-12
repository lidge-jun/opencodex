/** Response-header policy for managed Anthropic sends; no account or request payload data. */
import type { AnthropicInstanceId } from "../providers/anthropic-instance-id";
import type { GenerationContext } from "../lib/state-store-sweeper";
import { credentialGeneration, getAccountCredential } from "./store";
export type AnthropicRateLimitKind = "shared-quota" | "family-quota" | "transient-rate" | "request-scoped-unknown";
export type RateLimitHeaders = Pick<Headers, "get">;
export const ANTHROPIC_SHORT_RETRY_MS = 100;
export const ANTHROPIC_MAX_INLINE_THROTTLE_MS = 1_000;

export function anthropicRetryAfterMs(value: string | null | undefined, now: number): number | undefined {
  const text = value?.trim();
  if (!text || text.length > 128) return undefined;
  const at = /^\d+(?:\.\d+)?$/.test(text) ? now + Number(text) * 1000 : Date.parse(text);
  return Number.isFinite(new Date(at).getTime()) && at > now ? Math.ceil(at - now) : undefined;
}

export function classifyAnthropic429(headers: RateLimitHeaders, now = Date.now()): AnthropicRateLimitKind {
  const rejected = (window: string) => headers.get(`anthropic-ratelimit-unified-${window}-status`)?.trim() === "rejected";
  if (rejected("5h") || rejected("7d")) return "shared-quota";
  if (rejected("7d_oi")) return "family-quota";
  if (headers.get("anthropic-ratelimit-unified-status")?.trim() === "rejected") return "shared-quota";
  // Retry-After is an account-local admission pause, not proof of spent subscription quota.
  if (anthropicRetryAfterMs(headers.get("retry-after"), now) !== undefined
    || headers.get("anthropic-ratelimit-unified-status")?.trim() === "allowed") return "transient-rate";
  return "request-scoped-unknown";
}

function createAnthropicRatePolicy(instance: AnthropicInstanceId) {
  let pauses: Map<string, { until: number; generation: string }> | undefined;
  function pauseAnthropicRateAdmission(accountId: string, until: number): void {
    const credential = getAccountCredential(instance, accountId);
    if (!credential) return;
    const now = Date.now();
    const generation = credentialGeneration(credential);
    const rows = pauses ??= new Map();
    for (const [id, pause] of rows) if (pause.until <= now) rows.delete(id);
    const previous = rows.get(accountId);
    rows.set(accountId, { until: Math.max(previous?.generation === generation ? previous.until : 0, until), generation });
  }
  function anthropicRatePauseUntil(accountId: string, now = Date.now()): number | undefined {
    const pause = pauses?.get(accountId);
    if (!pause) return undefined;
    const credential = getAccountCredential(instance, accountId);
    if (pause.until <= now || !credential || credentialGeneration(credential) !== pause.generation) {
      pauses!.delete(accountId); return undefined;
    }
    return pause.until;
  }
  function clearAnthropicRatePauses(): void { pauses = undefined; }
  function reconcileAnthropicRatePauses(context: GenerationContext): number {
    let removed = 0;
    for (const id of pauses?.keys() ?? []) {
      if (context.oauthAccountKeys.has(`${instance}\0${id}`)) continue;
      pauses!.delete(id); removed++;
    }
    return removed;
  }
  function sweepExpiredAnthropicRatePauses(now = Date.now()): number {
    let removed = 0;
    for (const [id, pause] of pauses ?? []) if (pause.until <= now) { pauses!.delete(id); removed++; }
    return removed;
  }
  return Object.freeze({ instance, pauseAnthropicRateAdmission, anthropicRatePauseUntil,
    clearAnthropicRatePauses, reconcileAnthropicRatePauses, sweepExpiredAnthropicRatePauses });
}
export type AnthropicRatePolicy = ReturnType<typeof createAnthropicRatePolicy>;
const instances = new Map<AnthropicInstanceId, AnthropicRatePolicy>();
export function anthropicRatePolicyFor(instance: AnthropicInstanceId): AnthropicRatePolicy {
  let facade = instances.get(instance);
  if (!facade) { facade = createAnthropicRatePolicy(instance); instances.set(instance, facade); }
  return facade;
}
export function reconcileAllAnthropicRatePauses(context: GenerationContext): number {
  let removed = 0;
  for (const facade of instances.values()) removed += facade.reconcileAnthropicRatePauses(context);
  return removed;
}
export function sweepExpiredAllAnthropicRatePauses(now = Date.now()): number {
  let removed = 0;
  for (const facade of instances.values()) removed += facade.sweepExpiredAnthropicRatePauses(now);
  return removed;
}
export function clearAllAnthropicRatePauses(): void {
  for (const facade of instances.values()) facade.clearAnthropicRatePauses();
}
export function pauseAnthropicRateAdmission(accountId: string, until: number): void {
  anthropicRatePolicyFor("anthropic").pauseAnthropicRateAdmission(accountId, until);
}
export function anthropicRatePauseUntil(accountId: string, now = Date.now()): number | undefined {
  return anthropicRatePolicyFor("anthropic").anthropicRatePauseUntil(accountId, now);
}
export function clearAnthropicRatePauses(): void { anthropicRatePolicyFor("anthropic").clearAnthropicRatePauses(); }
