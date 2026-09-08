import type { OcxConfig } from "../types";
import { deleteConfigTopLevelKey } from "../config/rebase-provenance";

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

/** Active caps win over remembered values from an earlier switch-off. */
export function selectedProviderContextCaps(config: Pick<OcxConfig, "providerContextCaps" | "providerContextCapValues">): Record<string, number> {
  return { ...providerContextCaps({ providerContextCaps: config.providerContextCapValues }), ...providerContextCaps(config) };
}

export function setProviderContextCap(config: OcxConfig, provider: string, enabled: boolean, value?: number): void {
  const next = providerContextCaps(config);
  const selected = selectedProviderContextCaps(config);
  if (enabled) {
    const remembered = Object.hasOwn(selected, provider) ? selected[provider] : undefined;
    next[provider] = isValidContextCap(value) ? Math.floor(value) : (isValidContextCap(remembered) ? remembered : globalContextCapValue(config));
    selected[provider] = next[provider];
  } else {
    delete next[provider];
  }
  if (Object.keys(selected).length > 0) config.providerContextCapValues = selected;
  if (Object.keys(next).length > 0) config.providerContextCaps = next;
  else deleteConfigTopLevelKey(config, "providerContextCaps");
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
  if (Object.keys(caps).length > 0) {
    config.providerContextCaps = caps;
    config.providerContextCapValues = { ...selectedProviderContextCaps(config), ...caps };
  }
}

/** Enable the cap for every named provider at the current value, or clear all caps. */
export function setAllProviderContextCaps(config: OcxConfig, providerNames: string[], enabled: boolean): void {
  const selected = selectedProviderContextCaps(config);
  if (!enabled) {
    if (Object.keys(selected).length > 0) config.providerContextCapValues = selected;
    deleteConfigTopLevelKey(config, "providerContextCaps");
    return;
  }
  const value = globalContextCapValue(config);
  const next: Record<string, number> = {};
  for (const name of providerNames) { next[name] = value; selected[name] = value; }
  if (Object.keys(selected).length > 0) config.providerContextCapValues = selected;
  if (Object.keys(next).length > 0) config.providerContextCaps = next;
  else deleteConfigTopLevelKey(config, "providerContextCaps");
}

/** Provider removal clears both the active limit and its remembered selection. */
export function forgetProviderContextCap(config: OcxConfig, provider: string): void {
  setProviderContextCap(config, provider, false);
  const values = { ...config.providerContextCapValues };
  delete values[provider];
  if (Object.keys(values).length > 0) config.providerContextCapValues = values;
  else deleteConfigTopLevelKey(config, "providerContextCapValues");
}
