import type { TFn } from "../i18n/shared";
import { isAccountProvider, type WorkspaceItem } from "./catalog";
import { isLocalProvider } from "./kind";

export type ProviderAuthSurface = "codex-accounts" | "oauth-accounts" | "api-keys" | null;

export interface OAuthAccountIdentity {
  id: string;
  alias?: string;
  email?: string;
}

/**
 * Resolves the one authentication surface a workspace provider actually owns.
 * In particular, a custom forward proxy must never inherit the global Codex
 * account pool merely because it also uses forward authentication.
 */
export function providerAuthSurface(item: WorkspaceItem): ProviderAuthSurface {
  if (isAccountProvider(item.name, item)) return "codex-accounts";

  const mode = (item.authMode ?? "").toLowerCase();
  if (mode === "forward" || mode === "local" || isLocalProvider(item)) return null;
  if (mode === "oauth") return "oauth-accounts";

  const hasKeyMaterial = item.hasApiKey === true;
  const keyAuth = mode === "key" || hasKeyMaterial || mode === "";
  if (!keyAuth || (item.keyOptional === true && !hasKeyMaterial)) return null;
  return "api-keys";
}

/** Human-safe label for OAuth account rows; opaque storage ids stay private. */
export function oauthAccountDisplayLabel<T extends OAuthAccountIdentity>(
  accounts: readonly T[],
  account: OAuthAccountIdentity,
  t: TFn,
): string {
  const alias = account.alias?.trim();
  if (alias) return alias;
  const email = account.email?.trim();
  if (email) return email;
  const index = accounts.findIndex(candidate => candidate.id === account.id);
  return t("pws.accountOrdinal", { count: String(index >= 0 ? index + 1 : 1) });
}

/**
 * Secondary identity line for OAuth rows.
 * When the email is already the primary label, repeating it here only adds visual noise.
 * If an alias owns the primary slot, keep the email as useful disambiguation.
 */
export function oauthAccountSecondaryIdentity(
  account: OAuthAccountIdentity,
  maskedId: string,
  t: TFn,
): string {
  const alias = account.alias?.trim();
  const email = account.email?.trim();
  return [
    alias && email ? email : undefined,
    `${t("prov.accountId")}: ${maskedId}`,
  ].filter(Boolean).join(" · ");
}
