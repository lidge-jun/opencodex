import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { createIntegrationStateStore } from "../../src/integrations/store";
import { handleManagementAPI } from "../../src/server/management-api";
import { managementInferencePort } from "../../src/server/management/context";
import { setIntegrationMutationFlightTestHooks, setIntegrationPathTestHooks } from "../../src/server/management/integration-routes";
import { resetExportSnapshotForTests } from "../../src/server/management/model-rows";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let home: TempHome;
const originalFetch = globalThis.fetch;
beforeEach(() => {
  home = createTempHome("ocx-management-inference-port-");
  globalThis.fetch = (async () => { throw new Error("Network forbidden"); }) as typeof fetch;
  setIntegrationPathTestHooks({ env: {}, home: home.root });
  setIntegrationMutationFlightTestHooks({ store: createIntegrationStateStore(home.path("integrations")) });
  resetExportSnapshotForTests();
});
afterEach(() => {
  setIntegrationMutationFlightTestHooks(null);
  setIntegrationPathTestHooks(null);
  resetExportSnapshotForTests();
  globalThis.fetch = originalFetch;
  home.remove();
});
function config(): OcxConfig {
  return {
    port: 10100, hostname: "100.64.0.2", runtimeRole: "hub",
    hub: { managementIngress: { enabled: true, port: 10101 } },
    unauthenticatedLoopbackListener: { enabled: true },
    defaultProvider: "fixture", apiKeys: [],
    providers: { fixture: { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", liveModels: false, models: ["m"] } },
  } as unknown as OcxConfig;
}
async function route(cfg: OcxConfig, path: string, ingress: number, livePort?: number, init: RequestInit = {}) {
  const url = new URL(`http://127.0.0.1:${ingress}${path}`);
  const response = await handleManagementAPI(new Request(url, { ...init, headers: { Host: url.host, ...init.headers } }), url, cfg, {
    saveConfigPreservingClaudeCode: () => {},
    createManagementConvergeCodex: catalogConvergenceFactory(),
    ...(livePort === undefined ? {} : { liveListenPort: () => livePort }),
  });
  expect(response).not.toBeNull();
  return response!;
}

test.each([10100, 10101])("OpenCode export uses runtime port, not ingress %s", async ingress => {
  const response = await route(config(), "/api/client-config?client=opencode", ingress, 23456);
  expect(response.status).toBe(200);
  const body = await response.json() as { config: { provider: { opencodex: { options: { baseURL: string } } } } };
  expect(body.config.provider.opencodex.options.baseURL).toBe("http://127.0.0.1:23456/v1");
});
test("an explicit loopback inference port stays distinct from both runtime and management ports", async () => {
  const cfg = config();
  cfg.unauthenticatedLoopbackListener = { enabled: true, port: 10500 };
  const response = await route(cfg, "/api/client-config?client=pi", 10101, 23456);
  expect(response.status).toBe(200);
  const body = await response.json() as { config: { providers: { opencodex: { baseUrl: string } } } };
  expect(body.config.providers.opencodex.baseUrl).toBe("http://127.0.0.1:10500/v1");
});
test("ephemeral configuration uses the runtime-bound port", async () => {
  const cfg = config();
  cfg.port = 0;
  expect(managementInferencePort({ config: cfg, deps: { liveListenPort: () => 23456 } })).toBe(23456);
});
test("direct route fixtures without a lifecycle port use config, not their management URL", async () => {
  expect(managementInferencePort({ config: config(), deps: {} })).toBe(10100);
  const response = await route(config(), "/api/client-config?client=opencode", 10101);
  const body = await response.json() as { config: { provider: { opencodex: { options: { baseURL: string } } } } };
  expect(body.config.provider.opencodex.options.baseURL).toBe("http://127.0.0.1:10100/v1");
});
test.each(["opencode", "pi"] as const)("%s apply writes runtime inference URL through the actual writer", async client => {
  const spec = INTEGRATION_CLIENTS[client];
  mkdirSync(spec.detectDir({}, home.root), { recursive: true });
  const response = await route(config(), `/api/client-integrations/${client}`, 10101, 23456, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true });
  const written = readFileSync(spec.configPath({}, home.root), "utf8");
  expect(written).toContain("http://127.0.0.1:23456/v1");
  expect(written).not.toContain("http://127.0.0.1:10101/v1");
});
