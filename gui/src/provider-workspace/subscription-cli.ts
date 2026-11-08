/**
 * provider-workspace/subscription-cli.ts
 *
 * A subscription CLI row drives a locally signed-in vendor CLI instead of calling an API with a
 * key. These adapters run an official vendor CLI whose login and account entitlement it owns, and the
 * proxy stores, reads and injects no key. The registry marks the row `keyOptional` because no
 * key is required, which is also the flag the dashboard reads as "free" — so every surface that
 * groups or labels by pricing asks this helper first.
 *
 * Keyed on the adapter, not the provider id: the adapter is the transport identity
 * (src/adapters/registry.ts builds the CLI adapter for any provider that names it), so a
 * custom row using one of these adapters spends the same account entitlement and gets the same label.
 */
const SUBSCRIPTION_CLI_ADAPTERS: ReadonlySet<string> = new Set(["claude-cli", "trae-cn"]);

/** The Anthropic key-billing preset to point at instead of a subscription CLI row. */
export const SUBSCRIPTION_CLI_API_KEY_ALTERNATIVE = "anthropic-apikey";

export function isSubscriptionCliProvider(provider: { adapter?: string | null }): boolean {
  return SUBSCRIPTION_CLI_ADAPTERS.has((provider.adapter ?? "").trim());
}
