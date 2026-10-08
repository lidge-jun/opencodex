import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, loadConfig, saveConfig, setPersistedConfigMutationBeforeCommitForTests } from "../../src/config";
import { clearGatherRoutedModelsInflight, gatherRoutedModels, gatherRoutedModelsForCatalogGather } from "../../src/codex/catalog/provider-fetch";
import { captureProviderGather } from "../../src/codex/catalog/gather-capture";
import { fetchProviderModelsWithAuth, observedModelsAuthResolver, refreshingModelsAuthResolver } from "../../src/codex/catalog/provider-models";
import { clearModelCache } from "../../src/codex/model-cache";
import * as oauth from "../../src/oauth";
import { captureModelsOAuthTarget, guardModelsOAuthRequest } from "../../src/oauth/model-discovery-auth";
import { getAccountSet, getAuthStorePath, saveCredential } from "../../src/oauth/store";
import type { OAuthCredentials } from "../../src/oauth/types";
import { handleManagementAPI } from "../../src/server/management-api";
import { buildLabProviderAuthHeaders } from "../../src/lib/lab-live-route-production";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { withRegistryDiscovery } from "../helpers/provider-registry-discovery";

const previousEnv = { HOME: process.env.HOME, OPENCODEX_HOME: process.env.OPENCODEX_HOME,
  CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  OPENCODEX_API_AUTH_TOKEN: process.env.OPENCODEX_API_AUTH_TOKEN };
const previousFetch = globalThis.fetch;
let root: string;
let unexpectedFetches: number;
const calls: { url: string; headers: Headers }[] = [];
const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
  calls.push({ url: String(input), headers: new Headers(init?.headers) });
  return Response.json({ data: [{ id: "discovered-model" }] });
}) as typeof fetch;

function config(row?: OcxProviderConfig): OcxConfig {
  return { port: 10100, defaultProvider: "anthropic", modelCacheTtlMs: 0, providers: {
    anthropic: { ...structuredClone(oauth.OAUTH_PROVIDERS.anthropic!.providerConfig), liveModels: false },
    ...(row ? { anthropic2: row } : {}),
  } };
}
function builtin(): OcxProviderConfig {
  return { ...structuredClone(oauth.OAUTH_PROVIDERS.anthropic2!.providerConfig), liveModels: true };
}

test("Lab live probes never fetch a Pool 2 bearer for an unmarked anthropic2 row", async () => {
  const snapshot = spyOn(oauth, "getValidAccessTokenSnapshot");
  try {
    const unmarked = { ...builtin(), anthropicOAuthInstance: undefined };
    const context = { providerId: "anthropic2", baseUrl: "https://api.anthropic.com/v1" } as never;
    await expect(buildLabProviderAuthHeaders(context, config(unmarked)))
      .rejects.toMatchObject({ message: expect.stringContaining("anthropic instance unavailable") });
    expect(snapshot).not.toHaveBeenCalled();
  } finally {
    snapshot.mockRestore();
  }
});
function gateway(): OcxProviderConfig {
  return { adapter: "anthropic", authMode: "oauth", baseUrl: "https://gateway.example.test",
    models: ["gateway-fallback"], liveModels: true };
}
function unmarkedCanonical(): OcxProviderConfig {
  const row = builtin();
  delete row.anthropicOAuthInstance;
  row.models = ["gateway-fallback"];
  return row;
}
function credential(expires = Date.now() + 3_600_000): OAuthCredentials {
  return { access: "synthetic-pool2-access", refresh: "synthetic-pool2-refresh", expires,
    accountId: "synthetic-pool2-account", source: "oauth" };
}
function clearDiscovery() {
  clearModelCache(); clearGatherRoutedModelsInflight(); calls.length = 0;
}
function attachTransport(live: OcxConfig) {
  for (const row of Object.values(live.providers)) Object.assign(row, { fetch: transport });
  return live;
}
function withTransport(row: OcxProviderConfig): OcxProviderConfig & { fetch: typeof fetch } {
  return { ...row, fetch: transport };
}
async function probe(live: OcxConfig, name = "anthropic2") {
  const url = new URL(`http://localhost/api/providers/test?name=${name}`);
  const response = await handleManagementAPI(new ManagementRequest(url, { method: "POST" }), url, live, {
    saveConfigPreservingClaudeCode: () => {},
  });
  expect(response?.status).toBe(200);
  return await response!.json() as { ok?: boolean; applicable?: boolean; error?: string };
}
const modes = ["observed", "refreshing"] as const;
async function gather(live: OcxConfig, mode: typeof modes[number]) {
  return mode === "refreshing" ? gatherRoutedModels(live) : gatherRoutedModelsForCatalogGather(live, {
    authStoreBuffer: readFileSync(getAuthStorePath()),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-anthropic2-discovery-"));
  process.env.HOME = root;
  process.env.OPENCODEX_HOME = join(root, "ocx");
  process.env.CODEX_HOME = join(root, "codex");
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  mkdirSync(process.env.CODEX_HOME);
  mkdirSync(process.env.OPENCODEX_HOME);
  mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    accessToken: "synthetic-cli-a-access", refreshToken: "synthetic-cli-a-refresh", expiresAt: Date.now() + 3_600_000,
  } }));
  unexpectedFetches = 0;
  globalThis.fetch = (async () => { unexpectedFetches++; throw new Error("unexpected external transport"); }) as typeof fetch;
  clearDiscovery(); saveConfig(config());
});
afterEach(() => {
  setPersistedConfigMutationBeforeCommitForTests(null);
  globalThis.fetch = previousFetch;
  clearDiscovery();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  removeTreeWithRetry(root);
});

