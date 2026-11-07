import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleRouteToRoutes } from "../../src/server/management/route-to-routes";
import { projectHomeRouteIntent, routeClientIntentDigest } from "../../src/link/route-intent";
import { readRouteIntentState } from "../../src/routing/route-intent-state";
import { routeToDeviceStatus } from "../../src/routing/route-to-status";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import type { ManagementContext } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";

const id = "lnk_0123456789abcdef";
let home: TempHome;
let applied: number;
let remote: string[];
const config = { port: 12345, providers: {} } as OcxConfig;
function ctx(path: string, body?: unknown): ManagementContext {
  const req = new Request(`http://localhost${path}`, body === undefined ? {} : {
    method: path.endsWith("/sync") ? "POST" : "PUT",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { req, url: new URL(req.url), config, version: "test", deps: {
    readLinkStore: () => ({ version: 1, listenerPort: null, links: [
      { id, alias: "child-test", direction: "hub-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnop", tunnelPort: 41000, apiKeyId: "key-test", createdAt: new Date().toISOString(), remotePlatform: "posix" },
    ] }),
  } } as ManagementContext;
}
const deps = {
  applyHome: async () => { applied++; return []; },
  syncChild: async (link: { id: string }) => { remote.push(link.id); return { state: "synced" as const }; },
};
beforeEach(() => { home = createTempHome("route-to-api-"); applied = 0; remote = []; });
afterEach(() => home.remove());

describe("Route-to device API", () => {
  test("status is versioned and passive, and includes Home and every Child", async () => {
    const response = await handleRouteToRoutes(ctx("/api/route-to?device=all"), deps);
    expect(response?.status).toBe(200);
    const body = await response!.json();
    expect(body.schema).toBe("ocx.route-to/1");
    expect(body.devices.map((row: { id: string }) => row.id)).toEqual(["home", id]);
    expect(body.devices[1].clients.find((row: { client: string }) => row.client === "aside")).toMatchObject({ intent: "off", source: "builtin", applied: null });
    expect(applied).toBe(0);
  });
  test("device alias writes are isolated and inherit removes the override", async () => {
    expect((await handleRouteToRoutes(ctx("/api/route-to", { client: "aside", action: "on", device: "child-test", accounts: ["aside-user-test"] }), deps))?.status).toBe(200);
    expect(projectHomeRouteIntent(config, "test", id, readRouteIntentState()).clients.aside).toMatchObject({ enabled: true, accounts: ["aside-user-test"] });
    expect(projectHomeRouteIntent(config, "test", undefined, readRouteIntentState()).clients.aside.enabled).toBe(false);
    expect(applied).toBe(0);
    expect((await handleRouteToRoutes(ctx("/api/route-to", { client: "aside", action: "inherit", device: id }), deps))?.status).toBe(200);
    expect(projectHomeRouteIntent(config, "test", id, readRouteIntentState()).sources.aside).toBe("default");
  });
  test("Home defaults use the same local applier; explicit sync selects one Child", async () => {
    expect((await handleRouteToRoutes(ctx("/api/route-to", { client: "aside", action: "on" }), deps))?.status).toBe(200);
    expect(applied).toBe(1);
    expect((await handleRouteToRoutes(ctx("/api/route-to/sync", { device: "child-test" }), deps))?.status).toBe(200);
    expect(remote).toEqual([id]);
    expect(applied).toBe(1);
  });
  test("unknown devices and machine facts reject before persistence or materialization", async () => {
    for (const body of [
      { client: "aside", action: "on", device: "unknown" },
      { client: "aside", action: "on", port: 10100 },
      { client: "aside", action: "on", accounts: ["u/0"] },
      { client: "codex", action: "on", accounts: "all" },
      { client: "aside", action: "inherit" },
      { client: "aside", action: ["on"] },
    ]) expect((await handleRouteToRoutes(ctx("/api/route-to", body), deps))!.status).toBeGreaterThanOrEqual(400);
    expect(applied).toBe(0);
    expect(readRouteIntentState().defaults).toEqual({});
  });
  test("old successful receipts become stale when the desired intent changes", () => {
    const doc = projectHomeRouteIntent(config, "test", id, readRouteIntentState());
    const row = routeToDeviceStatus(id, "child-test", doc, [{ client: "codex", outcome: "current" }], "0".repeat(64));
    expect(row.clients.find(value => value.client === "codex")?.applied).toBe("stale");
  });
  test("Home-only native overrides preserve the inherited Child default", async () => {
    expect((await handleRouteToRoutes(ctx("/api/route-to", { client: "codex", action: "off", device: "home" }), deps))?.status).toBe(200);
    const mutated = { ...config, clientIntegrations: { codex: false } };
    expect(projectHomeRouteIntent(mutated, "test", id, readRouteIntentState()).clients.codex.enabled).toBe(true);
    expect(projectHomeRouteIntent(mutated, "test", "home", readRouteIntentState()).clients.codex.enabled).toBe(false);
  });
  test("partial apply keeps unrelated per-client success current", () => {
    const doc = projectHomeRouteIntent(config, "test", id);
    const row = routeToDeviceStatus(id, "child-test", doc, [
      { client: "codex", outcome: "current", intentDigest: routeClientIntentDigest(doc, "codex") },
      { client: "aside", outcome: "failed" },
    ], null);
    expect(row.clients.find(value => value.client === "codex")?.applied).toBe("current");
    expect(row.clients.find(value => value.client === "aside")?.applied).toBe("failed");
  });
  test("Home inherit invalidates only the corresponding initial selection", async () => {
    const doc = projectHomeRouteIntent(config, "test", id);
    const initial = { client: "codex" as const, outcome: "current" as const, initialIntent: { enabled: false }, initialRevision: 0 };
    expect(routeToDeviceStatus(id, "child-test", doc, [initial], null).clients.find(value => value.client === "codex")?.intent).toBe("off");
    await handleRouteToRoutes(ctx("/api/route-to", { client: "codex", action: "inherit", device: id }), deps);
    const next = projectHomeRouteIntent(config, "test", id, readRouteIntentState());
    expect(next.clientRevisions?.codex).toBe(1);
    expect(routeToDeviceStatus(id, "child-test", next, [initial], null).clients.find(value => value.client === "codex")?.intent).toBe("on");
  });
  test("a client toggle binds explicit takeover to that client", async () => {
    const scopes: unknown[] = [];
    const scoped = { ...deps, applyHome: async (_ctx: ManagementContext, overwrite: boolean, client?: string) => { scopes.push([overwrite, client]); return []; } };
    const response = await handleRouteToRoutes(ctx("/api/route-to", { client: "aside", action: "on", overwriteConflict: true }), scoped);
    expect(response?.status).toBe(200);
    expect(scopes).toEqual([[true, "aside"]]);
  });
});
