import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLinkManagementRequest } from "../../src/server/index/link-management";
import { syncRouteToChild } from "../../src/routing/route-to-sync-child";
import { routeIntentDigest } from "../../src/link/route-intent";
import { LINK_ROUTE_INTENT_PATH } from "../../src/link/management-routes";
import { linkStorePath } from "../../src/link/paths";
import { writeLinkStore, type LinkRecord } from "../../src/link/store";
import { setRouteClientIntent, routeIntentStatePath } from "../../src/routing/route-intent-state";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { homeRouteIntentWatch } from "../../src/link/route-intent-watch";
import { handleRouteToRoutes } from "../../src/server/management/route-to-routes";

test("watch replies distinguish unchanged timeout from explicit notification", async () => {
  const after = await digest();
  const wait = spyOn(homeRouteIntentWatch, "wait");
  try {
    wait.mockResolvedValueOnce("timeout").mockResolvedValueOnce("notified");
    const headers = { "x-ocx-route-intent-watch": "1", "x-ocx-route-intent-after": after };
    expect((await read(headers).response).headers.get("x-ocx-route-intent-wake")).toBe("timeout");
    expect((await read(headers).response).headers.get("x-ocx-route-intent-wake")).toBe("notified");
  } finally { wait.mockRestore(); }
});

const link: LinkRecord = { id: "lnk_0123456789abcdef", alias: "child", direction: "client-initiated", hostKeyFingerprint: null,
  tunnelPort: 19200, apiKeyId: "own-key", createdAt: "2026-11-07T00:00:00.000Z" };
let root: string;
let previous: string | undefined;
const aborts: AbortController[] = [];
beforeEach(() => {
  previous = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-watch-boundary-")); process.env.OPENCODEX_HOME = root;
  writeLinkStore(linkStorePath(), { version: 1, listenerPort: 19100, links: [link] });
  setRouteClientIntent("aside", { enabled: false });
});
afterEach(() => {
  for (const abort of aborts.splice(0)) abort.abort();
  if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
  removeTreeWithRetry(root);
});
function read(headers: HeadersInit = {}, key = link.apiKeyId, suffix = "", method = "GET", readmit?: () => string | undefined) {
  const abort = new AbortController(); aborts.push(abort);
  const url = new URL(LINK_ROUTE_INTENT_PATH + suffix, "http://127.0.0.1");
  return { abort, response: handleLinkManagementRequest(new Request(url, { headers, method, signal: abort.signal }), url, {} as never, {} as never, undefined, key, readmit) };
}
async function digest() { return routeIntentDigest(await (await read().response).json()); }
const turn = () => new Promise(resolve => setTimeout(resolve, 0));

test("same digest waits, Home sync wakes without SSH and returns pending rather than an apply claim", async () => {
  const after = await digest();
  const before = readFileSync(routeIntentStatePath(), "utf8");
  let settled = false;
  const pending = read({ "x-ocx-route-intent-watch": "1", "x-ocx-route-intent-after": after }).response.then(r => { settled = true; return r; });
  await turn();
  expect(settled).toBe(false);
  const result = await syncRouteToChild(link, { deps: { sshRunner: { run() { throw new Error("must not SSH"); } } } } as never);
  expect(result.state).toBe("pending");
  expect(result.reason).toContain("requested");
  const response = await pending;
  expect(response.headers.get("x-ocx-route-intent-watch")).toBe("1");
  expect(routeIntentDigest(await response.json())).toBe(after);
  expect(readFileSync(routeIntentStatePath(), "utf8")).toBe(before);
});

test("watch remains exact GET, query-free and admitted-key scoped", async () => {
  const headers = { "x-ocx-route-intent-watch": "1", "x-ocx-route-intent-after": "0".repeat(64) };
  for (const method of ["POST", "PUT", "DELETE", "HEAD"]) expect((await read(headers, link.apiKeyId, "", method).response).status).toBe(404);
  for (const query of ["?device=other", "?refresh=1"]) expect((await read(headers, link.apiKeyId, query).response).status).toBe(404);
  expect((await read(headers, "other-key").response).status).toBe(403);
  expect((await read({ ...headers, upgrade: "websocket" }).response).status).toBe(404);
  for (const bad of [{ "x-ocx-route-intent-watch": "yes" }, { "x-ocx-route-intent-after": "0".repeat(64) },
    { "x-ocx-route-intent-watch": "1", "x-ocx-route-intent-after": "secret-invalid" }]) {
    const response = await read(bad).response;
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("secret-invalid");
  }
});

test("cancelled/duplicate reads release ownership and fresh reads recheck revoked trust", async () => {
  const headers = { "x-ocx-route-intent-watch": "1", "x-ocx-route-intent-after": await digest() };
  const waiting = read(headers);
  expect((await read(headers).response).status).toBe(429);
  waiting.abort.abort(new Error("private abort"));
  expect((await waiting.response).status).toBe(499); expect(homeRouteIntentWatch.size).toBe(0);
  const revoked = read(headers);
  writeLinkStore(linkStorePath(), { version: 1, listenerPort: 19100, links: [] });
  homeRouteIntentWatch.notify(link.id);
  expect((await revoked.response).status).toBe(403); expect(homeRouteIntentWatch.size).toBe(0);
});

test("device mutations notify only their link; default mutations wake all and return fresh policy", async () => {
  const other: LinkRecord = { ...link, id: "lnk_fedcba9876543210", alias: "second", apiKeyId: "second-key" };
  writeLinkStore(linkStorePath(), { version: 1, listenerPort: 19100, links: [link, other] });
  const headers = { "x-ocx-route-intent-watch": "1", "x-ocx-route-intent-after": await digest() };
  const first = read(headers), second = read(headers, other.apiKeyId);
  let otherSettled = false; void second.response.then(() => { otherSettled = true; });
  const mutate = async (body: unknown) => {
    const req = new Request("http://localhost/api/route-to", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return handleRouteToRoutes({ req, url: new URL(req.url), config: { port: 10100, providers: {} }, version: "test", deps: {} } as never,
      { applyHome: async () => [] });
  };
  expect((await mutate({ client: "aside", action: "on", device: link.id }))?.status).toBe(200);
  await turn(); expect(otherSettled).toBe(false);
  expect(homeRouteIntentWatch.size).toBe(1);
  const doc = await (await first.response).json(); expect(doc.clients.aside.enabled).toBe(true);
  expect((await mutate({ client: "pi", action: "on" }))?.status).toBe(200);
  expect(homeRouteIntentWatch.size).toBe(0);
  expect((await (await second.response).json()).clients.pi.enabled).toBe(true);
});

test("a key revoked during the wait is refused even while its link record remains", async () => {
  const headers = { "x-ocx-route-intent-watch": "1", "x-ocx-route-intent-after": await digest() };
  let admitted: string | undefined = link.apiKeyId;
  const waiting = read(headers, link.apiKeyId, "", "GET", () => admitted);
  await turn();
  admitted = undefined;
  homeRouteIntentWatch.notify(link.id);
  const response = await waiting.response;
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain("aside");
});
