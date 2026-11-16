import type { OcxConfig, OcxProviderConfig } from "../../types";
import { oauthCredentialSlot } from "../../oauth/credential-siblings";
import { releaseProviderAccountSetUnlessRetained } from "../../oauth/store";
import { getProviderRegistryEntry } from "../../providers/registry";
import { providerUsesKeyAuthOverride } from "../../providers/key-store";
import { readConfigFileSnapshot } from "../../config/diagnostics";

/**
 * Whether a configured row signs in through its OAuth login, decided the way routing decides it
 * (src/providers/routed-config.ts): a registry OAuth entry is OAuth whatever `authMode` says
 * (including omitted), unless the entry allows a key override and the row selects it.
 */
export function rowUsesOAuthLogin(row: string, provider: OcxProviderConfig): boolean {
  const entry = getProviderRegistryEntry(row);
  if (entry?.authKind === "oauth") return !providerUsesKeyAuthOverride(entry, provider);
  return provider.authMode === "oauth";
}

/**
 * Release the OAuth login a removed provider row used, unless another remaining OAuth row
 * still signs in through the same login. `config` must already be without the removed row.
 *
 * Kimi and Kimi (Responses) share one login (src/oauth/credential-siblings.ts): removing one of
 * the two rows keeps the login the other still uses, and removing the last one releases it, so
 * neither row is left on a credential it no longer owns. The "still used" check runs inside the
 * serialized store write and reads both the live `config` and the persisted config.json, so a
 * row published while the release waited (by this process or another, including a re-created row
 * of the removed name) keeps the login instead of losing it.
 */
export async function releaseRemovedProviderCredentials(
  config: OcxConfig,
  name: string,
  release: typeof releaseProviderAccountSetUnlessRetained = releaseProviderAccountSetUnlessRetained,
): Promise<"released" | "retained"> {
  const slot = oauthCredentialSlot(name);
  // `config` no longer holds the removed row, so any row named `name` here was re-created.
  const usesSlot = (providers: OcxConfig["providers"]): boolean => Object.entries(providers).some(([row, provider]) =>
    oauthCredentialSlot(row) === slot && rowUsesOAuthLogin(row, provider));
  return release(name, () => {
    if (usesSlot(config.providers)) return true;
    const persisted = readConfigFileSnapshot({ passive: true }).diagnostics;
    return persisted.source === "file" && usesSlot(persisted.config.providers);
  });
}
