import type { OcxConfig } from "../../types";
import { oauthCredentialSlot } from "../../oauth/credential-siblings";
import { replaceProviderAccountSet } from "../../oauth/store";

/**
 * Release the OAuth login a removed provider row used, unless another remaining OAuth row
 * still signs in through the same login. `config` must already be without the removed row.
 *
 * Kimi and Kimi (Responses) share one login (src/oauth/credential-siblings.ts): removing one of
 * the two rows keeps the login the other still uses, and removing the last one releases it, so
 * neither row is left on a credential it no longer owns.
 */
export async function releaseRemovedProviderCredentials(
  config: OcxConfig,
  name: string,
  replace: typeof replaceProviderAccountSet = replaceProviderAccountSet,
): Promise<"released" | "retained"> {
  const slot = oauthCredentialSlot(name);
  const stillUsed = Object.entries(config.providers).some(([row, provider]) =>
    row !== name && provider.authMode === "oauth" && oauthCredentialSlot(row) === slot);
  if (stillUsed) return "retained";
  await replace(name, null);
  return "released";
}
