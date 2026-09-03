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

  test("prefers a user alias without exposing the opaque account id", () => {
    const account = { id: "opaque-123", alias: "Work", email: "w***@example.com" };
    expect(oauthAccountDisplayLabel([account], account, t)).toBe("Work");
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

async function providersPageSeam(): Promise<string> {
  const [page, oauth, utils, modals, pools] = await Promise.all([
    Bun.file("gui/src/pages/Providers.tsx").text(),
    Bun.file("gui/src/pages/use-providers-oauth.ts").text(),
    Bun.file("gui/src/pages/providers-page-utils.ts").text(),
    Bun.file("gui/src/pages/providers-page-modals.tsx").text(),
    Bun.file("gui/src/hooks/useProviderAccountPools.ts").text(),
  ]);
  return page + oauth + utils + modals + pools;
}

describe("workspace account integration seam", () => {
  test("passes account state and handlers into provider details", async () => {
    const source = await providersPageSeam();
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
      providersPageSeam(),
      Bun.file("gui/src/components/provider-workspace/ProviderAuthPanel.tsx").text(),
      Bun.file("gui/src/components/CodexAccountPool.tsx").text(),
    ]);
    expect(page).not.toContain("account.email ?? account.id");
    expect(panel).not.toContain("account.email ?? account.id");
    expect(codexPool).not.toContain("?.email ?? id");
  });

  test("keeps logout and delete failure states honest", async () => {
    const [page, codexPool, hook] = await Promise.all([
      providersPageSeam(),
      Bun.file("gui/src/components/CodexAccountPool.tsx").text(),
      Bun.file("gui/src/hooks/useCodexAccountPool.ts").text(),
    ]);
    expect(page).toContain('notify(t("prov.logoutFail"');
    expect(page).toContain('notify(t("prov.accountRemoveFail"');
    expect(page).toContain("await fetchAccountSets([provider])");
    // The failure path must surface codexAuth.removeFailed and mark it as an error tone.
    expect(codexPool).toContain('showActionFeedback(t("codexAuth.removeFailed"), "err")');
    expect(hook).toContain("pauseTokensRef");
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
      providersPageSeam(),
    ]);
    expect(shell).toContain("applyActiveAccountReauth");
    expect(shell).toContain("activeAccountNeedsReauth");
    expect(page).toContain("activeAccountNeedsReauth");
    expect(page).toContain("activeAccountNeedsReauth={activeAccountNeedsReauth}");
  });

  test("wires OAuth re-authenticate handlers into the workspace detail", async () => {
    const [page, panel, details, overview, loginHint] = await Promise.all([
      providersPageSeam(),
      Bun.file("gui/src/components/provider-workspace/ProviderAuthPanel.tsx").text(),
      Bun.file("gui/src/components/provider-workspace/ProviderDetails.tsx").text(),
      Bun.file("gui/src/components/provider-workspace/ProviderOverview.tsx").text(),
      Bun.file("gui/src/components/login-url-block.tsx").text(),
    ]);
    expect(page).toContain("onReauth:");
    expect(page).toContain("onCancelLogin: cancelLoginOAuth");
    // Reauth reaches login through the ToS-warning gate rather than calling loginOAuth
    // directly: a high-risk provider (anthropic, google-antigravity, meta-muse) must show
    // its warning before a REauthentication too, not only before the first login.
    // `requestLoginOAuth` is the warning-aware entry point and forwards the same
    // (provider, addAccount, accountId) triple.
    expect(page).toContain("requestLoginOAuth(provider, true, accountId)");
    expect(page).toContain("void loginOAuth(pending.provider, pending.addAccount, pending.accountId)");
    expect(page).toContain("accountId: reauthTargetId, reauth: true");
    expect(page).toContain("prov.reauthIdentityMismatch");
    expect(page).toContain("oauthLoginGenerationRef");
    expect(page).toContain("/api/oauth/login/cancel");
    expect(page).toContain("deviceCode");
    // The device-code widget is now owned by the shared login-hint component so
    // every login surface renders the same one. The panel's obligation is to
    // pass the code through; the widget itself lives with the component.
    expect(panel).toContain("deviceCode: hintForThis.deviceCode");
    expect(loginHint).toContain("pwi-device-code");
    // The workspace can accept a pasted redirect URL — previously only the
    // add-provider modal could, which stranded remote/SSH re-authentication.
    expect(panel).toContain("/api/oauth/login/code");
    // Add Provider account row CTA: OAuth uses loginOAuth; openai deep-links to Codex Auth.
    // The page is now Codex Set; `#codex-auth` still resolves through the legacy
    // redirect, but the CTA links to the live route rather than the old one.
    expect(page).toContain('href: "#codex-set"');
    expect(panel).toContain("onReauth");
    expect(panel).toContain("pws.reauthenticate");
    expect(panel).toContain("onCancelLogin");
    expect(details).toContain("onReauthenticate=");
    expect(details).toContain("authHandlers?.onReauth(item.name, active?.id)");
    expect(overview).toContain("onReauthenticate");
    expect(overview).toContain("pws.reauthenticate");
    // OAuth providers without an email (Cursor/Kimi) still read as logged in.
    expect(overview).toContain("oauth?.loggedIn");
    expect(overview).toContain('t("pws.loggedInTitle")');
  });

  test("wires Codex active reauth health into openai rail status", async () => {
    const [page, pool, panel, modal, hook, oauthHook, cards, mainCard] = await Promise.all([
      providersPageSeam(),
      Bun.file("gui/src/components/CodexAccountPool.tsx").text(),
      Bun.file("gui/src/components/provider-workspace/ProviderAuthPanel.tsx").text(),
      Bun.file("gui/src/components/AddCodexAccountModal.tsx").text(),
      Bun.file("gui/src/hooks/useCodexAccountPool.ts").text(),
      Bun.file("gui/src/components/use-add-codex-account-oauth.ts").text(),
      Bun.file("gui/src/components/codex-account-pool-cards.tsx").text(),
      Bun.file("gui/src/components/codex-account-pool-main-card.tsx").text(),
    ]);
    expect(page).toContain("codexActiveNeedsReauth");
    expect(page).toContain("buildActiveAccountNeedsReauthMap");
    expect(page).toContain("map.openai = true");

    // WP3: reauth health is DERIVED from the shared controller. The page used to keep a
    // second state copy refreshed by its own 30s timer, which meant two background
    // owners read the same endpoints and pauseRefresh() could not stop one of them.
    expect(page).toContain("const codexActiveNeedsReauth = codexPool.activeNeedsReauth;");
    expect(page).not.toContain("fetchCodexActiveReauth");
    expect(page).not.toContain("codexReauthGenerationRef");
    expect(page).not.toContain("setCodexActiveNeedsReauth");

    // Health-only reauth_required must reach both aggregate surfaces.
    expect(pool).toContain("onActiveNeedsReauthChange?.(activePoolNeedsReauth)");
    expect(hook).toContain("accountNeedsReauth(activeAccount)");
    expect(hook).toContain("!activeAccount?.paused &&");
    expect(hook).toContain("activePoolAccount ?? mainAccount");
    expect(page).toContain("accountNeedsReauth(active)");
    // WP3: background refresh pauses through a token lease, not a boolean read of the
    // modal flag. Two holders must both release before polling resumes.
    expect(pool).toContain("controller.pauseRefresh()");
    expect(pool).toContain("controller.resumeRefresh(token)");
    expect(pool).not.toContain("if (showAdd) {");
    expect(hook).toContain("pauseTokensRef");
    expect(hook).toContain("if (!enabled || pauseCount > 0) return;");
    // The initial load must not be re-triggered by pause transitions.
    // `apiBase` joined the dep list when the initial-load guard became per-base
    // (cafdc4986): the effect reads it, so omitting it would be the stale-closure bug
    // this assertion is meant to protect against. What still matters is the absence of
    // `pauseCount` — that is what would re-fire the initial load on every pause.
    expect(hook).toContain("}, [apiBase, enabled, load]);");
    // Reauth OAuth payload lives in the extracted OAuth hook (modal only wires props).
    expect(oauthHook).toContain("reauth: true");
    expect(oauthHook).toContain("startedReauthRef");
    expect(oauthHook).toContain("&reauth=1");
    expect(modal).toContain("reauthAccountId");
    expect(cards).toContain("codexAuth.reauthenticate");
    expect(mainCard).toContain("codexAuth.mainTokenExpired");
    // The panel now shares the controller instead of reporting health upward.
    expect(panel).toContain("controller={codexController}");
  });

  test("keeps the doctor-copy affordance off the Providers account surfaces", async () => {
    const [panel, pool] = await Promise.all([
      Bun.file("gui/src/components/provider-workspace/ProviderAuthPanel.tsx").text(),
      Bun.file("gui/src/components/CodexAccountPool.tsx").text(),
    ]);
    expect(panel).not.toContain("copyDoctor");
    expect(pool).toContain("const showDoctorCopy = !embedded;");
    expect(pool).toContain("onCopyDoctor={showDoctorCopy ? copyDoctor : undefined}");
  });
});
