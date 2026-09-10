import { getProviderRegistryEntry, providerMatchesRegistryTransport } from "./registry";
import type { OcxConfig } from "../types";

export const ZAI_PROVIDER_ID = "zai";
export const ZAI_RESPONSES_DEFAULT_VERSION = 1;

/**
 * Persist the Responses destination the router already applies to the `zai` row.
 *
 * The Z.AI coding plan moved from Chat Completions at /api/coding/paas/v4 to Responses at
 * /api/v1 (#4297). A config written before that move still stores the Chat adapter and the old
 * base URL, and `routedProviderConfig()` rewrites both on every request because the registry
 * entry owns a fixed destination. The row therefore already talks Responses while the dashboard,
 * `ocx doctor` and any direct config reader show the retired Chat endpoint, and each boot logs a
 * "configured baseUrl is ignored" warning about a value the user never chose.
 *
 * This migration writes the canonical pair once so the stored row matches the live wire. It is
 * behavior-preserving by construction: it only rewrites rows the router canonicalizes anyway.
 * Chat remains reachable per model through `modelAdapters`, and the persisted marker keeps a
 * later explicit Chat choice from being migrated again.
 *
 * A custom-named provider pointing at the retired endpoint is deliberately left alone. The router
 * does not canonicalize it, so rewriting it would change a wire the operator actually configured;
 * `destinationAliases` already gives it this row's metadata.
 */
export function migrateZaiResponsesDefault(config: OcxConfig): boolean {
  const provider = config.providers[ZAI_PROVIDER_ID];
  if (!provider || (provider.zaiResponsesDefaultVersion ?? 0) >= ZAI_RESPONSES_DEFAULT_VERSION) return false;
  const entry = getProviderRegistryEntry(ZAI_PROVIDER_ID);
  if (!entry) return false;
  // Fail closed if a later registry edit makes this destination operator-owned: only a fixed,
  // non-templated endpoint is canonicalized at request time, so only that one may be persisted.
  if (entry.allowBaseUrlOverride || /\{[^}]*\}/.test(entry.baseUrl)) return false;
  if (!providerMatchesRegistryTransport(ZAI_PROVIDER_ID, provider)) return false;
  config.providers = {
    ...config.providers,
    [ZAI_PROVIDER_ID]: {
      ...provider,
      adapter: entry.adapter,
      baseUrl: entry.baseUrl,
      zaiResponsesDefaultVersion: ZAI_RESPONSES_DEFAULT_VERSION,
    },
  };
  return true;
}
