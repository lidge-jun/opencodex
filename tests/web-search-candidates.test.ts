import { afterEach, describe, expect, mock, test } from "bun:test";
import * as storeModule from "../src/oauth/store";
import * as usabilityModule from "../src/codex/account-usability";
import * as modelRowsModule from "../src/server/management/model-rows";

let accountSets: Record<string, { accounts: Array<{ id: string; needsReauth?: boolean }>; activeAccountId?: string }> = {};
let usableCodexAccounts: Set<string> = new Set();
let managementRows: Array<Record<string, unknown>> = [];

mock.module("../src/oauth/store", () => ({
  ...storeModule,
  getAccountSet: (provider: string) => accountSets[provider] ?? null,
}));
mock.module("../src/codex/account-usability", () => ({
  ...usabilityModule,
  isCodexAccountUsable: (_config: unknown, accountId: string) => usableCodexAccounts.has(accountId),
}));
mock.module("../src/server/management/model-rows", () => ({
  ...modelRowsModule,
  listManagementModelRows: async () => managementRows,
}));

import { isWebSearchAuthSlotModel, webSearchSidecarCandidates } from "../src/web-search/backends";
import { pickerVisibleSidecarCandidates } from "../src/sidecar/candidates";
import { resolveSidecarAuth } from "../src/sidecar/auth";
import { resolveSidecarBackend } from "../src/web-search";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/account-id";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const forward: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" };
const anthropicOAuth: OcxProviderConfig = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" };

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return { port: 10100, defaultProvider: "openai", providers: { openai: forward, claude: anthropicOAuth }, ...overrides };
}

afterEach(() => {
  accountSets = {};
  usableCodexAccounts = new Set();
  managementRows = [];
});

async function candidatesFor(cfg: OcxConfig) {
  const auth = resolveSidecarAuth(cfg);
  const all = await pickerVisibleSidecarCandidates(cfg, auth);
  return webSearchSidecarCandidates(cfg, auth, all);
}

describe("webSearchSidecarCandidates = (picker ∪ slots) ∩ active backend", () => {
  test("no Codex login: openai side inactive — native rows and Luna absent, Haiku present", async () => {
    accountSets = { claude: { accounts: [{ id: "a1" }], activeAccountId: "a1" } };
    managementRows = [
      { provider: "openai", id: "gpt-5.6-terra", disabled: false, native: true },
      { provider: "claude", id: "claude-sonnet-5", disabled: false },
    ];
    const ids = (await candidatesFor(config())).map(c => c.id).sort();
    expect(ids).toEqual(["claude-haiku-4-5", "claude-sonnet-5"]);
  });

  test("hidden Luna + Codex login: present via the slot", async () => {
    usableCodexAccounts.add(MAIN_CODEX_ACCOUNT_ID);
    managementRows = [{ provider: "openai", id: "gpt-5.6-terra", disabled: false, native: true }];
    const cfg = config({ disabledModels: ["gpt-5.6-luna"] });
    const ids = (await candidatesFor(cfg)).map(c => c.id).sort();
    expect(ids).toEqual(["gpt-5.6-luna", "gpt-5.6-terra"]);
  });

  test("rows outside both backend families are excluded even when picker-visible", async () => {
    usableCodexAccounts.add(MAIN_CODEX_ACCOUNT_ID);
    accountSets = { claude: { accounts: [{ id: "a1" }], activeAccountId: "a1" } };
    managementRows = [
      { provider: "routed", id: "grok-4.6", disabled: false },
      { provider: "openai", id: "gpt-5.6-terra", disabled: false, native: true },
    ];
    const ids = (await candidatesFor(config())).map(c => c.id).sort();
    expect(ids).toEqual(["claude-haiku-4-5", "gpt-5.6-luna", "gpt-5.6-terra"]);
  });

  test("keyed same-adapter anthropic provider rows stay unreachable", async () => {
    accountSets = { claude: { accounts: [{ id: "a1" }], activeAccountId: "a1" } };
    const keyedClaude: OcxProviderConfig = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "key", apiKey: "k" };
    managementRows = [{ provider: "keyed-claude", id: "claude-sonnet-5", disabled: false }];
    const cfg = config({ providers: { openai: forward, claude: anthropicOAuth, "keyed-claude": keyedClaude } });
    const ids = (await candidatesFor(cfg)).map(c => c.id).sort();
    expect(ids).toEqual(["claude-haiku-4-5"]);
  });

  test("no logins at all -> empty candidate set", async () => {
    managementRows = [{ provider: "openai", id: "gpt-5.6-terra", disabled: false, native: true }];
    expect(await candidatesFor(config())).toEqual([]);
  });

  test("account-bound selector/slug native rows are excluded (executor cannot run them)", async () => {
    usableCodexAccounts.add(MAIN_CODEX_ACCOUNT_ID);
    managementRows = [
      { provider: "openai", id: "work/gpt-future-unlisted", disabled: false, native: true },
      { provider: "openai", id: "gpt-5.6-terra", disabled: false, native: true },
    ];
    const ids = (await candidatesFor(config())).map(c => c.id).sort();
    expect(ids).toEqual(["gpt-5.6-luna", "gpt-5.6-terra"]);
  });

  test("custom openai-keyed rows without the native flag are excluded", async () => {
    usableCodexAccounts.add(MAIN_CODEX_ACCOUNT_ID);
    managementRows = [
      { provider: "openai", id: "my-custom-gpt", disabled: false },
      { provider: "openai", id: "gpt-5.6-terra", disabled: false, native: true },
    ];
    const ids = (await candidatesFor(config())).map(c => c.id).sort();
    expect(ids).toEqual(["gpt-5.6-luna", "gpt-5.6-terra"]);
  });
});

describe("existing contracts stay pinned", () => {
  test("resolveSidecarBackend(undefined) is still openai (B4: no default change)", () => {
    expect(resolveSidecarBackend(undefined)).toBe("openai");
  });

  test("auth-slot membership helper knows exactly the two slot models", () => {
    expect(isWebSearchAuthSlotModel("gpt-5.6-luna")).toBe(true);
    expect(isWebSearchAuthSlotModel("claude-haiku-4-5")).toBe(true);
    expect(isWebSearchAuthSlotModel("gpt-5.6-terra")).toBe(false);
  });
});
