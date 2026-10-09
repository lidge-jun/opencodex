/** Model-scoped passive quota evidence. Reimplemented from documented behavior, not ported code. */
import { credentialGeneration, getAccountCredential } from "./store";
import { getCachedProviderAccountQuota } from "../providers/quota/account-cache";
import type { ProviderQuota, ProviderQuotaWindow } from "../providers/quota-types";
import type { AnthropicInstanceId } from "../providers/anthropic-instance-id";
import type { GenerationContext } from "../lib/state-store-sweeper";

export const ANTHROPIC_PASSIVE_FAMILY_MAX_AGE_MS = 30 * 60_000;
export type AnthropicModelFamily = "Fable" | "Opus" | "Sonnet";
export function anthropicModelFamily(model?: string): AnthropicModelFamily | undefined {
  return /(?:^|[/])claude-fable-5(?:-|$)/i.test(model ?? "") ? "Fable"
    : /(?:^|[/])claude-opus-/i.test(model ?? "") ? "Opus"
      : /(?:^|[/])claude-sonnet-/i.test(model ?? "") ? "Sonnet" : undefined;
}

export function anthropicModelPercents(quota: ProviderQuota | null, model?: string): number[] {
  const family = anthropicModelFamily(model);
  return [quota?.fiveHourPercent, quota?.weeklyPercent, ...(!model ? [quota?.monthlyPercent] : []),
    ...(quota?.customWindows ?? []).filter(window => !model || window.scope !== "model" || (family && window.label === family)).map(window => window.percent)]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}
interface FamilyObservation { generation: string; seenAt: number; resetAt?: number; busy: boolean; }
const keyFor = (id: string, family: string) => `${id}\0${family}`;
function createAnthropicModelQuota(instance: AnthropicInstanceId) {
  let spentFamilies: Map<string, FamilyObservation> | undefined;
  let familyGenerations: Map<string, number> | undefined;
  let nextFamilyGeneration = 1;
  let emptyGeneration = 0;
  function bump(id: string): void { (familyGenerations ??= new Map()).set(id, nextFamilyGeneration++); }
  function anthropicFamilyQuotaGeneration(id: string): number { return familyGenerations?.get(id) ?? emptyGeneration; }
  /** Reserving an asynchronous probe is a write; ordinary generation reads stay allocation-free. */
  function captureAnthropicFamilyQuotaGeneration(id: string): number {
    if (!familyGenerations?.has(id)) bump(id);
    return anthropicFamilyQuotaGeneration(id);
  }
  function anthropicModelExhausted(accountId: string, model?: string): boolean {
    return anthropicModelPercents(getCachedProviderAccountQuota(instance, accountId), model).some(percent => percent >= 100);
  }
  function ownedObservation(id: string, family: string): FamilyObservation | undefined {
    const key = keyFor(id, family);
    const entry = spentFamilies?.get(key);
    if (!entry) return undefined;
    const credential = getAccountCredential(instance, id);
    if (!credential || credentialGeneration(credential) !== entry.generation) { spentFamilies!.delete(key); bump(id); return undefined; }
    return entry;
  }
  function observeAnthropicFamilyQuota(id: string, windows: ProviderQuotaWindow[], now: number, authoritative = false): void {
    const credential = getAccountCredential(instance, id);
    if (!credential) return;
    if (!authoritative && !windows.some(window => window.scope === "model")) return;
    bump(id);
    const observations = spentFamilies ??= new Map();
    if (authoritative) for (const key of observations.keys()) if (key.startsWith(`${id}\0`)) observations.delete(key);
    for (const window of windows) {
      if (window.scope !== "model") continue;
      const key = keyFor(id, window.label);
      if (!window.rejected) { observations.delete(key); continue; }
      observations.set(key, { generation: credentialGeneration(credential), seenAt: now, resetAt: window.resetAt, busy: false });
    }
  }
  function anthropicFamilyRejected(id: string, model?: string, now = Date.now()): boolean {
    const family = anthropicModelFamily(model);
    const entry = family && ownedObservation(id, family);
    if (!entry) return false;
    if (entry.resetAt !== undefined && entry.resetAt <= now) return entry.busy;
    return entry.busy || now - entry.seenAt < ANTHROPIC_PASSIVE_FAMILY_MAX_AGE_MS;
  }
  /** Only stale passive family exclusions require a request-driven single-flight physical send. */
  function claimAnthropicFamilyRevalidation(id: string, model?: string, now = Date.now()): (() => void) | null {
    const family = anthropicModelFamily(model);
    const entry = family && ownedObservation(id, family);
    if (!entry) return () => {};
    if (anthropicFamilyRejected(id, model, now)) return null;
    entry.busy = true;
    return () => { if (spentFamilies?.get(keyFor(id, family!)) === entry) entry.busy = false; };
  }
  /** An owned successful send proves admission for its requested family even without headers. */
  function clearAnthropicRequestedFamilyQuota(id: string, model?: string): void {
    const family = anthropicModelFamily(model);
    if (family && spentFamilies?.delete(keyFor(id, family))) bump(id);
  }
  function clearAnthropicFamilyQuota(): void {
    // A prior zero-generation claim must stay stale even after an identical account is re-added.
    emptyGeneration = nextFamilyGeneration++;
    spentFamilies = undefined;
    familyGenerations = undefined;
  }
  function reconcileAnthropicFamilyQuota(context: GenerationContext): number {
    let removed = 0;
    const retired = new Set<string>();
    for (const [key] of spentFamilies ?? []) {
      const id = key.slice(0, key.indexOf("\0"));
      if (context.oauthAccountKeys.has(`${instance}\0${id}`)) continue;
      spentFamilies!.delete(key); retired.add(id); removed++;
    }
    for (const id of familyGenerations?.keys() ?? []) {
      if (!context.oauthAccountKeys.has(`${instance}\0${id}`)) retired.add(id);
    }
    for (const id of retired) bump(id);
    return removed;
  }
  function anthropicFamilyRetryAt(id: string, model?: string, now = Date.now()): number | undefined {
    const family = anthropicModelFamily(model);
    const entry = family && ownedObservation(id, family);
    if (!entry || !anthropicFamilyRejected(id, model, now)) return undefined;
    return entry.busy ? now + 1000 : Math.min(entry.resetAt ?? Infinity, entry.seenAt + ANTHROPIC_PASSIVE_FAMILY_MAX_AGE_MS);
  }
  return Object.freeze({ instance, anthropicModelExhausted, anthropicFamilyQuotaGeneration,
    captureAnthropicFamilyQuotaGeneration,
    observeAnthropicFamilyQuota, anthropicFamilyRejected, claimAnthropicFamilyRevalidation,
    clearAnthropicRequestedFamilyQuota, clearAnthropicFamilyQuota, anthropicFamilyRetryAt, reconcileAnthropicFamilyQuota });
}

