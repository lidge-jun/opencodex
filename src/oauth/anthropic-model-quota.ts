/** Model-scoped passive quota evidence. Reimplemented from documented behavior, not ported code. */
import { noteAnthropicCooldownMutation } from "../providers/quota/anthropic-cooldown-recovery";
import { credentialGeneration, getAccountCredential } from "./store";
import { getCachedProviderAccountQuota } from "../providers/quota/account-cache";
import type { ProviderQuota, ProviderQuotaWindow } from "../providers/quota-types";

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
export function anthropicModelExhausted(accountId: string, model?: string): boolean {
  return anthropicModelPercents(getCachedProviderAccountQuota("anthropic", accountId), model).some(percent => percent >= 100);
}

interface FamilyObservation { generation: string; seenAt: number; resetAt?: number; busy: boolean; }
const spentFamilies = new Map<string, FamilyObservation>();
const keyFor = (id: string, family: string) => `${id}\0${family}`;
function ownedObservation(id: string, family: string): FamilyObservation | undefined {
  const key = keyFor(id, family);
  const entry = spentFamilies.get(key);
  if (!entry) return undefined;
  const credential = getAccountCredential("anthropic", id);
  if (!credential || credentialGeneration(credential) !== entry.generation) { spentFamilies.delete(key); return undefined; }
  return entry;
}
export function observeAnthropicFamilyQuota(id: string, windows: ProviderQuotaWindow[], now: number, authoritative = false): void {
  const credential = getAccountCredential("anthropic", id);
  if (!credential) return;
  if (authoritative) for (const key of spentFamilies.keys()) if (key.startsWith(`${id}\0`)) spentFamilies.delete(key);
  for (const window of windows) {
    if (window.scope !== "model") continue;
    const key = keyFor(id, window.label);
    if (!window.rejected) { spentFamilies.delete(key); continue; }
    noteAnthropicCooldownMutation(id);
    spentFamilies.set(key, { generation: credentialGeneration(credential), seenAt: now, resetAt: window.resetAt, busy: false });
  }
}
export function anthropicFamilyRejected(id: string, model?: string, now = Date.now()): boolean {
  const family = anthropicModelFamily(model);
  const entry = family && ownedObservation(id, family);
  if (!entry) return false;
  if (entry.resetAt !== undefined && entry.resetAt <= now) return entry.busy;
  return entry.busy || now - entry.seenAt < ANTHROPIC_PASSIVE_FAMILY_MAX_AGE_MS;
}
/** Only stale passive family exclusions require a request-driven single-flight physical send. */
export function claimAnthropicFamilyRevalidation(id: string, model?: string, now = Date.now()): (() => void) | null {
  const family = anthropicModelFamily(model);
  const entry = family && ownedObservation(id, family);
  if (!entry) return () => {};
  if (anthropicFamilyRejected(id, model, now)) return null;
  entry.busy = true;
  return () => { entry.busy = false; };
}
export function clearAnthropicFamilyQuota(): void { spentFamilies.clear(); }

export function anthropicModelWeeklyPercent(quota: ProviderQuota | null, model?: string): number | undefined {
  const family = anthropicModelFamily(model);
  return family ? quota?.customWindows?.find(window => window.scope === "model" && window.label === family)?.percent : undefined;
}

export function anthropicFamilyRetryAt(id: string, model?: string, now = Date.now()): number | undefined {
  const family = anthropicModelFamily(model);
  const entry = family && ownedObservation(id, family);
  if (!entry || !anthropicFamilyRejected(id, model, now)) return undefined;
  return entry.busy ? now + 1000 : Math.min(entry.resetAt ?? Infinity, entry.seenAt + ANTHROPIC_PASSIVE_FAMILY_MAX_AGE_MS);
}
