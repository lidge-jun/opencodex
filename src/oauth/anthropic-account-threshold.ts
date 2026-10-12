import type { AnthropicInstanceId } from "../providers/anthropic-instance-id";
import { resolveAnthropicAccountPoolConfig } from "./anthropic-pool-config";
import type { OcxConfig } from "../types";
import type { ProviderAccount } from "./types";

/** Shared strict boundary for persisted rows and management writes. Zero is not exhaustion. */
export function parseAnthropicAccountThreshold(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
}

/** Missing or malformed legacy metadata inherits; concrete zero must survive nullish fallback. */
export function effectiveAnthropicAccountThresholdForInstance(instance: AnthropicInstanceId, config: OcxConfig, account?: Pick<ProviderAccount, "autoSwitchThresholdOverride">): number {
  return parseAnthropicAccountThreshold(account?.autoSwitchThresholdOverride)
    ?? parseAnthropicAccountThreshold(resolveAnthropicAccountPoolConfig(config, instance).autoSwitchThreshold) ?? 80;
}

export function effectiveAnthropicAccountThreshold(config: OcxConfig, account?: Pick<ProviderAccount, "autoSwitchThresholdOverride">): number {
  return effectiveAnthropicAccountThresholdForInstance("anthropic", config, account);
}
