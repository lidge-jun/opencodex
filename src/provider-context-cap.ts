import type { OcxConfig } from "./types";

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

export function setProviderContextCap(config: OcxConfig, provider: string, enabled: boolean): void {
  const next = providerContextCaps(config);
  if (enabled) next[provider] = DEFAULT_PROVIDER_CONTEXT_CAP;
  else delete next[provider];
  if (Object.keys(next).length > 0) config.providerContextCaps = next;
  else delete config.providerContextCaps;
}
