import { isGenericFailoverProvider } from "./generic-account-failover";
import type { OcxProviderConfig } from "../types";

/**
 * Which pool-settings contract a provider speaks (#695, slice 1).
 *
 * `codex` and `anthropic` keep their own routes and storage untouched. `generic` is every
 * other OAuth provider the generic failover module admits; its settings persist on
 * `providers.<name>.oauthAccountFailover`.
 *
 * `strategy` and `autoSwitchThreshold` are still a declared contract the selector does not
 * consume — that is what `inert` reports. `enabled` is NOT inert any more: an explicit
 * `true` enables pre-dispatch exhaustion avoidance (`preferredInitialAccount`); absence is off.
 * Healthy manual selections remain authoritative. What the switch can
 * no longer do is refuse reactive 429 rotation, which activates on account presence and is not
 * disableable.
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

export function parseGenericStickyLimit(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100 ? value : null;
}

export interface GenericPoolSettingsDto {
  provider: string;
  kind: "generic";
  enabled: boolean | null;
  strategy: GenericPoolStrategy | null;
  autoSwitchThreshold: number | null;
  stickyLimit: number | null;
  /**
   * Marker for `strategy`, `autoSwitchThreshold` and `stickyLimit` only: true while they are
   * persisted but not consumed by the selector, false once `pool.kernel` is on and they
   * actually choose an account.
   *
   * It deliberately does NOT describe `enabled`, which governs the pre-dispatch preference.
   * Widening it to the whole DTO would tell a dashboard that `enabled` changes nothing, which
   * has been false since reactive and proactive activation were split.
   *
   * Computed, never a literal: the flag is reversible, so a DTO that hard-codes either answer
   * would be lying in one of the two states.
   */
  inert: boolean;
}

export function genericPoolSettingsDto(
  name: string,
  provider: OcxProviderConfig,
  kernelEnabled = false,
): GenericPoolSettingsDto {
  const failover = provider.oauthAccountFailover ?? {};
  return {
    provider: name,
    kind: "generic",
    enabled: typeof failover.enabled === "boolean" ? failover.enabled : null,
    strategy: parseGenericPoolStrategy(failover.strategy),
    autoSwitchThreshold: parseGenericAutoSwitchThreshold(failover.autoSwitchThreshold),
    stickyLimit: parseGenericStickyLimit(failover.stickyLimit),
    inert: kernelEnabled !== true,
  };
}
