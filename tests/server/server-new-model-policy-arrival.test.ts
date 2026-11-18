import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig, saveConfig } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { flushNativeMainStartupReleases } from "../../src/codex/native-profile-startup";
import { flushWindowsSecretAclReapsBeforeRemoval } from "../../src/lib/windows-secret-acl";
import { setPersistedConfigMutationBeforeCommitForTests } from "../../src/config/persisted-mutation";
import { gatherRoutedModels, getLastComboCatalogOmissions } from "../../src/codex/catalog";
import { buildDesktop3pRegistry, desktop3pAlias, desktop3pRegistrySize, resolveDesktop3pAlias } from "../../src/claude/desktop-3p";
import {
  clearModelCache, expireModelCache, getProviderDiscoveryStatus, getStaleCached,
  isModelsFetchCoolingDown, observeModelCacheRevision, setCached,
} from "../../src/codex/model-cache";
import type { ManagementModelRow } from "../../src/server/management/model-rows";
import type { OcxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";
import { createTestCaseLifecycle } from "../helpers/test-sandbox-cleanup";

const provider = "fixture-catalog";
const existing = ["model-a", "model-b"];
const arrival = "model-c";
const now = "2026-01-01T00:00:00Z";
let home: TempHome;
let lifecycle: ReturnType<typeof createTestCaseLifecycle>;

beforeEach(() => {
  home = createTempHome("ocx-model-arrival-");
  mkdirSync(home.codexHome, { recursive: true });
  lifecycle = createTestCaseLifecycle();
  clearModelCache(provider);
});

afterEach(async () => {
  setPersistedConfigMutationBeforeCommitForTests(null);
  try {
    await lifecycle.close();
  } finally {
    clearModelCache(provider);
    buildDesktop3pRegistry([], []);
    await flushNativeMainStartupReleases();
    await flushConfigDirHardeningForTests();
    await flushWindowsSecretAclReapsBeforeRemoval(home.root);
    home.remove();
  }
});

const cases: Array<{
  name: string;
  global: "on" | "off";
  local?: "on" | "off";
  visible: boolean;
}> = [
  { name: "provider off overrides global on", global: "on", local: "off", visible: false },
  { name: "inherited global off", global: "off", visible: false },
  { name: "provider on overrides global off", global: "off", local: "on", visible: true },
  { name: "inherited global on", global: "on", visible: true },
];

// Discovery is driven through the real HTTP route, never by calling policy reconciliation, so the
// assertions below check the persisted contract under test (#6260): an absorbed baseline, a
// recorded arrival, a surviving manual block, and a manual re-enable that holds across refresh.
test.each(cases)("new arrival before catalog convergence: $name", policy => lifecycle.run(async () => {
  let ids = [...existing];
  const discoveries: string[][] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => {
    if (request.method !== "GET" || new URL(request.url).pathname !== "/v1/models") {
      return new Response("Unexpected upstream request", { status: 404 });
    }
    discoveries.push([...ids]);
    return Response.json({ data: ids.map(id => ({ id })) });
  } });
  lifecycle.ownStop(() => upstream.stop(true));
  const config: OcxConfig = {
    port: 0, hostname: "127.0.0.1", defaultProvider: provider,
    providers: { [provider]: {
      adapter: "openai-chat", baseUrl: new URL("/v1", upstream.url).href,
      apiKey: "fixture-key", allowPrivateNetwork: true, liveModels: true, models: [...existing],
      ...(policy.local === undefined ? {} : { newModelPolicy: policy.local }),
    } },
    disabledModels: [`${provider}/model-b`],
    modelDiscovery: { newModelPolicy: policy.global, knownModels: {
      [provider]: { ids: [...existing], removed: [], updatedAt: now },
    } },
  };
  saveConfig(config);
  expect(loadConfig().modelDiscovery?.knownModels?.[provider]?.ids).toEqual(existing);
  const { startServer } = await import("../../src/server");
  lifecycle.abort.signal.throwIfAborted();
  const server = startServer(0);
  lifecycle.ownStop(() => server.stop(true));
  const read = async () => {
    const response = await fetch(new URL("/v1/models", server.url), { signal: lifecycle.abort.signal });
    expect(response.status).toBe(200);
    return (await response.json() as { data: Array<{ id: string }> }).data
      .map(model => model.id).filter(id => id.startsWith(`${provider}/`)).sort();
  };
  expect(await read()).toEqual([`${provider}/model-a`]);
  expect(discoveries.at(-1)).toEqual(existing);
  const previousDiscoveries = discoveries.length;
  ids = [...existing, arrival];
  // Exercise a fresh discovery without waiting for the production cache TTL to expire.
  clearModelCache(provider);
  const after = await read();
  expect(discoveries.length).toBeGreaterThan(previousDiscoveries);
  expect(discoveries.at(-1)).toEqual([...existing, arrival]);
  expect(after).toContain(`${provider}/model-a`);
  expect(after).not.toContain(`${provider}/model-b`);
  expect(after).toEqual(policy.visible
    ? [`${provider}/model-a`, `${provider}/model-c`]
    : [`${provider}/model-a`]);

  // A successful discovery must persist, not only shape this response. The baseline absorbs the
  // arrival (so the next discovery does not re-flag it), the arrival is recorded for the operator,
  // and the manual block on model-b survives the same convergence that disabled model-c.
  const persisted = loadConfig();
  expect(persisted.modelDiscovery?.knownModels?.[provider]?.ids).toEqual([...existing, arrival]);
  expect(persisted.modelDiscovery?.recentArrivals?.[provider] ?? [])
    .toContainEqual(expect.objectContaining({ id: arrival }));
  expect(persisted.disabledModels ?? []).toContain(`${provider}/model-b`);
  if (policy.visible) expect(persisted.disabledModels ?? []).not.toContain(`${provider}/model-c`);
  else expect(persisted.disabledModels ?? []).toContain(`${provider}/model-c`);

  // Manual re-enable through the management route the CLI uses. It only sticks because the baseline
  // above absorbed model-c; a later discovery that still saw it as new would re-flag and re-hide it.
  const adminToken = readFileSync(home.path("admin-api-token"), "utf8").trim();
  const enable = await fetch(new URL("/api/model-visibility", server.url), {
    method: "PUT",
    headers: { "content-type": "application/json", "x-opencodex-api-key": adminToken },
    body: JSON.stringify({ scope: "models", provider, enabled: true, targets: [{ id: arrival }] }),
    signal: lifecycle.abort.signal,
  });
  expect(enable.status).toBe(200);
  expect(loadConfig().disabledModels ?? []).not.toContain(`${provider}/model-c`);

  clearModelCache(provider);
  expect(await read()).toEqual([`${provider}/model-a`, `${provider}/model-c`]);
}), SERVER_BUDGET_MS);

