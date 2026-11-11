import { describe, expect, test } from "bun:test";
import { clearModelCache, setCached } from "../../src/codex/model-cache";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { ManagementRequest as Request } from "../helpers/management-auth";

function config(): OcxConfig {
  // `adapter` and `baseUrl` are both required by the persisted-config schema, so a row without
  // them cannot reach this handler in production. The fixture used to omit them and still crossed
  // into the real catalog gather path, which builds a discovery request before the static-provider
  // branch returns; that is how it reached a URL join at all.
  return {
    port: 10100,
    defaultProvider: "vendor",
    providers: {
      vendor: { adapter: "openai-chat", baseUrl: "https://vendor.example/v1", liveModels: false, models: ["known"] },
    },
    disabledModels: ["vendor/new"],
  };
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

describe("#8236 arrival status and the admit policy", () => {
  test("arrival state follows the catalog's visibility rules", async () => {
    const live = config();
    live.providers.vendor.selectedModels = ["known", "kept"];
    live.disabledModels = ["vendor/legacy", "vendor/mine", "vendor/auto"];
    live.modelDiscovery = { recentArrivals: { vendor: [
      { id: "legacy", at: "t" },
      { id: "mine", at: "t", disabledByPolicy: false },
      { id: "auto", at: "t", disabledByPolicy: true },
      { id: "hidden", at: "t", disabledByPolicy: false },
      { id: "kept", at: "t", admitted: true, disabledByPolicy: false },
    ] } } as never;
    const get = await call(live, "/api/model-discovery");
    const states = Object.fromEntries((get.json.recentArrivals as Record<string, Array<{ id: string; state: string }>>).vendor!.map(row => [row.id, row.state]));
    expect(states).toEqual({
      // A row written before this field existed keeps its old reading.
      legacy: "auto-disabled",
      mine: "disabled",
      auto: "auto-disabled",
      hidden: "not-selected",
      kept: "enabled",
    });
  });

  test("an unselected provider reports a visible arrival as enabled", async () => {
    const live = config();
    live.disabledModels = [];
    live.modelDiscovery = { recentArrivals: { vendor: [{ id: "fresh", at: "t", disabledByPolicy: false }] } } as never;
    const get = await call(live, "/api/model-discovery");
    expect((get.json.recentArrivals as Record<string, Array<{ state: string }>>).vendor![0]!.state).toBe("enabled");
  });

  // An Antigravity base row stands for its low/medium/high tiers in the picker.
  const family = { provider: "vendor", id: "fam", antigravityEffortWireModelIds: { low: "fam-low", medium: "fam-medium", high: "fam-high" } };

  test("an Antigravity base arrival selected through one of its tiers reports enabled", async () => {
    const live = config();
    live.disabledModels = [];
    live.providers.vendor.selectedModels = ["fam-high"];
    live.modelDiscovery = { recentArrivals: { vendor: [{ id: "fam", at: "t", disabledByPolicy: false }] } } as never;
    setCached("vendor", [family as never]);
    try {
      const get = await call(live, "/api/model-discovery");
      expect((get.json.recentArrivals as Record<string, Array<{ state: string }>>).vendor![0]!.state).toBe("enabled");
    } finally { clearModelCache("vendor"); }
  });

  test("an Antigravity base arrival whose known tiers are all disabled reports disabled", async () => {
    const live = config();
    live.disabledModels = ["vendor/fam-low", "vendor/fam-medium", "vendor/fam-high"];
    live.modelDiscovery = {
      knownModels: { vendor: { ids: ["fam-low", "fam-medium", "fam-high"], removed: [], updatedAt: "t" } },
      recentArrivals: { vendor: [{ id: "fam", at: "t", disabledByPolicy: false }] },
    } as never;
    setCached("vendor", [family as never]);
    try {
      const get = await call(live, "/api/model-discovery");
      expect((get.json.recentArrivals as Record<string, Array<{ state: string }>>).vendor![0]!.state).toBe("disabled");
    } finally { clearModelCache("vendor"); }
  });

  test("PUT accepts admit globally and per provider, and still rejects anything else", async () => {
    const live = config();
    expect((await call(live, "/api/model-discovery", "PUT", { policy: "admit", provider: "vendor" })).response.status).toBe(200);
    expect(live.providers.vendor.newModelPolicy).toBe("admit");
    expect((await call(live, "/api/model-discovery", "PUT", { policy: "admit", provider: null })).response.status).toBe(200);
    expect(live.modelDiscovery?.newModelPolicy).toBe("admit");
    expect((await call(live, "/api/model-discovery", "PUT", { policy: "everything", provider: null })).response.status).toBe(400);
  });
});
