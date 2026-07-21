import { describe, expect, test } from "bun:test";
import {
  oauthAccountDisplayLabel,
  providerAuthSurface,
} from "../gui/src/provider-workspace/auth";
import type { WorkspaceItem } from "../gui/src/provider-workspace/catalog";
import type { TFn } from "../gui/src/i18n";

function provider(name: string, overrides: Partial<WorkspaceItem> = {}): WorkspaceItem {
  return {
    name,
    adapter: "openai-chat",
    baseUrl: "https://api.example.com/v1",
    hasApiKey: false,
    ...overrides,
  };
}

const t = ((key: string, vars?: Record<string, string | number>) => {
  if (key === "pws.accountOrdinal") return `Account ${vars?.count ?? "?"}`;
  return key;
}) as TFn;

describe("provider workspace auth surface", () => {
  test("only canonical OpenAI forward owns the Codex account pool", () => {
    const canonical = provider("openai", {
      adapter: "openai-responses",
      authMode: "forward",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
    expect(providerAuthSurface(canonical)).toBe("codex-accounts");
    expect(providerAuthSurface({ ...canonical, name: "custom-forward" })).toBeNull();
    expect(providerAuthSurface({ ...canonical, baseUrl: "https://proxy.example.com/codex" })).toBeNull();
  });

  test("OAuth, key, optional-key, and local providers get honest surfaces", () => {
    expect(providerAuthSurface(provider("anthropic", { authMode: "oauth" }))).toBe("oauth-accounts");
    expect(providerAuthSurface(provider("paid", { authMode: "key" }))).toBe("api-keys");
    expect(providerAuthSurface(provider("configured", { hasApiKey: true }))).toBe("api-keys");
    expect(providerAuthSurface(provider("free", { keyOptional: true }))).toBeNull();
    expect(providerAuthSurface(provider("ollama", { authMode: "local", baseUrl: "http://127.0.0.1:11434/v1" }))).toBeNull();
  });
});

describe("safe OAuth account labels", () => {
  const accounts = [
    { id: "opaque-first", email: "f***@example.com" },
    { id: "opaque-second" },
  ];

  test("uses an already-masked email when supplied", () => {
    expect(oauthAccountDisplayLabel(accounts, accounts[0]!, t)).toBe("f***@example.com");
  });

  test("uses a localized ordinal instead of an opaque id", () => {
    const label = oauthAccountDisplayLabel(accounts, accounts[1]!, t);
    expect(label).toBe("Account 2");
    expect(label).not.toContain("opaque-second");
  });

  test("unknown rows fail closed to the first generic ordinal", () => {
    expect(oauthAccountDisplayLabel(accounts, { id: "unlisted" }, t)).toBe("Account 1");
  });
});

describe("workspace account integration seam", () => {
  test("passes account state and handlers into provider details", async () => {
    const source = await Bun.file("gui/src/pages/Providers.tsx").text();
    expect(source).toContain("accountLoadState={accountLoadStates[item.name]");
    expect(source).toContain("switchingAccountId={switchingAccount?.provider === item.name");
    expect(source).toContain("onRetryAccounts: async provider => { await fetchAccountSets([provider]); }");
    expect(source).toContain("key={item.name}");
    expect(source).toContain("switchingAccountRef.current");
    expect(source).toContain("const refreshed = await fetchAccountSets([provider])");
    expect(source).toContain("if (!refreshed)");
  });

  test("owns an accessible dynamic account panel instead of nesting auth in Settings", async () => {
    const source = await Bun.file("gui/src/components/provider-workspace/ProviderDetails.tsx").text();
    expect(source).toContain('id: "accounts" as const');
    expect(source).toContain('role="tabpanel"');
    expect(source).toContain('aria-controls={`pws-panel-${candidate.id}`}');
    expect(source).toContain('tab === "accounts"');
    expect(source.lastIndexOf('tab === "accounts"')).toBeLessThan(source.lastIndexOf('tab === "settings" &&'));
  });

  test("does not fall back to opaque ids in workspace account feedback", async () => {
    const [page, panel, codexPool] = await Promise.all([
      Bun.file("gui/src/pages/Providers.tsx").text(),
      Bun.file("gui/src/components/provider-workspace/ProviderAuthPanel.tsx").text(),
      Bun.file("gui/src/components/CodexAccountPool.tsx").text(),
    ]);
    expect(page).not.toContain("account.email ?? account.id");
    expect(panel).not.toContain("account.email ?? account.id");
    expect(codexPool).not.toContain("?.email ?? id");
  });

  test("keeps logout and delete failure states honest", async () => {
    const [page, codexPool] = await Promise.all([
      Bun.file("gui/src/pages/Providers.tsx").text(),
      Bun.file("gui/src/components/CodexAccountPool.tsx").text(),
    ]);
    expect(page).toContain('notify(t("prov.logoutFail"');
    expect(page).toContain('notify(t("prov.accountRemoveFail"');
    expect(page).toContain("await fetchAccountSets([provider])");
    expect(codexPool).toContain('setToast(t("codexAuth.removeFailed"))');
  });

  test("gives canonical Codex accounts explicit native switch actions", async () => {
    const source = await Bun.file("gui/src/components/CodexAccountPool.tsx").text();
    expect(source).toContain("codex-account-switch");
    expect(source).not.toContain('onClick={() => !a.needsReauth && setConfirm(a)}');
    expect(source).not.toContain('onClick={() => !isMainActive ? setConfirm');
  });

  test("wires active reauth health into workspace rail status", async () => {
    const [shell, page] = await Promise.all([
      Bun.file("gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx").text(),
      Bun.file("gui/src/pages/Providers.tsx").text(),
    ]);
    expect(shell).toContain("applyActiveAccountReauth");
    expect(shell).toContain("activeAccountNeedsReauth");
    expect(page).toContain("activeAccountNeedsReauth");
    expect(page).toContain("activeAccountNeedsReauth={activeAccountNeedsReauth}");
  });

  test("wires OAuth re-authenticate handlers in classic and workspace", async () => {
    const [page, panel, details, overview] = await Promise.all([
      Bun.file("gui/src/pages/Providers.tsx").text(),
      Bun.file("gui/src/components/provider-workspace/ProviderAuthPanel.tsx").text(),
      Bun.file("gui/src/components/provider-workspace/ProviderDetails.tsx").text(),
      Bun.file("gui/src/components/provider-workspace/ProviderOverview.tsx").text(),
    ]);
    expect(page).toContain("onReauth:");
    expect(page).toContain("onCancelLogin: cancelLoginOAuth");
    expect(page).toContain("loginOAuth(provider, true, accountId)");
    expect(page).toContain("accountId: reauthTargetId, reauth: true");
    expect(page).toContain("prov.reauthIdentityMismatch");
    expect(page).toContain("loginOAuth(name, true, account.id)");
    expect(page).toContain("oauthLoginGenerationRef");
    expect(page).toContain("/api/oauth/login/cancel");
    // Classic provider-level CTA: OAuth uses loginOAuth; openai deep-links to Codex Auth.
    expect(page).toContain('activeAccountNeedsReauth[name] && prov.authMode === "oauth"');
    expect(page).toContain('activeAccountNeedsReauth[name] && name === "openai"');
    expect(page).toContain('href="#codex-auth"');
    expect(panel).toContain("onReauth");
    expect(panel).toContain("pws.reauthenticate");
    expect(panel).toContain("onCancelLogin");
    expect(details).toContain("onReauthenticate=");
    expect(details).toContain("authHandlers?.onReauth(item.name, active?.id)");
    expect(overview).toContain("onReauthenticate");
    expect(overview).toContain("pws.reauthenticate");
  });

  test("wires Codex active reauth health into openai rail status", async () => {
    const [page, pool, panel, modal] = await Promise.all([
      Bun.file("gui/src/pages/Providers.tsx").text(),
      Bun.file("gui/src/components/CodexAccountPool.tsx").text(),
      Bun.file("gui/src/components/provider-workspace/ProviderAuthPanel.tsx").text(),
      Bun.file("gui/src/components/AddCodexAccountModal.tsx").text(),
    ]);
    expect(page).toContain("codexActiveNeedsReauth");
    expect(page).toContain("map.openai = true");
    expect(page).toContain("onCodexActiveNeedsReauthChange={setCodexActiveNeedsReauth}");
    expect(page).toContain("codexReauthGenerationRef");
    expect(pool).toContain("onActiveNeedsReauthChange");
    expect(pool).toContain("if (showAdd)");
    expect(modal).toContain("reauth: true");
    expect(modal).toContain("startedReauthRef");
    expect(modal).toContain("&reauth=1");
    expect(pool).toContain("codexAuth.reauthenticate");
    expect(pool).toContain("codexAuth.mainTokenExpired");
    expect(panel).toContain("onActiveNeedsReauthChange={onCodexActiveNeedsReauthChange}");
  });

  test("keeps classic stale-account reauth and remove outside disabled row shell", async () => {
    const page = await Bun.file("gui/src/pages/Providers.tsx").text();
    expect(page).toContain('className="prov-account-row-main"');
    expect(page).toContain('className="prov-account-reauth"');
    expect(page).toContain("disabled={busy === name}");
    expect(page).toMatch(/<div[\s\S]*?className=\{`prov-account-row\$\{account\.active/);
  });

  test("keeps account provider discovery behind a connected-only picker", async () => {
    const page = await Bun.file("gui/src/pages/Providers.tsx").text();
    expect(page).toContain("const connectedAccountRows = addModalAccountRows.filter");
    expect(page).toContain("providerStatus?.loggedIn || activeAccountNeedsReauth[row.id]");
    expect(page).toContain("return !connected && (!query");
    expect(page).toContain("isAccountProvider(name, provider)");
    expect(page).toContain('className="prov-account-add-tile"');
    expect(page).toContain("visibleAccountRows.map");
    expect(page).toContain("dialog.showModal()");
    expect(page).toContain("if (event.target !== event.currentTarget || busy) return");
    expect(page).not.toContain("keyProviders");
  });

  test("splits OAuth and API providers with a key-only setup catalog", async () => {
    const [page, modal, catalog, styles] = await Promise.all([
      Bun.file("gui/src/pages/Providers.tsx").text(),
      Bun.file("gui/src/components/AddProviderModal.tsx").text(),
      Bun.file("gui/src/components/provider-catalog/ProviderCatalog.tsx").text(),
      Bun.file("gui/src/styles.css").text(),
    ]);
    expect(page).toContain('className="prov-auth-grid"');
    expect(page).toContain('t("prov.oauthProviders")');
    expect(page).toContain('t("prov.apiProviders")');
    expect(page).toContain("keyCardProviders.map");
    expect(page).toContain("setAddingApiProvider(true)");
    expect(page).toContain("apiKeyOnly={addingApiProvider}");
    expect(modal).toContain("excludedProviderIds={apiKeyOnly ? existingNames : []}");
    expect(catalog).toContain("supportsApiKeySetup(preset)");
    expect(catalog).toContain("!excluded.has(preset.id)");
    expect(styles).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
  });

  test("replaces the redundant add button with Codex restart and warns after provider creation", async () => {
    const [page, ui] = await Promise.all([
      Bun.file("gui/src/pages/Providers.tsx").text(),
      Bun.file("gui/src/ui.tsx").text(),
    ]);
    expect(page).toContain('fetch(`${apiBase}/api/codex/restart`, { method: "POST" })');
    expect(page).toContain("const restartCodexButton");
    expect(page).toContain('t("prov.restartCodexConfirm")');
    expect(page).toContain('notifyAfterModelSync(t("prov.addedRestartRequired", { name }), true)');
    expect(ui).toContain('tone: "ok" | "warn" | "err"');
  });

  test("reports automatic model-sync failures after provider connection", async () => {
    const page = await Bun.file("gui/src/pages/Providers.tsx").text();
    expect(page).toContain('return (await fetch(`${apiBase}/api/sync`, { method: "POST" })).ok');
    expect(page).toContain('t("prov.modelSyncFailed", { cmd: "ocx sync" })');
    expect(page).toContain("void notifyAfterModelSync");
  });
});