const supersededReads = [
  { path: "/api/models", policy: "off" },
  { path: "/v1/models", policy: "off" },
  { path: "/api/models", policy: "admit" },
  { path: "/v1/models", policy: "admit" },
] as const;

test.each(supersededReads)("$path projects a superseded success under policy $policy", ({ path, policy }) => lifecycle.run(async () => {
  const fetchingOlder = Promise.withResolvers<void>();
  const releaseOlder = Promise.withResolvers<void>();
  let sends = 0;
  const upstream = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch() {
      if (++sends === 2) return new Response(null, { status: 429 });
      fetchingOlder.resolve();
      await releaseOlder.promise;
      return Response.json({ data: [...existing, arrival].map(id => ({ id })) });
    },
  });
  lifecycle.ownStop(() => upstream.stop(true));
  saveConfig({
    port: 0, hostname: "127.0.0.1", defaultProvider: provider,
    providers: { [provider]: {
      adapter: "openai-chat", baseUrl: new URL("/v1", upstream.url).href,
      apiKey: "fixture-key", allowPrivateNetwork: true, liveModels: true,
      ...(policy === "admit" ? { selectedModels: [...existing] } : {}),
      newModelPolicy: policy,
    } },
    disabledModels: [`${provider}/model-b`],
    modelDiscovery: { knownModels: { [provider]: { ids: [...existing], removed: [], updatedAt: now } } },
  });
  const { startServer } = await import("../../src/server");
  lifecycle.abort.signal.throwIfAborted();
  const server = startServer(0);
  lifecycle.ownStop(() => server.stop(true));
  const configPath = home.path("config.json");
  const catalogPath = home.path(".codex", "opencodex-catalog.json");
  writeFileSync(catalogPath, '{"models":[]}');
  const configBefore = readFileSync(configPath, "utf8");
  const catalogBefore = readFileSync(catalogPath, "utf8");
  const lastGood = [{ provider, id: "last-good" }];
  setCached(provider, lastGood);
  expect(expireModelCache(provider)).toBe(true);
  const requestOptions = {
    headers: { "x-opencodex-api-key": readFileSync(home.path("admin-api-token"), "utf8").trim() },
    signal: lifecycle.abort.signal,
  };
  const pending = fetch(new URL(path, server.url), requestOptions);
  try {
    await fetchingOlder.promise;
    await gatherRoutedModels(loadConfig(), { onlyProvider: provider });
    const failure = { status: "failed", reason: "http", httpStatus: 429 };
    expect(getProviderDiscoveryStatus(provider)).toEqual(failure);
    const revision = observeModelCacheRevision(provider);
    const omissions = getLastComboCatalogOmissions();
    releaseOlder.resolve();
    const response = await pending;
    expect(response.status).toBe(200);
    if (path === "/api/models") {
      const rows = (await response.json() as ManagementModelRow[]).filter(row => row.provider === provider);
      expect(rows.map(({ id, disabled }) => ({ id, disabled }))).toEqual([
        { id: "model-a", disabled: false },
        { id: "model-b", disabled: true },
        { id: arrival, disabled: policy === "off" },
      ]);
    } else {
      const { data } = await response.json() as { data: Array<{ id: string }> };
      expect(data.map(row => row.id).filter(id => id.startsWith(`${provider}/`)).sort()).toEqual(
        policy === "off" ? [`${provider}/model-a`] : [`${provider}/model-a`, `${provider}/${arrival}`],
      );
    }
    expect(sends).toBe(2);
    expect(getProviderDiscoveryStatus(provider)).toEqual(failure);
    expect(isModelsFetchCoolingDown(provider)).toBe(true);
    expect(getStaleCached(provider)).toEqual(lastGood);
    expect(observeModelCacheRevision(provider)).toBe(revision);
    expect(getLastComboCatalogOmissions()).toBe(omissions);
    expect(readFileSync(configPath, "utf8")).toBe(configBefore);
    expect(readFileSync(catalogPath, "utf8")).toBe(catalogBefore);
    const discovery = await fetch(new URL("/api/model-discovery", server.url), requestOptions);
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({
      baselineCounts: { [provider]: existing.length }, recentArrivals: {},
    });
  } finally {
    releaseOlder.resolve();
    await pending;
  }
}), SERVER_BUDGET_MS);

