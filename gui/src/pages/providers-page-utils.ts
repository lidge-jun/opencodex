import type { AccountLoginRow, AccountLoginStatus } from "../components/provider-catalog/ProviderCatalog";
import type { TFn } from "../i18n/shared";
import type { TKey } from "../i18n/en";
import { formatProviderDisplayName } from "../provider-icons";
import { codexAccountProviderNames } from "../provider-payload";
import type { OAuthStatus, ProvidersConfig } from "./providers-shared";
import { oauthLabel } from "./providers-shared";

/**
 * Logged-out sub-text for OAuth rows whose provider id alone does not say what the account is.
 * The Gemini rows are two OAuth subtypes of one Google account, so the row needs to say which
 * one it authorizes; a live status (email or error) always wins over this hint.
 */
const OAUTH_ROW_HINT_KEYS: Record<string, TKey> = {
  "gemini-cli": "modal.accountGeminiCodeAssist",
  "gemini-ai-studio": "modal.accountGeminiAiStudio",
};

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
        href: "#codex-set",
      })),
    ...oauthProviders
      .toSorted((a, b) => a.localeCompare(b))
      .map(id => {
        const hintKey = OAUTH_ROW_HINT_KEYS[id];
        return {
          id,
          label: oauthLabel(id),
          kind: "oauth" as const,
          ...(hintKey ? { statusLabel: t(hintKey) } : {}),
        };
      }),
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
