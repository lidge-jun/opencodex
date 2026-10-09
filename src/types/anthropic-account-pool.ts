/**
 * Anthropic OAuth account-pool settings. One shape, two locations:
 * `config.anthropicAccountPool` for the `anthropic` instance and
 * `config.providers.anthropic2.anthropicAccountPool` for `anthropic2`. Neither inherits from the other.
 *
 * Leaf module: `config.ts` and `provider.ts` import these types, never the reverse.
 */
export type OcxAccountPoolRotationStrategy = "quota" | "round-robin" | "fill-first";

export type OcxAccountPoolQuotaWindow = "five-hour" | "weekly" | "max-utilization";

export interface AnthropicModelRoute {
  name: string;
  match: string;
  accounts: string[];
  fallback?: boolean;
}

export interface AnthropicAccountPoolConfig {
  enabled?: boolean;
  /** Preserve native Claude Messages while the pool is enabled. Default true; false selects legacy translation. */
  nativeMessages?: boolean;
  /** Usage % threshold for new-session auto-pick. Default 80. 0 = disabled (affinity/active only). */
  autoSwitchThreshold?: number;
  /** New-session rotation strategy. Default quota (today's behaviour). */
  strategy?: OcxAccountPoolRotationStrategy;
  /** Successful new-session binds retained on one round-robin selection. Default 1; range 1..100. */
  stickyLimit?: number;
  /** Usage window for quota-based scoring. Default "five-hour" (today's behaviour). */
  quotaWindow?: OcxAccountPoolQuotaWindow;
  /** Ordered model allowlists; inactive while the pool is disabled. Stored account IDs only. */
  routes?: AnthropicModelRoute[];
}