test.each(["format=desktop-config", "flavor=anthropic"])("superseded Claude listing preserves shared aliases (%s)", query => lifecycle.run(async () => {
  const fetchingOlder = Promise.withResolvers<void>();
  const releaseOlder = Promise.withResolvers<void>();
  const knownGood = "last-good";
  const common = "model-a";
  const obsolete = arrival;
  const forwarded: string[] = [];
  let discoveries = 0;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    switch (new URL(request.url).pathname) {
      case "/v1/models":
        if (++discoveries === 2) return new Response(null, { status: 429 });
        fetchingOlder.resolve();
        await releaseOlder.promise;
        return Response.json({ data: [common, obsolete].map(id => ({ id })) });
      case "/v1/chat/completions": {
        const { model } = await request.json() as { model: string };
        forwarded.push(model);
        const chunk = { id: "chat_fixture", object: "chat.completion.chunk", model,
          choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      default: return new Response(null, { status: 404 });
    }
  } });
  lifecycle.ownStop(() => upstream.stop(true));
  saveConfig({
    port: 0, hostname: "127.0.0.1", defaultProvider: provider,
    providers: { [provider]: {
      adapter: "openai-chat", baseUrl: new URL("/v1", upstream.url).href,
      apiKey: "fixture-key", allowPrivateNetwork: true, liveModels: true, newModelPolicy: "on",
    } },
    claudeCode: { enabled: true, desktopNativeModels: false },
  });
  const { startServer } = await import("../../src/server");
  const server = startServer(0);
  lifecycle.ownStop(() => server.stop(true));
  setCached(provider, [common, knownGood].map(id => ({ provider, id })));
  const listUrl = new URL(`/v1/models?${query}`, server.url);
  const signal = lifecycle.abort.signal;
  const goodAlias = desktop3pAlias(provider, knownGood);
  const commonAlias = desktop3pAlias(provider, common);
  const obsoleteAlias = desktop3pAlias(provider, obsolete);
  const ids = async (response: Response) => {
    expect(response.status).toBe(200);
    const body = await response.json() as { models?: Array<{ name: string }>; data?: Array<{ id: string }> };
    return body.models?.map(row => row.name) ?? body.data!.map(row => row.id);
  };
  expect(await ids(await fetch(listUrl, { signal }))).toEqual(expect.arrayContaining([goodAlias, commonAlias]));
  expect(resolveDesktop3pAlias(goodAlias)).toBe(`${provider}/${knownGood}`);
  expect(resolveDesktop3pAlias(obsoleteAlias)).toBeNull();
  const registrySize = desktop3pRegistrySize();
  expect(discoveries).toBe(0);
  expect(expireModelCache(provider)).toBe(true);

  const pending = fetch(listUrl, { signal });
  try {
    await fetchingOlder.promise;
    await gatherRoutedModels(loadConfig(), { onlyProvider: provider });
    expect(getProviderDiscoveryStatus(provider)).toEqual({ status: "failed", reason: "http", httpStatus: 429 });
    releaseOlder.resolve();
    const projectedIds = await ids(await pending);
    expect(resolveDesktop3pAlias(goodAlias)).toBe(`${provider}/${knownGood}`);
    expect(resolveDesktop3pAlias(commonAlias)).toBe(`${provider}/${common}`);
    expect(resolveDesktop3pAlias(obsoleteAlias)).toBeNull();
    expect(desktop3pRegistrySize()).toBe(registrySize);
    expect(projectedIds).toEqual([commonAlias]);

    const messages = await fetch(new URL("/v1/messages", server.url), {
      method: "POST", headers: { "content-type": "application/json" }, signal,
      body: JSON.stringify({ model: goodAlias, max_tokens: 32, messages: [{ role: "user", content: "fixture request" }] }),
    });
    expect(messages.status, await messages.text()).toBe(200);
    expect(forwarded).toEqual([knownGood]);
    expect(discoveries).toBe(2);
  } finally {
    releaseOlder.resolve();
    await pending;
  }
}), SERVER_BUDGET_MS);

