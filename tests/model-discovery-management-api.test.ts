import { describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";
import { ManagementRequest as Request } from "./helpers/management-auth";

function config(): OcxConfig {
  return { port: 10100, defaultProvider: "vendor", providers: { vendor: { liveModels: false, models: ["known"] } }, disabledModels: ["vendor/new"] };
}

async function call(live: OcxConfig, path: string, method = "GET", body?: unknown) {
  const url = new URL(`http://localhost${path}`);
  const response = await handleManagementAPI(new Request(url, {
    method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }), url, live, {
    saveConfigPreservingClaudeCode: () => {},
    fetchAllModels: async () => [{ provider: "vendor", id: "known" } as never],
    createManagementConvergeCodex: () => async () => ({ kind: "catalog-only", changed: false, catalogRefresh: { status: "unchanged" }, observed: {} as never, history: {} as never }),
  });
  return { response: response!, json: await response!.json() as Record<string, unknown> };
}

describe("model discovery management API", () => {
  test("PUT off bootstraps, GET reports state, and provider override persists", async () => {
    const live = config();
    const put = await call(live, "/api/model-discovery", "PUT", { policy: "off", provider: null });
    expect(put.response.status).toBe(200); expect(put.json.baselineBootstrapped).toBe(true);
    expect(live.modelDiscovery?.knownModels?.vendor.ids).toEqual(["known"]);
    await call(live, "/api/model-discovery", "PUT", { policy: "on", provider: "vendor" });
    expect(live.providers.vendor.newModelPolicy).toBe("on");
    const get = await call(live, "/api/model-discovery");
    expect(get.json.policy).toBe("off");
  });

  test("acknowledge removes recent badges without changing visibility", async () => {
    const live = config();
    live.modelDiscovery = { recentArrivals: { vendor: [{ id: "new", at: "2026-08-24T00:00:00Z" }] } };
    const result = await call(live, "/api/model-discovery/acknowledge", "POST", { provider: "vendor", ids: ["new"] });
    expect(result.response.status).toBe(200);
    expect(live.modelDiscovery.recentArrivals?.vendor).toEqual([]);
    expect(live.disabledModels).toEqual(["vendor/new"]);
  });
});
