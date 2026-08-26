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
import { xaiSearchOptionsFromConfig } from "../src/web-search";
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

// #2457: the picker offers every union backend, but the pair check used to
// collapse the union into openai/anthropic and fall back to the STORED backend
// for anything else. A submitted `gemini` was therefore validated as an OpenAI
// model and 400'd, while writing the identical pair straight into config.json
// worked. The executor was never the problem; only the write gate was.
const antigravityOAuth: OcxProviderConfig = {
  adapter: "google",
  baseUrl: "https://cloudcode-pa.googleapis.com",
  authMode: "oauth",
};

function armAntigravity(): void {
  accountSets["google-antigravity"] = {
    accounts: [{ id: "acct-antigravity" }],
    activeAccountId: "acct-antigravity",
  };
  const set = accountSets["google-antigravity"] as unknown as {
    accounts: Array<{ id: string; credential?: { projectId: string } }>;
  };
  set.accounts[0].credential = { projectId: "proj-1" };
}

describe("submitted backend drives the pair check (#2457)", () => {
  test("PUT switches openai/luna to a gemini pair the picker offers", async () => {
    armAntigravity();
    managementRows = [{ provider: "google-antigravity", id: "gemini-3.7-flash", disabled: false }];
    const cfg = config({
      providers: { openai: forward, claude: anthropicOAuth, "google-antigravity": antigravityOAuth },
      webSearchSidecar: { backend: "openai", model: "gpt-5.6-luna" },
    });
    const response = await sidecarSettings(cfg, {
      method: "PUT",
      body: { webSearch: { backend: "gemini", model: "gemini-3.7-flash" } },
    });
    expect(response.status).toBe(200);
    expect(cfg.webSearchSidecar).toMatchObject({ backend: "gemini", model: "gemini-3.7-flash" });
  });

  test("PUT accepts a gemini pair when no sidecar is configured at all", async () => {
    armAntigravity();
    managementRows = [{ provider: "google-antigravity", id: "gemini-3.7-flash", disabled: false }];
    const cfg = config({
      providers: { openai: forward, claude: anthropicOAuth, "google-antigravity": antigravityOAuth },
    });
    const response = await sidecarSettings(cfg, {
      method: "PUT",
      body: { webSearch: { backend: "gemini", model: "gemini-3.7-flash" } },
    });
    expect(response.status).toBe(200);
    expect(cfg.webSearchSidecar).toMatchObject({ backend: "gemini", model: "gemini-3.7-flash" });
  });

  test("PUT still rejects a gemini model submitted without its backend", async () => {
    armAntigravity();
    managementRows = [{ provider: "google-antigravity", id: "gemini-3.7-flash", disabled: false }];
    const cfg = config({
      providers: { openai: forward, claude: anthropicOAuth, "google-antigravity": antigravityOAuth },
      webSearchSidecar: { backend: "openai", model: "gpt-5.6-luna" },
    });
    const response = await sidecarSettings(cfg, {
      method: "PUT",
      body: { webSearch: { model: "gemini-3.7-flash" } },
    });
    expect(response.status).toBe(400);
    expect(cfg.webSearchSidecar).toEqual({ backend: "openai", model: "gpt-5.6-luna" });
  });

  test("PUT still rejects a real mismatch inside the widened union", async () => {
    armAntigravity();
    managementRows = [{ provider: "google-antigravity", id: "gemini-3.7-flash", disabled: false }];
    const cfg = config({
      providers: { openai: forward, claude: anthropicOAuth, "google-antigravity": antigravityOAuth },
    });
    const response = await sidecarSettings(cfg, {
      method: "PUT",
      body: { webSearch: { backend: "gemini", model: "gpt-5.6-luna" } },
    });
    expect(response.status).toBe(400);
    expect(cfg.webSearchSidecar).toBeUndefined();
  });
});