test("failed arrival persistence returns retryable HTTP 503 without publishing models", () => lifecycle.run(async () => {
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () =>
    Response.json({ data: [...existing, arrival].map(id => ({ id })) }),
  });
  lifecycle.ownStop(() => upstream.stop(true));
  saveConfig({
    port: 0, hostname: "127.0.0.1", defaultProvider: provider,
    providers: { [provider]: {
      adapter: "openai-chat", baseUrl: new URL("/v1", upstream.url).href,
      apiKey: "fixture-key", allowPrivateNetwork: true, liveModels: true, models: [...existing],
      newModelPolicy: "off",
    } },
    modelDiscovery: { knownModels: {
      [provider]: { ids: [...existing], removed: [], updatedAt: now },
    } },
  });
  const { startServer } = await import("../../src/server");
  lifecycle.abort.signal.throwIfAborted();
  const server = startServer(0);
  lifecycle.ownStop(() => server.stop(true));
  setPersistedConfigMutationBeforeCommitForTests(() => writeFileSync(home.path("config.json"), "invalid"));
  const response = await fetch(new URL("/v1/models", server.url), { signal: lifecycle.abort.signal });
  expect(response.status).toBe(503);
  expect(response.headers.get("retry-after")).toBe("1");
  const body = await response.json() as { error: { code: string }; data?: unknown };
  expect(body.error.code).toBe("catalog_busy");
  expect(body.data).toBeUndefined();
}), SERVER_BUDGET_MS);
