import type { TFn } from "../i18n";
import { isAccountProvider, type WorkspaceItem } from "./catalog";
import { isLocalProvider } from "./kind";

export type ProviderAuthSurface = "codex-accounts" | "oauth-accounts" | "api-keys" | null;

export interface OAuthAccountIdentity {
  id: string;
  email?: string;
}

export function partitionAccountProviderRows<T extends { id: string; label: string }>(
  rows: readonly T[],
  status: Readonly<Record<string, { loggedIn?: boolean } | undefined>>,
  needsReauth: Readonly<Record<string, boolean | undefined>>,
  query = "",
): { connected: T[]; available: T[] } {
  const normalizedQuery = query.trim().toLowerCase();
  const connected = (row: T) => status[row.id]?.loggedIn === true || needsReauth[row.id] === true;
  return {
    connected: rows.filter(connected),
    available: rows.filter(row => !connected(row)
      && (!normalizedQuery || row.id.toLowerCase().includes(normalizedQuery) || row.label.toLowerCase().includes(normalizedQuery))),
  };
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
  const email = account.email?.trim();
  if (email) return email;
  const index = accounts.findIndex(candidate => candidate.id === account.id);
  return t("pws.accountOrdinal", { count: String(index >= 0 ? index + 1 : 1) });
}