for (const mode of modes) {
  for (const expired of [false, true]) {
    for (const customRow of [gateway, unmarkedCanonical]) {
    test(`${mode}: custom OAuth B ${customRow.name} obtains no bearer and performs no refresh or discovery send (${expired ? "expired" : "valid"})`, async () => {
      await saveCredential("anthropic2", credential(expired ? Date.now() - 1 : undefined));
      saveConfig(config(customRow()));
      const live = attachTransport(loadConfig());
      const before = readFileSync(getAuthStorePath(), "utf8");
      const refresh = spyOn(oauth.OAUTH_PROVIDERS.anthropic2!, "refresh").mockImplementation(async () => {
        throw new Error("custom row cannot refresh B");
      });
      try {
        const resolver = observedModelsAuthResolver(readFileSync(getAuthStorePath()), []);
        if (resolver.kind !== "observed") throw new Error("expected observed resolver");
        expect(resolver.resolve("anthropic2", live.providers.anthropic2!).apiKey).toBeUndefined();
        const models = await gather(live, mode);
        expect(models.some(row => row.provider === "anthropic2" && row.id === "gateway-fallback")).toBe(true);
        expect((await probe(live)).ok).toBe(false);
        expect(calls).toEqual([]);
        expect(refresh).not.toHaveBeenCalled();
        expect(unexpectedFetches).toBe(0);
        expect(readFileSync(getAuthStorePath(), "utf8")).toBe(before);
      } finally { refresh.mockRestore(); }
    });
    }
  }

  test(`${mode}: absent and disabled B rows leave the orphan credential inert`, async () => {
    await saveCredential("anthropic2", credential(Date.now() - 1));
    const refresh = spyOn(oauth.OAUTH_PROVIDERS.anthropic2!, "refresh").mockImplementation(async () => {
      throw new Error("unconfigured B cannot refresh");
    });
    try {
      for (const row of [undefined, { ...builtin(), disabled: true }]) {
        saveConfig(config(row));
        const live = attachTransport(loadConfig());
        await expect(oauth.getModelsOAuthAccessSnapshot("anthropic2", row)).rejects.toThrow();
        if (row) expect(await oauth.resolveModelsAuthToken("anthropic2", row)).toBeUndefined();
        expect((await gather(live, mode)).some(model => model.provider === "anthropic2")).toBe(false);
        if (row) expect((await probe(live)).ok).toBe(false);
        expect(calls).toEqual([]);
        clearDiscovery();
      }
      expect(refresh).not.toHaveBeenCalled(); expect(unexpectedFetches).toBe(0);
    } finally { refresh.mockRestore(); }
  });

  test(`${mode}: builtin B still sends its own bearer to Anthropic`, async () => {
    await saveCredential("anthropic2", credential());
    saveConfig(config(builtin()));
    const live = attachTransport(loadConfig());
    const models = await gather(live, mode);
    expect(models.some(model => model.provider === "anthropic2" && model.id === "discovered-model")).toBe(true);
    expect((await probe(live)).ok).toBe(true);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe("https://api.anthropic.com/v1/models?limit=1000");
      expect(call.headers.get("authorization")).toBe("Bearer synthetic-pool2-access");
    }
    expect(unexpectedFetches).toBe(0);
  });

  test(`${mode}: marked override sends its own bearer only to the authorized configured discovery target`, async () => {
    await saveCredential("anthropic2", credential());
    const override = { ...builtin(), baseUrl: "https://owned-override.example.test/v1" };
    saveConfig(config(override));
    const live = attachTransport(loadConfig());
    expect((await gather(live, mode)).some(model => model.provider === "anthropic2" && model.id === "discovered-model")).toBe(true);
    expect((await probe(live)).ok).toBe(true);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe("https://owned-override.example.test/v1/models?limit=1000");
      expect(call.headers.get("authorization")).toBe("Bearer synthetic-pool2-access");
    }
    const request = oauth.buildModelsRequest(override, "synthetic-pool2-access", "anthropic2");
    const target = captureModelsOAuthTarget("anthropic2", override);
    for (const url of ["https://api.anthropic.com/v1/models?limit=1000", "https://other.example.test/v1/models?limit=1000",
      "https://owned-override.example.test/v1/messages", "https://owned-override.example.test/v1/models?limit=1",
      "https://user@owned-override.example.test/v1/models?limit=1000"]) {
      expect(new Headers(guardModelsOAuthRequest("anthropic2", override, { ...request, url }, target).headers).get("authorization")).toBeNull();
      expect(new Headers(guardModelsOAuthRequest("anthropic2", override, { ...request, url }, url).headers).get("authorization")).toBeNull();
    }
    expect(unexpectedFetches).toBe(0);
  });
}

