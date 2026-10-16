/**
 * Per-instance Anthropic pool settings. A reads only `config.anthropicAccountPool`; B reads only
 * `config.providers.anthropic2.anthropicAccountPool`. A missing B block means product defaults, never
 * A's settings. Pure: no store, network or state access.
 */
import type { OcxConfig } from "../types";
import type { AnthropicAccountPoolConfig } from "../types/anthropic-account-pool";
import type { AnthropicInstanceId } from "../providers/anthropic-instance-id";

/** The raw value at the instance's own location, preserving absent/invalid distinctions for callers that need them. */
export function rawAnthropicAccountPool(config: Pick<OcxConfig, "anthropicAccountPool" | "providers">, instance: AnthropicInstanceId): unknown {
  if (instance === "anthropic") return config.anthropicAccountPool;
  const row: unknown = config.providers?.[instance];
  return row && typeof row === "object" ? (row as { anthropicAccountPool?: unknown }).anthropicAccountPool : undefined;
}

export function resolveAnthropicAccountPoolConfig(
  config: Pick<OcxConfig, "anthropicAccountPool" | "providers">,
  instance: AnthropicInstanceId,
): AnthropicAccountPoolConfig {
  const raw = rawAnthropicAccountPool(config, instance);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as AnthropicAccountPoolConfig : {};
}

export function isAnthropicPoolEnabledFor(
  config: Pick<OcxConfig, "anthropicAccountPool" | "providers">,
  instance: AnthropicInstanceId,
): boolean {
  return resolveAnthropicAccountPoolConfig(config, instance).enabled === true;
}
