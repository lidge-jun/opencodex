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
    expect(source).toContain("onRetryAccounts: provider => fetchAccountSets([provider])");
    expect(source).toContain("key={item.name}");
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
});
