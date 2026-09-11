import { isGenericFailoverProvider } from "./generic-account-failover";
import { parseAccountPoolStickyLimit, parseAccountPoolStrategy } from "./pool-kernel";
import type { OcxConfig, OcxProviderConfig } from "../types";

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
  // Delegated, not re-implemented. Three pools accepting the same three names from three
  // private copies of the same check is how they drift apart: the Codex and Anthropic kinds
  // already shared this parser while the generic kind carried its own. The names and the
  // 1..100 bound live in pool-kernel.ts, once.
  return parseAccountPoolStrategy(value) as GenericPoolStrategy | null;
}

export function parseGenericAutoSwitchThreshold(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
}

export function parseGenericStickyLimit(value: unknown): number | null {
  return parseAccountPoolStickyLimit(value);
}

/** Fields the unified pool-settings contract can carry, per kind. */
export const POOL_SETTINGS_FIELDS = [
  "enabled", "strategy", "stickyLimit", "autoSwitchThreshold", "quotaWindow",
] as const;
export type PoolSettingsField = typeof POOL_SETTINGS_FIELDS[number];

/**
 * One shape for all three pool kinds.
 *
 * `supported` is the reason this is a consolidation rather than a fourth contract: a field a
 * kind does not honour is DECLARED unsupported instead of being omitted, so a dashboard can
 * tell "this pool has no quotaWindow" from "this response forgot to send one". Every kind
 * answers with the same keys.
 */
export interface PoolSettingsDto {
  provider: string;
  kind: PoolSettingsKind;
  supported: PoolSettingsField[];
  /** The STORED override. null means nothing is stored here, not "off". */
  enabled: boolean | null;
  /**
   * What the runtime actually resolves for `enabled`, after the global default.
   *
   * The generic kind inherits `config.oauthAccountFailover.enabled` when it stores no override
   * of its own, so `enabled: null` alone cannot distinguish a disabled pool from an inherited
   * one. This resolves exactly that config question and nothing else -- deliberately NOT the
   * roster quorum the dispatch predicate also applies, because a settings field that folded in
   * "how many accounts are logged in" would be answering a different question than it asks.
   */
  enabledEffective: boolean;
  strategy: string | null;
  stickyLimit: number | null;
  autoSwitchThreshold: number | null;
  quotaWindow: string | null;
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

/** Which fields each kind actually honours. Declared, never silently omitted. */
const SUPPORTED_BY_KIND: Record<PoolSettingsKind, PoolSettingsField[]> = {
  codex: ["strategy", "stickyLimit", "autoSwitchThreshold"],
  anthropic: ["enabled", "strategy", "stickyLimit", "autoSwitchThreshold", "quotaWindow"],
  generic: ["enabled", "strategy", "stickyLimit", "autoSwitchThreshold"],
};

/**
 * The one projection behind `/api/pool/settings`.
 *
 * Reads each kind's own storage -- this consolidates the CONTRACT, not the persistence -- and
 * answers with identical keys plus a `supported` list, so an unsupported field is a declared
 * `null` rather than an absence a caller has to guess about.
 */
export function unifiedPoolSettingsDto(
  config: OcxConfig,
  provider: string,
  kind: PoolSettingsKind,
): PoolSettingsDto {
  const base = { provider, kind, supported: SUPPORTED_BY_KIND[kind] };
  if (kind === "codex") {
    return {
      ...base,
      // The Codex pool has no enablement switch: it is on whenever accounts exist, so the
      // honest answer is "not a field here" rather than a fabricated true.
      enabled: null,
      enabledEffective: true,
      strategy: parseGenericPoolStrategy(config.accountPoolStrategy) ?? "quota",
      stickyLimit: parseGenericStickyLimit(config.accountPoolStickyLimit) ?? 1,
      autoSwitchThreshold: parseGenericAutoSwitchThreshold(config.autoSwitchThreshold) ?? 80,
      quotaWindow: null,
    };
  }
  if (kind === "anthropic") {
    const pool = config.anthropicAccountPool ?? {};
    const enabled = typeof pool.enabled === "boolean" ? pool.enabled : null;
    return {
      ...base,
      enabled,
      enabledEffective: enabled === true,
      strategy: parseGenericPoolStrategy(pool.strategy) ?? "quota",
      stickyLimit: parseGenericStickyLimit(pool.stickyLimit) ?? 1,
      autoSwitchThreshold: parseGenericAutoSwitchThreshold(pool.autoSwitchThreshold) ?? 80,
      quotaWindow: typeof pool.quotaWindow === "string" ? pool.quotaWindow : "five-hour",
    };
  }
  const failover = config.providers?.[provider]?.oauthAccountFailover ?? {};
  const stored = typeof failover.enabled === "boolean" ? failover.enabled : null;
  return {
    ...base,
    enabled: stored,
    // The defect this field exists to close: a generic provider with no stored override
    // inherits the global, so `enabled: null` alone cannot tell a disabled pool from an
    // inherited one. Config only -- the roster quorum the dispatch predicate also applies is a
    // different question and stays out of a settings field.
    enabledEffective: stored ?? (config.oauthAccountFailover?.enabled === true),
    strategy: parseGenericPoolStrategy(failover.strategy),
    stickyLimit: parseGenericStickyLimit(failover.stickyLimit),
    autoSwitchThreshold: parseGenericAutoSwitchThreshold(failover.autoSwitchThreshold),
    quotaWindow: null,
  };
}

