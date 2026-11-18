import type { TFn } from "../i18n/shared";
import { isAccountProvider, type WorkspaceItem } from "./catalog";
import { isLocalProvider } from "./kind";
import { isSubscriptionCliProvider } from "./subscription-cli";

export type ProviderAuthSurface = "codex-accounts" | "oauth-accounts" | "api-keys" | null;

export interface OAuthAccountIdentity {
  id: string;
  alias?: string;
  /** Server label that follows privacy.maskEmails: masked by default, the raw email when unmasked. */
  accountLabel?: string;
  /** Always-masked label; fallback for servers that do not send accountLabel. */
  maskedLabel?: string;
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
  // A subscription CLI row is keyless by adapter, with or without the registry's `keyOptional`:
  // it offers no key prompt, and only a key already saved on it keeps the surface for removal.
  const keyless = item.keyOptional === true || isSubscriptionCliProvider(item);
  if (!keyAuth || (keyless && !hasKeyMaterial)) return null;
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
  const label = account.accountLabel?.trim() || account.maskedLabel?.trim();
  if (label) return label;
  const index = accounts.findIndex(candidate => candidate.id === account.id);
  return t("pws.accountOrdinal", { count: String(index >= 0 ? index + 1 : 1) });
}
