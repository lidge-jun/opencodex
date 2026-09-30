import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig, saveConfig } from "../../src/config";
import { setPersistedConfigMutationBeforeCommitForTests } from "../../src/config/persisted-mutation";
import { clearModelCache } from "../../src/codex/model-cache";
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
