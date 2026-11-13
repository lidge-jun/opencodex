import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLinkManagementRequest } from "../../src/server/index/link-management";
import { LINK_ROUTE_INTENT_PATH, linkManagementRouteAllowed } from "../../src/link/management-routes";
import { linkRouteAllowed } from "../../src/link/routes";
import { writeLinkStore } from "../../src/link/store";
import { linkStorePath } from "../../src/link/paths";
import { setRouteClientIntent, routeIntentStatePath } from "../../src/routing/route-intent-state";
import { captureHomeRouteDefaults } from "../../src/routing/home-route-capture";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
let root: string;
let previous: string | undefined;
const id = "lnk_0123456789abcdef";
beforeEach(() => {
  previous = process.env.OPENCODEX_HOME; root = mkdtempSync(join(tmpdir(), "ocx-route-boundary-")); process.env.OPENCODEX_HOME = root;
  writeLinkStore(linkStorePath(), { version: 1, listenerPort: 19100, links: [{ id, alias: "child", direction: "client-initiated", hostKeyFingerprint: null, tunnelPort: 19200, apiKeyId: "own-key", createdAt: "2026-11-07T00:00:00.000Z" }] });
  // A linked Home saved its Children's native defaults at enrollment or listener start.
  captureHomeRouteDefaults({} as OcxConfig);
  setRouteClientIntent("aside", { enabled: true, accounts: "all" });
  setRouteClientIntent("aside", { enabled: false }, id);
  setRouteClientIntent("pi", { enabled: true }, "another-child");
});
afterEach(() => { if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous; removeTreeWithRetry(root); });
function request(path = LINK_ROUTE_INTENT_PATH, key: string | undefined = "own-key", method = "GET") {
  const url = new URL(path, "http://127.0.0.1:19100");
  return handleLinkManagementRequest(new Request(url, { method }), url, {} as never, {} as never, undefined, key);
}
test("authenticated read selects only the admitted link device and performs no durable write", async () => {
  const before = readFileSync(routeIntentStatePath(), "utf8");
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const document = await response.json();
  expect(document.clients.aside).toEqual({ enabled: false, accounts: "all" });
  expect(document.sources.aside).toBe("device");
  expect(document.clients.pi).toEqual({ enabled: false });
  expect(JSON.stringify(document)).not.toContain("another-child");
  expect(JSON.stringify(document)).not.toContain("own-key");
  expect(readFileSync(routeIntentStatePath(), "utf8")).toBe(before);
  expect((await request(LINK_ROUTE_INTENT_PATH, "wrong-key")).status).toBe(403);
  expect((await request(LINK_ROUTE_INTENT_PATH, "")).status).toBe(403);
});
test("route stays exact GET/no-query/no-upgrade and outside Child data-plane ingress", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
    const url = new URL(LINK_ROUTE_INTENT_PATH, "http://local");
    expect(linkManagementRouteAllowed(url, new Request(url, { method }))).toBe(false);
    expect((await request(LINK_ROUTE_INTENT_PATH, "own-key", method)).status).toBe(404);
  }
  for (const query of ["?device=another-child", "?refresh=1", "?force=0", "?reload=1", "?quota=1"]) {
    expect((await request(LINK_ROUTE_INTENT_PATH + query)).status).toBe(404);
  }
  const url = new URL(LINK_ROUTE_INTENT_PATH, "http://local");
  expect(linkManagementRouteAllowed(url, new Request(url, { headers: { upgrade: "websocket" } }))).toBe(false);
  expect(linkRouteAllowed(url, new Request(url))).toBe(false);
});