describe("xSearch config round-trip (review High)", () => {
  test("PUT validates doc limits (400) and persists+echoes a valid block; GET carries it; null clears", async () => {
    usableCodexAccounts.add(MAIN_CODEX_ACCOUNT_ID);
    const cfg = config();
    const bad = await sidecarSettings(cfg, { method: "PUT", body: { webSearch: { xSearch: { enabled: true, allowedXHandles: ["a"], excludedXHandles: ["b"] } } } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("mutually exclusive");
    const ok = await sidecarSettings(cfg, { method: "PUT", body: { webSearch: { xSearch: { enabled: true, allowedXHandles: ["xai"], fromDate: "2026-08-01" } } } });
    expect(ok.status).toBe(200);
    const putBody = await ok.json() as { webSearch: { xSearch?: unknown } };
    expect(putBody.webSearch.xSearch).toEqual({ enabled: true, allowedXHandles: ["xai"], fromDate: "2026-08-01" });
    const get = await sidecarSettings(cfg);
    expect(((await get.json()) as { webSearch: { xSearch?: unknown } }).webSearch.xSearch).toEqual({ enabled: true, allowedXHandles: ["xai"], fromDate: "2026-08-01" });
    const clear = await sidecarSettings(cfg, { method: "PUT", body: { webSearch: { xSearch: null } } });
    expect(clear.status).toBe(200);
    expect(cfg.webSearchSidecar?.xSearch).toBeUndefined();
  });

  test("invalid xSearch does not partially mutate other web-search settings", async () => {
    const original = {
      backend: "openai" as const,
      model: "gpt-5.6-luna",
      reasoning: "low",
      streamRoutedModelOutput: true,
    };
    const cfg = config({ webSearchSidecar: { ...original } });

    const response = await sidecarSettings(cfg, {
      method: "PUT",
      body: {
        webSearch: {
          backend: "xai",
          reasoning: "high",
          streamRoutedModelOutput: false,
          xSearch: { enabled: true, allowedXHandles: ["a"], excludedXHandles: ["b"] },
        },
      },
    });

    expect(response.status).toBe(400);
    expect(cfg.webSearchSidecar).toEqual(original);
  });

  test("rejects allowedXHandle typo without broadening or partially mutating x_search", async () => {
    const original = {
      backend: "xai" as const,
      reasoning: "low",
      xSearch: { enabled: true as const, allowedXHandles: ["trusted"] },
    };
    const cfg = config({ webSearchSidecar: structuredClone(original) });

    const response = await sidecarSettings(cfg, {
      method: "PUT",
      body: {
        webSearch: {
          reasoning: "high",
          xSearch: { enabled: true, allowedXHandle: ["xai"] },
        },
      },
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("webSearch.xSearch.allowedXHandle");
    expect(cfg.webSearchSidecar).toEqual(original);
    expect(xaiSearchOptionsFromConfig(cfg.webSearchSidecar!)).toEqual({
      xSearch: true,
      allowedXHandles: ["trusted"],
    });
  });

  test.each([
    ["non-object block", "invalid", "webSearch.xSearch must be an object or null"],
    ["non-boolean enabled", { enabled: "true" }, "enabled must be a boolean"],
    ["non-array handles", { enabled: true, allowedXHandles: "xai" }, "allowedXHandles must be an array of strings"],
    ["mixed handle array", { enabled: true, excludedXHandles: ["xai", 7] }, "excludedXHandles must be an array of strings"],
    ["non-string date", { enabled: true, fromDate: 20260801 }, "fromDate must be an ISO-8601 date"],
    ["malformed date", { enabled: true, toDate: "08/01/2026" }, "toDate must be an ISO-8601 date"],
    ["unknown field", { enabled: true, scope: "following" }, "webSearch.xSearch.scope"],
  ])("rejects malformed xSearch input: %s", async (_name, xSearch, message) => {
    const cfg = config({ webSearchSidecar: { backend: "openai" } });

    const response = await sidecarSettings(cfg, {
      method: "PUT",
      body: { webSearch: { xSearch } },
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(message);
    expect(cfg.webSearchSidecar).toEqual({ backend: "openai" });
  });
});

// The Claude override is the second writer named in web-search-sidecar-options.ts:
// "a gate on one route and a stale copy on the other is the same as no gate at
// all." It carried the same collapsed ternary, so it needs the same proof (#2457).
describe("claude-code webSearchSidecar override honors the submitted backend (#2457)", () => {
  async function claudeCode(cfg: OcxConfig, body: unknown): Promise<Response> {
    const url = new URL("http://localhost/api/claude-code");
    const request = new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const response = await handleManagementAPI(request, url, cfg);
    if (!response) throw new Error("claude-code route did not handle the request");
    return response;
  }

  function geminiConfig(): OcxConfig {
    armAntigravity();
    managementRows = [{ provider: "google-antigravity", id: "gemini-3.7-flash", disabled: false }];
    return config({
      providers: { openai: forward, claude: anthropicOAuth, "google-antigravity": antigravityOAuth },
      claudeCode: { webSearchSidecar: { backend: "openai", model: "gpt-5.6-luna" } },
    });
  }

  test("PUT persists a gemini override over a stored openai pair", async () => {
    const cfg = geminiConfig();
    const response = await claudeCode(cfg, { webSearchSidecar: { backend: "gemini", model: "gemini-3.7-flash" } });
    expect(response.status).toBe(200);
    expect(cfg.claudeCode?.webSearchSidecar).toMatchObject({ backend: "gemini", model: "gemini-3.7-flash" });
  });

  test("PUT still rejects a mismatched override pair", async () => {
    const cfg = geminiConfig();
    const response = await claudeCode(cfg, { webSearchSidecar: { backend: "gemini", model: "gpt-5.6-luna" } });
    expect(response.status).toBe(400);
    expect(cfg.claudeCode?.webSearchSidecar).toEqual({ backend: "openai", model: "gpt-5.6-luna" });
  });
});
