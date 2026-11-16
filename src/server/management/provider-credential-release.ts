import type { OcxConfig, OcxProviderConfig } from "../../types";
import { oauthCredentialSlot } from "../../oauth/credential-siblings";
import { releaseProviderAccountSetUnlessRetained } from "../../oauth/store";
import { getProviderRegistryEntry } from "../../providers/registry";
import { providerUsesKeyAuthOverride } from "../../providers/key-store";

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
 * neither row is left on a credential it no longer owns. The "still used" check reads `config`
 * inside the serialized store write, so a sibling row published while the release waited keeps
 * the login instead of losing it.
 */
export async function releaseRemovedProviderCredentials(
  config: OcxConfig,
  name: string,
  release: typeof releaseProviderAccountSetUnlessRetained = releaseProviderAccountSetUnlessRetained,
): Promise<"released" | "retained"> {
  const slot = oauthCredentialSlot(name);
  return release(name, () => Object.entries(config.providers).some(([row, provider]) =>
    row !== name && oauthCredentialSlot(row) === slot && rowUsesOAuthLogin(row, provider)));
}
