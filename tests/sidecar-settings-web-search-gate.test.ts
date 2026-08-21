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

import {
  webSearchCandidateRows,
  webSearchModelIsRejected,
  webSearchModelOptionsFrom,
  webSearchModelRejection,
} from "../src/server/management/web-search-sidecar-options";
import { handleManagementAPI } from "../src/server/management-api";
import { ManagementRequest as Request } from "./helpers/management-auth";
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

describe("web-search membership gate", () => {
  test("non-candidate id rejected with the filter named and allowed list attached", async () => {
    usableCodexAccounts.add(MAIN_CODEX_ACCOUNT_ID);
    managementRows = [{ provider: "openai", id: "gpt-5.6-terra", disabled: false, native: true }];
    const candidates = await webSearchCandidateRows(config());
    expect(webSearchModelIsRejected("openai", "o3-mini", candidates)).toBe(true);
    const rejection = webSearchModelRejection("webSearch.model", "openai", "o3-mini", candidates);
    expect(rejection.error).toContain("web-search sidecar candidate");
    expect(rejection.allowedModels).toContain("gpt-5.6-terra");
  });

  test("runnable candidate accepted", async () => {
    usableCodexAccounts.add(MAIN_CODEX_ACCOUNT_ID);
    managementRows = [{ provider: "openai", id: "gpt-5.6-terra", disabled: false, native: true }];
    const candidates = await webSearchCandidateRows(config());
    expect(webSearchModelIsRejected("openai", "gpt-5.6-terra", candidates)).toBe(false);
  });

  test("auth-slot models pass even with no login (settings must not be login-order-dependent)", async () => {
    const candidates = await webSearchCandidateRows(config());
    expect(candidates).toEqual([]);
    expect(webSearchModelIsRejected("openai", "gpt-5.6-luna", candidates)).toBe(false);
    expect(webSearchModelIsRejected("anthropic", "claude-haiku-4-5", candidates)).toBe(false);
    expect(webSearchModelIsRejected("openai", "claude-haiku-4-5", candidates)).toBe(true);
  });
});

describe("option list", () => {
  test("persisted now-illegal model is display-grandfathered; new writes still rejected", async () => {
    usableCodexAccounts.add(MAIN_CODEX_ACCOUNT_ID);
    managementRows = [{ provider: "openai", id: "gpt-5.6-terra", disabled: false, native: true }];
    const cfg = config({ webSearchSidecar: { backend: "anthropic", model: "legacy-model" } });
    const candidates = await webSearchCandidateRows(cfg);
    const options = webSearchModelOptionsFrom(cfg, candidates);
    expect(options.find(o => o.value === "legacy-model")).toMatchObject({
      backend: "anthropic",
      model: "legacy-model",
    });
    expect(webSearchModelIsRejected("anthropic", "legacy-model", candidates)).toBe(true);
  });

  test("auth-slot options carry the slot flag; list is stably sorted", async () => {
    usableCodexAccounts.add(MAIN_CODEX_ACCOUNT_ID);
    accountSets = { claude: { accounts: [{ id: "a1" }], activeAccountId: "a1" } };
    managementRows = [{ provider: "openai", id: "gpt-5.6-terra", disabled: false, native: true }];
    const cfg = config();
    const options = webSearchModelOptionsFrom(cfg, await webSearchCandidateRows(cfg));
    expect(options.map(o => o.value)).toEqual(["claude-haiku-4-5", "gpt-5.6-luna", "gpt-5.6-terra"]);
    expect(options.find(o => o.value === "gpt-5.6-luna")).toMatchObject({
      authSlot: true,
      backend: "openai",
      model: "gpt-5.6-luna",
    });
    expect(options.find(o => o.value === "claude-haiku-4-5")).toMatchObject({
      authSlot: true,
      backend: "anthropic",
      model: "claude-haiku-4-5",
    });
    expect(options.find(o => o.value === "gpt-5.6-terra")).toMatchObject({
      backend: "openai",
      model: "gpt-5.6-terra",
    });
  });
});

