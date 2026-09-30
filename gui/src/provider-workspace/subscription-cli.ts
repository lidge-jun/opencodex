/**
 * provider-workspace/subscription-cli.ts
 *
 * A subscription CLI row drives a locally signed-in vendor CLI instead of calling an API with a
 * key. Today that is only the `claude-cli` adapter: it runs the official Claude Code CLI
 * headlessly (`claude -p`), the CLI signs in and bills the user's Claude subscription, and the
 * proxy stores, reads and injects no key. The registry marks the row `keyOptional` because no
 * key is required, which is also the flag the dashboard reads as "free" — so every surface that
 * groups or labels by pricing asks this helper first.
 *
 * Keyed on the adapter, not the provider id: the adapter is the transport identity
 * (src/adapters/registry.ts builds the CLI adapter for any provider that names it), so a
 * custom row with `adapter: "claude-cli"` spends the same subscription and gets the same label.
 */
const SUBSCRIPTION_CLI_ADAPTERS: ReadonlySet<string> = new Set(["claude-cli"]);

/** The Anthropic key-billing preset to point at instead of a subscription CLI row. */
export const SUBSCRIPTION_CLI_API_KEY_ALTERNATIVE = "anthropic-apikey";

export function isSubscriptionCliProvider(provider: { adapter?: string | null }): boolean {
  return SUBSCRIPTION_CLI_ADAPTERS.has((provider.adapter ?? "").trim());
}
