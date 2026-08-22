import type { OcxConfig } from "../types";

export const DEFAULT_PROVIDER_CONTEXT_CAP = 350_000;

function isValidContextCap(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function providerContextCap(config: Pick<OcxConfig, "providerContextCaps">, provider: string): number | undefined {
  const value = config.providerContextCaps?.[provider];
  return isValidContextCap(value) ? value : undefined;
}

export function providerContextCaps(config: Pick<OcxConfig, "providerContextCaps">): Record<string, number> {
  const caps = config.providerContextCaps;
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) return {};
  const out: Record<string, number> = {};
  for (const [provider, value] of Object.entries(caps)) {
    if (isValidContextCap(value)) out[provider] = value;
  }
  return out;
}

export function applyProviderContextCap(contextWindow: number | undefined, cap: number | undefined): number | undefined {
  if (!isValidContextCap(cap)) return contextWindow;
  if (!isValidContextCap(contextWindow)) return contextWindow;
  return contextWindow > cap ? cap : contextWindow;
}

/**
 * 上游没报窗口时，已开启的 Context cap 就是实际窗口。
 * 128k 只是 Codex 解析器的兼容底线，不能当成“已发现窗口”再拿去和 cap 做 min。
 */
export function resolveUnknownRoutedContextWindow(cap: number | undefined): number {
  const window = isValidContextCap(cap) ? Math.floor(cap) : 0;
  return window > 0 ? window : 128_000;
}

/** Effective global cap value: explicit config value, else the built-in default. */
export function globalContextCapValue(config: Pick<OcxConfig, "contextCapValue">): number {
  const value = config.contextCapValue;
  return isValidContextCap(value) ? Math.floor(value) : DEFAULT_PROVIDER_CONTEXT_CAP;
}

export function setProviderContextCap(config: OcxConfig, provider: string, enabled: boolean, value?: number): void {
  const next = providerContextCaps(config);
  if (enabled) {
    next[provider] = isValidContextCap(value) ? Math.floor(value) : globalContextCapValue(config);
  } else {
    delete next[provider];
  }
  if (Object.keys(next).length > 0) config.providerContextCaps = next;
  else delete config.providerContextCaps;
}

/**
 * Set the global cap value (the default used by per-provider toggles and "set all").
 * Re-points every already-enabled provider only when `applyToAll` is true (the dashboard's
 * "apply to every routed provider" toggle); otherwise each provider keeps its own cap value.
 */
export function setGlobalContextCapValue(config: OcxConfig, value: number, applyToAll: boolean): void {
  if (!isValidContextCap(value)) return;
  const next = Math.floor(value);
  config.contextCapValue = next;
  if (!applyToAll) return;
  const caps = providerContextCaps(config);
  for (const provider of Object.keys(caps)) caps[provider] = next;
  if (Object.keys(caps).length > 0) config.providerContextCaps = caps;
}

/** Enable the cap for every named provider at the current value, or clear all caps. */
export function setAllProviderContextCaps(config: OcxConfig, providerNames: string[], enabled: boolean): void {
  if (!enabled) {
    delete config.providerContextCaps;
    return;
  }
  const value = globalContextCapValue(config);
  const next: Record<string, number> = {};
  for (const name of providerNames) next[name] = value;
  if (Object.keys(next).length > 0) config.providerContextCaps = next;
  else delete config.providerContextCaps;
}