async function sidecarSettings(config: OcxConfig, init?: { method: string; body: unknown }): Promise<Response> {
  const url = new URL("http://localhost/api/sidecar-settings");
  const request = init
    ? new Request(url, { method: init.method, headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) })
    : new Request(url);
  const response = await handleManagementAPI(request, url, config);
  if (!response) throw new Error("sidecar settings route did not handle the request");
  return response;
}

describe("HTTP contract on /api/sidecar-settings", () => {
  test("GET always carries webSearchModels — [] when nothing is runnable", async () => {
    const body = await (await sidecarSettings(config())).json() as { webSearchModels: unknown };
    expect(body.webSearchModels).toEqual([]);
  });

  test("PUT rejects a non-candidate with 400 and does not persist it", async () => {
    usableCodexAccounts.add(MAIN_CODEX_ACCOUNT_ID);
    managementRows = [{ provider: "openai", id: "gpt-5.6-terra", disabled: false, native: true }];
    const cfg = config();
    const response = await sidecarSettings(cfg, { method: "PUT", body: { webSearch: { model: "o3-mini" } } });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("web-search sidecar candidate");
    expect(cfg.webSearchSidecar?.model).toBeUndefined();
  });

  test("PUT rejects a backend/model mismatch and does not persist it", async () => {
    const cfg = config();
    const response = await sidecarSettings(cfg, {
      method: "PUT",
      body: { webSearch: { backend: "openai", model: "claude-haiku-4-5" } },
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("backend/model pair");
    expect(cfg.webSearchSidecar).toBeUndefined();
  });

  test("PUT validates a backend-only update against the preserved effective model", async () => {
    const cfg = config({ webSearchSidecar: { backend: "anthropic", model: "claude-haiku-4-5" } });
    const response = await sidecarSettings(cfg, {
      method: "PUT",
      body: { webSearch: { backend: "openai" } },
    });
    expect(response.status).toBe(400);
    expect(cfg.webSearchSidecar).toEqual({ backend: "anthropic", model: "claude-haiku-4-5" });
  });

  test("PUT persists the Anthropic auth-slot pair exactly as offered", async () => {
    const cfg = config();
    const response = await sidecarSettings(cfg, {
      method: "PUT",
      body: { webSearch: { backend: "anthropic", model: "claude-haiku-4-5" } },
    });
    expect(response.status).toBe(200);
    expect(cfg.webSearchSidecar).toMatchObject({ backend: "anthropic", model: "claude-haiku-4-5" });
  });

  test("PUT accepts a runnable candidate and ECHOES webSearchModels (GUI rebuilds from this body)", async () => {
    usableCodexAccounts.add(MAIN_CODEX_ACCOUNT_ID);
    managementRows = [{ provider: "openai", id: "gpt-5.6-terra", disabled: false, native: true }];
    const cfg = config();
    const response = await sidecarSettings(cfg, { method: "PUT", body: { webSearch: { model: "gpt-5.6-terra" } } });
    expect(response.status).toBe(200);
    const body = await response.json() as { webSearch: { model: string }; webSearchModels: Array<{ value: string }> };
    expect(body.webSearch.model).toBe("gpt-5.6-terra");
    expect(Array.isArray(body.webSearchModels)).toBe(true);
    expect(body.webSearchModels.map(o => o.value)).toContain("gpt-5.6-terra");
  });

  test("PUT with empty string clears the model without hitting the gate", async () => {
    const cfg = config({ webSearchSidecar: { model: "legacy-model" } });
    const response = await sidecarSettings(cfg, { method: "PUT", body: { webSearch: { model: "" } } });
    expect(response.status).toBe(200);
    expect(cfg.webSearchSidecar?.model).toBeUndefined();
  });

  test("rejection body's allowedModels includes the always-legal auth slots", async () => {
    const candidates = await webSearchCandidateRows(config());
    const rejection = webSearchModelRejection("webSearch.model", "openai", "o3-mini", candidates);
    expect(rejection.allowedModels).toContain("gpt-5.6-luna");
    expect(rejection.allowedModels).toContain("claude-haiku-4-5");
  });
});
