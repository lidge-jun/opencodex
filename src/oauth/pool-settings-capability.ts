import { isGenericFailoverProvider } from "./generic-account-failover";
import type { OcxProviderConfig } from "../types";

/**
 * Which pool-settings contract a provider speaks (#695, slice 1).
 *
 * `codex` and `anthropic` keep their own routes and storage untouched. `generic` is every
 * other OAuth provider the generic failover module admits; its settings persist on
 * `providers.<name>.oauthAccountFailover`. Settings stored for a generic provider are a
 * declared contract the selector can consume in a later slice; today they change nothing.
 */
export type PoolSettingsKind = "codex" | "anthropic" | "generic";

export const GENERIC_POOL_STRATEGIES = ["quota", "round-robin", "fill-first"] as const;
export type GenericPoolStrategy = typeof GENERIC_POOL_STRATEGIES[number];

export function poolSettingsCapability(name: string, provider: OcxProviderConfig | undefined): PoolSettingsKind | null {
  if (name === "openai") return "codex";
  if (name === "anthropic") return "anthropic";
  if (!provider) return null;
  return isGenericFailoverProvider(name, provider) ? "generic" : null;
}

export function parseGenericPoolStrategy(value: unknown): GenericPoolStrategy | null {
  return typeof value === "string" && (GENERIC_POOL_STRATEGIES as readonly string[]).includes(value)
    ? value as GenericPoolStrategy
    : null;
}

export function parseGenericAutoSwitchThreshold(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
}

export interface GenericPoolSettingsDto {
  provider: string;
  kind: "generic";
  enabled: boolean | null;
  strategy: GenericPoolStrategy | null;
  autoSwitchThreshold: number | null;
  /** Slice-1 marker: persisted, not yet consumed by the selector. */
  inert: true;
}

export function genericPoolSettingsDto(name: string, provider: OcxProviderConfig): GenericPoolSettingsDto {
  const failover = provider.oauthAccountFailover ?? {};
  return {
    provider: name,
    kind: "generic",
    enabled: typeof failover.enabled === "boolean" ? failover.enabled : null,
    strategy: parseGenericPoolStrategy(failover.strategy),
    autoSwitchThreshold: parseGenericAutoSwitchThreshold(failover.autoSwitchThreshold),
    inert: true,
  };
}

