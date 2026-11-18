import CatalogAccountRow from "../src/components/provider-catalog/CatalogAccountRow";
import { buildAccountLoginStatus, buildAddModalAccountRows } from "../src/pages/providers-page-utils";
import type { ProvidersConfig } from "../src/pages/providers-shared";
import { en } from "../src/i18n/en";
import type { TFn } from "../src/i18n/shared";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageProvider } from "../src/i18n/provider";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
import ProviderCurrentQuota from "../src/components/provider-workspace/ProviderCurrentQuota";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import type { OAuthAccountRow, AccountQuotaReading, ProviderAuthHandlers } from "../src/components/provider-workspace/types";

const handlers = { onLogin() {}, onLogout() {}, onSwitchAccount() {}, onReauth() {}, onRemoveAccount() {}, onEditAlias() {} } as unknown as ProviderAuthHandlers;

for (const provider of ["anthropic", "anthropic2"]) {
  for (const [plan, label] of [["pro", "Pro"], ["max_5x", "Max 5x"], ["claude_max_20x", "Ultra"], ["ultra", "Ultra"], ["claude_future_42x", "claude_future_42x"]]) {
    test(`${provider} account shows ${label} and keeps identity out of rendered text`, () => {
      const item = { name: provider, adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth",
        ...(provider === "anthropic2" ? { anthropicOAuthInstance: "anthropic2" } : {}) } as WorkspaceItem;
      const accounts: OAuthAccountRow[] = [{ id: "synthetic-private-account", email: "private@example.test", active: true,
        plan, quotaMode: "probe", quota: { ...(plan === "pro" || plan === "max_5x" ? { fiveHourPercent: 18 } : {}), weeklyPercent: 37, updatedAt: Date.now() } }];
      const markup = renderToStaticMarkup(<LanguageProvider><ProviderAuthPanel item={item} apiBase="" authHandlers={handlers} accounts={accounts} oauth={{ loggedIn: true }} /></LanguageProvider>);
      expect(markup).toContain(`>${label}</span>`);
      expect(markup).not.toContain("private@example.test");
      expect(markup).not.toContain("synthetic-private-account");
      expect(markup).toContain("37% used");
      if (plan === "pro" || plan === "max_5x") {
        expect(markup).toContain("5-hour limit");
        expect(markup).toContain("18% used");
      } else expect(markup).not.toContain("5-hour limit");
    });
  }
}

test("current quota shows subscription even when the usage read is unavailable", () => {
  const reading = { planLabel: "Ultra", quotaMode: "probe", quotaUnavailable: true, quotaFailure: "rate_limited" } as AccountQuotaReading;
  const markup = renderToStaticMarkup(<LanguageProvider><ProviderCurrentQuota reading={reading} /></LanguageProvider>);
  expect(markup).toContain(">Ultra</span>");
  expect(markup).toContain("data-quota-state=\"unavailable\"");
});

for (const [provider, adapter, marked, privateIdentity] of [
  ["anthropic", "anthropic", false, true], ["anthropic2", "anthropic", true, true],
  ["anthropic2", "openai-chat", false, false], ["cursor", "cursor", false, false],
] as const) {
  test(`catalog account status keeps ${provider}/${adapter} identity policy`, () => {
    const config = { port: 0, defaultProvider: provider, providers: { [provider]: {
      adapter, baseUrl: "https://example.test", authMode: "oauth", ...(marked ? { anthropicOAuthInstance: "anthropic2" } : {}),
    } } } as ProvidersConfig;
    const source = { [provider]: { loggedIn: true, email: "catalog-private@example.test" } };
    const status = buildAccountLoginStatus(config, source);
    const t = ((key: keyof typeof en) => en[key]) as TFn;
    const row = buildAddModalAccountRows(config, [provider], t)[0]!;
    const markup = renderToStaticMarkup(<LanguageProvider><CatalogAccountRow row={row} status={status[provider]} busyProvider={null} loginHint={null} /></LanguageProvider>);
    expect(markup.includes("catalog-private@example.test")).toBe(!privateIdentity);
    expect(source[provider]!.email).toBe("catalog-private@example.test");
    if (privateIdentity) expect(markup).toContain(en["modal.accountLoggedIn"]);
  });
}