for (const adapter of ["openai-chat", "anthropic"] as const) {
  for (const authMode of ["key", undefined] as const) {
    test(`custom ${adapter} B keeps its own key (${authMode ?? "omitted authMode"}) in helper, catalogs and probe`, async () => {
      await saveCredential("anthropic2", credential());
      const row: OcxProviderConfig = { adapter, baseUrl: "https://custom.example.test/v1",
        ...(authMode ? { authMode } : {}), apiKey: "synthetic-custom-key", liveModels: true };
      saveConfig(config(row));
      const live = attachTransport(loadConfig());
      expect(await oauth.resolveModelsAuthToken("anthropic2", live.providers.anthropic2!)).toBe("synthetic-custom-key");
      for (const mode of modes) {
        clearDiscovery();
        const models = await gather(live, mode);
        expect(models.some(model => model.provider === "anthropic2" && model.id === "discovered-model")).toBe(true);
        expect((await probe(live)).ok).toBe(true);
        expect(calls).toHaveLength(2);
        for (const call of calls) {
          expect(call.url).toBe(adapter === "anthropic"
            ? "https://custom.example.test/v1/models?limit=1000" : "https://custom.example.test/v1/models");
          expect(call.headers.get(adapter === "anthropic" ? "x-api-key" : "authorization"))
            .toBe(adapter === "anthropic" ? "synthetic-custom-key" : "Bearer synthetic-custom-key");
          expect(JSON.stringify([...call.headers])).not.toContain("synthetic-pool2-access");
        }
      }
      expect(unexpectedFetches).toBe(0);
    });
  }
}

test("publication-time OAuth gateway collision leaves B orphaned through both real catalog entrypoints and the probe", async () => {
  const login = spyOn(oauth.OAUTH_PROVIDERS.anthropic2!, "login").mockResolvedValue(credential());
  const refresh = spyOn(oauth.OAUTH_PROVIDERS.anthropic2!, "refresh").mockImplementation(async () => {
    throw new Error("orphan cannot refresh");
  });
  setPersistedConfigMutationBeforeCommitForTests(() => {
    const competing = loadConfig(); competing.providers.anthropic2 = gateway();
    writeFileSync(getConfigPath(), JSON.stringify(competing, null, 2) + "\n");
  });
  try {
    await expect(oauth.runLogin("anthropic2", {})).rejects.toThrow("orphan auth row");
    expect(getAccountSet("anthropic2")!.accounts[0]!.credential.access).toBe("synthetic-pool2-access");
    const live = attachTransport(loadConfig());
    for (const mode of modes) {
      clearDiscovery(); await gather(live, mode);
      expect(calls).toEqual([]);
    }
    expect((await probe(live)).ok).toBe(false);
    expect(calls).toEqual([]); expect(refresh).not.toHaveBeenCalled(); expect(unexpectedFetches).toBe(0);
  } finally { login.mockRestore(); refresh.mockRestore(); }
});

test("outgoing builder refuses a directly supplied B snapshot for custom OAuth and disabled B rows", async () => {
  await saveCredential("anthropic2", credential());
  const snapshot = await oauth.getValidAccessTokenSnapshot("anthropic2");
  for (const row of [gateway(), unmarkedCanonical(), { ...gateway(), adapter: "openai-chat" as const },
    { ...gateway(), adapter: "google" as const, googleMode: "ai-studio" as const }, { ...builtin(), disabled: true }]) {
    const request = oauth.buildModelsRequest(row, snapshot.accessToken, "anthropic2", { oauthApiBaseUrl: snapshot.apiBaseUrl });
    expect(new Headers(request.headers).get("authorization")).toBeNull();
    expect(JSON.stringify(request.headers)).not.toContain(snapshot.accessToken);
    if (!row.disabled) expect(new URL(request.url).origin).toBe(new URL(row.baseUrl).origin);
  }
  expect(new Headers(oauth.buildModelsRequest(builtin(), snapshot.accessToken, "anthropic2", { oauthApiBaseUrl: snapshot.apiBaseUrl }).headers)
    .get("authorization")).toBe("Bearer synthetic-pool2-access");
  const authorizedTarget = captureModelsOAuthTarget("anthropic2", builtin());
  await withRegistryDiscovery("anthropic2", { url: "https://gateway.example.test/models" }, () => {
    const request = oauth.buildModelsRequest(builtin(), snapshot.accessToken, "anthropic2", { oauthApiBaseUrl: snapshot.apiBaseUrl });
    expect(request.url).toBe("https://gateway.example.test/models");
    expect(new Headers(guardModelsOAuthRequest("anthropic2", builtin(), request, authorizedTarget).headers).get("authorization")).toBeNull();
  });
});

