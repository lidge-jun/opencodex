import { afterEach, describe, expect, mock, test } from "bun:test";
import * as storeModule from "../src/oauth/store";
import * as usabilityModule from "../src/codex/account-usability";

// The shared auth module reads two stores: the OAuth account store (Anthropic
// side) and the Codex account credential state (ChatGPT side). Both are mocked
// at module level so no test touches disk.
let accountSets: Record<string, { accounts: Array<{ id: string; needsReauth?: boolean }>; activeAccountId?: string }> = {};
let usableCodexAccounts: Set<string> = new Set();

mock.module("../src/oauth/store", () => ({
  ...storeModule,
  getAccountSet: (provider: string) => accountSets[provider] ?? null,
}));
mock.module("../src/codex/account-usability", () => ({
  ...usabilityModule,
  isCodexAccountUsable: (_config: unknown, accountId: string) => usableCodexAccounts.has(accountId),
}));

import { AUTH_SLOT_MODELS, resolveSidecarAuth, sidecarAuthSlots } from "../src/sidecar/auth";
import { findAnthropicSidecarProvider } from "../src/web-search";
import { findAnthropicVisionProvider } from "../src/vision";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/account-id";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const forward: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" };
const anthropicOAuth: OcxProviderConfig = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" };

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return { port: 10100, defaultProvider: "openai", providers: { openai: forward }, ...overrides };
}

afterEach(() => {
  accountSets = {};
  usableCodexAccounts = new Set();
});

describe("isCodexAuth is login-shaped, not provider-shaped", () => {
  test("forward provider present but no live token and no pool account -> false (B1 pin)", () => {
    expect(resolveSidecarAuth(config()).isCodexAuth).toBe(false);
  });

  test("live main token -> true", () => {
    usableCodexAccounts.add(MAIN_CODEX_ACCOUNT_ID);
    expect(resolveSidecarAuth(config()).isCodexAuth).toBe(true);
  });

  test("usable selectable pool credential alone -> true", () => {
    usableCodexAccounts.add("acct-1");
    const cfg = config({ codexAccounts: [{ id: "acct-1", label: "one" } as never] });
    expect(resolveSidecarAuth(cfg).isCodexAuth).toBe(true);
  });

  test("credential without a canonical forward provider -> false", () => {
    usableCodexAccounts.add(MAIN_CODEX_ACCOUNT_ID);
    const keyed: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://other.test/v1", authMode: "key", apiKey: "k" };
    const cfg = config({ providers: { openai: keyed } });
    expect(resolveSidecarAuth(cfg).isCodexAuth).toBe(false);
  });
});

describe("isAnthropicAuth mirrors the stored-OAuth predicate", () => {
  const active = { accounts: [{ id: "a1" }], activeAccountId: "a1" };

  test("enabled anthropic OAuth provider with healthy active account -> true, provider named", () => {
    accountSets = { claude: active };
    const auth = resolveSidecarAuth(config({ providers: { openai: forward, claude: anthropicOAuth } }));
    expect(auth.isAnthropicAuth).toBe(true);
    expect(auth.anthropicProviderName).toBe("claude");
  });

  test.each([
    ["disabled provider", { ...anthropicOAuth, disabled: true }, active],
    ["wrong adapter", { ...anthropicOAuth, adapter: "openai-chat" } as OcxProviderConfig, active],
    ["key auth", { ...anthropicOAuth, authMode: "key", apiKey: "k" } as OcxProviderConfig, active],
    ["active account needs reauth", anthropicOAuth, { accounts: [{ id: "a1", needsReauth: true }], activeAccountId: "a1" }],
    ["no account set", anthropicOAuth, undefined],
  ])("%s -> false", (_name, provider, set) => {
    accountSets = set ? { claude: set } : {};
    const auth = resolveSidecarAuth(config({ providers: { openai: forward, claude: provider } }));
    expect(auth.isAnthropicAuth).toBe(false);
  });
});

describe("auth slots survive picker hiding (#2188 core invariant)", () => {
  test("hidden/disabled Luna and Haiku still emitted when both logins present", () => {
    usableCodexAccounts.add(MAIN_CODEX_ACCOUNT_ID);
    accountSets = { claude: { accounts: [{ id: "a1" }], activeAccountId: "a1" } };
    const cfg = config({
      providers: { openai: forward, claude: anthropicOAuth },
      // Both slot models hidden from the picker: slots must not care.
      disabledModels: [AUTH_SLOT_MODELS.codex, AUTH_SLOT_MODELS.anthropic],
    });
    const slots = sidecarAuthSlots(resolveSidecarAuth(cfg));
    expect(slots).toEqual([
      { provider: "openai", id: "gpt-5.6-luna", slot: "codex" },
      { provider: "claude", id: "claude-haiku-4-5", slot: "anthropic" },
    ]);
  });

  test("no logins -> no slots", () => {
    expect(sidecarAuthSlots(resolveSidecarAuth(config()))).toEqual([]);
  });
});

describe("find* helpers delegate to the shared predicate", () => {
  test("web-search and vision return the same provider the shared module resolved", () => {
    accountSets = { claude: { accounts: [{ id: "a1" }], activeAccountId: "a1" } };
    const cfg = config({ providers: { openai: forward, claude: anthropicOAuth } });
    const auth = resolveSidecarAuth(cfg);
    const ws = findAnthropicSidecarProvider(cfg);
    const vision = findAnthropicVisionProvider(cfg);
    expect(ws?.providerName).toBe(auth.anthropicProviderName);
    expect(vision?.providerName).toBe(auth.anthropicProviderName);
    expect(ws?.provider).toBe(vision?.provider);
  });

  test("all three agree on absence", () => {
    const cfg = config();
    expect(resolveSidecarAuth(cfg).isAnthropicAuth).toBe(false);
    expect(findAnthropicSidecarProvider(cfg)).toBeUndefined();
    expect(findAnthropicVisionProvider(cfg)).toBeUndefined();
  });
});
