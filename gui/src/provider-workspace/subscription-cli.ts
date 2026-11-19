/**
 * provider-workspace/subscription-cli.ts
 *
 * A subscription CLI row drives a locally signed-in vendor CLI instead of calling an API with a
 * key: the `claude-cli` adapter runs the official Claude Code CLI headlessly (`claude -p`), and
 * the `agy-acp` adapter runs the official Antigravity CLI over ACP (`agy acp`). The CLI signs in
 * and bills the user's subscription, and the proxy stores, reads and injects no key. The registry
 * marks the row `keyOptional` because no key is required, which is also the flag the dashboard
 * reads as "free" — so every surface that groups or labels by pricing asks this helper first.
 *
 * Keyed on the adapter, not the provider id: the adapter is the transport identity
 * (src/adapters/registry.ts builds the CLI adapter for any provider that names it), so a
 * custom row with `adapter: "claude-cli"` spends the same subscription and gets the same label.
 */
import type { TKey } from "../i18n/shared";

/** Per adapter: the warning shown in place of a key field, its CLI command, and the key-billed preset to use instead. */
const SUBSCRIPTION_CLI_WARNINGS: Readonly<Record<string, { key: TKey; cmd: string; apiProvider: string }>> = {
  "claude-cli": { key: "modal.subscriptionCliWarning", cmd: "claude -p", apiProvider: "anthropic-apikey" },
  "agy-acp": { key: "modal.subscriptionCliWarningAgy", cmd: "agy acp", apiProvider: "google" },
};

export function isSubscriptionCliProvider(provider: { adapter?: string | null }): boolean {
  return Object.hasOwn(SUBSCRIPTION_CLI_WARNINGS, (provider.adapter ?? "").trim());
}

/** The add-provider warning for a subscription CLI row, or undefined for any other row. */
export function subscriptionCliWarning(provider: { adapter?: string | null }): { key: TKey; cmd: string; apiProvider: string } | undefined {
  const adapter = (provider.adapter ?? "").trim();
  return Object.hasOwn(SUBSCRIPTION_CLI_WARNINGS, adapter) ? SUBSCRIPTION_CLI_WARNINGS[adapter] : undefined;
}
