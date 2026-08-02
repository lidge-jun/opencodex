import type { AccountLoginRow, AccountLoginStatus } from "../components/provider-catalog/ProviderCatalog";
import type { TFn } from "../i18n/shared";
import { formatProviderDisplayName } from "../provider-icons";
import { codexAccountProviderNames } from "../provider-payload";
import type { OAuthStatus, ProvidersConfig } from "./providers-shared";
import { oauthLabel } from "./providers-shared";

export function buildAddModalAccountRows(
  config: ProvidersConfig,
  oauthProviders: string[],
  t: TFn,
): AccountLoginRow[] {
  return [
    ...codexAccountProviderNames(config.providers)
      .map(name => ({
        id: name,
        label: formatProviderDisplayName(name, t),
        kind: "codex" as const,
        href: "#codex-auth",
      })),
    ...oauthProviders
      .toSorted((a, b) => a.localeCompare(b))
      .map(id => ({ id, label: oauthLabel(id), kind: "oauth" as const })),
  ];
}

export function buildAccountLoginStatus(
  config: ProvidersConfig,
  oauthStatus: Record<string, OAuthStatus>,
): Record<string, AccountLoginStatus> {
  const accountLoginStatus: Record<string, OAuthStatus> = { ...oauthStatus };
  const codexStatus = oauthStatus.openai;
  if (codexStatus) {
    for (const [name, prov] of Object.entries(config.providers)) {
      if (prov.authMode === "forward") accountLoginStatus[name] = codexStatus;
    }
  }
  return accountLoginStatus;
}