test("refreshing catalog checks the captured row even when persisted/live config changes", async () => {
  await saveCredential("anthropic2", credential());
  const live = attachTransport(config(builtin()));
  const allowed = captureProviderGather("anthropic2", live.providers.anthropic2!, refreshingModelsAuthResolver);
  const denied = captureProviderGather("anthropic2", withTransport(gateway()), refreshingModelsAuthResolver);
  live.providers.anthropic2 = gateway(); saveConfig(live);
  await fetchProviderModelsWithAuth(allowed, 0, undefined, refreshingModelsAuthResolver);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/models?limit=1000");
  expect(calls[0]!.headers.get("authorization")).toBe("Bearer synthetic-pool2-access");
  clearDiscovery();
  live.providers.anthropic2 = builtin(); saveConfig(live);
  await fetchProviderModelsWithAuth(denied, 0, undefined, refreshingModelsAuthResolver);
  expect(calls).toEqual([]); expect(unexpectedFetches).toBe(0);
});

test("probe rechecks B ownership after snapshot resolution before transport", async () => {
  await saveCredential("anthropic2", credential());
  const live = attachTransport(config(builtin()));
  const resolve = oauth.getModelsOAuthAccessSnapshot;
  const snapshot = spyOn(oauth, "getModelsOAuthAccessSnapshot").mockImplementation(async (name, row) => {
    const result = await resolve(name, row);
    Object.assign(live.providers.anthropic2!, gateway());
    return result;
  });
  try {
    expect((await probe(live)).ok).toBe(false);
    expect(calls).toEqual([]); expect(unexpectedFetches).toBe(0);
  } finally { snapshot.mockRestore(); }
});

for (const change of ["remove-marker", "replace-target", "mutate-target"] as const) {
  test(`probe refuses ${change} after an OAuth await even when the row otherwise remains compatible`, async () => {
    await saveCredential("anthropic2", credential());
    const live = attachTransport(config(builtin()));
    const resolve = oauth.getModelsOAuthAccessSnapshot;
    const snapshot = spyOn(oauth, "getModelsOAuthAccessSnapshot").mockImplementation(async (name, row) => {
      const result = await resolve(name, row);
      if (change === "remove-marker") delete live.providers.anthropic2!.anthropicOAuthInstance;
      else if (change === "replace-target") live.providers.anthropic2 = withTransport({ ...builtin(), baseUrl: "https://replacement.example.test" });
      else live.providers.anthropic2!.baseUrl = "https://mutated.example.test";
      return result;
    });
    try {
      expect((await probe(live)).ok).toBe(false);
      expect(calls).toEqual([]);
      expect(unexpectedFetches).toBe(0);
    } finally { snapshot.mockRestore(); }
  });
}

test("refreshing B catalog retains captured target when registry discovery changes after admission", async () => {
  await saveCredential("anthropic2", credential());
  const captured = captureProviderGather("anthropic2", withTransport(builtin()), refreshingModelsAuthResolver);
  await withRegistryDiscovery("anthropic2", { url: "https://new-policy.example.test/models" }, async () => {
    await fetchProviderModelsWithAuth(captured, 0, undefined, refreshingModelsAuthResolver);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer synthetic-pool2-access");
  });
  expect(unexpectedFetches).toBe(0);
});

test("A and an unrelated key provider retain their existing discovery authentication", async () => {
  await saveCredential("anthropic", { ...credential(), access: "synthetic-a-access", refresh: "synthetic-a-refresh" });
  const live = attachTransport(config());
  live.providers.anthropic!.liveModels = true;
  expect((await probe(live, "anthropic")).ok).toBe(true);
  expect(calls[0]!.headers.get("authorization")).toBe("Bearer synthetic-a-access");
  clearDiscovery();
  live.providers.vendor = withTransport({ adapter: "openai-chat", authMode: "key", baseUrl: "https://vendor.example.test/v1",
    apiKey: "synthetic-vendor-key" });
  expect((await probe(live, "vendor")).ok).toBe(true);
  expect(calls[0]!.url).toBe("https://vendor.example.test/v1/models");
  expect(calls[0]!.headers.get("authorization")).toBe("Bearer synthetic-vendor-key");
  expect(unexpectedFetches).toBe(0);
});