export type AnthropicModelQuota = ReturnType<typeof createAnthropicModelQuota>;
const instances = new Map<AnthropicInstanceId, AnthropicModelQuota>();
export function anthropicModelQuotaFor(instance: AnthropicInstanceId): AnthropicModelQuota {
  let facade = instances.get(instance);
  if (!facade) { facade = createAnthropicModelQuota(instance); instances.set(instance, facade); }
  return facade;
}
export function reconcileAllAnthropicFamilyQuota(context: GenerationContext): number {
  let removed = 0;
  for (const facade of instances.values()) removed += facade.reconcileAnthropicFamilyQuota(context);
  return removed;
}
export function clearAllAnthropicFamilyQuota(): void {
  for (const facade of instances.values()) facade.clearAnthropicFamilyQuota();
}
export function anthropicModelExhausted(accountId: string, model?: string): boolean {
  return anthropicModelQuotaFor("anthropic").anthropicModelExhausted(accountId, model);
}
export function anthropicFamilyQuotaGeneration(id: string): number {
  return anthropicModelQuotaFor("anthropic").anthropicFamilyQuotaGeneration(id);
}
export function observeAnthropicFamilyQuota(id: string, windows: ProviderQuotaWindow[], now: number, authoritative = false): void {
  anthropicModelQuotaFor("anthropic").observeAnthropicFamilyQuota(id, windows, now, authoritative);
}
export function anthropicFamilyRejected(id: string, model?: string, now = Date.now()): boolean {
  return anthropicModelQuotaFor("anthropic").anthropicFamilyRejected(id, model, now);
}
export function claimAnthropicFamilyRevalidation(id: string, model?: string, now = Date.now()): (() => void) | null {
  return anthropicModelQuotaFor("anthropic").claimAnthropicFamilyRevalidation(id, model, now);
}
export function clearAnthropicRequestedFamilyQuota(id: string, model?: string): void {
  anthropicModelQuotaFor("anthropic").clearAnthropicRequestedFamilyQuota(id, model);
}
export function clearAnthropicFamilyQuota(): void { anthropicModelQuotaFor("anthropic").clearAnthropicFamilyQuota(); }
export function anthropicFamilyRetryAt(id: string, model?: string, now = Date.now()): number | undefined {
  return anthropicModelQuotaFor("anthropic").anthropicFamilyRetryAt(id, model, now);
}

export function anthropicModelWeeklyPercent(quota: ProviderQuota | null, model?: string): number | undefined {
  const family = anthropicModelFamily(model);
  return family ? quota?.customWindows?.find(window => window.scope === "model" && window.label === family)?.percent : undefined;
}
