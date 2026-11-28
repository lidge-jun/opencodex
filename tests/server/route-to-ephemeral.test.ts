import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { handleRouteToRoutes } from "../../src/server/management/route-to-routes";
import { handleRouteToCommand } from "../../src/cli/route-to";
import { homeLinkChildParity } from "../../src/link/child-parity";
import { readRouteIntentState, routeIntentStatePath } from "../../src/routing/route-intent-state";
import { syncRouteToChild } from "../../src/routing/route-to-sync-child";
import { homeHasLinks } from "../../src/routing/home-route-capture";
import { writeLinkStore, type LinkRecord } from "../../src/link/store";
import { linkStorePath } from "../../src/link/paths";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import type { ManagementContext } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";

/** An ephemeral ocx-child never reads route intent: no route write, sync or status claims it does. */
const full = "lnk_0123456789abcdef", eph = "lnk_fedcba9876543210";
const links: LinkRecord[] = [
  { id: full, alias: "full-child", direction: "hub-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnop", tunnelPort: 41000, apiKeyId: "key-full", createdAt: "2026-11-07T00:00:00.000Z", remotePlatform: "posix", childKind: "full" },
  { id: eph, alias: "devbox", direction: "hub-initiated", hostKeyFingerprint: "SHA256:ponmlkjihgfedcba", tunnelPort: 41001, apiKeyId: "key-eph", createdAt: "2026-11-07T00:00:00.000Z", remotePlatform: "posix", childKind: "ephemeral" },
];
let home: TempHome;
let applied: number;
let remote: string[];
const config = { port: 12345, providers: {} } as OcxConfig;
function ctx(path: string, body?: unknown, method?: string): ManagementContext {
  const req = new Request(`http://localhost${path}`, body === undefined ? {} : {
    method: method ?? (path.endsWith("/sync") ? "POST" : "PUT"), headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { req, url: new URL(req.url), config, version: "test", deps: { readLinkStore: () => ({ version: 1, listenerPort: null, links }) } } as ManagementContext;
}
const deps = {
  applyHome: async () => { applied++; return []; },
  syncChild: async (link: { id: string }) => { remote.push(link.id); return { state: "synced" as const }; },
};
beforeEach(() => { home = createTempHome("route-to-ephemeral-"); applied = 0; remote = []; homeLinkChildParity.clear(); });
afterEach(() => { homeLinkChildParity.clear(); home.remove(); });

describe("route intent on an ephemeral ocx-child link", () => {
  test("a route write that targets it is refused before any state change", async () => {
    for (const device of [eph, "devbox"]) {
      for (const body of [{ client: "codex", action: "off", device }, { client: "pi", action: "on", device, overwriteConflict: true }, { client: "pi", action: "inherit", device }]) {
        const response = await handleRouteToRoutes(ctx("/api/route-to", body), deps);
        expect(response?.status).toBe(409);
        expect(await response!.json()).toMatchObject({ code: "route_intent_unsupported", reason: "ephemeral-child-no-route-intent", device: eph });
      }
    }
    expect(existsSync(routeIntentStatePath())).toBe(false);
    expect({ applied, remote }).toEqual({ applied: 0, remote: [] });
  });

  test("route-to sync never runs its remote sync: one device is refused, all reports it unsupported", async () => {
    const one = await handleRouteToRoutes(ctx("/api/route-to/sync", { device: "devbox", overwriteConflict: true }), deps);
    expect(one?.status).toBe(409);
    expect(await one!.json()).toMatchObject({ code: "route_intent_unsupported", reason: "ephemeral-child-no-route-intent" });
    expect({ applied, remote }).toEqual({ applied: 0, remote: [] });
    const all = await handleRouteToRoutes(ctx("/api/route-to/sync", { device: "all" }), deps);
    expect(all?.status).toBe(200);
    const body = await all!.json();
    expect(body.syncs).toEqual([{ id: full, state: "synced" }, { id: eph, state: "unsupported", reason: "ephemeral-child-no-route-intent" }]);
    expect(remote).toEqual([full]);
    // The shared Child sync helper refuses on its own as well, before any SSH.
    expect(await syncRouteToChild(links[1]!, ctx("/api/route-to/sync", {}), true, "pi"))
      .toEqual({ state: "unsupported", reason: "ephemeral-child-no-route-intent" });
  });

  test("status rows show route intent unsupported, also after a default write", async () => {
    expect((await handleRouteToRoutes(ctx("/api/route-to", { client: "pi", action: "off" }), deps))?.status).toBe(200);
    const response = await handleRouteToRoutes(ctx("/api/route-to?device=all"), deps);
    const body = await response!.json();
    expect(body.devices.find((row: { id: string }) => row.id === eph))
      .toEqual({ id: eph, alias: "devbox", desiredDigest: "", appliedRouteIntentDigest: null, clients: [], routeIntent: "unsupported", reason: "ephemeral-child-no-route-intent" });
    expect(body.devices.find((row: { id: string }) => row.id === full).clients.length).toBeGreaterThan(0);
    // The CLI accepts and prints the row.
    const out: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...parts) => { out.push(parts.join(" ")); });
    try {
      expect(await handleRouteToCommand(["status", "--device", "all"], { baseUrl: "http://route-to.invalid", fetchImpl: (async () => Response.json(body)) as unknown as typeof fetch })).toBe(0);
    } finally { log.mockRestore(); }
    expect(out.join("\n")).toContain("devbox  route intent unsupported (ephemeral-child-no-route-intent)");
  });

  test("a Home whose only links are ephemeral has no Child to protect", () => {
    writeLinkStore(linkStorePath(), { version: 1, listenerPort: null, links: [links[1]!] });
    expect(homeHasLinks()).toBe(false);
    writeLinkStore(linkStorePath(), { version: 1, listenerPort: null, links });
    expect(homeHasLinks()).toBe(true);
    expect(readRouteIntentState().defaults).toEqual({});
  });
});
