import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig, saveConfig } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { flushNativeMainStartupReleases } from "../../src/codex/native-profile-startup";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import {
  invalidateCodexModelEntitlementsForAccount, resolveCodexEntitlementClientVersion, seedCodexModelEntitlementsForTests,
} from "../../src/codex/model-entitlements";
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

async function expectDesktopSnapshotBusy(response: Response): Promise<void> {
  expect(response.status, await response.clone().text()).toBe(503);
  expect(response.headers.get("retry-after")).toBe("1");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    error: { type: "server_error", code: "desktop_snapshot_busy", message: "Desktop model snapshot is temporarily unavailable" },
  });
}

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

test.each(["desktop-warm", "desktop-cold", "desktop-registry-changed", "desktop-model-hidden", "anthropic"] as const)("superseded Claude listing preserves the working profile (%s)", mode => lifecycle.run(async () => {
  const fetchingOlder = Promise.withResolvers<void>();
  const releaseOlder = Promise.withResolvers<void>();
  const knownGood = "known-good";
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
  const anthropicUrl = new URL("/v1/models?flavor=anthropic", server.url);
  const desktopUrl = new URL("/v1/models?format=desktop-config", server.url);
  const signal = lifecycle.abort.signal;
  const goodAlias = desktop3pAlias(provider, knownGood);
  const commonAlias = desktop3pAlias(provider, common);
  const obsoleteAlias = desktop3pAlias(provider, obsolete);
  const ids = async (response: Response) => {
    expect(response.status).toBe(200);
    const { data } = await response.json() as { data: Array<{ id: string }> };
    return data.map(row => row.id);
  };
  const apply = async () => {
    const child = Bun.spawn([process.execPath, "-e", `
      import { applyProfile } from "./src/cli/claude-desktop.ts";
      const result = await applyProfile(undefined, "static", {
        lifecycleLockDeps: { lockPath: process.env.OPENCODEX_HOME + "/desktop-lifecycle.sqlite" },
        probeClaudeDesktopPolicy: () => "present",
      });
      console.log(JSON.stringify(result));
    `], {
      env: {
        ...process.env,
        OPENCODEX_HOME: home.path("client"),
        CODEX_HOME: home.path("client", "codex"),
        CLAUDE_CONFIG_DIR: home.path("client", "claude"),
        OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: home.path("client", "desktop"),
      },
      signal, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    return JSON.parse(stdout.trim().split("\n").at(-1)!) as { ok: boolean; path: string; reason?: string };
  };
  let firstProfile: { path: string; bytes: Buffer } | undefined;
  if (mode === "desktop-warm" || mode === "desktop-registry-changed" || mode === "desktop-model-hidden") {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const token = "desktop-fixture-key";
    mkdirSync(home.path("client"));
    writeFileSync(home.path("client", "service-api-token"), `${token}\n`, { mode: 0o600 });
    writeFileSync(home.path("client", "config.json"), JSON.stringify({
      defaultProvider: provider, providers: { [provider]: {
        adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "fixture-only", allowPrivateNetwork: true, liveModels: false, models: [common],
      } }, runtimeRole: "client",
      client: {
        serverUrl: baseUrl, managementUrl: baseUrl, managementTransport: "direct",
        selectedClients: ["codex"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN", apiKeyId: "desktop-key",
        tokenFingerprint: createHash("sha256").update(token).digest("hex"),
        protocolVersion: 1, connectedAt: now,
      },
    } satisfies OcxConfig), { mode: 0o600 });
    const first = await apply();
    expect(first).toMatchObject({ ok: true });
    const bytes = readFileSync(first.path);
    const profile = JSON.parse(bytes.toString("utf8")) as { inferenceModels: Array<{ name: string }>; modelDiscoveryEnabled: boolean };
    expect(profile.modelDiscoveryEnabled).toBe(false);
    expect(profile.inferenceModels.map(row => row.name).sort()).toEqual([goodAlias, commonAlias].sort());
    firstProfile = { path: first.path, bytes };
  } else {
    expect((await ids(await fetch(anthropicUrl, { signal }))).sort()).toEqual([goodAlias, commonAlias].sort());
  }
  if (mode === "desktop-model-hidden") {
    const adminToken = readFileSync(home.path("admin-api-token"), "utf8").trim();
    const hidden = await fetch(new URL("/api/model-visibility", server.url), {
      method: "PUT",
      headers: { "content-type": "application/json", "x-opencodex-api-key": adminToken },
      body: JSON.stringify({ scope: "models", provider, enabled: false, targets: [{ id: knownGood }] }),
      signal,
    });
    expect(hidden.status).toBe(200);
    expect(loadConfig().disabledModels).toContain(`${provider}/${knownGood}`);
  }
  expect(resolveDesktop3pAlias(goodAlias)).toBe(`${provider}/${knownGood}`);
  expect(resolveDesktop3pAlias(obsoleteAlias)).toBeNull();
  let registrySize = desktop3pRegistrySize();
  expect(discoveries).toBe(0);
  expect(expireModelCache(provider)).toBe(true);

  const supersede = async (pending: Promise<unknown>) => {
    await Promise.race([fetchingOlder.promise, pending.then(() => { throw new Error("Listing finished before discovery"); })]);
    await gatherRoutedModels(loadConfig(), { onlyProvider: provider });
    expect(getProviderDiscoveryStatus(provider)).toEqual({ status: "failed", reason: "http", httpStatus: 429 });
    if (mode === "desktop-registry-changed") {
      buildDesktop3pRegistry([], [{ provider, id: common }]);
      registrySize = desktop3pRegistrySize();
    }
    releaseOlder.resolve();
  };
  const checkAfterSupersession = async <T>(pending: Promise<T>, check: (result: T) => void | Promise<void>) => {
    try {
      await supersede(pending);
      await check(await pending);
    } finally {
      releaseOlder.resolve();
      await pending;
    }
  };
  if (mode === "desktop-cold" || mode === "desktop-model-hidden") {
    await checkAfterSupersession(fetch(desktopUrl, { signal }), expectDesktopSnapshotBusy);
  } else if (firstProfile) {
    const { path, bytes } = firstProfile;
    await checkAfterSupersession(apply(), second => {
      expect(second).toMatchObject({ ok: false, reason: "desktop_snapshot_http_503", applied: false });
      expect(readFileSync(path)).toEqual(bytes);
    });
  } else {
    await checkAfterSupersession(fetch(anthropicUrl, { signal }), async response => {
      expect(await ids(response)).toEqual([commonAlias]);
    });
  }
  const changedRegistry = mode === "desktop-registry-changed";
  expect(resolveDesktop3pAlias(goodAlias)).toBe(changedRegistry ? null : `${provider}/${knownGood}`);
  expect(resolveDesktop3pAlias(commonAlias)).toBe(`${provider}/${common}`);
  expect(resolveDesktop3pAlias(obsoleteAlias)).toBeNull();
  expect(desktop3pRegistrySize()).toBe(registrySize);

  const messageAlias = changedRegistry ? commonAlias : goodAlias;
  const messages = await fetch(new URL("/v1/messages", server.url), {
    method: "POST", headers: { "content-type": "application/json" }, signal,
    body: JSON.stringify({ model: messageAlias, max_tokens: 32, messages: [{ role: "user", content: "fixture request" }] }),
  });
  expect(messages.status, await messages.text()).toBe(200);
  expect(forwarded).toEqual([changedRegistry ? common : knownGood]);
  expect(discoveries).toBe(2);
  if (mode === "desktop-model-hidden") {
    setCached(provider, [common, knownGood].map(id => ({ provider, id })));
    const fresh = await fetch(desktopUrl, { signal });
    expect(fresh.status).toBe(200);
    const { models } = await fresh.json() as { models: Array<{ name: string }> };
    expect(models.map(model => model.name)).toEqual([commonAlias]);
  }
}), SERVER_BUDGET_MS);

test("superseded Desktop listing retries after a Daybreak grant is withdrawn", () => lifecycle.run(async () => {
  const daybreak = "gpt-daybreak-blue-latest";
  const alias = desktop3pAlias("native", daybreak);
  const accountId = "desktop-entitlement-fixture";
  const version = resolveCodexEntitlementClientVersion();
  const seedRoster = (models: readonly string[]) => seedCodexModelEntitlementsForTests(
    MAIN_CODEX_ACCOUNT_ID, models, Date.now(), version, `main:${accountId}`,
  );
  const fetchingOlder = Promise.withResolvers<void>();
  const releaseOlder = Promise.withResolvers<void>();
  let discoveries = 0;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/models") return new Response(null, { status: 404 });
    if (++discoveries === 2) return new Response(null, { status: 429 });
    fetchingOlder.resolve();
    await releaseOlder.promise;
    return Response.json({ data: [{ id: arrival }] });
  } });
  lifecycle.ownStop(() => upstream.stop(true));
  saveConfig({
    port: 0, hostname: "127.0.0.1", defaultProvider: provider,
    providers: { [provider]: {
      adapter: "openai-chat", baseUrl: new URL("/v1", upstream.url).href,
      apiKey: "fixture-key", allowPrivateNetwork: true, liveModels: true,
    } },
    claudeCode: { enabled: true, desktopNativeModels: true },
  });
  const { startServer } = await import("../../src/server");
  const server = startServer(0);
  lifecycle.ownStop(() => server.stop(true));
  writeFileSync(home.path(".codex", "auth.json"), JSON.stringify({
    tokens: { access_token: "fixture-entitlement-token", account_id: accountId },
  }), { mode: 0o600 });
  const cachedModels = [{ provider, id: "model-a" }];
  setCached(provider, cachedModels);
  seedRoster([daybreak]);
  const url = new URL("/v1/models?format=desktop-config", server.url);
  const options = { signal: lifecycle.abort.signal };
  const modelNames = async (response: Response) => {
    expect(response.status).toBe(200);
    const { models } = await response.json() as { models: Array<{ name: string }> };
    return models.map(model => model.name);
  };
  try {
    expect(await modelNames(await fetch(url, options))).toContain(alias);
    seedRoster([]);
    expect(resolveDesktop3pAlias(alias)).toBe(`native/${daybreak}`);
    expect(discoveries).toBe(0);
    expect(expireModelCache(provider)).toBe(true);

    const pending = fetch(url, options);
    let superseded: Response;
    try {
      await Promise.race([fetchingOlder.promise, pending.then(() => { throw new Error("Listing finished before discovery"); })]);
      await gatherRoutedModels(loadConfig(), { onlyProvider: provider });
      expect(getProviderDiscoveryStatus(provider)).toEqual({ status: "failed", reason: "http", httpStatus: 429 });
      releaseOlder.resolve();
      superseded = await pending;
    } finally {
      releaseOlder.resolve();
      await pending;
    }
    expect(resolveDesktop3pAlias(alias)).toBe(`native/${daybreak}`);
    setCached(provider, cachedModels);
    expect(await modelNames(await fetch(url, options))).not.toContain(alias);
    expect(discoveries).toBe(2);
    await expectDesktopSnapshotBusy(superseded);
  } finally {
    invalidateCodexModelEntitlementsForAccount(MAIN_CODEX_ACCOUNT_ID);
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
